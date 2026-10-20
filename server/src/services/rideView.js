'use strict';

// Shapes a Ride for API responses, adding only what the viewer is allowed
// to see (the other party's name and vehicle, never emails or hashes).
const { User, DriverProfile, DriverLocation, Payment } = require('../models');
const { fromPoint } = require('../utils/geo');
const { DRIVER_ATTACHED } = require('./rideStateMachine');
const config = require('../config');
const { getVehicle } = require('../config/vehicles');

const ratingOf = (stats) =>
  stats && stats.count ? { average: Math.round((stats.sum / stats.count) * 10) / 10, count: stats.count } : { average: null, count: 0 };

function place(p) {
  return p ? { address: p.address, ...fromPoint(p.location) } : null;
}

/**
 * `viewer` ({ id, role }) controls privacy-sensitive fields:
 *   - driverPreference is shown to the passenger and admins only (it can
 *     reveal something personal about the passenger, so drivers never see it).
 */
async function buildRideView(rideDoc, { includeDriverLocation = true, viewer = null } = {}) {
  const ride = typeof rideDoc.toObject === 'function' ? rideDoc.toObject() : rideDoc;
  const view = {
    id: String(ride._id),
    status: ride.status,
    passengerId: String(ride.passengerId),
    driverId: ride.driverId ? String(ride.driverId) : null,
    pickup: place(ride.pickup),
    destination: place(ride.destination),
    vehicleType: ride.vehicleType,
    vehicleLabel: getVehicle(ride.vehicleType) ? getVehicle(ride.vehicleType).label : ride.vehicleType,
    passengerCount: ride.passengerCount || 1,
    noDriverReason: ride.noDriverReason || null,
    paymentMethod: ride.paymentMethod,
    estimatedFare: ride.estimatedFare,
    finalFare: ride.finalFare,
    currency: ride.currency,
    estimate: ride.estimate
      ? {
          distanceMeters: ride.estimate.distanceMeters,
          durationSeconds: ride.estimate.durationSeconds,
          source: ride.estimate.source,
          isEstimate: true,
        }
      : null,
    finalBreakdown: ride.finalBreakdown || null,
    tripDistanceMeters: ride.tripDistanceMeters,
    matchingRadiusKm: ride.matchingRadiusKm,
    matchingStartedAt: ride.matchingStartedAt,
    requestKey: ride.requestKey,
    assignedAt: ride.assignedAt || null,
    arrivedAt: ride.arrivedAt || null,
    startedAt: ride.startedAt || null,
    completedAt: ride.completedAt || null,
    cancelledAt: ride.cancelledAt || null,
    cancelReason: ride.cancelReason || null,
    createdAt: ride.createdAt,
    updatedAt: ride.updatedAt,
    driver: null,
    passenger: null,
    driverLocation: null,
    payment: null,
  };

  const isDriverViewer = viewer && viewer.role === 'DRIVER';
  if (!isDriverViewer) view.driverPreference = ride.driverPreference || 'ANY';
  // Destination privacy: the driver only learns the destination once the
  // passenger's trip-start code has been verified (the trip has started).
  view.destinationHidden = Boolean(isDriverViewer && !ride.startedAt);
  if (view.destinationHidden) view.destination = null;
  view.startVerifiedAt = ride.startVerifiedAt || null;
  view.completionVerifiedAt = ride.completionVerifiedAt || null;

  const passenger = await User.findById(ride.passengerId).select('name ratingStats').lean();
  view.passenger = passenger ? { id: String(passenger._id), name: passenger.name, rating: ratingOf(passenger.ratingStats) } : null;

  if (ride.driverId) {
    const [user, profile] = await Promise.all([
      User.findById(ride.driverId).select('name phone ratingStats').lean(),
      DriverProfile.findOne({ userId: ride.driverId }).select('vehicle').lean(),
    ]);
    // Only public driver details: never documents, identity or eligibility flags.
    view.driver = user
      ? {
          id: String(user._id),
          name: user.name,
          phone: user.phone || null,
          rating: ratingOf(user.ratingStats),
          vehicle: profile
            ? {
                type: profile.vehicle.type,
                label: getVehicle(profile.vehicle.type) ? getVehicle(profile.vehicle.type).label : profile.vehicle.type,
                registrationNumber: profile.vehicle.registrationNumber,
                model: profile.vehicle.model || null,
                color: profile.vehicle.color || null,
                capacity: profile.vehicle.capacity,
              }
            : null,
        }
      : null;

    // Location is shared only while the driver is attached to the trip.
    if (includeDriverLocation && DRIVER_ATTACHED.includes(ride.status)) {
      const loc = await DriverLocation.findOne({ driverId: ride.driverId }).lean();
      if (loc) {
        const fresh = Date.now() - loc.updatedAt.getTime() <= config.matching.locationFreshnessMs * 4;
        view.driverLocation = { ...fromPoint(loc.location), heading: loc.heading ?? null, updatedAt: loc.updatedAt, fresh };
      }
    }
  }

  const payment = await Payment.findOne({ rideId: ride._id }).lean();
  if (payment) {
    view.payment = {
      id: String(payment._id),
      status: payment.status,
      method: payment.method,
      amount: payment.amount,
      currency: payment.currency,
    };
  }
  return view;
}

module.exports = { buildRideView, place, ratingOf };
