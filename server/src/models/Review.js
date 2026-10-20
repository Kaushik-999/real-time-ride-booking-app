'use strict';

const mongoose = require('mongoose');
const { REVIEW_STATUS } = require('../utils/constants');

/**
 * A rating left by one ride participant about the other.
 *   reviewerRole PASSENGER -> reviewee is the driver (+ optional serviceRating for the vehicle/service)
 *   reviewerRole DRIVER    -> reviewee is the passenger
 */
const reviewSchema = new mongoose.Schema(
  {
    rideId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ride', required: true },
    reviewerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    revieweeId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    reviewerRole: { type: String, enum: ['PASSENGER', 'DRIVER'], required: true },
    rating: { type: Number, required: true, min: 1, max: 5, validate: Number.isInteger },
    serviceRating: { type: Number, min: 1, max: 5, validate: (v) => v == null || Number.isInteger(v), default: null },
    comment: { type: String, trim: true, maxlength: 500, default: '' },
    status: { type: String, enum: Object.values(REVIEW_STATUS), required: true, default: REVIEW_STATUS.PUBLISHED },
    moderation: {
      by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      at: Date,
      reason: { type: String, maxlength: 300 },
    },
  },
  { timestamps: true }
);

// One review per reviewer, per ride, per person reviewed.
reviewSchema.index({ rideId: 1, reviewerId: 1, revieweeId: 1 }, { unique: true });
reviewSchema.index({ revieweeId: 1, status: 1, createdAt: -1 });
reviewSchema.index({ reviewerId: 1, createdAt: -1 });
reviewSchema.index({ status: 1, rating: 1, createdAt: -1 });

module.exports = mongoose.model('Review', reviewSchema);
