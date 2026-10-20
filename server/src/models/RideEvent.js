'use strict';

const mongoose = require('mongoose');
const { RIDE_EVENT, RIDE_STATUS } = require('../utils/constants');

// Append-only audit trail of everything important that happens to a ride.
const rideEventSchema = new mongoose.Schema(
  {
    rideId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ride', required: true },
    // null for system actions (matching, timeouts, recovery worker).
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    eventType: { type: String, enum: Object.values(RIDE_EVENT), required: true },
    previousStatus: { type: String, enum: [...Object.values(RIDE_STATUS), null], default: null },
    newStatus: { type: String, enum: [...Object.values(RIDE_STATUS), null], default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

rideEventSchema.index({ rideId: 1, createdAt: 1 });

rideEventSchema.set('toJSON', {
  transform(_doc, ret) {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('RideEvent', rideEventSchema);
