'use strict';

// These tests use REAL concurrent operations against a real MongoDB replica
// set (Promise.all over HTTP requests / service calls), not simulations.
const request = require('supertest');
const { createApp } = require('../../src/app');
const { useDatabase, clear } = require('../helpers/db');
const f = require('../helpers/factory');
const m = require('../helpers/matching');
const matching = require('../../src/services/matchingService');
const offerService = require('../../src/services/offerService');
const { releaseReservation } = require('../../src/services/driverReservation');
const { RideOffer, Ride, RideEvent, DriverProfile } = require('../../src/models');

useDatabase();
afterEach(() => jest.restoreAllMocks());
const app = createApp();

describe('E. Concurrency and data consistency', () => {
  test('#49 two passengers request simultaneously with one driver: at most one reserves them', async () => {
    for (let round = 0; round < 5; round += 1) {
      await clear();
      const driver = await f.createDriver({ distanceKm: 1 });
      const p1 = await f.createPassenger();
      const p2 = await f.createPassenger();
      const r1 = await f.createRide(p1);
      const r2 = await f.createRide(p2);
      const results = await Promise.all([matching.advanceMatching(r1._id), matching.advanceMatching(r2._id)]);

      const offers = await RideOffer.find({ driverId: driver.id }).lean();
      expect(offers).toHaveLength(1);
      const profile = await m.profileOf(driver);
      expect(profile.availability).toBe('RESERVED');
      expect(String(profile.activeRideId)).toBe(String(offers[0].rideId));
      expect(results.map((r) => r.outcome).sort()).toEqual(['no_driver_found', 'offered']);
    }
  });

  test('#50 #58 two drivers holding pending offers for the same ride accept at once: only one is assigned', async () => {
    // Normally a ride never has two PENDING offers (sequential matching plus
    // the one_pending_offer_per_ride index). Drop that index to force the
    // worst case and prove the ride-level conditional update still allows
    // exactly one winner.
    await RideOffer.collection.dropIndex('one_pending_offer_per_ride');
    try {
      for (let round = 0; round < 5; round += 1) {
        await clear();
        const passenger = await f.createPassenger();
        const a = await f.createDriver({ distanceKm: 1 });
        const b = await f.createDriver({ distanceKm: 2 });
        const ride = await f.createRide(passenger);
        const expiresAt = new Date(Date.now() + 15000);
        const offers = [];
        for (const d of [a, b]) {
          await DriverProfile.updateOne({ userId: d.id }, { $set: { availability: 'RESERVED', activeRideId: ride._id, reservedAt: new Date() } });
          offers.push(await RideOffer.create({ rideId: ride._id, driverId: d.user._id, ringIndex: 0, expiresAt }));
        }
        expect(await RideOffer.countDocuments({ rideId: ride._id, status: 'PENDING' })).toBe(2);

        const [resA, resB] = await Promise.all([
          request(app).post(`/api/offers/${offers[0]._id}/accept`).set(f.auth(a.token)).send({}),
          request(app).post(`/api/offers/${offers[1]._id}/accept`).set(f.auth(b.token)).send({}),
        ]);
        expect([resA.status, resB.status].sort()).toEqual([200, 409]);
        const winner = resA.status === 200 ? a : b;
        const loser = winner === a ? b : a;
        const r = await m.rideOf(ride._id);
        expect(r.status).toBe('DRIVER_ASSIGNED');
        expect(String(r.driverId)).toBe(winner.id);
        expect(await RideOffer.countDocuments({ rideId: ride._id, status: 'ACCEPTED' })).toBe(1);
        expect(await RideEvent.countDocuments({ rideId: ride._id, eventType: 'DRIVER_ASSIGNED' })).toBe(1);
        expect((await m.profileOf(winner)).availability).toBe('ON_TRIP');
        // The loser's transaction rolled back completely: still RESERVED (the
        // recovery worker reconciles it), never ON_TRIP.
        expect((await m.profileOf(loser)).availability).toBe('RESERVED');
      }
    } finally {
      await clear();
      await RideOffer.syncIndexes();
    }
  });

  test('#51 ten simultaneous accepts of the same offer produce exactly one assignment', async () => {
    const passenger = await f.createPassenger();
    const d = await f.createDriver({ distanceKm: 1 });
    const ride = await f.createRide(passenger);
    await matching.advanceMatching(ride._id);
    const offer = await m.pendingOffer(ride._id);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => request(app).post(`/api/offers/${offer._id}/accept`).set(f.auth(d.token)).send({}))
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.body.data.alreadyAccepted === false)).toHaveLength(1);
    expect(await RideEvent.countDocuments({ rideId: ride._id, eventType: 'DRIVER_ASSIGNED' })).toBe(1);
    const prof = await m.profileOf(d);
    expect(prof).toMatchObject({ availability: 'ON_TRIP' });
  });

  test('#53 cancellation racing acceptance never leaves a cancelled ride with an active assignment', async () => {
    for (let round = 0; round < 6; round += 1) {
      await clear();
      const passenger = await f.createPassenger();
      const d = await f.createDriver({ distanceKm: 1 });
      const ride = await f.createRide(passenger);
      await matching.advanceMatching(ride._id);
      const offer = await m.pendingOffer(ride._id);
      await Promise.all([
        request(app).post(`/api/offers/${offer._id}/accept`).set(f.auth(d.token)).send({}),
        request(app).post(`/api/rides/${ride._id}/cancel`).set(f.auth(passenger.token)).send({}),
      ]);
      const r = await m.rideOf(ride._id);
      const prof = await m.profileOf(d);
      // Cancellation is allowed from both SEARCHING and DRIVER_ASSIGNED, so it always wins eventually.
      expect(r.status).toBe('CANCELLED');
      expect(prof.activeRideId).toBeNull();
      expect(prof.availability).toBe('AVAILABLE');
      expect(await RideOffer.countDocuments({ rideId: ride._id, status: 'PENDING' })).toBe(0);
    }
  });

  test('#54 a failed transaction leaves no partially committed assignment', async () => {
    const passenger = await f.createPassenger();
    const d = await f.createDriver({ distanceKm: 1 });
    const ride = await f.createRide(passenger);
    await matching.advanceMatching(ride._id);
    const offer = await m.pendingOffer(ride._id);
    // Fail the LAST write of the accept transaction.
    jest.spyOn(RideEvent, 'create').mockRejectedValueOnce(new Error('simulated crash'));
    await expect(offerService.acceptOffer(offer._id, d.id)).rejects.toThrow('simulated crash');
    expect((await RideOffer.findById(offer._id)).status).toBe('PENDING');
    const r = await m.rideOf(ride._id);
    expect(r.status).toBe('SEARCHING');
    expect(r.driverId).toBeNull();
    expect((await m.profileOf(d)).availability).toBe('RESERVED');
  });

  test('#56 a failed reservation/offer step does not leave an orphaned driver reservation', async () => {
    const passenger = await f.createPassenger();
    const d = await f.createDriver({ distanceKm: 1 });
    const ride = await f.createRide(passenger);
    jest.spyOn(RideOffer, 'create').mockRejectedValueOnce(new Error('simulated offer failure'));
    await expect(matching.advanceMatching(ride._id)).rejects.toThrow('simulated offer failure');
    expect(await m.profileOf(d)).toMatchObject({ availability: 'AVAILABLE', activeRideId: null });
    const r = await m.rideOf(ride._id);
    expect(r.matching.lockOwner).toBeNull(); // lease released
    expect(r.matching.attemptedDriverIds).toHaveLength(0); // the whole step rolled back
    jest.restoreAllMocks();
    const retry = await matching.advanceMatching(ride._id);
    expect(retry.outcome).toBe('offered');
  });

  test('#57 releasing a stale reservation cannot free a driver now held by another ride', async () => {
    const p1 = await f.createPassenger();
    const p2 = await f.createPassenger();
    const d = await f.createDriver({ distanceKm: 1 });
    const oldRide = await f.createRide(p1);
    const newRide = await f.createRide(p2);
    await DriverProfile.updateOne({ userId: d.id }, { $set: { availability: 'RESERVED', activeRideId: newRide._id } });
    expect(await releaseReservation(d.id, oldRide._id)).toBe(false);
    const prof = await m.profileOf(d);
    expect(prof.availability).toBe('RESERVED');
    expect(String(prof.activeRideId)).toBe(String(newRide._id));
  });

  test('concurrent advanceMatching calls for one ride send exactly one offer (lease)', async () => {
    const passenger = await f.createPassenger();
    for (const km of [1, 2, 3]) await f.createDriver({ distanceKm: km - 0.5 });
    const ride = await f.createRide(passenger);
    await Promise.all(Array.from({ length: 8 }, () => matching.advanceMatching(ride._id)));
    expect(await RideOffer.countDocuments({ rideId: ride._id })).toBe(1);
    expect((await Ride.findById(ride._id)).matching.lockOwner).toBeNull();
  });

  test('many rides competing for few drivers: no driver is ever double-reserved', async () => {
    const drivers = [];
    for (let i = 0; i < 3; i += 1) drivers.push(await f.createDriver({ distanceKm: 0.5 + i }));
    const rides = [];
    for (let i = 0; i < 8; i += 1) rides.push(await f.createRide(await f.createPassenger()));
    await Promise.all(rides.map((r) => matching.advanceMatching(r._id)));
    const pending = await RideOffer.find({ status: 'PENDING' }).lean();
    expect(pending).toHaveLength(3);
    expect(new Set(pending.map((o) => String(o.driverId))).size).toBe(3);
    for (const d of drivers) {
      const prof = await m.profileOf(d);
      const offer = pending.find((o) => String(o.driverId) === d.id);
      expect(String(prof.activeRideId)).toBe(String(offer.rideId));
    }
  });
});
