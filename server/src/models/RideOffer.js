'use strict';

const mongoose = require('mongoose');
const { OFFER_STATUS } = require('../utils/constants');

const rideOfferSchema = new mongoose.Schema(
  {
    rideId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ride', required: true },
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: Object.values(OFFER_STATUS), required: true, default: OFFER_STATUS.PENDING },
    ringIndex: { type: Number, required: true, min: 0 },
    distanceMeters: { type: Number, min: 0 },
    offeredAt: { type: Date, required: true, default: Date.now },
    expiresAt: { type: Date, required: true },
    respondedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// A driver receives at most one offer per ride.
rideOfferSchema.index({ rideId: 1, driverId: 1 }, { unique: true });
// At most one PENDING offer per ride at any time (sequential offers).
rideOfferSchema.index(
  { rideId: 1 },
  { unique: true, partialFilterExpression: { status: OFFER_STATUS.PENDING }, name: 'one_pending_offer_per_ride' }
);
// The recovery worker scans for expired pending offers.
rideOfferSchema.index({ status: 1, expiresAt: 1 });
rideOfferSchema.index({ driverId: 1, status: 1 });

rideOfferSchema.set('toJSON', {
  transform(_doc, ret) {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('RideOffer', rideOfferSchema);
