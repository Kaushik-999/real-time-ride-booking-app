'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { useDatabase } = require('../helpers/db');
const f = require('../helpers/factory');
const m = require('../helpers/matching');
const matching = require('../../src/services/matchingService');
const offerService = require('../../src/services/offerService');
const { Ride, Payment, RideEvent } = require('../../src/models');
const { destinationPoint } = require('../../src/utils/geo');

useDatabase();
const app = createApp();

async function assignedRide(opts = {}) {
  const passenger = await f.createPassenger();
  const driver = await f.createDriver({ distanceKm: 1 });
  const other = await f.createDriver({ distanceKm: 2, availability: 'OFFLINE' });
  const ride = await f.createRide(passenger, opts);
  await matching.advanceMatching(ride._id);
  const offer = await m.pendingOffer(ride._id);
  await offerService.acceptOffer(offer._id, driver.id);
  return { passenger, driver, other, ride };
}

/** Driver action through the API. start/complete send the passenger's current code unless `otp` is given. */
const step = async (rideId, name, token, otp) => {
  let body = {};
  if (name !== 'arrive') {
    let code = otp;
    if (code === undefined) {
      try {
        code = await m.tripOtp(rideId);
      } catch {
        code = '000000'; // no code applicable in this state
      }
    }
    body = { otp: code };
  }
  return request(app).post(`/api/rides/${rideId}/${name}`).set(f.auth(token)).send(body);
};

describe('F. Ride lifecycle', () => {
  test('#61 #62 #66 assigned driver arrives, starts and completes; #70 every transition is recorded', async () => {
    const { driver, ride } = await assignedRide();
    expect((await step(ride._id, 'arrive', driver.token)).body.data.ride.status).toBe('DRIVER_ARRIVED');
    expect((await step(ride._id, 'start', driver.token)).body.data.ride.status).toBe('IN_PROGRESS');
    const done = await step(ride._id, 'complete', driver.token);
    expect(done.status).toBe(200);
    expect(done.body.data.ride.status).toBe('COMPLETED');
    const types = (await m.eventsOf(ride._id)).map((e) => e.eventType);
    expect(types).toEqual(['RIDE_REQUESTED', 'OFFER_SENT', 'DRIVER_ASSIGNED', 'DRIVER_ARRIVED', 'TRIP_STARTED', 'TRIP_COMPLETED']);
    const events = await m.eventsOf(ride._id);
    const completed = events.find((e) => e.eventType === 'TRIP_COMPLETED');
    expect(completed).toMatchObject({ previousStatus: 'IN_PROGRESS', newStatus: 'COMPLETED' });
    expect(String(completed.actorId)).toBe(driver.id);
    expect(completed.createdAt).toBeInstanceOf(Date);
  });

  test('#63 an unassigned driver cannot arrive, start or complete', async () => {
    const { other, ride } = await assignedRide();
    for (const s of ['arrive', 'start', 'complete']) expect((await step(ride._id, s, other.token)).status).toBe(403);
  });

  test('#64 a passenger cannot start or complete the trip', async () => {
    const { passenger, driver, ride } = await assignedRide();
    expect((await step(ride._id, 'arrive', driver.token)).status).toBe(200);
    expect((await step(ride._id, 'start', passenger.token)).status).toBe(403);
    expect((await step(ride._id, 'complete', passenger.token)).status).toBe(403);
    expect((await m.rideOf(ride._id)).status).toBe('DRIVER_ARRIVED');
  });

  test('a driver cannot start before arriving, or before being assigned', async () => {
    const { driver, ride } = await assignedRide();
    const early = await step(ride._id, 'start', driver.token);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('INVALID_TRANSITION');
    const p = await f.createPassenger();
    const searching = await f.createRide(p);
    expect((await step(searching._id, 'start', driver.token)).status).toBe(403);
  });

  test('#65 a trip cannot start twice', async () => {
    const { driver, ride } = await assignedRide();
    expect((await step(ride._id, 'arrive', driver.token)).status).toBe(200);
    expect((await step(ride._id, 'start', driver.token)).status).toBe(200);
    expect((await step(ride._id, 'start', driver.token)).status).toBe(409);
    expect(await RideEvent.countDocuments({ rideId: ride._id, eventType: 'TRIP_STARTED' })).toBe(1);
  });

  test('#67 a completed trip cannot be started again; a repeated complete changes nothing', async () => {
    const { driver, ride } = await assignedRide();
    for (const s of ['arrive', 'start', 'complete']) expect((await step(ride._id, s, driver.token)).status).toBe(200);
    expect((await step(ride._id, 'start', driver.token)).status).toBe(409);
    const again = await step(ride._id, 'complete', driver.token);
    expect(again.status).toBe(200);
    expect(again.body.data.alreadyDone).toBe(true);
    expect(await RideEvent.countDocuments({ rideId: ride._id, eventType: 'TRIP_COMPLETED' })).toBe(1);
    expect(await Payment.countDocuments({ rideId: ride._id })).toBe(1);
  });

  test('#68 permitted cancellations record status and release the right reservation', async () => {
    const { passenger, driver, ride } = await assignedRide();
    expect((await step(ride._id, 'arrive', driver.token)).status).toBe(200);
    const res = await request(app).post(`/api/rides/${ride._id}/cancel`).set(f.auth(passenger.token)).send({ reason: 'Changed plans' });
    expect(res.status).toBe(200);
    const r = await m.rideOf(ride._id);
    expect(r).toMatchObject({ status: 'CANCELLED', cancelReason: 'Changed plans', active: false });
    expect(String(r.cancelledBy)).toBe(passenger.id);
    expect(await m.profileOf(driver)).toMatchObject({ availability: 'AVAILABLE', activeRideId: null });
    const ev = await m.eventsOf(ride._id, 'RIDE_CANCELLED');
    expect(ev[0]).toMatchObject({ previousStatus: 'DRIVER_ARRIVED', newStatus: 'CANCELLED' });
    // repeated cancel is idempotent
    const again = await request(app).post(`/api/rides/${ride._id}/cancel`).set(f.auth(passenger.token)).send({});
    expect(again.body.data.alreadyCancelled).toBe(true);
  });

  test('#69 cancellation is rejected once the trip is in progress or done, and by non-owners', async () => {
    const { passenger, driver, ride } = await assignedRide();
    const stranger = await f.createPassenger();
    expect((await request(app).post(`/api/rides/${ride._id}/cancel`).set(f.auth(stranger.token)).send({})).status).toBe(404);
    expect((await request(app).post(`/api/rides/${ride._id}/cancel`).set(f.auth(driver.token)).send({})).status).toBe(403);
    expect((await step(ride._id, 'arrive', driver.token)).status).toBe(200);
    expect((await step(ride._id, 'start', driver.token)).status).toBe(200);
    const res = await request(app).post(`/api/rides/${ride._id}/cancel`).set(f.auth(passenger.token)).send({});
    expect(res.status).toBe(409);
    expect((await m.rideOf(ride._id)).status).toBe('IN_PROGRESS');
  });

  test('#71 final fare is computed server-side from tracked distance; #72 driver becomes AVAILABLE', async () => {
    const { driver, ride } = await assignedRide();
    // Driver reports being at the pickup before the trip (not counted: not IN_PROGRESS yet).
    await request(app).patch('/api/drivers/me/location').set(f.auth(driver.token)).send(f.ORIGIN).expect(200);
    expect((await step(ride._id, 'arrive', driver.token)).status).toBe(200);
    expect((await step(ride._id, 'start', driver.token)).status).toBe(200);
    expect((await m.rideOf(ride._id)).tripDistanceMeters).toBe(0);
    // Drive ~3 km in 500 m hops, reported through the API.
    let pos = f.ORIGIN;
    for (let i = 0; i < 6; i += 1) {
      pos = destinationPoint(pos, 500, 180);
      await request(app).patch('/api/drivers/me/location').set(f.auth(driver.token)).send(pos).expect(200);
    }
    const tracked = (await m.rideOf(ride._id)).tripDistanceMeters;
    expect(tracked).toBeGreaterThan(2900);
    expect(tracked).toBeLessThan(3100);
    const done = await step(ride._id, 'complete', driver.token);
    const r = done.body.data.ride;
    expect(r.finalBreakdown.distanceMeters).toBe(Math.round(tracked));
    expect(Number.isInteger(r.finalFare)).toBe(true);
    expect(r.finalFare).toBeGreaterThan(0);
    expect(await m.profileOf(driver)).toMatchObject({ availability: 'AVAILABLE', activeRideId: null });
    // the passenger can now book again
    expect((await Ride.findById(ride._id)).active).toBe(false);
  });

  test('driver earnings summary counts completed trips', async () => {
    const { driver, ride } = await assignedRide();
    for (const s of ['arrive', 'start', 'complete']) expect((await step(ride._id, s, driver.token)).status).toBe(200);
    const res = await request(app).get('/api/drivers/me/trips').set(f.auth(driver.token));
    expect(res.body.data.earnings.completedTrips).toBe(1);
    expect(res.body.data.earnings.totalPaise).toBe((await m.rideOf(ride._id)).finalFare);
  });
});
