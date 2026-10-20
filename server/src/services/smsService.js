'use strict';

/**
 * SMS delivery behind one interface, chosen by SMS_PROVIDER:
 *
 *   dev_outbox - DEVELOPMENT ONLY. Nothing is sent. The message is stored in
 *                the `devoutboxmessages` collection so a developer can read it
 *                with `npm run dev:outbox`. Results say delivered:false.
 *                Refused when NODE_ENV=production (see config validation).
 *   twilio     - real SMS through Twilio's REST API (needs TWILIO_* vars).
 *                Implemented but NOT verified against a live account here.
 *   disabled   - SMS features are unavailable; callers get 503.
 *
 * Message bodies may contain codes, so they are never logged.
 */
const config = require('../config');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errors');
const { DevOutboxMessage } = require('../models');

const unavailable = () => new AppError(503, 'SMS_UNAVAILABLE', 'SMS delivery is not configured on this server');

function isAvailable() {
  return config.sms.provider !== 'disabled';
}

async function sendViaTwilio({ to, body }) {
  const { accountSid, authToken, from } = config.sms.twilio;
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: to, From: from, Body: body }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Twilio responded ${res.status}`);
  const json = await res.json();
  return { provider: 'twilio', delivered: true, reference: json.sid || null };
}

/** Returns { provider, delivered, reference? }. Throws on failure. */
async function sendSms({ to, body, purpose }) {
  switch (config.sms.provider) {
    case 'dev_outbox':
      if (config.isProduction) throw unavailable();
      await DevOutboxMessage.create({ to, body, purpose });
      return { provider: 'dev_outbox', delivered: false };
    case 'twilio':
      return sendViaTwilio({ to, body });
    default:
      throw unavailable();
  }
}

/** Fire-and-forget variant: failures are logged (without the body) and reported, never thrown. */
async function trySendSms(msg) {
  try {
    return await sendSms(msg);
  } catch (err) {
    logger.warn({ purpose: msg.purpose, provider: config.sms.provider, err: err.message }, 'sms delivery failed');
    return { provider: config.sms.provider, delivered: false, error: err.code || 'SMS_FAILED' };
  }
}

module.exports = { sendSms, trySendSms, isAvailable };
