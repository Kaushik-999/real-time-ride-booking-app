'use strict';

const mongoose = require('mongoose');
const { OTP_STATUS } = require('../utils/constants');

/**
 * One-time code proving the driver is with the right passenger.
 *   TRIP_START    - passenger reads it to the driver at pickup
 *   TRIP_COMPLETE - passenger reads it to the driver at drop-off
 *
 * The plaintext code is NEVER stored:
 *   codeHash       - HMAC-SHA256(secret, rideId|purpose|passengerId|code), used to verify
 *   codeCiphertext - AES-256-GCM encryption of the code, so the *passenger*
 *                    (and only the passenger) can view it again after
 *                    reloading the app. Decrypted only in
 *                    rideOtpService.revealForPassenger.
 */
const rideOtpSchema = new mongoose.Schema(
  {
    rideId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ride', required: true },
    purpose: { type: String, enum: ['TRIP_START', 'TRIP_COMPLETE'], required: true },
    passengerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    codeHash: { type: String, required: true, select: false },
    codeCiphertext: { type: String, required: true, select: false },
    status: { type: String, enum: Object.values(OTP_STATUS), required: true, default: OTP_STATUS.ACTIVE },
    attempts: { type: Number, required: true, default: 0, min: 0 },
    maxAttempts: { type: Number, required: true },
    expiresAt: { type: Date, required: true },
    verifiedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// At most one usable code per ride and purpose.
rideOtpSchema.index(
  { rideId: 1, purpose: 1 },
  { unique: true, partialFilterExpression: { status: 'ACTIVE' }, name: 'one_active_otp_per_ride_purpose' }
);
rideOtpSchema.index({ rideId: 1, purpose: 1, createdAt: -1 });

module.exports = mongoose.model('RideOtp', rideOtpSchema);
