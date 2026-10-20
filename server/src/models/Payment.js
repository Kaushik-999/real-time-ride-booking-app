'use strict';

const mongoose = require('mongoose');
const { PAYMENT_STATUS, PAYMENT_METHOD } = require('../utils/constants');

// No card numbers, CVVs or other payment-instrument data are ever stored.
// Only an opaque reference returned by the (mock) payment provider.
const paymentSchema = new mongoose.Schema(
  {
    rideId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ride', required: true },
    passengerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    amount: { type: Number, required: true, min: 0, validate: Number.isInteger }, // paise
    currency: { type: String, required: true, default: 'INR' },
    method: { type: String, enum: Object.values(PAYMENT_METHOD), required: true },
    status: { type: String, enum: Object.values(PAYMENT_STATUS), required: true, default: PAYMENT_STATUS.PENDING },
    providerReference: { type: String, default: null },
    failureReason: { type: String, maxlength: 200 },
    settledAt: Date,
    // A refund REQUEST recorded by an admin. The mock provider cannot move
    // money, so nothing here ever claims a refund was paid out.
    refund: {
      status: { type: String, enum: ['REQUESTED_MANUAL', null], default: null },
      reason: { type: String, maxlength: 300 },
      requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      requestedAt: Date,
    },
  },
  { timestamps: true }
);

// Exactly one payment record per ride.
paymentSchema.index({ rideId: 1 }, { unique: true });
paymentSchema.index(
  { providerReference: 1 },
  { unique: true, partialFilterExpression: { providerReference: { $type: 'string' } } }
);
paymentSchema.index({ passengerId: 1, createdAt: -1 });

paymentSchema.set('toJSON', {
  transform(_doc, ret) {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('Payment', paymentSchema);
