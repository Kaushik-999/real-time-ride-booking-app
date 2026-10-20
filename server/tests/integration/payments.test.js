'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { useDatabase } = require('../helpers/db');
const f = require('../helpers/factory');
const m = require('../helpers/matching');
const matching = require('../../src/services/matchingService');
const offerService = require('../../src/services/offerService');
const { sign } = require('../../src/services/paymentService');
const { Payment } = require('../../src/models');

useDatabase();
const app = createApp();

async function completedRide(paymentMethod = 'ONLINE') {
  const passenger = await f.createPassenger();
  const driver = await f.createDriver({ distanceKm: 1 });
  const ride = await f.createRide(passenger, { paymentMethod });
  await matching.advanceMatching(ride._id);
  await offerService.acceptOffer((await m.pendingOffer(ride._id))._id, driver.id);
  await m.driveTrip(ride._id, driver.id);
  return { passenger, driver, ride };
}

function webhook(body, signature = sign(JSON.stringify(body))) {
  return request(app).post('/api/payments/webhook').set('Content-Type', 'application/json').set('X-Signature', signature).send(JSON.stringify(body));
}

describe('I. Payments', () => {
  test('#94 completing a ride creates a PENDING payment, not a successful one', async () => {
    const { ride } = await completedRide();
    const p = await Payment.findOne({ rideId: ride._id });
    expect(p.status).toBe('PENDING');
    expect(p.amount).toBe((await m.rideOf(ride._id)).finalFare);
  });

  test('#91 a passenger cannot pay for (create/alter a payment on) another passenger ride', async () => {
    const { ride } = await completedRide();
    const stranger = await f.createPassenger();
    const res = await request(app).post(`/api/rides/${ride._id}/pay`).set(f.auth(stranger.token)).send({});
    expect(res.status).toBe(404);
    const p = await Payment.findOne({ rideId: ride._id });
    expect(p.status).toBe('PENDING');
    expect(p.providerReference).toBeNull();
    expect(await Payment.countDocuments()).toBe(1);
  });

  test('#92 repeated success callbacks do not double-record; forged callbacks are rejected', async () => {
    const { passenger, ride } = await completedRide();
    const started = await request(app).post(`/api/rides/${ride._id}/pay`).set(f.auth(passenger.token)).send({});
    expect(started.body.data.payment.status).toBe('PROCESSING');
    const ref = started.body.data.payment.providerReference;

    const forged = await webhook({ providerReference: ref, status: 'SUCCEEDED' }, 'a'.repeat(64));
    expect(forged.status).toBe(401);
    expect((await Payment.findOne({ rideId: ride._id })).status).toBe('PROCESSING');

    const body = { providerReference: ref, status: 'SUCCEEDED' };
    const results = await Promise.all([webhook(body), webhook(body), webhook(body)]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.body.data.duplicate === false)).toHaveLength(1);
    const events = await m.eventsOf(ride._id, 'PAYMENT_UPDATED');
    expect(events).toHaveLength(1);
    expect((await Payment.findOne({ rideId: ride._id })).status).toBe('SUCCEEDED');
    // paying again is idempotent
    const again = await request(app).post(`/api/rides/${ride._id}/pay`).set(f.auth(passenger.token)).send({});
    expect(again.body.data.payment.status).toBe('SUCCEEDED');
  });

  test('#93 a failed payment is never marked successful by a late callback', async () => {
    const { passenger, ride } = await completedRide();
    const started = await request(app).post(`/api/rides/${ride._id}/pay`).set(f.auth(passenger.token)).send({});
    const ref = started.body.data.payment.providerReference;
    await webhook({ providerReference: ref, status: 'FAILED', failureReason: 'insufficient funds' }).expect(200);
    const late = await webhook({ providerReference: ref, status: 'SUCCEEDED' });
    expect(late.status).toBe(409);
    expect((await Payment.findOne({ rideId: ride._id })).status).toBe('FAILED');
    // the passenger may retry with a NEW provider reference
    const retry = await request(app).post(`/api/rides/${ride._id}/pay`).set(f.auth(passenger.token)).send({});
    expect(retry.body.data.payment.status).toBe('PROCESSING');
    expect(retry.body.data.payment.providerReference).not.toBe(ref);
  });

  test('cash rides are settled by the assigned driver only', async () => {
    const { driver, passenger, ride } = await completedRide('CASH');
    expect((await request(app).post(`/api/rides/${ride._id}/pay`).set(f.auth(passenger.token)).send({})).status).toBe(409);
    const other = await f.createDriver();
    expect((await request(app).post(`/api/rides/${ride._id}/cash-collected`).set(f.auth(other.token)).send({})).status).toBe(403);
    const ok = await request(app).post(`/api/rides/${ride._id}/cash-collected`).set(f.auth(driver.token)).send({});
    expect(ok.body.data.payment.status).toBe('SUCCEEDED');
  });

  test('a payment cannot be started before the ride is completed', async () => {
    const passenger = await f.createPassenger();
    const ride = await f.createRide(passenger, { paymentMethod: 'ONLINE' });
    const res = await request(app).post(`/api/rides/${ride._id}/pay`).set(f.auth(passenger.token)).send({});
    expect(res.status).toBe(409);
    expect(await Payment.countDocuments()).toBe(0);
  });
});
