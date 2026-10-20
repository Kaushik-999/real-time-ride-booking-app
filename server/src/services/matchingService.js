'use strict';

/**
 * Progressive-radius, sequential driver matching.
 *
 * The search space around the pickup is split into NON-OVERLAPPING rings:
 *   ring 0: 0-3 km, ring 1: (3-6] km, ring 2: (6-9] km, ring 3: (9-12] km
 * Inside a ring, eligible drivers are tried nearest-first, ONE AT A TIME:
 * reserve -> offer -> wait for accept / reject / timeout -> next.
 *
 * Matching is event-driven rather than one long-running loop:
 *   - `runMatchingStep` does a short burst of work: find the next candidate,
 *     reserve them and create a PENDING offer, then return. It never waits
 *     for the driver.
 *   - A driver's rejection, an offer timeout, or the recovery worker calls
 *     `advanceMatching` again, which runs the next step.
 * All progress (current ring, drivers already tried) lives on the Ride
 * document, so any process can pick up where another left off.
 *
 * `advanceMatching` holds a short lease on the ride so two processes never
 * run a step for the same ride at the same time.
 */
const crypto = require('crypto');
const os = require('os');
const config = require('../config');
const logger = require('../utils/logger');
const notifier = require('../sockets/notifier');
const offerTimers = require('./offerTimers');
const { Ride, RideOffer, RideEvent, DriverLocation, DriverProfile, User } = require('../models');
const { RIDE_STATUS, OFFER_STATUS, DRIVER_AVAILABILITY, APPROVAL_STATUS, RIDE_EVENT } = require('../utils/constants');
const { withTransactionOrAbort, AbortTransaction } = require('../utils/transaction');
const { reserveDriver } = require('./driverReservation');
const { fromPoint } = require('../utils/geo');
const { rideEligibilityFilter } = require('./driverEligibility');

const PROCESS_ID = `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`;
let invocation = 0;

/** Ring boundaries in metres, built from configuration. */
function buildRings(cfg = config.matching) {
  const rings = [];
  let min = 0;
  let max = cfg.initialRadiusKm;
  while (min < cfg.maxRadiusKm - 1e-9) {
    const capped = Math.min(max, cfg.maxRadiusKm);
    rings.push({ index: rings.length, minMeters: Math.round(min * 1000), maxMeters: Math.round(capped * 1000) });
    min = capped;
    max = capped + cfg.radiusStepKm;
  }
  return rings;
}

/**
 * Eligible drivers inside one ring, nearest first, excluding drivers already
 * tried for this ride. Returns at most `candidatePageSize` drivers; the caller
 * keeps calling until the ring is empty, so nobody is silently skipped.
 *
 * $geoNear is MongoDB's aggregation form of $near: it sorts by distance and
 * supports minDistance/maxDistance (metres for GeoJSON points). We use the
 * aggregation form so we can join DriverProfile and filter on eligibility
 * BEFORE limiting the page size.
 */
async function findCandidates(ride, ring, excludeDriverIds, cfg = config.matching) {
  const freshSince = new Date(Date.now() - cfg.locationFreshnessMs);
  const pipeline = [
    {
      $geoNear: {
        near: ride.pickup.location,
        key: 'location',
        distanceField: 'distanceMeters',
        spherical: true,
        minDistance: ring.minMeters,
        maxDistance: ring.maxMeters,
        query: { updatedAt: { $gte: freshSince }, driverId: { $nin: excludeDriverIds } },
      },
    },
  ];
  // minDistance is inclusive. Rings after the first are (min, max] so a
  // driver sitting exactly on a boundary belongs to exactly one ring.
  if (ring.index > 0) pipeline.push({ $match: { distanceMeters: { $gt: ring.minMeters } } });
  pipeline.push(
    { $lookup: { from: DriverProfile.collection.name, localField: 'driverId', foreignField: 'userId', as: 'profile' } },
    { $unwind: '$profile' },
    {
      $match: {
        'profile.approvalStatus': APPROVAL_STATUS.APPROVED,
        'profile.availability': DRIVER_AVAILABILITY.AVAILABLE,
        'profile.activeRideId': null,
        ...rideEligibilityFilter(ride, 'profile.'),
      },
    },
    { $limit: cfg.candidatePageSize },
    { $project: { driverId: 1, distanceMeters: 1 } }
  );
  return DriverLocation.aggregate(pipeline);
}

/**
 * Reserve `candidate` and create their PENDING offer in one transaction.
 * Returns { offer } on success, { skipped: true } if the driver was no
 * longer available, or { notSearching: true } if the ride left SEARCHING.
 */
async function reserveAndOffer(rideId, candidate, ring, cfg = config.matching) {
  return withTransactionOrAbort(async (session) => {
    const now = new Date();
    // Record the attempt first (and confirm the ride is still searching).
    const ride = await Ride.findOneAndUpdate(
      { _id: rideId, status: RIDE_STATUS.SEARCHING },
      {
        $addToSet: { 'matching.attemptedDriverIds': candidate.driverId },
        $set: { 'matching.lastProgressAt': now, matchingRadiusKm: ring.maxMeters / 1000 },
      },
      { new: true, session }
    );
    if (!ride) throw new AbortTransaction({ notSearching: true });

    const profile = await reserveDriver(candidate.driverId, rideId, { session, now, eligibility: rideEligibilityFilter(ride) });
    // Lost the race (driver went offline / got reserved elsewhere): keep the
    // "attempted" mark so we move on, and try the next candidate.
    if (!profile) return { skipped: true };

    const [offer] = await RideOffer.create(
      [
        {
          rideId,
          driverId: candidate.driverId,
          ringIndex: ring.index,
          distanceMeters: Math.round(candidate.distanceMeters),
          offeredAt: now,
          expiresAt: new Date(now.getTime() + cfg.offerTimeoutMs),
        },
      ],
      { session }
    );
    await Ride.updateOne({ _id: rideId }, { $set: { 'matching.currentOfferId': offer._id } }, { session });
    await RideEvent.create(
      [
        {
          rideId,
          eventType: RIDE_EVENT.OFFER_SENT,
          previousStatus: RIDE_STATUS.SEARCHING,
          newStatus: RIDE_STATUS.SEARCHING,
          metadata: { offerId: offer._id, driverId: candidate.driverId, ringIndex: ring.index, distanceMeters: offer.distanceMeters },
        },
      ],
      { session }
    );
    return { offer, ride };
  });
}

async function markNoDriverFound(rideId, rings) {
  const lastRing = rings[rings.length - 1];
  const ride = await withTransactionOrAbort(async (session) => {
    const current = await Ride.findById(rideId).select('driverPreference').session(session).lean();
    // With a strict preference we say so explicitly instead of quietly
    // dropping the restriction and assigning someone else.
    const reason = current && current.driverPreference === 'FEMALE_ONLY' ? 'PREFERENCE_UNAVAILABLE' : 'NO_ELIGIBLE_DRIVER';
    const updated = await Ride.findOneAndUpdate(
      { _id: rideId, status: RIDE_STATUS.SEARCHING },
      { $set: { status: RIDE_STATUS.NO_DRIVER_FOUND, active: false, noDriverReason: reason, 'matching.currentOfferId': null } },
      { new: true, session }
    );
    if (!updated) throw new AbortTransaction(null);
    await RideEvent.create(
      [
        {
          rideId,
          eventType: RIDE_EVENT.NO_DRIVER_FOUND,
          previousStatus: RIDE_STATUS.SEARCHING,
          newStatus: RIDE_STATUS.NO_DRIVER_FOUND,
          metadata: { maxRadiusKm: lastRing ? lastRing.maxMeters / 1000 : 0, attempted: updated.matching.attemptedDriverIds.length, reason },
        },
      ],
      { session }
    );
    return updated;
  });
  if (ride) notifier.rideStatus(ride, 'ride:no-driver-found', { reason: ride.noDriverReason });
  return ride;
}

async function moveToRing(rideId, fromIndex, toIndex, rings) {
  const ring = rings[toIndex];
  const updated = await Ride.findOneAndUpdate(
    { _id: rideId, status: RIDE_STATUS.SEARCHING, 'matching.ringIndex': fromIndex },
    { $set: { 'matching.ringIndex': toIndex, 'matching.lastProgressAt': new Date(), matchingRadiusKm: ring ? ring.maxMeters / 1000 : null } },
    { new: true }
  );
  if (updated && ring) {
    await RideEvent.create({
      rideId,
      eventType: RIDE_EVENT.RADIUS_EXPANDED,
      previousStatus: RIDE_STATUS.SEARCHING,
      newStatus: RIDE_STATUS.SEARCHING,
      metadata: { ringIndex: toIndex, minKm: ring.minMeters / 1000, maxKm: ring.maxMeters / 1000 },
    });
    notifier.toUser(updated.passengerId, 'ride:searching', {
      rideId: String(rideId),
      status: RIDE_STATUS.SEARCHING,
      radiusKm: ring.maxMeters / 1000,
    });
  }
  return Boolean(updated);
}

async function notifyOffer(offer, ride) {
  const passenger = await User.findById(ride.passengerId).select('name').lean();
  notifier.toUser(offer.driverId, 'driver:offer', {
    offerId: String(offer._id),
    rideId: String(ride._id),
    expiresAt: offer.expiresAt,
    distanceToPickupMeters: offer.distanceMeters,
    pickup: { address: ride.pickup.address, ...fromPoint(ride.pickup.location) },
    // Destination is withheld from drivers until pickup is verified with the
    // trip-start code; only the approximate trip length is shared.
    destinationHidden: true,
    tripDistanceMeters: ride.estimate ? ride.estimate.distanceMeters : null,
    estimatedFare: ride.estimatedFare,
    currency: ride.currency,
    vehicleType: ride.vehicleType,
    passengerCount: ride.passengerCount || 1,
    passengerName: passenger ? passenger.name : null,
  });
}

/**
 * One matching step. Assumes the caller holds the ride's matching lease.
 * Outcomes: 'offered' | 'waiting' | 'no_driver_found' | 'not_searching'.
 */
async function runMatchingStep(rideId, cfg = config.matching) {
  const rings = buildRings(cfg);
  let ride = await Ride.findById(rideId).lean();
  if (!ride || ride.status !== RIDE_STATUS.SEARCHING) return { outcome: 'not_searching' };

  // Sequential: never send a second offer while one is still open.
  const pending = await RideOffer.findOne({ rideId, status: OFFER_STATUS.PENDING }).lean();
  if (pending) {
    if (pending.expiresAt > new Date()) return { outcome: 'waiting', offerId: pending._id };
    // Its timer was lost (e.g. restart). Expire it here, then carry on.
    const { expireOffer } = require('./offerService');
    await expireOffer(pending._id);
    ride = await Ride.findById(rideId).lean();
    if (!ride || ride.status !== RIDE_STATUS.SEARCHING) return { outcome: 'not_searching' };
  }

  // ObjectIds (not strings): aggregation pipelines are not cast by Mongoose.
  const attempted = [...ride.matching.attemptedDriverIds];
  let ringIndex = ride.matching.ringIndex;

  while (ringIndex < rings.length) {
    const ring = rings[ringIndex];
    const candidates = await findCandidates(ride, ring, attempted, cfg);

    if (candidates.length === 0) {
      // Nobody (left) in this ring: expand immediately, no timeout needed.
      const moved = await moveToRing(rideId, ringIndex, ringIndex + 1, rings);
      if (!moved) return { outcome: 'not_searching' };
      ringIndex += 1;
      continue;
    }

    for (const candidate of candidates) {
      attempted.push(candidate.driverId);
      const result = await reserveAndOffer(rideId, candidate, ring, cfg);
      if (result.notSearching) return { outcome: 'not_searching' };
      if (result.skipped) {
        logger.debug({ rideId: String(rideId), driverId: String(candidate.driverId) }, 'candidate no longer available');
        continue;
      }
      // Transaction committed: now (and only now) notify the driver.
      offerTimers.schedule(result.offer, handleOfferTimeout);
      await notifyOffer(result.offer, result.ride);
      logger.info(
        { rideId: String(rideId), offerId: String(result.offer._id), driverId: String(candidate.driverId), ring: ring.index },
        'offer sent'
      );
      return { outcome: 'offered', offer: result.offer };
    }
    // Every candidate on this page was taken; loop re-queries the same ring
    // (attempted drivers are excluded, so the next page comes back).
  }

  const final = await markNoDriverFound(rideId, rings);
  return { outcome: final ? 'no_driver_found' : 'not_searching' };
}

async function claimLease(rideId, owner, cfg) {
  const now = new Date();
  return Ride.findOneAndUpdate(
    {
      _id: rideId,
      status: RIDE_STATUS.SEARCHING,
      $or: [{ 'matching.lockedUntil': null }, { 'matching.lockedUntil': { $lte: now } }],
    },
    { $set: { 'matching.lockOwner': owner, 'matching.lockedUntil': new Date(now.getTime() + cfg.leaseMs) } },
    { new: true, projection: { matching: 1, status: 1 } }
  ).lean();
}

/**
 * Run matching for a ride under a lease. Safe to call from anywhere, any
 * number of times, in any process: if another caller holds the lease we
 * "kick" the ride and the holder re-runs the step before releasing.
 */
async function advanceMatching(rideId, cfg = config.matching) {
  invocation += 1;
  const owner = `${PROCESS_ID}:${invocation}`;

  let lease = await claimLease(rideId, owner, cfg);
  if (!lease) {
    const kicked = await Ride.updateOne({ _id: rideId, status: RIDE_STATUS.SEARCHING }, { $inc: { 'matching.kicks': 1 } });
    if (kicked.matchedCount === 0) return { outcome: 'not_searching' };
    // The holder may have released between our two calls: try once more.
    lease = await claimLease(rideId, owner, cfg);
    if (!lease) return { outcome: 'deferred' };
  }

  let kicks = lease.matching.kicks;
  let result = { outcome: 'not_searching' };
  try {
    for (let round = 0; round < 20; round += 1) {
      result = await runMatchingStep(rideId, cfg);
      // Release only if nobody kicked us meanwhile.
      const released = await Ride.updateOne(
        { _id: rideId, 'matching.lockOwner': owner, 'matching.kicks': kicks },
        { $set: { 'matching.lockOwner': null, 'matching.lockedUntil': null } }
      );
      if (released.modifiedCount === 1) return result;
      const current = await Ride.findById(rideId, { matching: 1 }).lean();
      if (!current || current.matching.lockOwner !== owner) return result; // lease expired and was taken over
      kicks = current.matching.kicks;
      await Ride.updateOne(
        { _id: rideId, 'matching.lockOwner': owner },
        { $set: { 'matching.lockedUntil': new Date(Date.now() + cfg.leaseMs) } }
      );
    }
    return result;
  } catch (err) {
    await Ride.updateOne(
      { _id: rideId, 'matching.lockOwner': owner },
      { $set: { 'matching.lockOwner': null, 'matching.lockedUntil': null } }
    ).catch(() => {});
    throw err;
  }
}

/** Fire-and-forget trigger used by API handlers (disabled in some tests). */
function kickMatching(rideId) {
  if (!config.matching.autoStart) return;
  setImmediate(() => {
    advanceMatching(rideId).catch((err) => logger.error({ err, rideId: String(rideId) }, 'matching step failed'));
  });
}

/** Called when an offer's in-memory timer fires. */
async function handleOfferTimeout(offerId) {
  const { expireOffer } = require('./offerService');
  const offer = await expireOffer(offerId);
  if (offer) await advanceMatching(offer.rideId);
  return offer;
}

module.exports = {
  buildRings,
  findCandidates,
  runMatchingStep,
  advanceMatching,
  kickMatching,
  handleOfferTimeout,
  PROCESS_ID,
};
