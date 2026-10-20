'use strict';

const config = require('../../src/config');
const { useDatabase } = require('../helpers/db');
const f = require('../helpers/factory');
const m = require('../helpers/matching');
const matching = require('../../src/services/matchingService');
const offerService = require('../../src/services/offerService');
const { DriverProfile, RideOffer } = require('../../src/models');

useDatabase();
afterEach(() => jest.restoreAllMocks());

const advance = (rideId, cfg) => matching.advanceMatching(rideId, cfg);

async function setup(driverSpecs, rideOverrides) {
  const passenger = await f.createPassenger();
  const drivers = [];
  for (const spec of driverSpecs) drivers.push(await f.createDriver(spec));
  const ride = await f.createRide(passenger, rideOverrides);
  return { passenger, drivers, ride };
}

/**
 * Make the reservation of the given drivers fail as if they went offline
 * between the geospatial search and the reservation attempt.
 */
function goOfflineJustBeforeReservation(drivers) {
  const targets = new Set(drivers.map((d) => d.id));
  const original = DriverProfile.findOneAndUpdate.bind(DriverProfile);
  return jest.spyOn(DriverProfile, 'findOneAndUpdate').mockImplementation(function (filter, ...rest) {
    const id = filter && filter.userId && String(filter.userId);
    if (filter && filter.availability === 'AVAILABLE' && targets.has(id)) {
      targets.delete(id);
      return DriverProfile.updateOne({ userId: id }, { $set: { availability: 'OFFLINE' } }).then(() => original(filter, ...rest));
    }
    return original(filter, ...rest);
  });
}

describe('C. Progressive-radius matching', () => {
  test('#21 driver within 2 km accepts: assigned without searching farther', async () => {
    const { ride, drivers } = await setup([{ distanceKm: 2 }, { distanceKm: 5 }]);
    const r = await advance(ride._id);
    expect(r.outcome).toBe('offered');
    const offer = await m.pendingOffer(ride._id);
    expect(String(offer.driverId)).toBe(drivers[0].id);
    expect(offer.ringIndex).toBe(0);
    await offerService.acceptOffer(offer._id, drivers[0].id);
    const after = await m.rideOf(ride._id);
    expect(after.status).toBe('DRIVER_ASSIGNED');
    expect(after.matching.ringIndex).toBe(0);
    expect(await m.offeredDriverIds(ride._id)).toEqual([drivers[0].id]);
    expect(await m.eventsOf(ride._id, 'RADIUS_EXPANDED')).toHaveLength(0);
  });

  test('#22 #35 no eligible driver within 3 km: expands to 6 km immediately (no timeout wait)', async () => {
    const { ride, drivers } = await setup([{ distanceKm: 5 }]);
    const started = Date.now();
    const r = await advance(ride._id);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(r.outcome).toBe('offered');
    expect(String(r.offer.driverId)).toBe(drivers[0].id);
    expect(r.offer.ringIndex).toBe(1);
    expect((await m.rideOf(ride._id)).matchingRadiusKm).toBe(6);
    expect(await RideOffer.countDocuments({ rideId: ride._id, status: 'EXPIRED' })).toBe(0);
    const expanded = await m.eventsOf(ride._id, 'RADIUS_EXPANDED');
    expect(expanded.map((e) => e.metadata.maxKm)).toEqual([6]);
  });

  test('#23 all 3 km drivers reject or time out: continues into the 3-6 km ring, nearest first', async () => {
    const { ride, drivers } = await setup([{ distanceKm: 2 }, { distanceKm: 1 }, { distanceKm: 4 }]);
    await advance(ride._id);
    expect(String((await m.pendingOffer(ride._id)).driverId)).toBe(drivers[1].id); // 1 km first
    await m.rejectCurrent(ride._id);
    expect(String((await m.pendingOffer(ride._id)).driverId)).toBe(drivers[0].id); // then 2 km
    await m.timeOut(ride._id);
    const third = await m.pendingOffer(ride._id);
    expect(String(third.driverId)).toBe(drivers[2].id);
    expect(third.ringIndex).toBe(1);
    const statuses = (await RideOffer.find({ rideId: ride._id }).sort({ offeredAt: 1 }).lean()).map((o) => o.status);
    expect(statuses).toEqual(['REJECTED', 'EXPIRED', 'PENDING']);
  });

  test('#24 nothing within 6 km: expands to 9 km', async () => {
    const { ride } = await setup([{ distanceKm: 8 }]);
    const r = await advance(ride._id);
    expect(r.offer.ringIndex).toBe(2);
  });

  test('#25 nothing within 9 km: expands to 12 km', async () => {
    const { ride } = await setup([{ distanceKm: 11 }]);
    const r = await advance(ride._id);
    expect(r.offer.ringIndex).toBe(3);
    expect((await m.rideOf(ride._id)).matchingRadiusKm).toBe(12);
  });

  test('#26 acceptance in the 6-9 km ring stops the search', async () => {
    const { ride, drivers } = await setup([{ distanceKm: 7 }, { distanceKm: 10 }]);
    const r = await advance(ride._id);
    await offerService.acceptOffer(r.offer._id, drivers[0].id);
    expect((await advance(ride._id)).outcome).toBe('not_searching');
    expect(await m.offeredDriverIds(ride._id)).toEqual([drivers[0].id]);
    expect((await m.profileOf(drivers[1])).availability).toBe('AVAILABLE');
  });

  test('#27 a driver from an earlier ring is never offered the same ride again', async () => {
    const { ride, drivers } = await setup([{ distanceKm: 1 }]);
    await advance(ride._id);
    const r = await m.rejectCurrent(ride._id);
    expect(r.outcome).toBe('no_driver_found');
    expect(await m.offeredDriverIds(ride._id)).toEqual([drivers[0].id]);
    // driver is back to AVAILABLE and close by, yet a re-run never re-offers
    expect((await m.profileOf(drivers[0])).availability).toBe('AVAILABLE');
  });

  test('#28 a driver exactly on a ring boundary belongs to exactly one ring', async () => {
    const { ride, drivers } = await setup([{ distanceKm: 3 }]);
    const rings = matching.buildRings(config.matching);
    const lean = await m.rideOf(ride._id);
    const inRing0 = await matching.findCandidates(lean, rings[0], []);
    const inRing1 = await matching.findCandidates(lean, rings[1], []);
    expect(inRing0.length + inRing1.length).toBe(1);
    await advance(ride._id);
    await m.rejectCurrent(ride._id);
    expect(await m.offeredDriverIds(ride._id)).toEqual([drivers[0].id]);
    expect((await m.rideOf(ride._id)).status).toBe('NO_DRIVER_FOUND');
  });

  test('#29 #30 offline, reserved and on-trip drivers are not offered', async () => {
    const { ride, drivers } = await setup([
      { distanceKm: 0.5, availability: 'OFFLINE' },
      { distanceKm: 0.6, availability: 'RESERVED' },
      { distanceKm: 0.7, availability: 'ON_TRIP' },
      { distanceKm: 2.5 },
    ]);
    const r = await advance(ride._id);
    expect(String(r.offer.driverId)).toBe(drivers[3].id);
  });

  test('#31 a driver with a stale location is excluded', async () => {
    const { ride, drivers } = await setup([{ distanceKm: 0.5, locationAgeMs: 60000 }, { distanceKm: 2 }]);
    const r = await advance(ride._id);
    expect(String(r.offer.driverId)).toBe(drivers[1].id);
  });

  test('#32 #33 a driver outside 12 km is never offered; exhausting every ring gives NO_DRIVER_FOUND', async () => {
    const { ride, drivers } = await setup([{ distanceKm: 1 }, { distanceKm: 4 }, { distanceKm: 7 }, { distanceKm: 10 }, { distanceKm: 13 }]);
    await advance(ride._id);
    await m.rejectCurrent(ride._id);
    await m.timeOut(ride._id);
    await m.rejectCurrent(ride._id);
    const last = await m.rejectCurrent(ride._id);
    expect(last.outcome).toBe('no_driver_found');
    expect(await m.offeredDriverIds(ride._id)).toEqual(drivers.slice(0, 4).map((d) => d.id));
    const final = await m.rideOf(ride._id);
    expect(final.status).toBe('NO_DRIVER_FOUND');
    expect(final.active).toBe(false);
    expect(final.driverId).toBeNull();
    expect(await m.eventsOf(ride._id, 'NO_DRIVER_FOUND')).toHaveLength(1);
    for (const d of drivers) expect((await m.profileOf(d)).availability).toBe('AVAILABLE');
  });

  test('#34 closest candidate becomes unavailable mid-matching: next candidate is tried', async () => {
    const { ride, drivers } = await setup([{ distanceKm: 1 }, { distanceKm: 2 }]);
    goOfflineJustBeforeReservation([drivers[0]]);
    const r = await advance(ride._id);
    expect(r.outcome).toBe('offered');
    expect(String(r.offer.driverId)).toBe(drivers[1].id);
    const p0 = await m.profileOf(drivers[0]);
    expect(p0).toMatchObject({ availability: 'OFFLINE', activeRideId: null });
    const lean = await m.rideOf(ride._id);
    expect(lean.matching.attemptedDriverIds.map(String)).toEqual([drivers[0].id, drivers[1].id]);
  });

  test('#36 vehicle type filter excludes incompatible drivers', async () => {
    const { ride, drivers } = await setup([{ distanceKm: 0.5, vehicleType: 'BIKE' }, { distanceKm: 1.5, vehicleType: 'AUTO' }, { distanceKm: 2 }]);
    const r = await advance(ride._id);
    expect(String(r.offer.driverId)).toBe(drivers[2].id);
  });

  test('#37 candidate pagination does not silently skip eligible drivers', async () => {
    const cfg = { ...config.matching, candidatePageSize: 2 };
    const specs = [0.4, 0.8, 1.2, 1.6, 2.0, 2.4].map((distanceKm) => ({ distanceKm }));
    const { ride, drivers } = await setup(specs);
    // The first three (more than one page) vanish right before reservation.
    goOfflineJustBeforeReservation(drivers.slice(0, 3));
    let r = await advance(ride._id, cfg);
    expect(String(r.offer.driverId)).toBe(drivers[3].id);
    jest.restoreAllMocks();
    for (let i = 4; i < drivers.length; i += 1) {
      const offer = await m.pendingOffer(ride._id);
      await offerService.rejectOffer(offer._id, offer.driverId);
      r = await advance(ride._id, cfg);
      expect(String(r.offer.driverId)).toBe(drivers[i].id);
    }
    expect(await m.offeredDriverIds(ride._id)).toEqual(drivers.slice(3).map((d) => d.id));
    expect((await m.rideOf(ride._id)).matching.attemptedDriverIds).toHaveLength(6);
  });

  test('#10 an unapproved driver is never offered a ride', async () => {
    const { ride } = await setup([{ distanceKm: 0.5, approved: false }]);
    const r = await advance(ride._id);
    expect(r.outcome).toBe('no_driver_found');
    expect(await RideOffer.countDocuments({ rideId: ride._id })).toBe(0);
  });

  test('sequential: only one pending offer at a time, and re-running while waiting is a no-op', async () => {
    const { ride } = await setup([{ distanceKm: 1 }, { distanceKm: 2 }]);
    await advance(ride._id);
    const again = await advance(ride._id);
    expect(again.outcome).toBe('waiting');
    expect(await RideOffer.countDocuments({ rideId: ride._id })).toBe(1);
  });

  test('every matching step is recorded as a ride event', async () => {
    const { ride } = await setup([{ distanceKm: 1 }, { distanceKm: 5 }]);
    await advance(ride._id);
    await m.rejectCurrent(ride._id);
    const types = (await m.eventsOf(ride._id)).map((e) => e.eventType);
    expect(types).toEqual(['RIDE_REQUESTED', 'OFFER_SENT', 'OFFER_REJECTED', 'RADIUS_EXPANDED', 'OFFER_SENT']);
  });
});
