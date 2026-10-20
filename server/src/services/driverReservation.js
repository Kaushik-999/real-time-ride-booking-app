'use strict';

// Atomic driver-state changes. Every update is conditional ("only if the
// driver is still in the state I expect"), so a stale or duplicate caller
// can never overwrite a newer decision made by someone else.
const { DriverProfile } = require('../models');
const { DRIVER_AVAILABILITY: A, APPROVAL_STATUS } = require('../utils/constants');

/**
 * Reserve a driver for a ride. Succeeds only if the driver is approved,
 * AVAILABLE and has no active ride - checked and changed in ONE document
 * update, so two rides can never both reserve the same driver.
 * Returns the updated profile, or null if another operation won the race.
 */
function reserveDriver(driverUserId, rideId, { session, now = new Date(), eligibility = {} } = {}) {
  return DriverProfile.findOneAndUpdate(
    // `eligibility` (vehicle type, capacity, women-driver verification) is
    // re-checked here atomically, not just trusted from the earlier search.
    { userId: driverUserId, availability: A.AVAILABLE, activeRideId: null, approvalStatus: APPROVAL_STATUS.APPROVED, ...eligibility },
    { $set: { availability: A.RESERVED, activeRideId: rideId, reservedAt: now } },
    { new: true, session }
  );
}

/**
 * Undo a reservation - but only if it still belongs to `rideId`. A stale
 * release (for an old ride) cannot free a driver now held by another ride.
 */
async function releaseReservation(driverUserId, rideId, { session } = {}) {
  const res = await DriverProfile.updateOne(
    { userId: driverUserId, availability: A.RESERVED, activeRideId: rideId },
    { $set: { availability: A.AVAILABLE, activeRideId: null, reservedAt: null } },
    { session }
  );
  return res.modifiedCount === 1;
}

/** Free a driver whose assigned trip ended (completed or cancelled). */
async function releaseTripDriver(driverUserId, rideId, { session } = {}) {
  const res = await DriverProfile.updateOne(
    { userId: driverUserId, availability: { $in: [A.ON_TRIP, A.RESERVED] }, activeRideId: rideId },
    { $set: { availability: A.AVAILABLE, activeRideId: null, reservedAt: null } },
    { session }
  );
  return res.modifiedCount === 1;
}

module.exports = { reserveDriver, releaseReservation, releaseTripDriver };
