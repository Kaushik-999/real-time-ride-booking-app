'use strict';

const mongoose = require('mongoose');
const { DRIVER_AVAILABILITY, APPROVAL_STATUS, VEHICLE_TYPES, FEMALE_PROGRAM_STATUS } = require('../utils/constants');
const { getVehicle } = require('../config/vehicles');

const vehicleSchema = new mongoose.Schema(
  {
    type: { type: String, enum: VEHICLE_TYPES, required: true },
    // Normalised to upper-case without spaces/dashes ("ka 01-ab 1234" -> "KA01AB1234").
    registrationNumber: { type: String, required: true, uppercase: true, trim: true, maxlength: 20 },
    model: { type: String, trim: true, maxlength: 60 },
    color: { type: String, trim: true, maxlength: 30 },
    // How many passengers this vehicle may carry. Must not exceed the
    // catalog's maxCapacity for the vehicle type.
    capacity: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator(v) {
          const entry = getVehicle(this.type);
          return Number.isInteger(v) && (!entry || v <= entry.maxCapacity);
        },
        message: 'capacity exceeds the maximum for this vehicle type',
      },
      default() {
        const entry = getVehicle(this.type);
        return entry ? entry.defaultCapacity : 1;
      },
    },
  },
  { _id: false }
);

const ratingStatsSchema = new mongoose.Schema(
  { sum: { type: Number, default: 0, min: 0 }, count: { type: Number, default: 0, min: 0 } },
  { _id: false }
);

const driverProfileSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    vehicle: { type: vehicleSchema, required: true },
    // Identity details needed to operate. Deliberately NOT stored: Aadhaar
    // or PAN numbers (only the uploaded documents, reviewed by an admin).
    identity: {
      legalName: { type: String, trim: true, maxlength: 100 },
      dateOfBirth: { type: Date },
      licenseNumber: { type: String, trim: true, uppercase: true, maxlength: 20 },
    },
    approvalStatus: {
      type: String,
      enum: Object.values(APPROVAL_STATUS),
      required: true,
      default: APPROVAL_STATUS.DOCUMENTS_REQUIRED,
    },
    // Who decided, when, and why (for approval, rejection or suspension).
    review: {
      submittedAt: Date,
      reviewedAt: Date,
      reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      rejectionReason: { type: String, maxlength: 500 },
    },
    // Eligibility for "women drivers only" requests. Set ONLY by an admin
    // after checking documents; the only gender-related data we keep.
    femaleDriverProgram: {
      status: { type: String, enum: Object.values(FEMALE_PROGRAM_STATUS), default: FEMALE_PROGRAM_STATUS.NOT_REQUESTED },
      requestedAt: Date,
      reviewedAt: Date,
      reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    },
    availability: {
      type: String,
      enum: Object.values(DRIVER_AVAILABILITY),
      required: true,
      default: DRIVER_AVAILABILITY.OFFLINE,
    },
    // The ride currently holding this driver (reservation or trip). null when free.
    activeRideId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ride', default: null },
    // When the current reservation was made; used to reconcile abandoned ones.
    reservedAt: { type: Date, default: null },
    // Passengers' ratings of the vehicle / service (separate from the driver rating).
    serviceRatingStats: { type: ratingStatsSchema, default: () => ({}) },
  },
  { timestamps: true }
);

driverProfileSchema.index({ userId: 1 }, { unique: true });
driverProfileSchema.index({ 'vehicle.registrationNumber': 1 }, { unique: true });
driverProfileSchema.index({ availability: 1, approvalStatus: 1 });
driverProfileSchema.index({ activeRideId: 1 });
driverProfileSchema.index({ approvalStatus: 1, 'review.submittedAt': 1 });

driverProfileSchema.set('toJSON', {
  transform(_doc, ret) {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    const s = ret.serviceRatingStats || { sum: 0, count: 0 };
    ret.serviceRating = s.count ? { average: Math.round((s.sum / s.count) * 10) / 10, count: s.count } : { average: null, count: 0 };
    delete ret.serviceRatingStats;
    return ret;
  },
});

module.exports = mongoose.model('DriverProfile', driverProfileSchema);
