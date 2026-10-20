'use strict';

const mongoose = require('mongoose');

/**
 * DEVELOPMENT ONLY. Messages that WOULD have been sent by SMS, kept so a
 * developer can read test OTPs with `npm run dev:outbox`. Nothing here was
 * delivered to a phone. The SMS service refuses to use this outbox when
 * NODE_ENV=production. Entries expire automatically after one hour.
 */
const devOutboxMessageSchema = new mongoose.Schema(
  {
    to: { type: String, required: true, maxlength: 20 },
    body: { type: String, required: true, maxlength: 300 },
    purpose: { type: String, maxlength: 40 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

devOutboxMessageSchema.index({ createdAt: 1 }, { expireAfterSeconds: 3600 });

module.exports = mongoose.model('DevOutboxMessage', devOutboxMessageSchema);
