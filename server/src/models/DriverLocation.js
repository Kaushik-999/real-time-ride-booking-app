'use strict';

const mongoose = require('mongoose');
const { isValidLatLng } = require('../utils/geo');

const pointSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['Point'], required: true, default: 'Point' },
    // GeoJSON order is [longitude, latitude].
    coordinates: {
      type: [Number],
      required: true,
      validate: {
        validator: (c) => Array.isArray(c) && c.length === 2 && isValidLatLng(c[1], c[0]),
        message: 'coordinates must be [longitude, latitude] within valid ranges',
      },
    },
  },
  { _id: false }
);

const driverLocationSchema = new mongoose.Schema({
  // References the driver's User id (the same id used in Ride.driverId).
  driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  location: { type: pointSchema, required: true },
  heading: { type: Number, min: 0, max: 360 },
  // Set by the server whenever a location update is accepted. Matching
  // ignores drivers whose updatedAt is older than LOCATION_FRESHNESS_MS.
  updatedAt: { type: Date, required: true, default: Date.now },
});

driverLocationSchema.index({ driverId: 1 }, { unique: true });
driverLocationSchema.index({ location: '2dsphere' });

module.exports = mongoose.model('DriverLocation', driverLocationSchema);
module.exports.pointSchema = pointSchema;
