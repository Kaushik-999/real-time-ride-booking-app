'use strict';

// RideOffer lifecycle: PENDING -> ACCEPTED | REJECTED | EXPIRED | CANCELLED.
// Every change is a conditional update on `status: PENDING`, so exactly one
// outcome can ever win, no matter how many requests/timers/workers race.
const { RideOffer, Ride, RideEvent, DriverProfile } = require('../models');
const { OFFER_STATUS, RIDE_STATUS, DRIVER_AVAILABILITY, APPROVAL_STATUS, RIDE_EVENT } = require('../utils/constants');
const { withTransactionOrAbort, AbortTransaction } = require('../utils/transaction');
const { AppError, notFound, forbidden, conflict } = require('../utils/errors');
const { releaseReservation } = require('./driverReservation');
const offerTimers = require('./offerTimers');
const { rideEligibilityFilter } = require('./driverEligibility');
const rideOtpService = require('./rideOtpService');
const notifier = require('../sockets/notifier');
const logger = require('../utils/logger');

const lazyMatching = () => require('./matchingService');

async function loadOwnOffer(offerId, driverUserId) {
  const offer = await RideOffer.findById(offerId).lean();
  if (!offer) throw notFound('Offer not found');
  if (String(offer.driverId) !== String(driverUserId)) throw forbidden('This offer belongs to another driver');
  return offer;
}

/**
 * Accept an offer. In one transaction:
 *   offer   PENDING (not expired, mine) -> ACCEPTED
 *   ride    SEARCHING (no driver)       -> DRIVER_ASSIGNED, driverId = me
 *   driver  RESERVED for this ride      -> ON_TRIP
 * If any condition fails, nothing is written.
 */
async function acceptOffer(offerId, driverUserId) {
  const offer = await loadOwnOffer(offerId, driverUserId);

  // Idempotent retry: the same driver re-sending accept for an offer they
  // already won gets the same answer, with no new side effects.
  if (offer.status === OFFER_STATUS.ACCEPTED) {
    const ride = await Ride.findById(offer.rideId).lean();
    return { offer, ride, alreadyAccepted: true };
  }
  if (offer.status !== OFFER_STATUS.PENDING) {
    throw conflict(`Offer is ${offer.status.toLowerCase()} and can no longer be accepted`, 'OFFER_NOT_PENDING');
  }

  const profile = await DriverProfile.findOne({ userId: driverUserId }).lean();
  if (!profile || profile.approvalStatus !== APPROVAL_STATUS.APPROVED) throw forbidden('Driver is not approved');

  const result = await withTransactionOrAbort(async (session) => {
    const now = new Date();
    const accepted = await RideOffer.findOneAndUpdate(
      { _id: offerId, driverId: driverUserId, status: OFFER_STATUS.PENDING, expiresAt: { $gt: now } },
      { $set: { status: OFFER_STATUS.ACCEPTED, respondedAt: now } },
      { new: true, session }
    );
    if (!accepted) throw new AbortTransaction({ error: conflict('Offer has expired or was already answered', 'OFFER_NOT_PENDING') });

    const ride = await Ride.findOneAndUpdate(
      { _id: accepted.rideId, status: RIDE_STATUS.SEARCHING, driverId: null },
      { $set: { status: RIDE_STATUS.DRIVER_ASSIGNED, driverId: driverUserId, assignedAt: now, 'matching.currentOfferId': null } },
      { new: true, session }
    );
    if (!ride) throw new AbortTransaction({ error: conflict('Ride is no longer looking for a driver', 'RIDE_NOT_SEARCHING') });

    const driver = await DriverProfile.findOneAndUpdate(
      {
        userId: driverUserId,
        availability: DRIVER_AVAILABILITY.RESERVED,
        activeRideId: accepted.rideId,
        approvalStatus: APPROVAL_STATUS.APPROVED,
        // An incompatible vehicle / capacity / preference can never be assigned.
        ...rideEligibilityFilter(ride),
      },
      { $set: { availability: DRIVER_AVAILABILITY.ON_TRIP, reservedAt: null } },
      { new: true, session }
    );
    if (!driver) throw new AbortTransaction({ error: conflict('Driver is no longer reserved for this ride or does not match its requirements', 'NOT_ELIGIBLE') });

    await RideEvent.create(
      [
        {
          rideId: ride._id,
          actorId: driverUserId,
          eventType: RIDE_EVENT.DRIVER_ASSIGNED,
          previousStatus: RIDE_STATUS.SEARCHING,
          newStatus: RIDE_STATUS.DRIVER_ASSIGNED,
          metadata: { offerId: accepted._id, ringIndex: accepted.ringIndex, distanceMeters: accepted.distanceMeters },
        },
      ],
      { session }
    );
    // Pickup verification code, created atomically with the assignment.
    const startOtp = await rideOtpService.issue(ride, 'TRIP_START', { session });
    return { offer: accepted.toObject(), ride: ride.toObject(), startOtp };
  });

  if (result.error) {
    if (result.error instanceof AppError && result.error.code === 'OFFER_NOT_PENDING') {
      // Maybe a concurrent duplicate request won; answer it idempotently.
      const fresh = await RideOffer.findById(offerId).lean();
      if (fresh && fresh.status === OFFER_STATUS.ACCEPTED) {
        return { offer: fresh, ride: await Ride.findById(fresh.rideId).lean(), alreadyAccepted: true };
      }
    }
    throw result.error;
  }

  offerTimers.cancel(offerId);
  notifier.rideStatus(result.ride, 'ride:driver-assigned', { driverId: String(driverUserId) });
  await rideOtpService.deliver(result.startOtp).catch((err) => logger.warn({ err: err.message }, 'start code notification failed'));
  delete result.startOtp; // never returned to the driver
  logger.info({ rideId: String(result.ride._id), driverId: String(driverUserId) }, 'driver assigned');
  return { ...result, alreadyAccepted: false };
}

/**
 * Close a PENDING offer as REJECTED / EXPIRED / CANCELLED and release the
 * driver's reservation (only if it still belongs to this ride).
 * Returns the closed offer, or null if it was not PENDING any more.
 */
async function closeOffer(filter, newStatus, eventType, actorId = null) {
  return withTransactionOrAbort(async (session) => {
    const now = new Date();
    const closed = await RideOffer.findOneAndUpdate(
      { ...filter, status: OFFER_STATUS.PENDING },
      { $set: { status: newStatus, respondedAt: now } },
      { new: true, session }
    );
    if (!closed) throw new AbortTransaction(null);

    await releaseReservation(closed.driverId, closed.rideId, { session });
    await Ride.updateOne(
      { _id: closed.rideId, 'matching.currentOfferId': closed._id },
      { $set: { 'matching.currentOfferId': null, 'matching.lastProgressAt': now } },
      { session }
    );
    await RideEvent.create(
      [
        {
          rideId: closed.rideId,
          actorId,
          eventType,
          previousStatus: RIDE_STATUS.SEARCHING,
          newStatus: RIDE_STATUS.SEARCHING,
          metadata: { offerId: closed._id, driverId: closed.driverId },
        },
      ],
      { session }
    );
    return closed.toObject();
  });
}

async function rejectOffer(offerId, driverUserId) {
  const offer = await loadOwnOffer(offerId, driverUserId);
  if (offer.status === OFFER_STATUS.REJECTED) return { offer, alreadyRejected: true };
  if (offer.status !== OFFER_STATUS.PENDING) {
    throw conflict(`Offer is ${offer.status.toLowerCase()} and can no longer be rejected`, 'OFFER_NOT_PENDING');
  }

  const closed = await closeOffer({ _id: offerId, driverId: driverUserId }, OFFER_STATUS.REJECTED, RIDE_EVENT.OFFER_REJECTED, driverUserId);
  if (!closed) {
    const fresh = await RideOffer.findById(offerId).lean();
    if (fresh && fresh.status === OFFER_STATUS.REJECTED) return { offer: fresh, alreadyRejected: true };
    throw conflict(`Offer is ${fresh ? fresh.status.toLowerCase() : 'gone'} and can no longer be rejected`, 'OFFER_NOT_PENDING');
  }
  offerTimers.cancel(offerId);
  lazyMatching().kickMatching(closed.rideId);
  return { offer: closed, alreadyRejected: false };
}

/**
 * Expire an offer whose deadline has passed. The conditional update is the
 * "claim": if a timer, the recovery worker and another worker all call this
 * at once, exactly one of them gets a non-null result.
 */
async function expireOffer(offerId) {
  const closed = await closeOffer({ _id: offerId, expiresAt: { $lte: new Date() } }, OFFER_STATUS.EXPIRED, RIDE_EVENT.OFFER_EXPIRED);
  if (closed) {
    offerTimers.cancel(offerId);
    notifier.toUser(closed.driverId, 'driver:offer-expired', { offerId: String(closed._id), rideId: String(closed.rideId) });
    logger.info({ offerId: String(closed._id), rideId: String(closed.rideId) }, 'offer expired');
  }
  return closed;
}

/** Offers the driver can currently act on, with the ride details they need. */
async function listPendingOffers(driverUserId) {
  const offers = await RideOffer.find({ driverId: driverUserId, status: OFFER_STATUS.PENDING, expiresAt: { $gt: new Date() } })
    .sort({ offeredAt: -1 })
    .populate({ path: 'rideId', select: 'pickup destination estimatedFare currency vehicleType passengerCount estimate status' })
    .lean();
  return offers.map((o) => ({
    id: String(o._id),
    rideId: o.rideId ? String(o.rideId._id) : null,
    status: o.status,
    offeredAt: o.offeredAt,
    expiresAt: o.expiresAt,
    distanceToPickupMeters: o.distanceMeters,
    ride: o.rideId
      ? {
          pickup: o.rideId.pickup,
          // The destination stays hidden until the trip-start code is verified.
          destinationHidden: true,
          estimatedFare: o.rideId.estimatedFare,
          currency: o.rideId.currency,
          vehicleType: o.rideId.vehicleType,
          passengerCount: o.rideId.passengerCount || 1,
          estimate: o.rideId.estimate,
        }
      : null,
  }));
}

module.exports = { acceptOffer, rejectOffer, expireOffer, closeOffer, listPendingOffers };
