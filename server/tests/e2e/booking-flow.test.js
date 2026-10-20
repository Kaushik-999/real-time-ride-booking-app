'use strict';

// Full end-to-end flow with production-like settings: matching starts
// automatically, offers expire through real timers, Socket.IO uses the
// MongoDB adapter, and a recovery worker runs alongside.
// (Env must be set before any src module is loaded in this test file.)
Object.assign(process.env, {
  MATCHING_AUTO_START: 'true',
  OFFER_TIMERS_ENABLED: 'true',
  OFFER_TIMEOUT_MS: '1000',
  SOCKET_ADAPTER: 'mongo',
});

const request = require('supertest');
const { useDatabase } = require('../helpers/db');
const f = require('../helpers/factory');
const { startServer, waitForEvent, emitWithAck } = require('../helpers/server');
const { createMongoEmitter } = require('../../src/sockets');
const { RecoveryWorker } = require('../../src/workers/recoveryWorker');
const { RideOffer, Payment } = require('../../src/models');
const { destinationPoint } = require('../../src/utils/geo');

useDatabase();
let srv;
let worker;
beforeEach(async () => {
  srv = await startServer({ adapter: 'mongo' });
  worker = new RecoveryWorker({ intervalMs: 200 });
  worker.start();
});
afterEach(async () => {
  await worker.stop();
  await srv.close();
});

describe('end-to-end booking', () => {
  test('book -> reject -> timeout -> expand -> accept -> track -> complete -> pay', async () => {
    const api = request(srv.app);
    const passenger = await f.createPassenger();
    const d1 = await f.createDriver({ distanceKm: 1 }); // will reject
    const d2 = await f.createDriver({ distanceKm: 2 }); // will ignore (timeout)
    const d3 = await f.createDriver({ distanceKm: 5 }); // will accept (3-6 km ring)
    const [ps, s1, s2, s3] = await Promise.all([passenger, d1, d2, d3].map((u) => srv.connect(u.token)));

    // 1. Estimate and book.
    const est = await api.post('/api/rides/estimate').set(f.auth(passenger.token)).send({ pickup: f.ORIGIN, destination: f.DESTINATION });
    const booking = await api.post('/api/rides').set(f.auth(passenger.token)).send(f.bookingBody({ paymentMethod: 'ONLINE' }));
    expect(booking.status).toBe(201);
    const rideId = booking.body.data.ride.id;
    expect(booking.body.data.ride.estimatedFare).toBe(est.body.data.estimatedFare);
    await waitForEvent(ps, 'ride:searching');

    // 2. Nearest driver gets the offer automatically and rejects it.
    const o1 = await waitForEvent(s1, 'driver:offer');
    await api.post(`/api/offers/${o1.offerId}/reject`).set(f.auth(d1.token)).send({}).expect(200);

    // 3. Next driver ignores the offer; the real 1 s timer expires it.
    const o2 = await waitForEvent(s2, 'driver:offer');
    await waitForEvent(s2, 'driver:offer-expired', (p) => p.offerId === o2.offerId, 4000);

    // 4. Search expands to the 3-6 km ring; that driver accepts.
    await waitForEvent(ps, 'ride:searching', (p) => p.radiusKm === 6);
    const o3 = await waitForEvent(s3, 'driver:offer', () => true, 4000);
    const late = await api.post(`/api/offers/${o2.offerId}/accept`).set(f.auth(d2.token)).send({});
    expect(late.status).toBe(409);
    await api.post(`/api/offers/${o3.offerId}/accept`).set(f.auth(d3.token)).send({}).expect(200);
    await waitForEvent(ps, 'ride:driver-assigned', (p) => p.driverId === d3.id);

    // 5. Live tracking.
    expect((await emitWithAck(ps, 'ride:subscribe', { rideId })).ok).toBe(true);
    await api.patch('/api/drivers/me/location').set(f.auth(d3.token)).send(f.ORIGIN).expect(200);
    await waitForEvent(ps, 'driver:location-updated');

    // 6. Arrive, start, drive 2 km, complete.
    await api.post(`/api/rides/${rideId}/arrive`).set(f.auth(d3.token)).send({}).expect(200);
    await waitForEvent(ps, 'ride:driver-arrived');
    // Driver cannot see the destination yet; the passenger reads out the start code.
    const before = await api.get(`/api/rides/${rideId}`).set(f.auth(d3.token));
    expect(before.body.data.ride).toMatchObject({ destination: null, destinationHidden: true });
    const startCode = (await api.get(`/api/rides/${rideId}/otp`).set(f.auth(passenger.token))).body.data.otp;
    expect(startCode.purpose).toBe('TRIP_START');
    await api.post(`/api/rides/${rideId}/start`).set(f.auth(d3.token)).send({ otp: startCode.code }).expect(200);
    const after = await api.get(`/api/rides/${rideId}`).set(f.auth(d3.token));
    expect(after.body.data.ride.destination).toMatchObject({ lat: expect.any(Number) });
    await waitForEvent(ps, 'ride:started');
    let pos = f.ORIGIN;
    for (let i = 0; i < 4; i += 1) {
      pos = destinationPoint(pos, 500, 160);
      await api.patch('/api/drivers/me/location').set(f.auth(d3.token)).send(pos).expect(200);
    }
    const endCode = (await api.get(`/api/rides/${rideId}/otp`).set(f.auth(passenger.token))).body.data.otp;
    expect(endCode.purpose).toBe('TRIP_COMPLETE');
    const done = await api.post(`/api/rides/${rideId}/complete`).set(f.auth(d3.token)).send({ otp: endCode.code });
    expect(done.body.data.ride.status).toBe('COMPLETED');
    const completedEvt = await waitForEvent(ps, 'ride:completed');
    expect(completedEvt.finalFare).toBe(done.body.data.ride.finalFare);

    // 7. State is recoverable over REST (e.g. after a reconnect).
    const view = await api.get(`/api/rides/${rideId}`).set(f.auth(passenger.token));
    expect(view.body.data.ride).toMatchObject({ status: 'COMPLETED', driverId: d3.id, payment: { status: 'PENDING' } });
    const offers = await RideOffer.find({ rideId }).sort({ offeredAt: 1 }).lean();
    expect(offers.map((o) => [String(o.driverId), o.status])).toEqual([
      [d1.id, 'REJECTED'],
      [d2.id, 'EXPIRED'],
      [d3.id, 'ACCEPTED'],
    ]);
    expect(await f.waitFor(async () => (await api.get('/api/drivers/me').set(f.auth(d3.token))).body.data.profile.availability === 'AVAILABLE')).toBe(true);

    // 8. Payment goes through the signed-webhook path.
    const pay = await api.post(`/api/rides/${rideId}/pay`).set(f.auth(passenger.token)).send({});
    expect(pay.body.data.payment.status).toBe('PROCESSING');
    expect((await Payment.findOne({ rideId })).status).toBe('PROCESSING');
  });

  test('events emitted by another process (worker emitter) reach clients through MongoDB', async () => {
    const passenger = await f.createPassenger();
    const ps = await srv.connect(passenger.token);
    const emitter = await createMongoEmitter();
    emitter.to(`user:${passenger.id}`).emit('ride:searching', { rideId: 'x', fromWorker: true });
    const evt = await waitForEvent(ps, 'ride:searching', (p) => p.fromWorker);
    expect(evt.rideId).toBe('x');
  });

  test('a booking with no drivers anywhere ends as NO_DRIVER_FOUND automatically', async () => {
    const passenger = await f.createPassenger();
    await f.createDriver({ distanceKm: 15 });
    const ps = await srv.connect(passenger.token);
    const res = await request(srv.app).post('/api/rides').set(f.auth(passenger.token)).send(f.bookingBody());
    expect(res.body.data.ride.status).toBe('SEARCHING');
    const evt = await waitForEvent(ps, 'ride:no-driver-found');
    expect(evt.status).toBe('NO_DRIVER_FOUND');
  });
});
