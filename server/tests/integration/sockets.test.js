'use strict';

const request = require('supertest');
const { useDatabase } = require('../helpers/db');
const f = require('../helpers/factory');
const m = require('../helpers/matching');
const { startServer, waitForEvent, emitWithAck } = require('../helpers/server');
const matching = require('../../src/services/matchingService');
const { Ride, Payment } = require('../../src/models');

useDatabase();
let srv;
beforeEach(async () => {
  srv = await startServer({ adapter: 'memory' });
});
afterEach(async () => {
  await srv.close();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('H. Socket.IO', () => {
  test('connections without a valid token are refused', async () => {
    await expect(srv.connect('garbage')).rejects.toThrow('UNAUTHORIZED');
    await expect(srv.connect(undefined)).rejects.toThrow('UNAUTHORIZED');
  });

  test('#81 an authenticated passenger receives updates for their own ride', async () => {
    const passenger = await f.createPassenger();
    const driver = await f.createDriver({ distanceKm: 1 });
    const ps = await srv.connect(passenger.token);
    const ride = await f.createRide(passenger);
    await matching.advanceMatching(ride._id);
    const offer = await m.pendingOffer(ride._id);
    await request(srv.app).post(`/api/offers/${offer._id}/accept`).set(f.auth(driver.token)).send({}).expect(200);
    const evt = await waitForEvent(ps, 'ride:driver-assigned');
    expect(evt).toMatchObject({ rideId: String(ride._id), status: 'DRIVER_ASSIGNED', driverId: driver.id });

    // Live location only after subscribing to the ride room (server-authorised).
    const ack = await emitWithAck(ps, 'ride:subscribe', { rideId: String(ride._id) });
    expect(ack).toEqual({ ok: true, status: 'DRIVER_ASSIGNED' });
    await request(srv.app).patch('/api/drivers/me/location').set(f.auth(driver.token)).send({ lat: 12.97, lng: 77.6 }).expect(200);
    const loc = await waitForEvent(ps, 'driver:location-updated');
    expect(loc).toMatchObject({ rideId: String(ride._id), lat: 12.97, lng: 77.6 });
  });

  test("#82 a passenger cannot subscribe to another passenger's ride room or see its events", async () => {
    const owner = await f.createPassenger();
    const intruder = await f.createPassenger();
    const driver = await f.createDriver({ distanceKm: 1 });
    const is = await srv.connect(intruder.token);
    const ride = await f.createRide(owner);
    expect(await emitWithAck(is, 'ride:subscribe', { rideId: String(ride._id) })).toEqual({ ok: false, error: 'FORBIDDEN' });
    expect(await emitWithAck(is, 'ride:subscribe', { rideId: 'not-an-id' })).toEqual({ ok: false, error: 'INVALID_RIDE_ID' });

    await matching.advanceMatching(ride._id);
    const offer = await m.pendingOffer(ride._id);
    await request(srv.app).post(`/api/offers/${offer._id}/accept`).set(f.auth(driver.token)).send({}).expect(200);
    await request(srv.app).patch('/api/drivers/me/location').set(f.auth(driver.token)).send({ lat: 12.97, lng: 77.6 }).expect(200);
    await sleep(300);
    expect(is.received).toEqual([]);
  });

  test('#83 a driver receives only their own offers', async () => {
    const passenger = await f.createPassenger();
    const near = await f.createDriver({ distanceKm: 1 });
    const far = await f.createDriver({ distanceKm: 2 });
    const nearSocket = await srv.connect(near.token);
    const farSocket = await srv.connect(far.token);
    const ride = await f.createRide(passenger);
    await matching.advanceMatching(ride._id);
    const offer = await waitForEvent(nearSocket, 'driver:offer');
    expect(offer).toMatchObject({ rideId: String(ride._id), estimatedFare: expect.any(Number) });
    expect(offer.pickup).toMatchObject({ lat: expect.any(Number), lng: expect.any(Number) });
    await sleep(200);
    expect(farSocket.received.filter((e) => e.event === 'driver:offer')).toHaveLength(0);

    // After the near driver rejects, the far driver (and only they) gets the next offer.
    await request(srv.app).post(`/api/offers/${offer.offerId}/reject`).set(f.auth(near.token)).send({}).expect(200);
    await matching.advanceMatching(ride._id);
    const second = await waitForEvent(farSocket, 'driver:offer');
    expect(second.rideId).toBe(String(ride._id));
    expect(nearSocket.received.filter((e) => e.event === 'driver:offer')).toHaveLength(1);
  });

  test('#86 repeated or forged client socket events cannot create rides or payments', async () => {
    const passenger = await f.createPassenger();
    const ps = await srv.connect(passenger.token);
    const ride = await f.createRide(passenger);
    for (let i = 0; i < 5; i += 1) {
      ps.emit('ride:completed', { rideId: String(ride._id), status: 'COMPLETED' });
      ps.emit('ride:create', { pickup: f.ORIGIN });
      ps.emit('payment:updated', { rideId: String(ride._id), status: 'SUCCEEDED' });
      await emitWithAck(ps, 'ride:subscribe', { rideId: String(ride._id) });
    }
    await sleep(200);
    expect(await Ride.countDocuments()).toBe(1);
    expect((await Ride.findById(ride._id)).status).toBe('SEARCHING');
    expect(await Payment.countDocuments()).toBe(0);
  });
});
