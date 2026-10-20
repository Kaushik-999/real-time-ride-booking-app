'use strict';

/**
 * The single definition of "which drivers may serve this ride", beyond being
 * approved and free. Used in three places so they can never disagree:
 *   1. matchingService.findCandidates  (geospatial search, prefixed "profile.")
 *   2. driverReservation.reserveDriver (atomic reservation)
 *   3. offerService.acceptOffer        (atomic acceptance)
 *
 * Rules:
 *   - same vehicle type as requested (CAR riders get cars, BIKE riders bikes...)
 *   - vehicle capacity >= number of riders
 *   - FEMALE_ONLY requests: only drivers whose women-driver eligibility an
 *     admin VERIFIED. Never inferred from names or photos.
 */
const { DRIVER_PREFERENCE, FEMALE_PROGRAM_STATUS } = require('../utils/constants');

function rideEligibilityFilter(ride, prefix = '') {
  const filter = {
    [`${prefix}vehicle.type`]: ride.vehicleType,
    [`${prefix}vehicle.capacity`]: { $gte: ride.passengerCount || 1 },
  };
  if (ride.driverPreference === DRIVER_PREFERENCE.FEMALE_ONLY) {
    filter[`${prefix}femaleDriverProgram.status`] = FEMALE_PROGRAM_STATUS.VERIFIED;
  }
  return filter;
}

module.exports = { rideEligibilityFilter };
