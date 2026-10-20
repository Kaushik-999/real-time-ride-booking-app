'use strict';

const mongoose = require('mongoose');
const { ROLES, ACCOUNT_STATUS, ADMIN_PERMISSIONS } = require('../utils/constants');

// A sign-in method other than email+password, e.g. Google. `subject` is the
// provider's stable user id (Google's `sub` claim), never the email.
const authProviderSchema = new mongoose.Schema(
  {
    provider: { type: String, enum: ['google'], required: true },
    subject: { type: String, required: true, maxlength: 255 },
    email: { type: String, lowercase: true, trim: true, maxlength: 254 },
    emailVerified: { type: Boolean, default: false },
    linkedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const ratingStatsSchema = new mongoose.Schema(
  { sum: { type: Number, default: 0, min: 0 }, count: { type: Number, default: 0, min: 0 } },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 1, maxlength: 100 },
    // Stored normalised (trimmed + lower-case) so "A@x.com" and "a@x.com"
    // cannot both register; the unique index enforces it at the DB level.
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
    phone: { type: String, trim: true, maxlength: 20 },
    // Set the first time the user proves they control the phone (OTP login).
    phoneVerifiedAt: { type: Date, default: null },
    // `select: false` keeps the hash out of every query unless explicitly
    // requested. Optional: accounts created with Google have no password.
    passwordHash: { type: String, select: false },
    role: { type: String, enum: Object.values(ROLES), required: true, default: ROLES.PASSENGER },
    accountStatus: { type: String, enum: Object.values(ACCOUNT_STATUS), required: true, default: ACCOUNT_STATUS.ACTIVE },
    suspension: {
      reason: { type: String, maxlength: 300 },
      by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      at: Date,
    },
    authProviders: { type: [authProviderSchema], default: [] },
    // Admin-only: which administrative powers this admin has ('*' = all).
    adminPermissions: { type: [{ type: String, enum: [...ADMIN_PERMISSIONS, '*'] }], default: undefined },
    // Ratings this user RECEIVED (published reviews only). average = sum / count.
    ratingStats: { type: ratingStatsSchema, default: () => ({}) },
  },
  { timestamps: true }
);

userSchema.index({ email: 1 }, { unique: true });
// Phone is optional; the partial filter lets many users omit it while still
// keeping provided numbers unique.
userSchema.index({ phone: 1 }, { unique: true, partialFilterExpression: { phone: { $type: 'string' } } });
// One app account per external identity (e.g. one Google account).
userSchema.index(
  { 'authProviders.provider': 1, 'authProviders.subject': 1 },
  { unique: true, partialFilterExpression: { 'authProviders.subject': { $type: 'string' } }, name: 'unique_external_identity' }
);
userSchema.index({ role: 1, createdAt: -1 });

userSchema.set('toJSON', {
  transform(_doc, ret) {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    delete ret.passwordHash;
    // Expose which providers are linked, not their identifiers.
    ret.authProviders = (ret.authProviders || []).map((p) => ({ provider: p.provider, email: p.email, linkedAt: p.linkedAt }));
    const stats = ret.ratingStats || { sum: 0, count: 0 };
    ret.rating = stats.count ? { average: Math.round((stats.sum / stats.count) * 10) / 10, count: stats.count } : { average: null, count: 0 };
    delete ret.ratingStats;
    if (ret.role !== ROLES.ADMIN) delete ret.adminPermissions;
    return ret;
  },
});

module.exports = mongoose.model('User', userSchema);
