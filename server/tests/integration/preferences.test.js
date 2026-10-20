'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { useDatabase } = require('../helpers/db');
const f = require('../helpers/factory');
const m = require('../helpers/matching');
const matching = require('../../src/services/matchingService');
const offerService = require('../../src/services/offerService');
const { RideOffer, DriverProfile } = require('../../src/models');

useDatabase();
const app = createApp();
const api = () => request(app);

describe("Women's driver-selection preference", () => {
  test('FEMALE_ONLY is offered only to verified drivers, still nearest-first through the rings', async () => {
    await f.createDriver({ distanceKm: 0.5 }); // not in programme
    await f.createDriver({ distanceKm: 1.0, femaleProgram: 'PENDING' }); // requested, not verified
    await f.createDriver({ distanceKm: 2.0, femaleProgram: 'REJECTED' });
    const verifiedFar = await f.createDriver({ distanceKm: 7.5, femaleProgram: 'VERIFIED' });
    const verifiedNear = await f.createDriver({ distanceKm: 4.5, femaleProgram: 'VERIFIED' });
    const ride = await f.createRide(await f.createPassenger(), { driverPreference: 'FEMALE_ONLY' });

    const first = await matching.advanceMatching(ride._id);
    expect(String(first.offer.driverId)).toBe(verifiedNear.id);
    expect(first.offer.ringIndex).toBe(1); // 0-3 km had no eligible driver, so the radius expanded
    await m.rejectCurrent(ride._id);
    const second = await m.pendingOffer(ride._id);
    expect(String(second.driverId)).toBe(verifiedFar.id);
    expect(second.ringIndex).toBe(2);
    expect(await m.offeredDriverIds(ride._id)).toEqual([verifiedNear.id, verifiedFar.id]);
  });

  test('when no verified driver accepts, the restriction is NOT silently dropped', async () => {
    const anyDriver = await f.createDriver({ distanceKm: 0.5 });
    const ride = await f.createRide(await f.createPassenger(), { driverPreference: 'FEMALE_ONLY' });
    const r = await matching.advanceMatching(ride._id);
    expect(r.outcome).toBe('no_driver_found');
    const final = await m.rideOf(ride._id);
    expect(final).toMatchObject({ status: 'NO_DRIVER_FOUND', driverPreference: 'FEMALE_ONLY', noDriverReason: 'PREFERENCE_UNAVAILABLE', driverId: null });
    expect(await RideOffer.countDocuments({ driverId: anyDriver.id })).toBe(0);
    const ev = await m.eventsOf(ride._id, 'NO_DRIVER_FOUND');
    expect(ev[0].metadata.reason).toBe('PREFERENCE_UNAVAILABLE');
  });

  test('the passenger can explicitly choose a different preference by booking again', async () => {
    const p = await f.createPassenger();
    const anyDriver = await f.createDriver({ distanceKm: 0.5 });
    const strict = await api().post('/api/rides').set(f.auth(p.token)).send(f.bookingBody({ driverPreference: 'FEMALE_ONLY' }));
    await matching.advanceMatching(strict.body.data.ride.id);
    const view = await api().get(`/api/rides/${strict.body.data.ride.id}`).set(f.auth(p.token));
    expect(view.body.data.ride).toMatchObject({ status: 'NO_DRIVER_FOUND', noDriverReason: 'PREFERENCE_UNAVAILABLE', driverPreference: 'FEMALE_ONLY' });
    const relaxed = await api().post('/api/rides').set(f.auth(p.token)).send(f.bookingBody({ driverPreference: 'ANY' }));
    expect(relaxed.status).toBe(201);
    const r = await matching.advanceMatching(relaxed.body.data.ride.id);
    expect(String(r.offer.driverId)).toBe(anyDriver.id);
  });

  test('an unverified driver cannot accept a FEMALE_ONLY ride even with a forged offer', async () => {
    const d = await f.createDriver({ distanceKm: 0.5, femaleProgram: 'PENDING' });
    const ride = await f.createRide(await f.createPassenger(), { driverPreference: 'FEMALE_ONLY' });
    await DriverProfile.updateOne({ userId: d.id }, { $set: { availability: 'RESERVED', activeRideId: ride._id } });
    const offer = await RideOffer.create({ rideId: ride._id, driverId: d.user._id, ringIndex: 0, expiresAt: new Date(Date.now() + 15000) });
    expect((await api().post(`/api/offers/${offer._id}/accept`).set(f.auth(d.token)).send({})).status).toBe(409);
    expect((await m.rideOf(ride._id)).status).toBe('SEARCHING');
  });

  test('preference survives concurrency: two FEMALE_ONLY rides, one verified driver', async () => {
    const v = await f.createDriver({ distanceKm: 1, femaleProgram: 'VERIFIED' });
    await f.createDriver({ distanceKm: 0.5 });
    const r1 = await f.createRide(await f.createPassenger(), { driverPreference: 'FEMALE_ONLY' });
    const r2 = await f.createRide(await f.createPassenger(), { driverPreference: 'FEMALE_ONLY' });
    const out = await Promise.all([matching.advanceMatching(r1._id), matching.advanceMatching(r2._id)]);
    expect(out.map((o) => o.outcome).sort()).toEqual(['no_driver_found', 'offered']);
    const offers = await RideOffer.find().lean();
    expect(offers).toHaveLength(1);
    expect(String(offers[0].driverId)).toBe(v.id);
  });

  test('sensitive data is not exposed: drivers never see the preference; passengers never see eligibility flags', async () => {
    const p = await f.createPassenger();
    const d = await f.createDriver({ distanceKm: 1, femaleProgram: 'VERIFIED' });
    const ride = await f.createRide(p, { driverPreference: 'FEMALE_ONLY' });
    await matching.advanceMatching(ride._id);
    const offers = await api().get('/api/drivers/me/offers').set(f.auth(d.token));
    expect(JSON.stringify(offers.body)).not.toMatch(/FEMALE|driverPreference/);
    await offerService.acceptOffer((await m.pendingOffer(ride._id))._id, d.id);
    const driverView = await api().get(`/api/rides/${ride._id}`).set(f.auth(d.token));
    expect(driverView.body.data.ride.driverPreference).toBeUndefined();
    const passengerView = await api().get(`/api/rides/${ride._id}`).set(f.auth(p.token));
    expect(passengerView.body.data.ride.driverPreference).toBe('FEMALE_ONLY');
    expect(JSON.stringify(passengerView.body.data.ride.driver)).not.toMatch(/femaleDriverProgram|VERIFIED|identity|document/i);
    // Eligibility lists are admin-only (drivers:review permission).
    expect((await api().get('/api/admin/drivers?femaleProgram=VERIFIED').set(f.auth(p.token))).status).toBe(403);
    const limited = await f.createAdmin({ adminPermissions: ['rides:read'] });
    expect((await api().get('/api/admin/drivers?femaleProgram=VERIFIED').set(f.auth(limited.token))).status).toBe(403);
  });

  test('invalid preference values are rejected', async () => {
    const p = await f.createPassenger();
    expect((await api().post('/api/rides').set(f.auth(p.token)).send(f.bookingBody({ driverPreference: 'MALE_ONLY' }))).status).toBe(400);
  });
});
