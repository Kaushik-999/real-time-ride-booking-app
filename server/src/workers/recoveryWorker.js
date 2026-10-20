'use strict';

/**
 * Database-backed recovery worker (no Redis, no Celery).
 *
 * Every WORKER_INTERVAL_MS it runs three idempotent sweeps:
 *   1. expireOffers        PENDING offers past expiresAt -> EXPIRED, release
 *                          driver, resume matching.
 *   2. resumeStalledRides  SEARCHING rides with no open offer and no live
 *                          lease that have not progressed recently (e.g. the
 *                          process crashed mid-match) -> advanceMatching.
 *   3. reconcileDrivers    drivers stuck RESERVED/ON_TRIP for a ride that no
 *                          longer needs them -> AVAILABLE.
 *
 * Safe with many worker instances: each change is a conditional update
 * (the "claim"), and matching is protected by the per-ride lease, so two
 * workers can never both process the same task.
 */
const config = require('../config');
const baseLogger = require('../utils/logger');
const { RideOffer, Ride, DriverProfile } = require('../models');
const { OFFER_STATUS, RIDE_STATUS, DRIVER_AVAILABILITY: A } = require('../utils/constants');
const { DRIVER_ATTACHED } = require('../services/rideStateMachine');
const offerService = require('../services/offerService');
const matchingService = require('../services/matchingService');
const driverOnboardingService = require('../services/driverOnboardingService');
const chatService = require('../services/chatService');
const safetyService = require('../services/safetyService');

const BATCH = 100;

class RecoveryWorker {
  constructor({ intervalMs = config.worker.intervalMs, logger = baseLogger, settings = config.worker } = {}) {
    this.intervalMs = intervalMs;
    this.logger = logger.child ? logger.child({ component: 'recovery-worker' }) : logger;
    this.settings = settings;
    this.timer = null;
    this.running = null;
    this.stopped = true;
    // Housekeeping tasks that add their own counters only when they did work.
    this.extraTasks = [
      [
        'purgeExpiredDocuments',
        async (stats) => {
          const n = await driverOnboardingService.purgeExpiredDocuments();
          if (n) stats.purgedDocuments = n;
        },
      ],
      [
        'retryEmergencyDispatches',
        async (stats) => {
          const n = await safetyService.retryDueDispatches();
          if (n) stats.emergencyDispatchAttempts = n;
        },
      ],
      [
        'purgeOldChatMessages',
        async (stats) => {
          const n = await chatService.purgeOldMessages();
          if (n) stats.purgedChatMessages = n;
        },
      ],
    ];
  }

  /** Run one task, logging (not throwing) on failure so one bad sweep can't kill the worker. */
  async safely(name, fn, stats) {
    try {
      await fn();
    } catch (err) {
      stats.errors += 1;
      this.logger.error({ err, task: name }, 'recovery task failed');
    }
  }

  async expireOffers(stats) {
    const due = await RideOffer.find({ status: OFFER_STATUS.PENDING, expiresAt: { $lte: new Date() } })
      .sort({ expiresAt: 1 })
      .limit(BATCH)
      .select('_id rideId')
      .lean();
    for (const o of due) {
      // expireOffer only succeeds for whoever flips PENDING -> EXPIRED first.
      const closed = await offerService.expireOffer(o._id);
      if (!closed) continue;
      stats.expiredOffers += 1;
      await matchingService.advanceMatching(closed.rideId);
    }
  }

  async resumeStalledRides(stats) {
    const now = Date.now();
    const rides = await Ride.find({
      status: RIDE_STATUS.SEARCHING,
      'matching.lastProgressAt': { $lte: new Date(now - this.settings.staleSearchMs) },
      $or: [{ 'matching.lockedUntil': null }, { 'matching.lockedUntil': { $lte: new Date(now) } }],
    })
      .limit(BATCH)
      .select('_id')
      .lean();
    for (const r of rides) {
      const open = await RideOffer.exists({ rideId: r._id, status: OFFER_STATUS.PENDING, expiresAt: { $gt: new Date() } });
      if (open) continue; // legitimately waiting for a driver's answer
      const result = await matchingService.advanceMatching(r._id);
      if (result.outcome !== 'deferred' && result.outcome !== 'not_searching') stats.resumedRides += 1;
    }
  }

  async reconcileDrivers(stats) {
    const cutoff = new Date(Date.now() - this.settings.reservationGraceMs);

    // RESERVED with no matching PENDING offer = abandoned reservation.
    const reserved = await DriverProfile.find({ availability: A.RESERVED, reservedAt: { $lte: cutoff } })
      .limit(BATCH)
      .select('userId activeRideId')
      .lean();
    for (const d of reserved) {
      const open = await RideOffer.exists({ driverId: d.userId, rideId: d.activeRideId, status: OFFER_STATUS.PENDING });
      if (open) continue;
      // Conditional on the SAME ride: cannot free a driver who has since moved on.
      const res = await DriverProfile.updateOne(
        { _id: d._id, availability: A.RESERVED, activeRideId: d.activeRideId },
        { $set: { availability: A.AVAILABLE, activeRideId: null, reservedAt: null } }
      );
      if (res.modifiedCount) {
        stats.releasedReservations += 1;
        this.logger.warn({ driverId: String(d.userId), rideId: String(d.activeRideId) }, 'released abandoned reservation');
      }
    }

    // ON_TRIP pointing at a ride that is over (or not theirs) = stale trip lock.
    const onTrip = await DriverProfile.find({ availability: A.ON_TRIP, updatedAt: { $lte: cutoff } })
      .limit(BATCH)
      .select('userId activeRideId')
      .lean();
    for (const d of onTrip) {
      const ride = d.activeRideId ? await Ride.findById(d.activeRideId).select('status driverId').lean() : null;
      const stillOwned = ride && String(ride.driverId) === String(d.userId) && DRIVER_ATTACHED.includes(ride.status);
      if (stillOwned) continue;
      const res = await DriverProfile.updateOne(
        { _id: d._id, availability: A.ON_TRIP, activeRideId: d.activeRideId },
        { $set: { availability: A.AVAILABLE, activeRideId: null, reservedAt: null } }
      );
      if (res.modifiedCount) {
        stats.releasedReservations += 1;
        this.logger.warn({ driverId: String(d.userId) }, 'released stale on-trip lock');
      }
    }
  }

  /** One full pass. Returns counters (useful for tests and logs). */
  async runOnce() {
    const stats = { expiredOffers: 0, resumedRides: 0, releasedReservations: 0, errors: 0 };
    await this.safely('expireOffers', () => this.expireOffers(stats), stats);
    await this.safely('resumeStalledRides', () => this.resumeStalledRides(stats), stats);
    await this.safely('reconcileDrivers', () => this.reconcileDrivers(stats), stats);
    for (const [name, task] of this.extraTasks) {
      await this.safely(name, () => task(stats), stats);
    }
    if (stats.expiredOffers || stats.resumedRides || stats.releasedReservations || stats.errors) {
      this.logger.info(stats, 'recovery pass');
    }
    return stats;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    const tick = async () => {
      if (this.stopped) return;
      this.running = this.runOnce().catch((err) => this.logger.error({ err }, 'recovery pass crashed'));
      await this.running;
      this.running = null;
      if (!this.stopped) {
        this.timer = setTimeout(tick, this.intervalMs);
        this.timer.unref();
      }
    };
    this.timer = setTimeout(tick, 0);
    this.timer.unref();
    this.logger.info({ intervalMs: this.intervalMs }, 'recovery worker started');
  }

  /** Graceful stop: no new passes, wait for the current one to finish. */
  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.running) await this.running;
    this.logger.info('recovery worker stopped');
  }
}

module.exports = { RecoveryWorker };
