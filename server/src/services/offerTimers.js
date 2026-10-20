'use strict';

// In-memory timers that expire an offer promptly when its 15 s window ends.
// These are only an optimisation for responsiveness: if this process dies,
// the timers die with it. The recovery worker scans MongoDB for PENDING
// offers whose `expiresAt` has passed, so expiry still happens after a crash.
const config = require('../config');
const logger = require('../utils/logger');

const timers = new Map();

function schedule(offer, onExpire) {
  if (!config.matching.offerTimersEnabled) return;
  const id = String(offer._id);
  cancel(id);
  // Small grace so the DB clock has definitely passed expiresAt.
  const delay = Math.max(0, new Date(offer.expiresAt).getTime() - Date.now()) + 50;
  const t = setTimeout(() => {
    timers.delete(id);
    Promise.resolve(onExpire(id)).catch((err) => logger.error({ err, offerId: id }, 'offer timeout handler failed'));
  }, delay);
  t.unref();
  timers.set(id, t);
}

function cancel(offerId) {
  const id = String(offerId);
  const t = timers.get(id);
  if (t) clearTimeout(t);
  timers.delete(id);
}

function clearAll() {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
}

module.exports = { schedule, cancel, clearAll, size: () => timers.size };
