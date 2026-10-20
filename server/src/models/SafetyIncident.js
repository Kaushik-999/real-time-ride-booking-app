'use strict';

const mongoose = require('mongoose');
const { INCIDENT_STATUS, DISPATCH_STATUS } = require('../utils/constants');
const { pointSchema } = require('./DriverLocation');

const historySchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    action: { type: String, required: true, maxlength: 60 },
    note: { type: String, maxlength: 500 },
  },
  { _id: false }
);

/**
 * A safety alert raised from the in-ride safety button.
 * `emergencyDispatch` records what happened with an EXTERNAL emergency
 * service. NOT_CONFIGURED means nothing was sent anywhere outside this app.
 * Only ACCEPTED means an external service confirmed receipt.
 */
const safetyIncidentSchema = new mongoose.Schema(
  {
    rideId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ride', required: true },
    reporterId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    reporterRole: { type: String, enum: ['PASSENGER', 'DRIVER'], required: true },
    status: { type: String, enum: Object.values(INCIDENT_STATUS), required: true, default: INCIDENT_STATUS.OPEN },
    // true until RESOLVED; a partial unique index allows one open incident
    // per ride per reporter, so repeated taps don't create duplicates.
    active: { type: Boolean, required: true, default: true },
    message: { type: String, trim: true, maxlength: 500 },
    location: {
      point: { type: pointSchema, default: undefined },
      source: { type: String, enum: ['DEVICE', 'DRIVER_LAST_KNOWN', 'NONE'], default: 'NONE' },
      capturedAt: Date,
    },
    context: {
      rideStatus: String,
      passengerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      vehicleRegistration: String,
    },
    emergencyDispatch: {
      provider: { type: String, default: 'none' },
      status: { type: String, enum: Object.values(DISPATCH_STATUS), required: true, default: DISPATCH_STATUS.NOT_CONFIGURED },
      attempts: { type: Number, default: 0 },
      nextAttemptAt: Date,
      lockedUntil: Date,
      lastError: { type: String, maxlength: 300 },
      externalReference: { type: String, maxlength: 200 },
      updatedAt: Date,
    },
    history: { type: [historySchema], default: [] },
  },
  { timestamps: true }
);

safetyIncidentSchema.index(
  { rideId: 1, reporterId: 1 },
  { unique: true, partialFilterExpression: { active: true }, name: 'one_open_incident_per_ride_reporter' }
);
safetyIncidentSchema.index({ status: 1, createdAt: -1 });
safetyIncidentSchema.index({ 'emergencyDispatch.status': 1, 'emergencyDispatch.nextAttemptAt': 1 });

module.exports = mongoose.model('SafetyIncident', safetyIncidentSchema);
