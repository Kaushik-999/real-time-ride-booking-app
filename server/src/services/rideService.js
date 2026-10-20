'use strict';

const { Ride, RideEvent, RideOffer, Payment, DriverProfile } = require('../models');
const { RIDE_STATUS: S, ROLES, OFFER_STATUS, PAYMENT_STATUS, RIDE_EVENT, DRIVER_AVAILABILITY, DRIVER_PREFERENCE } = require('../utils/constants');
const config = require('../config');
const { getVehicle } = require('../config/vehicles');
const { withTransactionOrAbort, AbortTransaction, isDuplicateKeyError } = require('../utils/transaction');
const { AppError, badRequest, notFound, forbidden, conflict } = require('../utils/errors');
const { toPoint, fromPoint } = require('../utils/geo');
const { PASSENGER_CANCELLABLE, canTransition } = require('./rideStateMachine');
const fareService = require('./fareService');
const matchingService = require('./matchingService');
const offerTimers = require('./offerTimers');
const rideOtpService = require('./rideOtpService');
const { releaseReservation, releaseTripDriver } = require('./driverReservation');
const notifier = require('../sockets/notifier');
const logger = require('../utils/logger');

function sameTrip(ride, body) {
  const p = fromPoint(ride.pickup.location);
  const d = fromPoint(ride.destination.location);
  return (
    p.lat === body.pickup.lat &&
    p.lng === body.pickup.lng &&
    d.lat === body.destination.lat &&
    d.lng === body.destination.lng &&
    ride.vehicleType === body.vehicleType &&
    (ride.passengerCount || 1) === body.passengerCount &&
    (ride.driverPreference || 'ANY') === body.driverPreference
  );
}

async function existingForKey(passengerId, body) {
  const existing = await Ride.findOne({ passengerId, requestKey: body.requestKey });
  if (!existing) return null;
  if (!sameTrip(existing, body)) {
    throw conflict('This requestKey was already used for a different trip', 'IDEMPOTENCY_KEY_REUSED');
  }
  return existing;
}

/**
 * Create a ride (idempotent on passengerId + requestKey).
 * Returns { ride, created } where created=false means "this is the ride you
 * already created with this key".
 */
async function createRide(passengerId, body) {
  const prior = await existingForKey(passengerId, body);
  if (prior) return { ride: prior, created: false };

  // Re-check capacity here too (defence in depth: never rely only on request validation).
  const vehicle = getVehicle(body.vehicleType);
  if (!vehicle) throw badRequest('Unknown vehicle type');
  if (!Number.isInteger(body.passengerCount) || body.passengerCount < 1 || body.passengerCount > vehicle.maxCapacity) {
    throw badRequest(`A ${vehicle.label} can carry at most ${vehicle.maxCapacity} passenger(s)`);
  }
  if (body.driverPreference === DRIVER_PREFERENCE.FEMALE_ONLY && !config.preferences.femaleDriverEnabled) {
    throw new AppError(409, 'PREFERENCE_UNAVAILABLE', 'The women-driver preference is not available here');
  }

  // Fare is computed here from coordinates; nothing price-related is read from the client.
  const estimate = await fareService.estimateTrip(body.pickup, body.destination, body.vehicleType, body.passengerCount);

  let ride;
  try {
    ride = await withTransactionOrAbort(async (session) => {
      const [created] = await Ride.create(
        [
          {
            passengerId,
            pickup: { address: body.pickup.address, location: toPoint(body.pickup) },
            destination: { address: body.destination.address, location: toPoint(body.destination) },
            vehicleType: body.vehicleType,
            passengerCount: body.passengerCount,
            driverPreference: body.driverPreference,
            paymentMethod: body.paymentMethod,
            status: S.SEARCHING,
            estimatedFare: estimate.estimatedFare,
            currency: estimate.currency,
            estimate: {
              distanceMeters: estimate.distanceMeters,
              durationSeconds: estimate.durationSeconds,
              source: estimate.source,
              breakdown: estimate.breakdown,
            },
            requestKey: body.requestKey,
            matchingStartedAt: new Date(),
          },
        ],
        { session }
      );
      await RideEvent.create(
        [
          {
            rideId: created._id,
            actorId: passengerId,
            eventType: RIDE_EVENT.RIDE_REQUESTED,
            previousStatus: null,
            newStatus: S.SEARCHING,
            metadata: { estimatedFare: created.estimatedFare, distanceMeters: estimate.distanceMeters },
          },
        ],
        { session }
      );
      return created;
    });
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    // A concurrent identical request won the race: return its ride.
    const winner = await existingForKey(passengerId, body);
    if (winner) return { ride: winner, created: false };
    // Otherwise the one-active-ride-per-passenger index fired.
    throw conflict('You already have an active ride', 'ACTIVE_RIDE_EXISTS');
  }

  notifier.rideStatus(ride, 'ride:searching', { radiusKm: null });
  matchingService.kickMatching(ride._id);
  logger.info({ rideId: String(ride._id), passengerId: String(passengerId) }, 'ride requested');
  return { ride, created: true };
}

/** Object-level authorization: passenger owner, assigned driver, or admin. */
async function getRideForUser(rideId, user) {
  const ride = await Ride.findById(rideId);
  if (!ride) throw notFound('Ride not found');
  const isOwner = String(ride.passengerId) === user.id;
  const isDriver = ride.driverId && String(ride.driverId) === user.id;
  // 404 rather than 403 so other users cannot even confirm the ride exists.
  if (!isOwner && !isDriver && user.role !== ROLES.ADMIN) throw notFound('Ride not found');
  return ride;
}

async function listPassengerRides(passengerId, { page, limit }) {
  const filter = { passengerId };
  const [items, total] = await Promise.all([
    Ride.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    Ride.countDocuments(filter),
  ]);
  return { items, total, page, limit };
}

/** Passenger (or admin) cancellation. */
async function cancelRide(rideId, user, reason) {
  const ride = await getRideForUser(rideId, user);
  const isOwner = String(ride.passengerId) === user.id;
  if (!isOwner && user.role !== ROLES.ADMIN) throw forbidden('Only the passenger can cancel this ride');

  if (ride.status === S.CANCELLED) return { ride, alreadyCancelled: true };
  if (!PASSENGER_CANCELLABLE.includes(ride.status)) {
    throw conflict(`A ride that is ${ride.status} cannot be cancelled`, 'INVALID_TRANSITION');
  }

  const result = await withTransactionOrAbort(async (session) => {
    const now = new Date();
    const current = await Ride.findById(rideId).session(session);
    if (!current || !PASSENGER_CANCELLABLE.includes(current.status)) {
      throw new AbortTransaction({ error: conflict(`A ride that is ${current ? current.status : 'missing'} cannot be cancelled`, 'INVALID_TRANSITION') });
    }
    const previousStatus = current.status;
    const updated = await Ride.findOneAndUpdate(
      { _id: rideId, status: previousStatus },
      {
        $set: {
          status: S.CANCELLED,
          active: false,
          cancelledAt: now,
          cancelledBy: user.id,
          cancelReason: reason || null,
          'matching.currentOfferId': null,
        },
      },
      { new: true, session }
    );
    if (!updated) throw new AbortTransaction({ error: conflict('Ride changed, please retry', 'CONFLICT') });

    // Close any open offer and free whichever driver this ride was holding.
    const pendingOffers = await RideOffer.find({ rideId, status: OFFER_STATUS.PENDING }).session(session).lean();
    if (pendingOffers.length) {
      await RideOffer.updateMany(
        { rideId, status: OFFER_STATUS.PENDING },
        { $set: { status: OFFER_STATUS.CANCELLED, respondedAt: now } },
        { session }
      );
      for (const o of pendingOffers) await releaseReservation(o.driverId, rideId, { session });
    }
    if (current.driverId) await releaseTripDriver(current.driverId, rideId, { session });
    // No verification code for this ride may be used any more.
    await rideOtpService.invalidateAll(rideId, { session });
    // Safety net: nothing may still point at a cancelled ride.
    await DriverProfile.updateMany(
      { activeRideId: rideId, availability: { $in: [DRIVER_AVAILABILITY.RESERVED, DRIVER_AVAILABILITY.ON_TRIP] } },
      { $set: { availability: DRIVER_AVAILABILITY.AVAILABLE, activeRideId: null, reservedAt: null } },
      { session }
    );

    await RideEvent.create(
      [
        {
          rideId,
          actorId: user.id,
          eventType: RIDE_EVENT.RIDE_CANCELLED,
          previousStatus,
          newStatus: S.CANCELLED,
          metadata: { reason: reason || null, by: user.role },
        },
      ],
      { session }
    );
    return { ride: updated, pendingOffers };
  });

  if (result.error) {
    const fresh = await Ride.findById(rideId);
    if (fresh && fresh.status === S.CANCELLED) return { ride: fresh, alreadyCancelled: true };
    throw result.error;
  }

  for (const o of result.pendingOffers) {
    offerTimers.cancel(o._id);
    notifier.toUser(o.driverId, 'driver:offer-expired', { offerId: String(o._id), rideId: String(rideId), reason: 'cancelled' });
  }
  notifier.rideStatus(result.ride, 'ride:cancelled', { reason: reason || null });
  return { ride: result.ride, alreadyCancelled: false };
}

const DRIVER_STEPS = {
  arrive: { from: S.DRIVER_ASSIGNED, to: S.DRIVER_ARRIVED, event: RIDE_EVENT.DRIVER_ARRIVED, socket: 'ride:driver-arrived', at: 'arrivedAt' },
  // start/complete require the passenger's one-time code (see rideOtpService).
  start: { from: S.DRIVER_ARRIVED, to: S.IN_PROGRESS, event: RIDE_EVENT.TRIP_STARTED, socket: 'ride:started', at: 'startedAt', otp: 'TRIP_START', verifiedAt: 'startVerifiedAt' },
  complete: { from: S.IN_PROGRESS, to: S.COMPLETED, event: RIDE_EVENT.TRIP_COMPLETED, socket: 'ride:completed', at: 'completedAt', otp: 'TRIP_COMPLETE', verifiedAt: 'completionVerifiedAt' },
};

/**
 * Driver-initiated transitions (arrive, start, complete). Only the driver
 * assigned to the ride may perform them, and only from the right status.
 */
async function driverTransition(rideId, driverUserId, stepName, { otp } = {}) {
  const step = DRIVER_STEPS[stepName];
  const ride = await Ride.findById(rideId);
  if (!ride) throw notFound('Ride not found');
  if (!ride.driverId || String(ride.driverId) !== String(driverUserId)) {
    throw forbidden('You are not the driver assigned to this ride');
  }
  // Repeated arrive/complete requests (e.g. network retry) are harmless.
  if (ride.status === step.to && stepName !== 'start') return { ride, alreadyDone: true };
  if (ride.status !== step.from || !canTransition(step.from, step.to)) {
    throw conflict(`Cannot ${stepName} a ride that is ${ride.status}`, 'INVALID_TRANSITION');
  }

  // Verify the passenger's code BEFORE the transaction (wrong attempts must
  // be counted even though the transition does not happen).
  const otpDoc = step.otp ? await rideOtpService.checkCode(ride, step.otp, driverUserId, otp) : null;

  const result = await withTransactionOrAbort(async (session) => {
    const now = new Date();
    const current = await Ride.findOne({ _id: rideId, driverId: driverUserId, status: step.from }).session(session);
    if (!current) throw new AbortTransaction({ error: conflict(`Ride is no longer ${step.from}`, 'INVALID_TRANSITION') });
    // Single use: only one concurrent request can consume the code.
    if (otpDoc && !(await rideOtpService.consume(otpDoc._id, { session }))) {
      throw new AbortTransaction({ error: conflict('This code was already used', 'OTP_ALREADY_USED') });
    }

    const set = { status: step.to, [step.at]: now };
    if (step.verifiedAt) set[step.verifiedAt] = now;
    const metadata = {};
    if (stepName === 'complete') {
      const fare = fareService.calculateFinalFare(current, now);
      set.finalFare = fare.totalPaise;
      set.finalBreakdown = fare.breakdown;
      set.active = false;
      metadata.finalFare = fare.totalPaise;
    }

    const updated = await Ride.findOneAndUpdate({ _id: rideId, driverId: driverUserId, status: step.from }, { $set: set }, { new: true, session });
    if (!updated) throw new AbortTransaction({ error: conflict(`Ride is no longer ${step.from}`, 'INVALID_TRANSITION') });

    if (stepName === 'complete') {
      await releaseTripDriver(driverUserId, rideId, { session });
      // Completion creates a PENDING payment; it does NOT mean the passenger has paid.
      await Payment.create(
        [
          {
            rideId,
            passengerId: updated.passengerId,
            amount: updated.finalFare,
            currency: updated.currency,
            method: updated.paymentMethod,
            status: PAYMENT_STATUS.PENDING,
          },
        ],
        { session }
      );
    }

    await RideEvent.create(
      [{ rideId, actorId: driverUserId, eventType: step.event, previousStatus: step.from, newStatus: step.to, metadata: { ...metadata, ...(otpDoc ? { otpVerified: step.otp } : {}) } }],
      { session }
    );
    // Starting the trip creates the separate drop-off code.
    const nextOtp = stepName === 'start' ? await rideOtpService.issue(updated, 'TRIP_COMPLETE', { session }) : null;
    return { ride: updated, nextOtp };
  });

  if (result.error) {
    const fresh = await Ride.findById(rideId);
    if (fresh && fresh.status === step.to && stepName !== 'start') return { ride: fresh, alreadyDone: true };
    throw result.error;
  }
  notifier.rideStatus(result.ride, step.socket, stepName === 'complete' ? { finalFare: result.ride.finalFare } : {});
  if (result.nextOtp) await rideOtpService.deliver(result.nextOtp).catch((err) => logger.warn({ err: err.message }, 'completion code notification failed'));
  return { ride: result.ride, alreadyDone: false };
}

async function listRideEvents(rideId) {
  return RideEvent.find({ rideId }).sort({ createdAt: 1, _id: 1 }).lean();
}

module.exports = { createRide, getRideForUser, listPassengerRides, cancelRide, driverTransition, listRideEvents };
