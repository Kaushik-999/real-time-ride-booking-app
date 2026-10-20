'use strict';

const mongoose = require('mongoose');
const { RIDE_STATUS, VEHICLE_TYPES, PAYMENT_METHOD, DRIVER_PREFERENCE } = require('../utils/constants');
const { pointSchema } = require('./DriverLocation');

const placeSchema = new mongoose.Schema(
  {
    address: { type: String, required: true, trim: true, maxlength: 300 },
    location: { type: pointSchema, required: true },
  },
  { _id: false }
);

// Matching progress is persisted on the ride so any process (API server or
// recovery worker) can resume it after a crash or restart.
const matchingSchema = new mongoose.Schema(
  {
    // Index of the ring currently being searched (0 = 0-3 km, 1 = 3-6 km, ...).
    ringIndex: { type: Number, default: 0, min: 0 },
    // Every driver that has already been tried for this ride (offered or
    // skipped because they became unavailable). Never offered again.
    attemptedDriverIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    currentOfferId: { type: mongoose.Schema.Types.ObjectId, ref: 'RideOffer', default: null },
    // Lease: only the process whose id is in lockOwner may advance matching
    // until lockedUntil. Expired leases can be taken over.
    lockOwner: { type: String, default: null },
    lockedUntil: { type: Date, default: null },
    // Incremented when someone wants matching re-run while another process
    // holds the lease; the holder notices on release and runs again.
    kicks: { type: Number, default: 0 },
    lastProgressAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const fareBreakdownSchema = new mongoose.Schema(
  {
    basePaise: Number,
    distancePaise: Number,
    timePaise: Number,
    minimumApplied: Boolean,
    distanceMeters: Number,
    durationSeconds: Number,
  },
  { _id: false }
);

const rideSchema = new mongoose.Schema(
  {
    passengerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    pickup: { type: placeSchema, required: true },
    destination: { type: placeSchema, required: true },
    vehicleType: { type: String, enum: VEHICLE_TYPES, required: true, default: 'CAR' },
    // Riders in this booking (individual ride, not carpooling). Checked
    // against the catalog limit at booking and each driver's capacity in matching.
    passengerCount: { type: Number, required: true, default: 1, min: 1, max: 20 },
    // FEMALE_ONLY: only drivers whose women-driver eligibility an admin verified.
    driverPreference: { type: String, enum: Object.values(DRIVER_PREFERENCE), required: true, default: DRIVER_PREFERENCE.ANY },
    // Why matching ended without a driver (only set with NO_DRIVER_FOUND).
    noDriverReason: { type: String, enum: ['NO_ELIGIBLE_DRIVER', 'PREFERENCE_UNAVAILABLE', null], default: null },
    paymentMethod: { type: String, enum: Object.values(PAYMENT_METHOD), required: true, default: PAYMENT_METHOD.CASH },
    status: { type: String, enum: Object.values(RIDE_STATUS), required: true, default: RIDE_STATUS.SEARCHING },
    // true while the ride is not in a terminal status. A partial unique index
    // on (passengerId, active=true) guarantees one active ride per passenger.
    active: { type: Boolean, required: true, default: true },

    // Money is always an integer number of paise (1 INR = 100 paise).
    estimatedFare: { type: Number, required: true, min: 0, validate: Number.isInteger },
    finalFare: { type: Number, default: null, min: 0 },
    currency: { type: String, required: true, default: 'INR' },
    estimate: {
      distanceMeters: { type: Number, required: true, min: 0 },
      durationSeconds: { type: Number, required: true, min: 0 },
      source: { type: String, enum: ['straight_line', 'osrm'], required: true },
      breakdown: fareBreakdownSchema,
    },
    finalBreakdown: { type: fareBreakdownSchema, default: null },
    // Distance travelled during IN_PROGRESS, accumulated from server-accepted
    // driver location updates.
    tripDistanceMeters: { type: Number, default: 0, min: 0 },

    requestKey: { type: String, required: true, trim: true, minlength: 8, maxlength: 100 },
    matchingRadiusKm: { type: Number, default: null },
    matchingStartedAt: { type: Date, default: Date.now },
    matching: { type: matchingSchema, default: () => ({}) },

    assignedAt: Date,
    arrivedAt: Date,
    // Pickup verification (trip-start OTP) succeeded; destination now visible to the driver.
    startVerifiedAt: Date,
    // Drop-off verification (trip-completion OTP) succeeded.
    completionVerifiedAt: Date,
    startedAt: Date,
    completedAt: Date,
    cancelledAt: Date,
    cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    cancelReason: { type: String, maxlength: 300 },
  },
  { timestamps: true }
);

// Idempotent booking: the same passenger + requestKey can only ever create one ride.
rideSchema.index({ passengerId: 1, requestKey: 1 }, { unique: true });
rideSchema.index(
  { passengerId: 1 },
  { unique: true, partialFilterExpression: { active: true }, name: 'one_active_ride_per_passenger' }
);
rideSchema.index({ passengerId: 1, createdAt: -1 });
rideSchema.index({ driverId: 1, status: 1, createdAt: -1 });
rideSchema.index({ status: 1, 'matching.lockedUntil': 1 });

rideSchema.set('toJSON', {
  transform(_doc, ret) {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    // Internal coordination fields are not useful to API clients.
    if (ret.matching) {
      ret.matching = { ringIndex: ret.matching.ringIndex, attemptedCount: (ret.matching.attemptedDriverIds || []).length };
    }
    return ret;
  },
});

module.exports = mongoose.model('Ride', rideSchema);
