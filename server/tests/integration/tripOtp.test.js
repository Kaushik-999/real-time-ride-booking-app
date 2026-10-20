'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { useDatabase } = require('../helpers/db');
const f = require('../helpers/factory');
const m = require('../helpers/matching');
const { startServer, waitForEvent } = require('../helpers/server');
const matching = require('../../src/services/matchingService');
const offerService = require('../../src/services/offerService');
const rideOtpService = require('../../src/services/rideOtpService');
const logger = require('../../src/utils/logger');
const { RideOtp, Ride, RideEvent, Payment, DevOutboxMessage } = require('../../src/models');

useDatabase();
afterEach(() => jest.restoreAllMocks());
const app = createApp();
const api = () => request(app);

async function assigned({ phone } = {}) {
  const passenger = await f.createPassenger(phone ? { phone } : {});
  const driver = await f.createDriver({ distanceKm: 1 });
  const other = await f.createDriver({ distanceKm: 2, availability: 'OFFLINE' });
  const ride = await f.createRide(passenger);
  await matching.advanceMatching(ride._id);
  const accept = await api().post(`/api/offers/${(await m.pendingOffer(ride._id))._id}/accept`).set(f.auth(driver.token)).send({});
  return { passenger, driver, other, ride, accept };
}
const post = (rideId, step, token, body = {}) => api().post(`/api/rides/${rideId}/${step}`).set(f.auth(token)).send(body);
const getOtp = (rideId, token) => api().get(`/api/rides/${rideId}/otp`).set(f.auth(token));
const wrongOf = (code) => (code === '000000' ? '111111' : '000000');

describe('Trip-start OTP and destination privacy', () => {
  test('the driver cannot see the destination before pickup verification, and can after', async () => {
    const { passenger, driver, ride, accept } = await assigned();
    expect(accept.body.data.ride).toMatchObject({ destination: null, destinationHidden: true });
    const view = await api().get(`/api/rides/${ride._id}`).set(f.auth(driver.token));
    expect(view.body.data.ride.destination).toBeNull();
    expect(JSON.stringify(view.body)).not.toContain('Drop'); // destination address
    // passenger still sees it
    expect((await api().get(`/api/rides/${ride._id}`).set(f.auth(passenger.token))).body.data.ride.destination.address).toBe('Drop');
    await post(ride._id, 'arrive', driver.token).expect(200);
    const code = (await getOtp(ride._id, passenger.token)).body.data.otp.code;
    await post(ride._id, 'start', driver.token, { otp: code }).expect(200);
    const after = await api().get(`/api/rides/${ride._id}`).set(f.auth(driver.token));
    expect(after.body.data.ride).toMatchObject({ destinationHidden: false, destination: { address: 'Drop' } });
  });

  test('offers (REST and socket) never include the destination', async () => {
    const srv = await startServer({ adapter: 'memory' });
    try {
      const passenger = await f.createPassenger();
      const driver = await f.createDriver({ distanceKm: 1 });
      const ds = await srv.connect(driver.token);
      const ride = await f.createRide(passenger);
      await matching.advanceMatching(ride._id);
      const evt = await waitForEvent(ds, 'driver:offer');
      expect(evt.destination).toBeUndefined();
      expect(evt).toMatchObject({ destinationHidden: true, tripDistanceMeters: expect.any(Number) });
      const list = await request(srv.app).get('/api/drivers/me/offers').set(f.auth(driver.token));
      expect(list.body.data.offers[0].ride.destination).toBeUndefined();
      expect(JSON.stringify(list.body)).not.toContain('Drop');
    } finally {
      await srv.close();
    }
  });

  test('a correct start code starts the trip and issues a separate completion code', async () => {
    const { passenger, driver, ride } = await assigned();
    await post(ride._id, 'arrive', driver.token).expect(200);
    const start = (await getOtp(ride._id, passenger.token)).body.data.otp;
    expect(start).toMatchObject({ purpose: 'TRIP_START', code: expect.stringMatching(/^\d{6}$/), attemptsRemaining: 5 });
    const res = await post(ride._id, 'start', driver.token, { otp: start.code });
    expect(res.status).toBe(200);
    const r = await m.rideOf(ride._id);
    expect(r.status).toBe('IN_PROGRESS');
    expect(r.startVerifiedAt).toBeInstanceOf(Date);
    const complete = (await getOtp(ride._id, passenger.token)).body.data.otp;
    expect(complete.purpose).toBe('TRIP_COMPLETE');
    const docs = await RideOtp.find({ rideId: ride._id }).sort({ createdAt: 1 }).lean();
    expect(docs.map((d) => [d.purpose, d.status])).toEqual([['TRIP_START', 'VERIFIED'], ['TRIP_COMPLETE', 'ACTIVE']]);
  });

  test('the start OTP is required: missing or malformed codes are 400', async () => {
    const { driver, ride } = await assigned();
    await post(ride._id, 'arrive', driver.token).expect(200);
    expect((await post(ride._id, 'start', driver.token, {})).status).toBe(400);
    expect((await post(ride._id, 'start', driver.token, { otp: '12ab' })).status).toBe(400);
    expect((await m.rideOf(ride._id)).status).toBe('DRIVER_ARRIVED');
  });

  test('an invalid code fails, counts an attempt, and is recorded; the ride does not start', async () => {
    const { passenger, driver, ride } = await assigned();
    await post(ride._id, 'arrive', driver.token).expect(200);
    const code = (await getOtp(ride._id, passenger.token)).body.data.otp.code;
    const res = await post(ride._id, 'start', driver.token, { otp: wrongOf(code) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'INVALID_OTP', details: { attemptsRemaining: 4 } });
    expect((await m.rideOf(ride._id)).status).toBe('DRIVER_ARRIVED');
    expect(await RideEvent.countDocuments({ rideId: ride._id, eventType: 'OTP_FAILED' })).toBe(1);
  });

  test('expired codes are rejected; the passenger then gets a fresh one', async () => {
    const { passenger, driver, ride } = await assigned();
    await post(ride._id, 'arrive', driver.token).expect(200);
    const code = (await getOtp(ride._id, passenger.token)).body.data.otp.code;
    await RideOtp.updateMany({ rideId: ride._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await post(ride._id, 'start', driver.token, { otp: code });
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('OTP_EXPIRED');
    const fresh = (await getOtp(ride._id, passenger.token)).body.data.otp.code;
    await post(ride._id, 'start', driver.token, { otp: fresh }).expect(200);
  });

  test('excessive attempts lock the code, even for the right digits', async () => {
    const { passenger, driver, ride } = await assigned();
    await post(ride._id, 'arrive', driver.token).expect(200);
    const code = (await getOtp(ride._id, passenger.token)).body.data.otp.code;
    for (let i = 0; i < 5; i += 1) expect((await post(ride._id, 'start', driver.token, { otp: wrongOf(code) })).status).toBe(400);
    const locked = await post(ride._id, 'start', driver.token, { otp: code });
    expect(locked.status).toBe(423);
    expect(locked.body.error.code).toBe('OTP_LOCKED');
    expect((await m.rideOf(ride._id)).status).toBe('DRIVER_ARRIVED');
  });

  test('replayed codes fail: start cannot run twice and the start code is useless for completion', async () => {
    const { passenger, driver, ride } = await assigned();
    await post(ride._id, 'arrive', driver.token).expect(200);
    let start = (await getOtp(ride._id, passenger.token)).body.data.otp.code;
    await post(ride._id, 'start', driver.token, { otp: start }).expect(200);
    expect((await post(ride._id, 'start', driver.token, { otp: start })).status).toBe(409);
    let completion = (await getOtp(ride._id, passenger.token)).body.data.otp.code;
    // (6 random digits could coincide; make sure the two differ for this check)
    while (completion === start) {
      await RideOtp.updateMany({ rideId: ride._id, purpose: 'TRIP_COMPLETE', status: 'ACTIVE' }, { $set: { expiresAt: new Date(0) } });
      completion = (await getOtp(ride._id, passenger.token)).body.data.otp.code;
    }
    const replay = await post(ride._id, 'complete', driver.token, { otp: start });
    expect(replay.status).toBe(400);
    expect((await m.rideOf(ride._id)).status).toBe('IN_PROGRESS');
    start = null;
  });

  test('five simultaneous start requests with the right code start the ride exactly once', async () => {
    const { passenger, driver, ride } = await assigned();
    await post(ride._id, 'arrive', driver.token).expect(200);
    const code = (await getOtp(ride._id, passenger.token)).body.data.otp.code;
    const results = await Promise.all(Array.from({ length: 5 }, () => post(ride._id, 'start', driver.token, { otp: code })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status !== 200).every((r) => r.status === 409)).toBe(true);
    expect(await RideEvent.countDocuments({ rideId: ride._id, eventType: 'TRIP_STARTED' })).toBe(1);
    expect(await RideOtp.countDocuments({ rideId: ride._id, purpose: 'TRIP_COMPLETE' })).toBe(1);
  });

  test('only the assigned driver can verify, only after arriving', async () => {
    const { passenger, driver, other, ride } = await assigned();
    const code = (await getOtp(ride._id, passenger.token)).body.data.otp.code;
    expect((await post(ride._id, 'start', driver.token, { otp: code })).status).toBe(409); // not arrived yet
    await post(ride._id, 'arrive', driver.token).expect(200);
    expect((await post(ride._id, 'start', other.token, { otp: code })).status).toBe(403);
    expect((await post(ride._id, 'start', passenger.token, { otp: code })).status).toBe(403);
  });

  test('only the ride passenger can view the code', async () => {
    const { driver, ride } = await assigned();
    const stranger = await f.createPassenger();
    expect((await getOtp(ride._id, driver.token)).status).toBe(403);
    expect((await getOtp(ride._id, stranger.token)).status).toBe(404);
  });

  test('codes are never stored in plaintext, never sent to the driver, never logged', async () => {
    const spies = ['info', 'warn', 'error', 'debug'].map((lvl) => jest.spyOn(logger, lvl));
    const { passenger, driver, ride, accept } = await assigned();
    const code = (await getOtp(ride._id, passenger.token)).body.data.otp.code;
    const raw = JSON.stringify(await RideOtp.collection.find({ rideId: ride._id }).toArray());
    expect(raw).not.toContain(`"${code}"`);
    expect(raw).toMatch(/codeHash/);
    expect(JSON.stringify(accept.body)).not.toMatch(/otp|codeHash|codeCiphertext/i);
    const driverView = await api().get(`/api/rides/${ride._id}`).set(f.auth(driver.token));
    expect(JSON.stringify(driverView.body)).not.toContain(code);
    await post(ride._id, 'arrive', driver.token).expect(200);
    await post(ride._id, 'start', driver.token, { otp: code }).expect(200);
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    expect(logged).not.toContain(code);
  });

  test('the passenger is notified that a code is ready, without the code in the event', async () => {
    const srv = await startServer({ adapter: 'memory' });
    try {
      const passenger = await f.createPassenger();
      const driver = await f.createDriver({ distanceKm: 1 });
      const ps = await srv.connect(passenger.token);
      const ds = await srv.connect(driver.token);
      const ride = await f.createRide(passenger);
      await matching.advanceMatching(ride._id);
      await offerService.acceptOffer((await m.pendingOffer(ride._id))._id, driver.id);
      const evt = await waitForEvent(ps, 'ride:otp-available');
      expect(evt).toMatchObject({ rideId: String(ride._id), purpose: 'TRIP_START' });
      expect(Object.keys(evt).sort()).toEqual(['expiresAt', 'purpose', 'rideId']);
      expect(ds.received.some((e) => e.event === 'ride:otp-available')).toBe(false);
    } finally {
      await srv.close();
    }
  });

  test('passengers with a phone also receive the code by SMS (dev outbox here); drivers never do', async () => {
    const { passenger, driver } = await assigned({ phone: '+919812345678' });
    const msgs = await DevOutboxMessage.find().lean();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ to: '+919812345678', purpose: 'TRIP_START' });
    expect(passenger).toBeTruthy();
    expect(driver).toBeTruthy();
  });

  test('cancelling the ride invalidates its codes', async () => {
    const { passenger, driver, ride } = await assigned();
    const code = (await getOtp(ride._id, passenger.token)).body.data.otp.code;
    await api().post(`/api/rides/${ride._id}/cancel`).set(f.auth(passenger.token)).send({}).expect(200);
    expect(await RideOtp.countDocuments({ rideId: ride._id, status: 'ACTIVE' })).toBe(0);
    expect((await getOtp(ride._id, passenger.token)).status).toBe(409);
    expect((await post(ride._id, 'start', driver.token, { otp: code })).status).toBe(409);
  });

  test('rides already assigned before this feature existed get a code on demand', async () => {
    const { passenger, driver, ride } = await assigned();
    await RideOtp.deleteMany({ rideId: ride._id }); // simulate a pre-upgrade ride
    await post(ride._id, 'arrive', driver.token).expect(200);
    const code = (await getOtp(ride._id, passenger.token)).body.data.otp.code;
    await post(ride._id, 'start', driver.token, { otp: code }).expect(200);
  });

  test('code regeneration is limited', async () => {
    const { passenger, ride } = await assigned();
    for (let i = 0; i < 6; i += 1) {
      await RideOtp.updateMany({ rideId: ride._id, status: 'ACTIVE' }, { $set: { expiresAt: new Date(0) } });
      await getOtp(ride._id, passenger.token);
    }
    await RideOtp.updateMany({ rideId: ride._id, status: 'ACTIVE' }, { $set: { expiresAt: new Date(0) } });
    const res = await getOtp(ride._id, passenger.token);
    expect(res.status).toBe(429);
  });
});

describe('Trip-completion OTP', () => {
  async function inProgress() {
    const ctx = await assigned();
    await post(ctx.ride._id, 'arrive', ctx.driver.token).expect(200);
    await post(ctx.ride._id, 'start', ctx.driver.token, { otp: (await getOtp(ctx.ride._id, ctx.passenger.token)).body.data.otp.code }).expect(200);
    return ctx;
  }

  test('completion needs the separate completion code; invalid codes do not complete the trip', async () => {
    const { passenger, driver, ride } = await inProgress();
    const code = (await getOtp(ride._id, passenger.token)).body.data.otp.code;
    expect((await post(ride._id, 'complete', driver.token, {})).status).toBe(400);
    expect((await post(ride._id, 'complete', driver.token, { otp: wrongOf(code) })).status).toBe(400);
    expect((await m.rideOf(ride._id)).status).toBe('IN_PROGRESS');
    expect(await Payment.countDocuments({ rideId: ride._id })).toBe(0);
    const ok = await post(ride._id, 'complete', driver.token, { otp: code });
    expect(ok.status).toBe(200);
    expect(ok.body.data.ride.status).toBe('COMPLETED');
    expect((await m.rideOf(ride._id)).completionVerifiedAt).toBeInstanceOf(Date);
  });

  test('a verified completion does not mean the passenger has paid', async () => {
    const { passenger, driver, ride } = await inProgress();
    await post(ride._id, 'complete', driver.token, { otp: (await getOtp(ride._id, passenger.token)).body.data.otp.code }).expect(200);
    const pay = await Payment.findOne({ rideId: ride._id });
    expect(pay.status).toBe('PENDING');
    const view = await api().get(`/api/rides/${ride._id}`).set(f.auth(passenger.token));
    expect(view.body.data.ride.payment.status).toBe('PENDING');
  });

  test('a repeated completion (retry) returns the completed ride without new effects; late codes are rejected', async () => {
    const { passenger, driver, ride } = await inProgress();
    const code = (await getOtp(ride._id, passenger.token)).body.data.otp.code;
    await post(ride._id, 'complete', driver.token, { otp: code }).expect(200);
    const again = await post(ride._id, 'complete', driver.token, { otp: code });
    expect(again.status).toBe(200);
    expect(again.body.data.alreadyDone).toBe(true);
    expect(await Payment.countDocuments({ rideId: ride._id })).toBe(1);
    expect(await RideEvent.countDocuments({ rideId: ride._id, eventType: 'TRIP_COMPLETED' })).toBe(1);
    expect((await getOtp(ride._id, passenger.token)).status).toBe(409); // no code needed any more
  });

  test('parallel completions with the right code complete once', async () => {
    const { passenger, driver, ride } = await inProgress();
    const code = (await getOtp(ride._id, passenger.token)).body.data.otp.code;
    const results = await Promise.all(Array.from({ length: 5 }, () => post(ride._id, 'complete', driver.token, { otp: code })));
    expect(results.every((r) => r.status === 200)).toBe(true); // losers see the completed ride (idempotent)
    expect(results.filter((r) => r.body.data.alreadyDone === false)).toHaveLength(1);
    expect(await Payment.countDocuments({ rideId: ride._id })).toBe(1);
    expect(await RideEvent.countDocuments({ rideId: ride._id, eventType: 'TRIP_COMPLETED' })).toBe(1);
  });

  test('the completion code is bound to its ride: another ride\'s code fails', async () => {
    const a = await inProgress();
    const b = await inProgress();
    const codeB = (await getOtp(b.ride._id, b.passenger.token)).body.data.otp.code;
    const codeA = (await getOtp(a.ride._id, a.passenger.token)).body.data.otp.code;
    if (codeA !== codeB) expect((await post(a.ride._id, 'complete', a.driver.token, { otp: codeB })).status).toBe(400);
    expect(rideOtpService.purposeFor('IN_PROGRESS')).toBe('TRIP_COMPLETE');
    expect(await Ride.countDocuments({ status: 'COMPLETED' })).toBe(0);
  });
});
