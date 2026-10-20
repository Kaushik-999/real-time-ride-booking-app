'use strict';

const mongoose = require('mongoose');
const { OTP_STATUS } = require('../utils/constants');

/**
 * Login challenge for "sign in with mobile OTP".
 * A challenge is created for EVERY request, whether or not the phone is
 * registered (userId is then null and no SMS is sent), so responses and
 * timing don't reveal which numbers have accounts.
 */
const authOtpSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true, maxlength: 20 },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    codeHash: { type: String, required: true, select: false },
    status: { type: String, enum: Object.values(OTP_STATUS), required: true, default: OTP_STATUS.ACTIVE },
    attempts: { type: Number, required: true, default: 0 },
    maxAttempts: { type: Number, required: true },
    expiresAt: { type: Date, required: true },
    verifiedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

authOtpSchema.index({ phone: 1, createdAt: -1 });
authOtpSchema.index({ phone: 1 }, { unique: true, partialFilterExpression: { status: 'ACTIVE' }, name: 'one_active_login_otp_per_phone' });
// MongoDB deletes old challenges automatically a day after they expire.
authOtpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 24 * 3600 });

module.exports = mongoose.model('AuthOtp', authOtpSchema);
