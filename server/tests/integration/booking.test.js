'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { useDatabase } = require('../helpers/db');
const { Ride, RideEvent } = require('../../src/models');
const f = require('../helpers/factory');

useDatabase();
const app = createApp();

describe('B. Fare and booking', () => {
  test('#11 estimate returns distance, duration and fare from the server', async () => {
    const p = await f.createPassenger();
    const res = await request(app)
      .post('/api/rides/estimate')
      .set(f.auth(p.token))
      .send({ pickup: f.ORIGIN, destination: f.DESTINATION });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ source: 'straight_line', isEstimate: true, currency: 'INR' });
    expect(Number.isInteger(res.body.data.estimatedFare)).toBe(true);
    expect(res.body.data.estimatedFare).toBeGreaterThan(0);
  });

  test.each([
    ['latitude > 90', { pickup: { lat: 95, lng: 77 }, destination: f.DESTINATION }],
    ['longitude < -180', { pickup: f.ORIGIN, destination: { lat: 12, lng: -200 } }],
    ['string coordinate', { pickup: { lat: '12.9', lng: 77.6 }, destination: f.DESTINATION }],
    ['missing destination', { pickup: f.ORIGIN }],
  ])('#12 rejects invalid coordinates: %s', async (_n, body) => {
    const p = await f.createPassenger();
    const res = await request(app).post('/api/rides/estimate').set(f.auth(p.token)).send(body);
    expect(res.status).toBe(400);
  });

  test.each([
    ['client fare', { estimatedFare: 1 }],
    ['negative fare', { fare: -500 }],
    ['client finalFare', { finalFare: 0 }],
    ['client status', { status: 'COMPLETED' }],
    ['client driverId', { driverId: '507f1f77bcf86cd799439011' }],
  ])('#13 #18 rejects client-manipulated field: %s', async (_n, extra) => {
    const p = await f.createPassenger();
    const res = await request(app).post('/api/rides').set(f.auth(p.token)).send({ ...f.bookingBody(), ...extra });
    expect(res.status).toBe(400);
    expect(await Ride.countDocuments()).toBe(0);
  });

  test('#14 #15 valid passenger requests a ride that starts SEARCHING with a server-side fare', async () => {
    const p = await f.createPassenger();
    const res = await request(app).post('/api/rides').set(f.auth(p.token)).send(f.bookingBody());
    expect(res.status).toBe(201);
    expect(res.body.data.created).toBe(true);
    const ride = res.body.data.ride;
    expect(ride.status).toBe('SEARCHING');
    expect(ride.driverId).toBeNull();
    expect(ride.passengerId).toBe(p.id);
    expect(ride.estimatedFare).toBeGreaterThan(0);
    expect(await RideEvent.countDocuments({ rideId: ride.id, eventType: 'RIDE_REQUESTED' })).toBe(1);
  });

  test('#16 a retry with the same request key returns the original ride', async () => {
    const p = await f.createPassenger();
    const body = f.bookingBody();
    const first = await request(app).post('/api/rides').set(f.auth(p.token)).send(body);
    const retry = await request(app).post('/api/rides').set(f.auth(p.token)).send(body);
    expect(retry.status).toBe(200);
    expect(retry.body.data.created).toBe(false);
    expect(retry.body.data.ride.id).toBe(first.body.data.ride.id);
    expect(await Ride.countDocuments()).toBe(1);
  });

  test('reusing a request key for a different trip is rejected', async () => {
    const p = await f.createPassenger();
    const body = f.bookingBody();
    await request(app).post('/api/rides').set(f.auth(p.token)).send(body).expect(201);
    const res = await request(app)
      .post('/api/rides')
      .set(f.auth(p.token))
      .send({ ...body, destination: { address: 'Elsewhere', lat: 13.0, lng: 77.7 } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  test('#17 a different request key creates a separate booking once the first ride has ended', async () => {
    const p = await f.createPassenger();
    const first = await request(app).post('/api/rides').set(f.auth(p.token)).send(f.bookingBody());
    // While the first ride is active, a second one is refused.
    const blocked = await request(app).post('/api/rides').set(f.auth(p.token)).send(f.bookingBody());
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('ACTIVE_RIDE_EXISTS');
    await request(app).post(`/api/rides/${first.body.data.ride.id}/cancel`).set(f.auth(p.token)).send({}).expect(200);
    const second = await request(app).post('/api/rides').set(f.auth(p.token)).send(f.bookingBody());
    expect(second.status).toBe(201);
    expect(second.body.data.ride.id).not.toBe(first.body.data.ride.id);
  });

  test('#18 passengerId in the body cannot impersonate another user', async () => {
    const p = await f.createPassenger();
    const victim = await f.createPassenger();
    const res = await request(app).post('/api/rides').set(f.auth(p.token)).send({ ...f.bookingBody(), passengerId: victim.id });
    expect(res.status).toBe(400);
    const ok = await request(app).post('/api/rides').set(f.auth(p.token)).send(f.bookingBody());
    expect(ok.body.data.ride.passengerId).toBe(p.id);
  });

  test('#19 history returns only the authenticated passenger rides', async () => {
    const a = await f.createPassenger();
    const b = await f.createPassenger();
    await f.createRide(a);
    await Ride.updateMany({}, { $set: { active: false, status: 'CANCELLED' } });
    await f.createRide(a);
    await f.createRide(b);
    const res = await request(app).get('/api/rides/history').set(f.auth(a.token));
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(2);
    expect(res.body.data.items.every((r) => r.passengerId === a.id)).toBe(true);
  });

  test('#9 a passenger cannot read another passenger ride', async () => {
    const a = await f.createPassenger();
    const b = await f.createPassenger();
    const ride = await f.createRide(a);
    expect((await request(app).get(`/api/rides/${ride._id}`).set(f.auth(b.token))).status).toBe(404);
    expect((await request(app).get(`/api/rides/${ride._id}`).set(f.auth(a.token))).status).toBe(200);
    const admin = await f.createAdmin();
    expect((await request(app).get(`/api/rides/${ride._id}`).set(f.auth(admin.token))).status).toBe(200);
  });

  test('#99 invalid ids and malformed JSON return controlled errors', async () => {
    const p = await f.createPassenger();
    const bad = await request(app).get('/api/rides/not-an-id').set(f.auth(p.token));
    expect(bad.status).toBe(400);
    const malformed = await request(app)
      .post('/api/rides')
      .set(f.auth(p.token))
      .set('Content-Type', 'application/json')
      .send('{"pickup": ');
    expect(malformed.status).toBe(400);
    expect(malformed.body).toEqual({ success: false, error: { code: 'BAD_REQUEST', message: 'Malformed JSON body' } });
  });

  test('#55 concurrent duplicate booking requests create exactly one ride', async () => {
    const p = await f.createPassenger();
    const body = f.bookingBody();
    const results = await Promise.all(Array.from({ length: 10 }, () => request(app).post('/api/rides').set(f.auth(p.token)).send(body)));
    expect(results.every((r) => [200, 201].includes(r.status))).toBe(true);
    const ids = new Set(results.map((r) => r.body.data.ride.id));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.body.data.created).length).toBe(1);
    expect(await Ride.countDocuments({ passengerId: p.id })).toBe(1);
  });
});
