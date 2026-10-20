'use strict';

// All money is handled as integer paise (1 INR = 100 paise). Integers avoid
// floating-point surprises such as 0.1 + 0.2 = 0.30000000000000004.
const config = require('../config');
const { badRequest } = require('../utils/errors');
const routingService = require('./routingService');
const { getVehicle, TYPES } = require('../config/vehicles');

const MIN_TRIP_METERS = 100;
const MAX_TRIP_METERS = 200 * 1000;

/**
 * fare = base + distance(km) x perKm + duration(min) x perMin
 * then raised to the minimum fare and rounded to the nearest whole rupee.
 */
function calculateFare({ distanceMeters, durationSeconds }, rates = config.fare) {
  if (!Number.isFinite(distanceMeters) || distanceMeters < 0) throw badRequest('distance must be a non-negative number');
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) throw badRequest('duration must be a non-negative number');

  const basePaise = rates.basePaise;
  // Multiply before dividing and round once, so each component is an integer.
  const distancePaise = Math.round((distanceMeters * rates.perKmPaise) / 1000);
  const timePaise = Math.round((durationSeconds * rates.perMinPaise) / 60);
  const raw = basePaise + distancePaise + timePaise;
  const minimumApplied = raw < rates.minimumPaise;
  const totalPaise = Math.round(Math.max(raw, rates.minimumPaise) / 100) * 100;

  return {
    totalPaise,
    currency: rates.currency,
    breakdown: { basePaise, distancePaise, timePaise, minimumApplied, distanceMeters, durationSeconds },
  };
}

/** Fare table for a vehicle type (from the configurable catalog). */
function ratesFor(vehicleType = 'CAR') {
  const entry = getVehicle(vehicleType);
  if (!entry) throw badRequest(`Unknown vehicle type ${vehicleType}`);
  return { currency: config.fare.currency, ...entry.fare };
}

/** Server-side estimate for a pickup -> destination trip in one vehicle type. */
async function estimateTrip(pickup, destination, vehicleType = 'CAR', passengerCount = 1) {
  const route = await routingService.getRoute(pickup, destination);
  if (route.distanceMeters < MIN_TRIP_METERS) throw badRequest('Pickup and destination are too close together');
  if (route.distanceMeters > MAX_TRIP_METERS) throw badRequest('Trip is longer than the 200 km service limit');
  const fare = calculateFare(route, ratesFor(vehicleType));
  return {
    vehicleType,
    distanceMeters: route.distanceMeters,
    durationSeconds: route.durationSeconds,
    source: route.source,
    isEstimate: true,
    estimatedFare: fare.totalPaise,
    currency: fare.currency,
    breakdown: fare.breakdown,
    // The same route priced for every vehicle type that fits the group,
    // so the booking screen can show all options at once.
    options: TYPES.filter((type) => getVehicle(type).maxCapacity >= passengerCount).map((type) => {
      const entry = getVehicle(type);
      return { vehicleType: type, label: entry.label, maxPassengers: entry.maxCapacity, estimatedFare: calculateFare(route, ratesFor(type)).totalPaise };
    }),
  };
}

/**
 * Final fare from trusted, server-recorded trip data:
 * - distance: metres accumulated from driver location updates the server
 *   accepted during IN_PROGRESS, or the booking estimate if none arrived;
 * - duration: server timestamps startedAt -> completedAt.
 */
function calculateFinalFare(ride, completedAt) {
  const distanceMeters = ride.tripDistanceMeters > 0 ? Math.round(ride.tripDistanceMeters) : ride.estimate.distanceMeters;
  const durationSeconds = Math.max(0, Math.round((completedAt - ride.startedAt) / 1000));
  return calculateFare({ distanceMeters, durationSeconds }, ratesFor(ride.vehicleType));
}

const formatInr = (paise) => `₹${(paise / 100).toFixed(2)}`;

module.exports = { calculateFare, ratesFor, estimateTrip, calculateFinalFare, formatInr, MIN_TRIP_METERS, MAX_TRIP_METERS };
