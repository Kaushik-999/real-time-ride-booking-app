'use strict';

/**
 * Trip verification codes.
 *
 *   TRIP_START    issued when a driver is assigned. The passenger reads it to
 *                 the driver at pickup; the driver's app submits it with
 *                 POST /rides/:id/start. Only then does the trip start and
 *                 the destination become visible to the driver.
 *   TRIP_COMPLETE issued when the trip starts. Submitted with
 *                 POST /rides/:id/complete at the drop-off.
 *
 * Security properties:
 *   - 6 random digits from crypto.randomInt.
 *   - Stored as an HMAC bound to (ride, purpose, passenger) plus an AES-GCM
 *     ciphertext that only revealForPassenger decrypts. Never logged.
 *   - Expires (TRIP_OTP_TTL_MS) and locks after TRIP_OTP_MAX_ATTEMPTS wrong tries.
 *   - Single use: ACTIVE -> VERIFIED is a conditional update inside the same
 *     transaction as the ride transition, so two parallel submissions can
 *     never start (or complete) a trip twice.
 */
const config = require('../config');
const { RideOtp, Ride, RideEvent } = require('../models');
const { OTP_STATUS, OTP_PURPOSE, RIDE_STATUS, RIDE_EVENT } = require('../utils/constants');
const { AppError, notFound, conflict } = require('../utils/errors');
const { generateNumericCode, hmacCode, safeEqualHex, encryptString, decryptString } = require('../utils/otpCrypto');
const { isDuplicateKeyError } = require('../utils/transaction');
const smsService = require('./smsService');
const notifier = require('../sockets/notifier');

const codeHash = (rideId, purpose, passengerId, code) => hmacCode(config.otp.secret, 'RIDE', String(rideId), purpose, String(passengerId), code);

/** Which code the ride needs next, based on its status. */
function purposeFor(status) {
  if (status === RIDE_STATUS.DRIVER_ASSIGNED || status === RIDE_STATUS.DRIVER_ARRIVED) return OTP_PURPOSE.TRIP_START;
  if (status === RIDE_STATUS.IN_PROGRESS) return OTP_PURPOSE.TRIP_COMPLETE;
  return null;
}

/**
 * Create a fresh code for the ride (superseding any active one). Call inside
 * the transaction that changes the ride; deliver() the result after commit.
 */
async function issue(ride, purpose, { session } = {}) {
  const code = generateNumericCode(6);
  await RideOtp.updateMany({ rideId: ride._id, purpose, status: OTP_STATUS.ACTIVE }, { $set: { status: OTP_STATUS.SUPERSEDED } }, { session });
  const [otp] = await RideOtp.create(
    [
      {
        rideId: ride._id,
        purpose,
        passengerId: ride.passengerId,
        driverId: ride.driverId,
        codeHash: codeHash(ride._id, purpose, ride.passengerId, code),
        codeCiphertext: encryptString(config.otp.tripEncryptionKey, code),
        maxAttempts: config.otp.tripMaxAttempts,
        expiresAt: new Date(Date.now() + config.otp.tripTtlMs),
      },
    ],
    { session }
  );
  return { otp, code, ride };
}

/**
 * After commit: tell the passenger's app a code is ready (WITHOUT the code),
 * and also SMS it if the passenger has a phone and SMS is configured.
 */
async function deliver({ ride, code, otp }) {
  notifier.toUser(ride.passengerId, 'ride:otp-available', { rideId: String(ride._id), purpose: otp.purpose, expiresAt: otp.expiresAt });
  const { User } = require('../models');
  const passenger = await User.findById(ride.passengerId).select('phone').lean();
  if (passenger && passenger.phone && smsService.isAvailable()) {
    const label = otp.purpose === OTP_PURPOSE.TRIP_START ? 'to START your ride' : 'to END your ride';
    await smsService.trySendSms({ to: passenger.phone, body: `Ride code ${code} - share it with your driver only ${label}.`, purpose: otp.purpose });
  }
}

/**
 * The passenger's in-app view of the current code. Creates a new one if the
 * current code is missing, expired or locked (e.g. rides that were already in
 * progress when this feature was deployed), within a regeneration limit.
 */
async function revealForPassenger(rideId, passengerUserId) {
  const ride = await Ride.findById(rideId).lean();
  if (!ride || String(ride.passengerId) !== String(passengerUserId)) throw notFound('Ride not found');
  const purpose = purposeFor(ride.status);
  if (!purpose) throw conflict(`No verification code is needed while the ride is ${ride.status}`, 'NO_OTP_NEEDED');

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const active = await RideOtp.findOne({ rideId, purpose, status: OTP_STATUS.ACTIVE, expiresAt: { $gt: new Date() } }).select('+codeCiphertext');
    if (active && active.attempts < active.maxAttempts) {
      return {
        purpose,
        code: decryptString(config.otp.tripEncryptionKey, active.codeCiphertext),
        expiresAt: active.expiresAt,
        attemptsRemaining: active.maxAttempts - active.attempts,
      };
    }
    const issued = await RideOtp.countDocuments({ rideId, purpose });
    if (issued > config.otp.tripMaxRegenerations) {
      throw new AppError(429, 'OTP_REGENERATION_LIMIT', 'Too many new codes were requested for this ride. Contact support.');
    }
    try {
      const result = await issue(ride, purpose);
      await deliver(result);
      return { purpose, code: result.code, expiresAt: result.otp.expiresAt, attemptsRemaining: result.otp.maxAttempts };
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err; // a parallel request just issued one: read it
    }
  }
  throw conflict('Could not prepare a code, please retry', 'CONFLICT');
}

/**
 * Check a code submitted by the driver. Counts the attempt atomically first.
 * Returns the matching ACTIVE otp document (not yet consumed). Throws:
 *   400 INVALID_OTP (with attemptsRemaining), 409 OTP_ALREADY_USED,
 *   410 OTP_EXPIRED, 423 OTP_LOCKED, 409 OTP_NOT_ISSUED.
 */
async function checkCode(ride, purpose, driverUserId, code) {
  const now = new Date();
  const otp = await RideOtp.findOneAndUpdate(
    {
      rideId: ride._id,
      purpose,
      driverId: driverUserId,
      status: OTP_STATUS.ACTIVE,
      expiresAt: { $gt: now },
      $expr: { $lt: ['$attempts', '$maxAttempts'] },
    },
    { $inc: { attempts: 1 } },
    { new: true }
  ).select('+codeHash');

  if (!otp) {
    const latest = await RideOtp.findOne({ rideId: ride._id, purpose }).sort({ createdAt: -1 }).lean();
    if (!latest) throw conflict('No code has been issued yet. Ask the passenger to open their ride screen.', 'OTP_NOT_ISSUED');
    if (latest.status === OTP_STATUS.VERIFIED) throw conflict('This code was already used', 'OTP_ALREADY_USED');
    if (latest.status === OTP_STATUS.LOCKED || latest.attempts >= latest.maxAttempts) {
      throw new AppError(423, 'OTP_LOCKED', 'Too many wrong codes. The passenger can show a new code.');
    }
    if (latest.expiresAt <= now) throw new AppError(410, 'OTP_EXPIRED', 'This code has expired. The passenger can show a new code.');
    throw new AppError(400, 'INVALID_OTP', 'Incorrect code');
  }

  if (!safeEqualHex(otp.codeHash, codeHash(ride._id, purpose, ride.passengerId, code))) {
    const remaining = otp.maxAttempts - otp.attempts;
    if (remaining <= 0) await RideOtp.updateOne({ _id: otp._id, status: OTP_STATUS.ACTIVE }, { $set: { status: OTP_STATUS.LOCKED } });
    await RideEvent.create({
      rideId: ride._id,
      actorId: driverUserId,
      eventType: RIDE_EVENT.OTP_FAILED,
      previousStatus: ride.status,
      newStatus: ride.status,
      metadata: { purpose, attemptsRemaining: Math.max(0, remaining) },
    });
    throw new AppError(400, 'INVALID_OTP', 'Incorrect code', { attemptsRemaining: Math.max(0, remaining) });
  }
  return otp;
}

/** Inside the ride-transition transaction: single-use consumption. */
async function consume(otpId, { session }) {
  const res = await RideOtp.updateOne({ _id: otpId, status: OTP_STATUS.ACTIVE }, { $set: { status: OTP_STATUS.VERIFIED, verifiedAt: new Date() } }, { session });
  return res.modifiedCount === 1;
}

/** Inside a cancellation transaction: no code for this ride may be used any more. */
async function invalidateAll(rideId, { session } = {}) {
  await RideOtp.updateMany({ rideId, status: OTP_STATUS.ACTIVE }, { $set: { status: OTP_STATUS.SUPERSEDED } }, { session });
}

module.exports = { issue, deliver, revealForPassenger, checkCode, consume, invalidateAll, purposeFor };
