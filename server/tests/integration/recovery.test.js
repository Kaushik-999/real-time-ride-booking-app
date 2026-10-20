'use strict';

const { useDatabase } = require('../helpers/db');
const f = require('../helpers/factory');
const m = require('../helpers/matching');
const matching = require('../../src/services/matchingService');
const offerService = require('../../src/services/offerService');
const { RecoveryWorker } = require('../../src/workers/recoveryWorker');
const { RideOffer, Ride, DriverProfile, RideEvent } = require('../../src/models');

useDatabase();
afterEach(() => jest.restoreAllMocks());

const silentLogger = () => {
  const l = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  l.child = () => l;
  return l;
};
const newWorker = (logger = silentLogger()) =>
  new RecoveryWorker({ intervalMs: 20, logger, settings: { staleSearchMs: 0, reservationGraceMs: 0 } });

async function rideWithOffer(specs = [{ distanceKm: 1 }, { distanceKm: 2 }]) {
  const passenger = await f.createPassenger();
  const drivers = [];
  for (const s of specs) drivers.push(await f.createDriver(s));
  const ride = await f.createRide(passenger);
  await matching.advanceMatching(ride._id);
  return { passenger, drivers, ride, offer: await m.pendingOffer(ride._id) };
}
const expireNow = (offerId) => RideOffer.updateOne({ _id: offerId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });

describe('G. Recovery without Redis or Celery', () => {
  test('#73 an expired pending offer is discovered, expired, and matching continues', async () => {
    const { ride, offer, drivers } = await rideWithOffer();
    await expireNow(offer._id);
    const stats = await newWorker().runOnce();
    expect(stats.expiredOffers).toBe(1);
    expect((await RideOffer.findById(offer._id)).status).toBe('EXPIRED');
    expect(await m.profileOf(drivers[0])).toMatchObject({ availability: 'AVAILABLE', activeRideId: null });
    expect(String((await m.pendingOffer(ride._id)).driverId)).toBe(drivers[1].id);
  });

  test('#74 an offer accepted before expiry is not expired', async () => {
    const { ride, offer, drivers } = await rideWithOffer();
    await offerService.acceptOffer(offer._id, drivers[0].id);
    await expireNow(offer._id); // its deadline passes after acceptance
    const stats = await newWorker().runOnce();
    expect(stats.expiredOffers).toBe(0);
    expect((await RideOffer.findById(offer._id)).status).toBe('ACCEPTED');
    expect((await m.rideOf(ride._id)).status).toBe('DRIVER_ASSIGNED');
    expect((await m.profileOf(drivers[0])).availability).toBe('ON_TRIP');
  });

  test('#75 two worker instances cannot both claim the same expiration', async () => {
    const { ride, offer } = await rideWithOffer();
    await expireNow(offer._id);
    const [a, b] = await Promise.all([newWorker().runOnce(), newWorker().runOnce()]);
    expect(a.expiredOffers + b.expiredOffers).toBe(1);
    expect(await RideEvent.countDocuments({ rideId: ride._id, eventType: 'OFFER_EXPIRED' })).toBe(1);
    expect(await RideOffer.countDocuments({ rideId: ride._id, status: 'PENDING' })).toBe(1);
    expect(await RideOffer.countDocuments({ rideId: ride._id })).toBe(2);
  });

  test('#75 the claim itself: five simultaneous expireOffer calls, one winner', async () => {
    const { offer } = await rideWithOffer();
    await expireNow(offer._id);
    const results = await Promise.all(Array.from({ length: 5 }, () => offerService.expireOffer(offer._id)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  test("#76 an expired offer releases only its own driver's reservation", async () => {
    const { offer, drivers } = await rideWithOffer([{ distanceKm: 1 }]);
    const other = await f.createDriver({ distanceKm: 3 });
    const otherRide = await f.createRide(await f.createPassenger());
    await DriverProfile.updateOne({ userId: other.id }, { $set: { availability: 'RESERVED', activeRideId: otherRide._id, reservedAt: new Date() } });
    await RideOffer.create({ rideId: otherRide._id, driverId: other.user._id, ringIndex: 0, expiresAt: new Date(Date.now() + 60000) });
    await expireNow(offer._id);
    await newWorker().runOnce();
    expect(await m.profileOf(drivers[0])).toMatchObject({ availability: 'AVAILABLE', activeRideId: null });
    const o = await m.profileOf(other);
    expect(o.availability).toBe('RESERVED');
    expect(String(o.activeRideId)).toBe(String(otherRide._id));
  });

  test('#77 matching resumes after a simulated crash/restart', async () => {
    const passenger = await f.createPassenger();
    const d = await f.createDriver({ distanceKm: 4 });
    const ride = await f.createRide(passenger);
    // The process that owned matching died mid-step: lease left behind (expired),
    // ring 0 already searched, no offer created.
    await Ride.updateOne(
      { _id: ride._id },
      {
        $set: {
          'matching.ringIndex': 1,
          'matching.lockOwner': 'dead-host:123:abc:1',
          'matching.lockedUntil': new Date(Date.now() - 1000),
          'matching.lastProgressAt': new Date(Date.now() - 60000),
        },
      }
    );
    const stats = await newWorker().runOnce();
    expect(stats.resumedRides).toBe(1);
    const offer = await m.pendingOffer(ride._id);
    expect(String(offer.driverId)).toBe(d.id);
    expect(offer.ringIndex).toBe(1);
  });

  test('#77 a live lease held by another process is respected', async () => {
    const passenger = await f.createPassenger();
    await f.createDriver({ distanceKm: 1 });
    const ride = await f.createRide(passenger);
    await Ride.updateOne({ _id: ride._id }, { $set: { 'matching.lockOwner': 'other', 'matching.lockedUntil': new Date(Date.now() + 60000) } });
    await newWorker().runOnce();
    expect(await RideOffer.countDocuments({ rideId: ride._id })).toBe(0);
  });

  test('#78 abandoned reservations and stale trip locks are reconciled safely', async () => {
    const p = await f.createPassenger();
    const abandoned = await f.createDriver({ distanceKm: 20 });
    const stale = await f.createDriver({ distanceKm: 20 });
    const ride = await f.createRide(p);
    await Ride.updateOne({ _id: ride._id }, { $set: { status: 'CANCELLED', active: false } });
    // RESERVED with no offer at all; ON_TRIP for a ride that was cancelled.
    await DriverProfile.updateOne({ userId: abandoned.id }, { $set: { availability: 'RESERVED', activeRideId: ride._id, reservedAt: new Date(Date.now() - 60000) } });
    await DriverProfile.updateOne({ userId: stale.id }, { $set: { availability: 'ON_TRIP', activeRideId: ride._id } });
    // A legitimate reservation (pending offer) must be left alone.
    const legit = await rideWithOffer([{ distanceKm: 1 }]);

    const stats = await newWorker().runOnce();
    expect(stats.releasedReservations).toBe(2);
    expect(await m.profileOf(abandoned)).toMatchObject({ availability: 'AVAILABLE', activeRideId: null });
    expect(await m.profileOf(stale)).toMatchObject({ availability: 'AVAILABLE', activeRideId: null });
    expect((await m.profileOf(legit.drivers[0])).availability).toBe('RESERVED');
  });

  test('#79 a failing task is logged and does not stop the other tasks or the worker loop', async () => {
    const logger = silentLogger();
    const worker = newWorker(logger);
    const { offer } = await rideWithOffer([{ distanceKm: 1 }]);
    await expireNow(offer._id);
    const spy = jest.spyOn(RideOffer, 'find').mockImplementationOnce(() => {
      throw new Error('database hiccup');
    });
    const stats = await worker.runOnce();
    expect(stats.errors).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ task: 'expireOffers' }), 'recovery task failed');
    spy.mockRestore();

    // The periodic loop keeps running and processes the offer on a later pass.
    worker.start();
    await f.waitFor(async () => (await RideOffer.findById(offer._id)).status === 'EXPIRED', { timeout: 3000 });
    await worker.stop();
  });

  test('#80 reprocessing an already completed recovery task is idempotent', async () => {
    const { ride, offer } = await rideWithOffer([{ distanceKm: 1 }]);
    await expireNow(offer._id);
    const worker = newWorker();
    const first = await worker.runOnce();
    const eventsAfterFirst = await RideEvent.countDocuments({ rideId: ride._id });
    const second = await worker.runOnce();
    expect(first.expiredOffers).toBe(1);
    expect(second).toEqual({ expiredOffers: 0, resumedRides: 0, releasedReservations: 0, errors: 0 });
    expect(await RideEvent.countDocuments({ rideId: ride._id })).toBe(eventsAfterFirst);
    expect((await m.rideOf(ride._id)).status).toBe('NO_DRIVER_FOUND');
  });
});
