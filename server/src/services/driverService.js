'use strict';

const mongoose = require('mongoose');
const config = require('../config');
const { DriverProfile, DriverLocation, Ride } = require('../models');
const { DRIVER_AVAILABILITY: A, APPROVAL_STATUS, RIDE_STATUS } = require('../utils/constants');
const { notFound, forbidden, conflict, badRequest } = require('../utils/errors');
const { isDuplicateKeyError } = require('../utils/transaction');
const { toPoint, fromPoint, haversineMeters } = require('../utils/geo');
const { DRIVER_ATTACHED } = require('./rideStateMachine');
const notifier = require('../sockets/notifier');

// Ignore GPS "teleports" larger than this between two updates when adding
// up trip distance (e.g. a phone that was offline for a while).
const MAX_SEGMENT_METERS = 2000;

async function getProfile(userId) {
  const profile = await DriverProfile.findOne({ userId });
  if (!profile) throw notFound('Driver profile not found');
  return profile;
}

/**
 * Go online (AVAILABLE) or offline. Allowed only while the driver holds no
 * ride: a RESERVED or ON_TRIP driver cannot flip their own state, because
 * that would break the ride that owns the reservation.
 */
async function setAvailability(userId, availability) {
  const profile = await getProfile(userId);
  if (availability === A.AVAILABLE && profile.approvalStatus !== APPROVAL_STATUS.APPROVED) {
    throw forbidden('Your driver profile has not been approved yet');
  }
  const updated = await DriverProfile.findOneAndUpdate(
    { userId, availability: { $in: [A.OFFLINE, A.AVAILABLE] }, activeRideId: null },
    { $set: { availability } },
    { new: true }
  );
  if (!updated) throw conflict('You cannot change availability while a ride is reserved or in progress', 'DRIVER_BUSY');
  return updated;
}

/**
 * Store the driver's latest position (one document per driver, upserted).
 * Also adds trip distance during IN_PROGRESS and forwards the position to
 * the passenger's ride room while a ride is attached.
 */
async function updateLocation(userId, { lat, lng, heading, recordedAt }) {
  const now = new Date();
  if (recordedAt) {
    const t = new Date(recordedAt).getTime();
    if (t > now.getTime() + 5000) throw badRequest('recordedAt is in the future');
    if (now.getTime() - t > config.matching.locationFreshnessMs) throw badRequest('Location is stale');
  }
  const profile = await getProfile(userId);

  const update = { $set: { location: toPoint({ lat, lng }), updatedAt: now, ...(heading !== undefined ? { heading } : {}) } };
  let previous;
  try {
    previous = await DriverLocation.findOneAndUpdate({ driverId: userId }, update, { upsert: true, new: false }).lean();
  } catch (err) {
    // Two concurrent first-time upserts: the unique index on driverId lets
    // only one insert succeed. Retry as a plain update.
    if (!isDuplicateKeyError(err)) throw err;
    previous = await DriverLocation.findOneAndUpdate({ driverId: userId }, update, { new: false }).lean();
  }

  const position = { lat, lng, heading: heading ?? null, updatedAt: now };
  if (profile.activeRideId) {
    const ride = await Ride.findOne({ _id: profile.activeRideId, driverId: userId }).select('status passengerId').lean();
    if (ride && DRIVER_ATTACHED.includes(ride.status)) {
      if (ride.status === RIDE_STATUS.IN_PROGRESS && previous) {
        const segment = haversineMeters(fromPoint(previous.location), { lat, lng });
        if (segment > 0 && segment <= MAX_SEGMENT_METERS) {
          await Ride.updateOne({ _id: ride._id, status: RIDE_STATUS.IN_PROGRESS }, { $inc: { tripDistanceMeters: segment } });
        }
      }
      notifier.toRide(ride._id, 'driver:location-updated', { rideId: String(ride._id), driverId: String(userId), ...position });
    }
  }
  return position;
}

/**
 * Change vehicle. The new vehicle's registration certificate and insurance
 * must be re-uploaded and the driver re-reviewed, so the driver goes back to
 * DOCUMENTS_REQUIRED (and offline). Not allowed during a ride.
 */
async function updateVehicle(userId, vehicle) {
  const profile = await getProfile(userId);
  if (profile.activeRideId) throw conflict('Cannot change vehicle during a ride', 'DRIVER_BUSY');
  try {
    const { withTransactionOrAbort, AbortTransaction } = require('../utils/transaction');
    const { DriverDocument } = require('../models');
    const result = await withTransactionOrAbort(async (session) => {
      const updated = await DriverProfile.findOneAndUpdate(
        { userId, activeRideId: null },
        { $set: { vehicle, approvalStatus: APPROVAL_STATUS.DOCUMENTS_REQUIRED, availability: A.OFFLINE } },
        { new: true, runValidators: true, session }
      );
      if (!updated) throw new AbortTransaction({ error: conflict('Cannot change vehicle during a ride', 'DRIVER_BUSY') });
      const retention = new Date(Date.now() + config.documents.retentionDays * 24 * 3600 * 1000);
      await DriverDocument.updateMany(
        { driverId: userId, type: { $in: ['VEHICLE_RC', 'VEHICLE_INSURANCE'] }, status: { $in: ['SUBMITTED', 'ACCEPTED'] } },
        { $set: { status: 'SUPERSEDED', deleteAfter: retention } },
        { session }
      );
      return { profile: updated };
    });
    if (result.error) throw result.error;
    return result.profile;
  } catch (err) {
    if (isDuplicateKeyError(err)) throw conflict('This registration number is already registered', 'DUPLICATE');
    throw err;
  }
}

async function getActiveRide(userId) {
  return Ride.findOne({ driverId: userId, status: { $in: DRIVER_ATTACHED } }).sort({ assignedAt: -1 });
}

async function listTrips(userId, { page, limit }) {
  const filter = { driverId: userId, status: { $in: [RIDE_STATUS.COMPLETED, RIDE_STATUS.CANCELLED] } };
  const [items, total, earnings] = await Promise.all([
    Ride.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    Ride.countDocuments(filter),
    Ride.aggregate([
      { $match: { driverId: new mongoose.Types.ObjectId(String(userId)), status: RIDE_STATUS.COMPLETED } },
      { $group: { _id: null, totalPaise: { $sum: '$finalFare' }, trips: { $sum: 1 }, distanceMeters: { $sum: '$tripDistanceMeters' } } },
    ]),
  ]);
  const summary = earnings[0] || { totalPaise: 0, trips: 0, distanceMeters: 0 };
  return {
    items,
    total,
    page,
    limit,
    earnings: { totalPaise: summary.totalPaise, completedTrips: summary.trips, currency: config.fare.currency },
  };
}

module.exports = { getProfile, setAvailability, updateLocation, updateVehicle, getActiveRide, listTrips };
