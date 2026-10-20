'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { User, DriverProfile, DriverLocation, Ride, RideEvent } = require('../../src/models');
const { signToken } = require('../../src/services/authService');
const { toPoint, destinationPoint } = require('../../src/utils/geo');
const { estimateTrip } = require('../../src/services/fareService');

// Central Bengaluru, used as the default pickup point.
const ORIGIN = Object.freeze({ lat: 12.9716, lng: 77.5946 });
const DESTINATION = Object.freeze({ lat: 12.9352, lng: 77.6245 });
const PASSWORD = 'Passw0rd!';
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq += 1)}${crypto.randomBytes(2).toString('hex')}`;

async function createUser(role = 'PASSENGER', overrides = {}) {
  const id = uniq();
  const user = await User.create({ name: `${role} ${id}`, email: `${role.toLowerCase()}-${id}@test.dev`, passwordHash: PASSWORD_HASH, role, ...overrides });
  return { user, id: String(user._id), token: signToken(user) };
}

const createPassenger = (o) => createUser('PASSENGER', o);
const createAdmin = (o) => createUser('ADMIN', { adminPermissions: ['*'], ...o });

/**
 * Create a driver. Options:
 *   distanceKm/bearing - place them that far from `origin` (default ORIGIN)
 *   approved (true), availability ('AVAILABLE'), vehicleType ('CAR'),
 *   locationAgeMs (0) - make the location stale, location:false - no location
 */
async function createDriver(opts = {}) {
  const {
    distanceKm = 1,
    bearing = 90,
    origin = ORIGIN,
    approved = true,
    availability = 'AVAILABLE',
    vehicleType = 'CAR',
    capacity,
    femaleProgram,
    locationAgeMs = 0,
    location = true,
  } = opts;
  const u = await createUser('DRIVER');
  const profile = await DriverProfile.create({
    userId: u.user._id,
    vehicle: { type: vehicleType, registrationNumber: `KA${uniq().toUpperCase().slice(0, 10)}`, ...(capacity ? { capacity } : {}) },
    ...(femaleProgram ? { femaleDriverProgram: { status: femaleProgram } } : {}),
    approvalStatus: approved ? 'APPROVED' : 'PENDING_REVIEW',
    availability,
  });
  let point = null;
  if (location) {
    point = distanceKm === 0 ? { ...origin } : destinationPoint(origin, distanceKm * 1000, bearing);
    await DriverLocation.create({ driverId: u.user._id, location: toPoint(point), updatedAt: new Date(Date.now() - locationAgeMs) });
  }
  return { ...u, profile, point };
}

/** Create a SEARCHING ride directly (bypasses HTTP; matching is not started). */
async function createRide(passenger, overrides = {}) {
  const pickup = overrides.pickup || ORIGIN;
  const destination = overrides.destination || DESTINATION;
  const vehicleType = overrides.vehicleType || 'CAR';
  const est = await estimateTrip(pickup, destination, vehicleType, overrides.passengerCount || 1);
  const ride = await Ride.create({
    passengerId: passenger.user._id,
    pickup: { address: 'Pickup', location: toPoint(pickup) },
    destination: { address: 'Drop', location: toPoint(destination) },
    vehicleType,
    passengerCount: overrides.passengerCount || 1,
    driverPreference: overrides.driverPreference || 'ANY',
    paymentMethod: overrides.paymentMethod || 'CASH',
    estimatedFare: est.estimatedFare,
    currency: est.currency,
    estimate: { distanceMeters: est.distanceMeters, durationSeconds: est.durationSeconds, source: est.source, breakdown: est.breakdown },
    requestKey: overrides.requestKey || `key-${uniq()}`,
  });
  await RideEvent.create({ rideId: ride._id, actorId: passenger.user._id, eventType: 'RIDE_REQUESTED', newStatus: 'SEARCHING' });
  return ride;
}

const bookingBody = (overrides = {}) => ({
  pickup: { address: 'MG Road, Bengaluru', ...ORIGIN },
  destination: { address: 'Koramangala, Bengaluru', ...DESTINATION },
  vehicleType: 'CAR',
  paymentMethod: 'CASH',
  requestKey: `req-${uniq()}`,
  ...overrides,
});

const auth = (token) => ({ Authorization: `Bearer ${token}` });

/** Poll until `fn()` returns truthy (for asynchronous, auto-started flows). */
async function waitFor(fn, { timeout = 5000, interval = 50 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, interval));
  }
}

module.exports = {
  ORIGIN,
  DESTINATION,
  PASSWORD,
  uniq,
  createUser,
  createPassenger,
  createAdmin,
  createDriver,
  createRide,
  bookingBody,
  auth,
  waitFor,
};
