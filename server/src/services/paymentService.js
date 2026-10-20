'use strict';

/**
 * Payments. A Payment row is created (PENDING) when a trip completes.
 *
 *   ONLINE: passenger calls POST /api/rides/:rideId/pay
 *           PENDING|FAILED -> PROCESSING (new providerReference)
 *           provider later calls POST /api/payments/webhook (HMAC-signed)
 *           PROCESSING -> SUCCEEDED | FAILED  (exactly once)
 *   CASH:   assigned driver calls POST /api/rides/:rideId/cash-collected
 *           PENDING -> SUCCEEDED
 *
 * The only provider implemented is a MOCK used for development: it
 * "settles" by invoking the same code path a real webhook would. No card
 * details are ever collected or stored.
 */
const crypto = require('crypto');
const config = require('../config');
const logger = require('../utils/logger');
const { Payment, Ride, RideEvent } = require('../models');
const { PAYMENT_STATUS: P, PAYMENT_METHOD, RIDE_STATUS, RIDE_EVENT } = require('../utils/constants');
const { notFound, conflict, forbidden } = require('../utils/errors');
const notifier = require('../sockets/notifier');

function sign(rawBody, secret = config.payments.webhookSecret) {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

function verifySignature(rawBody, signature) {
  if (!rawBody || typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = Buffer.from(sign(rawBody), 'hex');
  const given = Buffer.from(signature, 'hex');
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

async function loadOwnedRidePayment(rideId, passengerId) {
  const ride = await Ride.findById(rideId).lean();
  // Not your ride -> 404, and nothing is created or changed.
  if (!ride || String(ride.passengerId) !== String(passengerId)) throw notFound('Ride not found');
  const payment = await Payment.findOne({ rideId }).lean();
  if (!payment || ride.status !== RIDE_STATUS.COMPLETED) throw conflict('Ride is not completed yet', 'RIDE_NOT_COMPLETED');
  return { ride, payment };
}

async function getPayment(rideId, passengerId) {
  return (await loadOwnedRidePayment(rideId, passengerId)).payment;
}

async function startOnlinePayment(rideId, passengerId) {
  const { payment } = await loadOwnedRidePayment(rideId, passengerId);
  if (payment.method !== PAYMENT_METHOD.ONLINE) throw conflict('This ride is paid in cash to the driver', 'WRONG_PAYMENT_METHOD');
  if (payment.status === P.SUCCEEDED || payment.status === P.PROCESSING) return payment; // idempotent

  const providerReference = `mock_${crypto.randomBytes(12).toString('hex')}`;
  const updated = await Payment.findOneAndUpdate(
    { _id: payment._id, status: { $in: [P.PENDING, P.FAILED] } },
    { $set: { status: P.PROCESSING, providerReference }, $unset: { failureReason: 1 } },
    { new: true }
  ).lean();
  if (!updated) return Payment.findById(payment._id).lean(); // a concurrent request already started it

  if (config.payments.mockAutoSettle) {
    // MOCK PROVIDER: pretend the bank approved the charge after a delay.
    setTimeout(() => {
      applyProviderResult({ providerReference, status: P.SUCCEEDED }).catch((err) =>
        logger.error({ err }, 'mock payment settlement failed')
      );
    }, config.payments.mockSettleDelayMs).unref();
  }
  return updated;
}

/**
 * Apply a provider callback. Only PROCESSING payments can change, so a
 * repeated SUCCEEDED callback is a no-op and a FAILED payment can never be
 * flipped to SUCCEEDED by a late or forged duplicate.
 */
async function applyProviderResult({ providerReference, status, failureReason }) {
  const now = new Date();
  const updated = await Payment.findOneAndUpdate(
    { providerReference, status: P.PROCESSING },
    { $set: { status, settledAt: now, ...(status === P.FAILED ? { failureReason: failureReason || 'declined' } : {}) } },
    { new: true }
  ).lean();

  if (!updated) {
    const existing = await Payment.findOne({ providerReference }).lean();
    if (!existing) throw notFound('Unknown payment reference');
    if (existing.status === status) return { payment: existing, duplicate: true };
    throw conflict(`Payment is already ${existing.status}`, 'PAYMENT_STATE_CONFLICT');
  }

  await RideEvent.create({
    rideId: updated.rideId,
    eventType: RIDE_EVENT.PAYMENT_UPDATED,
    metadata: { paymentId: updated._id, status: updated.status },
  });
  notifier.toUser(updated.passengerId, 'payment:updated', { rideId: String(updated.rideId), status: updated.status });
  return { payment: updated, duplicate: false };
}

async function confirmCashCollected(rideId, driverUserId) {
  const ride = await Ride.findById(rideId).lean();
  if (!ride) throw notFound('Ride not found');
  if (!ride.driverId || String(ride.driverId) !== String(driverUserId)) throw forbidden('You are not the driver of this ride');
  const payment = await Payment.findOne({ rideId }).lean();
  if (!payment) throw conflict('Ride is not completed yet', 'RIDE_NOT_COMPLETED');
  if (payment.method !== PAYMENT_METHOD.CASH) throw conflict('This ride is paid online', 'WRONG_PAYMENT_METHOD');
  if (payment.status === P.SUCCEEDED) return payment;

  const updated = await Payment.findOneAndUpdate(
    { _id: payment._id, status: P.PENDING },
    { $set: { status: P.SUCCEEDED, settledAt: new Date() } },
    { new: true }
  ).lean();
  const result = updated || (await Payment.findById(payment._id).lean());
  if (updated) {
    await RideEvent.create({
      rideId,
      actorId: driverUserId,
      eventType: RIDE_EVENT.PAYMENT_UPDATED,
      metadata: { paymentId: updated._id, status: updated.status, method: 'CASH' },
    });
    notifier.toUser(updated.passengerId, 'payment:updated', { rideId: String(rideId), status: updated.status });
  }
  return result;
}

module.exports = { sign, verifySignature, getPayment, startOnlinePayment, applyProviderResult, confirmCashCollected };
