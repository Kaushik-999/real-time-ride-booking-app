'use strict';

const http = require('http');
const crypto = require('crypto');
const request = require('supertest');
const { useDatabase } = require('../helpers/db');
const f = require('../helpers/factory');
const m = require('../helpers/matching');
const { startServer, waitForEvent } = require('../helpers/server');
const matching = require('../../src/services/matchingService');
const offerService = require('../../src/services/offerService');
const safetyService = require('../../src/services/safetyService');
const emergency = require('../../src/services/emergencyService');
const { SafetyIncident, AuditLog, RideEvent } = require('../../src/models');

useDatabase();
let srv;
beforeEach(async () => {
  srv = await startServer({ adapter: 'memory' });
});
afterEach(async () => {
  emergency.setProviderForTesting(emergency.createNoneProvider());
  await srv.close();
});
const api = () => request(srv.app);

async function activeRide() {
  const passenger = await f.createPassenger();
  const driver = await f.createDriver({ distanceKm: 1 });
  const ride = await f.createRide(passenger);
  await matching.advanceMatching(ride._id);
  await offerService.acceptOffer((await m.pendingOffer(ride._id))._id, driver.id);
  return { passenger, driver, ride, rideId: String(ride._id) };
}
const press = (rideId, token, body = {}) => api().post(`/api/rides/${rideId}/safety-incidents`).set(f.auth(token)).send(body);

/** A fake external emergency service that answers however the test wants. */
async function fakeEmergencyService(handler) {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      handler(req, res, body, received.length);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/alerts`, received, close: () => new Promise((r) => server.close(r)) };
}

describe('Safety button and incidents', () => {
  test('a passenger raises an incident for their active ride; admins are alerted; no false dispatch claim', async () => {
    const admin = await f.createAdmin();
    const as = await srv.connect(admin.token);
    const { passenger, rideId } = await activeRide();
    const res = await press(rideId, passenger.token, { lat: 12.97, lng: 77.6, message: 'Driver took a strange route' });
    expect(res.status).toBe(201);
    const inc = res.body.data.incident;
    expect(inc).toMatchObject({ reporterRole: 'PASSENGER', status: 'OPEN', location: { lat: 12.97, lng: 77.6, source: 'DEVICE' } });
    expect(inc.emergency).toMatchObject({ status: 'NOT_CONFIGURED', policeNotified: false, emergencyNumber: '112' });
    expect(inc.emergency.message).toMatch(/not available/i);
    expect(inc.emergency.message).toMatch(/112/);
    const evt = await waitForEvent(as, 'safety:incident');
    expect(evt.incidentId).toBe(inc.id);
    expect(await RideEvent.countDocuments({ rideId, eventType: 'SAFETY_INCIDENT' })).toBe(1);
  });

  test('the assigned driver can raise one too; without device location the last known driver location is used', async () => {
    const { driver, rideId } = await activeRide();
    const res = await press(rideId, driver.token);
    expect(res.status).toBe(201);
    expect(res.body.data.incident).toMatchObject({ reporterRole: 'DRIVER', location: { source: 'DRIVER_LAST_KNOWN' } });
  });

  test('unrelated users cannot raise or read incidents for a ride', async () => {
    const { passenger, rideId } = await activeRide();
    const id = (await press(rideId, passenger.token)).body.data.incident.id;
    const other = await f.createPassenger();
    const otherDriver = await f.createDriver();
    expect((await press(rideId, other.token)).status).toBe(404);
    expect((await press(rideId, otherDriver.token)).status).toBe(404);
    expect((await api().get(`/api/safety/incidents/${id}`).set(f.auth(other.token))).status).toBe(404);
    expect((await api().get(`/api/admin/safety-incidents/${id}`).set(f.auth(other.token))).status).toBe(403);
    const limitedAdmin = await f.createAdmin({ adminPermissions: ['rides:read'] });
    expect((await api().get(`/api/admin/safety-incidents/${id}`).set(f.auth(limitedAdmin.token))).status).toBe(403);
    expect((await api().get(`/api/safety/incidents/${id}`).set(f.auth(passenger.token))).status).toBe(200);
  });

  test('only during an active ride', async () => {
    const passenger = await f.createPassenger();
    const ride = await f.createRide(passenger); // SEARCHING, no driver
    expect((await press(ride._id, passenger.token)).body.error.code).toBe('NOT_ACTIVE_RIDE');
  });

  test('repeated presses (even simultaneous) create ONE incident and record each press', async () => {
    const { passenger, rideId } = await activeRide();
    const results = await Promise.all(Array.from({ length: 5 }, () => press(rideId, passenger.token)));
    expect(results.every((r) => [200, 201].includes(r.status))).toBe(true);
    expect(results.filter((r) => r.body.data.duplicate === false)).toHaveLength(1);
    expect(await SafetyIncident.countDocuments({ rideId })).toBe(1);
    const inc = await SafetyIncident.findOne({ rideId });
    expect(inc.history.map((h) => h.action)).toEqual(['REPORTED', 'REPEATED_ALERT', 'REPEATED_ALERT', 'REPEATED_ALERT', 'REPEATED_ALERT']);
  });

  test('a configured integration that confirms acceptance is reported as accepted, with a signed request', async () => {
    const secret = 'test-emergency-secret-123';
    const svc = await fakeEmergencyService((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ accepted: true, reference: 'ERS-42' }));
    });
    try {
      emergency.setProviderForTesting(emergency.createWebhookProvider({ url: svc.url, secret }));
      const { passenger, rideId } = await activeRide();
      const res = await press(rideId, passenger.token, { lat: 12.97, lng: 77.6 });
      expect(res.body.data.incident.emergency).toMatchObject({ status: 'ACCEPTED', policeNotified: true, reference: 'ERS-42' });
      const sent = svc.received[0];
      expect(sent.headers['x-signature']).toBe(crypto.createHmac('sha256', secret).update(sent.body).digest('hex'));
      expect(JSON.parse(sent.body)).toMatchObject({ rideId, reporterRole: 'PASSENGER', location: { lat: 12.97, lng: 77.6 } });
    } finally {
      await svc.close();
    }
  });

  test.each([
    ['an error status', (req, res) => { res.writeHead(503); res.end(); }],
    ['a 200 that does not confirm acceptance', (req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); }],
    ['a non-JSON body', (req, res) => { res.writeHead(200); res.end('received'); }],
  ])('a failing integration (%s) is never reported as dispatched; it retries, then FAILS visibly', async (_n, handler) => {
    const svc = await fakeEmergencyService(handler);
    try {
      emergency.setProviderForTesting(emergency.createWebhookProvider({ url: svc.url, secret: 'test-emergency-secret-123' }));
      const admin = await f.createAdmin();
      const as = await srv.connect(admin.token);
      const { passenger, rideId } = await activeRide();
      const res = await press(rideId, passenger.token);
      expect(res.body.data.incident.emergency).toMatchObject({ status: 'PENDING', policeNotified: false });
      expect(res.body.data.incident.emergency.message).toMatch(/NOT confirmed/);
      // run the retries the worker would run (skip the backoff wait)
      for (let i = 0; i < 6; i += 1) {
        await SafetyIncident.updateMany({}, { $set: { 'emergencyDispatch.nextAttemptAt': new Date(0) } });
        await safetyService.retryDueDispatches();
      }
      const inc = await SafetyIncident.findOne({ rideId });
      expect(inc.emergencyDispatch.status).toBe('FAILED');
      expect(inc.emergencyDispatch.attempts).toBe(5);
      expect(svc.received).toHaveLength(5);
      expect(inc.history.filter((h) => h.action === 'DISPATCH_ATTEMPT_FAILED')).toHaveLength(4);
      expect(inc.history.at(-1).action).toBe('DISPATCH_FAILED');
      await waitForEvent(as, 'safety:dispatch-failed');
      const view = await api().get(`/api/safety/incidents/${inc._id}`).set(f.auth(passenger.token));
      expect(view.body.data.incident.emergency).toMatchObject({ status: 'FAILED', policeNotified: false });
      expect(view.body.data.incident.emergency.message).toMatch(/could not reach/);
    } finally {
      await svc.close();
    }
  });

  test('an unreachable integration (network error) is also a failure, not a success', async () => {
    emergency.setProviderForTesting(emergency.createWebhookProvider({ url: 'http://127.0.0.1:9/nothing-here', secret: 'test-emergency-secret-123', timeoutMs: 500 }));
    const { passenger, rideId } = await activeRide();
    const res = await press(rideId, passenger.token);
    expect(res.body.data.incident.emergency.policeNotified).toBe(false);
    expect((await SafetyIncident.findOne({ rideId })).emergencyDispatch.lastError).toMatch(/network|timeout/);
  });

  test('two workers retrying at once deliver an incident only once (lease)', async () => {
    let calls = 0;
    const svc = await fakeEmergencyService((req, res) => {
      calls += 1;
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ accepted: true, reference: 'R1' }));
      }, 100);
    });
    try {
      emergency.setProviderForTesting(emergency.createNoneProvider());
      const { passenger, rideId } = await activeRide();
      await press(rideId, passenger.token);
      await SafetyIncident.updateMany({}, { $set: { 'emergencyDispatch.status': 'PENDING', 'emergencyDispatch.nextAttemptAt': new Date(0), 'emergencyDispatch.attempts': 0 } });
      emergency.setProviderForTesting(emergency.createWebhookProvider({ url: svc.url, secret: 'test-emergency-secret-123' }));
      await Promise.all([safetyService.retryDueDispatches(), safetyService.retryDueDispatches(), safetyService.retryDueDispatches()]);
      expect(calls).toBe(1);
      expect((await SafetyIncident.findOne({ rideId })).emergencyDispatch.status).toBe('ACCEPTED');
    } finally {
      await svc.close();
    }
  });

  test('admins acknowledge, escalate and resolve (note required); every step is audited and visible in history', async () => {
    const { passenger, rideId } = await activeRide();
    const id = (await press(rideId, passenger.token)).body.data.incident.id;
    const admin = await f.createAdmin({ adminPermissions: ['safety:manage'] });
    const act = (body) => api().patch(`/api/admin/safety-incidents/${id}`).set(f.auth(admin.token)).send(body);
    await act({ action: 'ACKNOWLEDGE', note: 'Calling passenger' }).expect(200);
    await act({ action: 'ESCALATE', note: 'Senior safety team' }).expect(200);
    expect((await act({ action: 'RESOLVE' })).status).toBe(400);
    const done = await act({ action: 'RESOLVE', note: 'Passenger safe at home' });
    expect(done.body.data.incident.status).toBe('RESOLVED');
    expect(done.body.data.incident.history.map((h) => h.action)).toEqual(['REPORTED', 'ACKNOWLEDGE', 'ESCALATE', 'RESOLVE']);
    expect(await AuditLog.countDocuments({ targetId: id })).toBe(3);
    expect((await act({ action: 'ACKNOWLEDGE' })).status).toBe(409);
    // escalation is internal: it does not claim external dispatch
    expect(done.body.data.incident.emergency.policeNotified).toBe(false);
    // after resolution a new press opens a new incident
    expect((await press(rideId, passenger.token)).status).toBe(201);
  });

  test('retrying dispatch without an integration is refused, not faked', async () => {
    const { passenger, rideId } = await activeRide();
    const id = (await press(rideId, passenger.token)).body.data.incident.id;
    const admin = await f.createAdmin();
    const res = await api().patch(`/api/admin/safety-incidents/${id}`).set(f.auth(admin.token)).send({ action: 'RETRY_DISPATCH' });
    expect(res.status).toBe(409);
    expect((await SafetyIncident.findById(id)).emergencyDispatch.status).toBe('NOT_CONFIGURED');
  });

  test('the safety config tells the app whether automated dispatch exists', async () => {
    const p = await f.createPassenger();
    const res = await api().get('/api/safety/config').set(f.auth(p.token));
    expect(res.body.data).toEqual({ emergencyNumber: '112', automatedDispatchAvailable: false });
  });

  test('invalid location and half-coordinates are rejected', async () => {
    const { passenger, rideId } = await activeRide();
    expect((await press(rideId, passenger.token, { lat: 95, lng: 77 })).status).toBe(400);
    expect((await press(rideId, passenger.token, { lat: 12 })).status).toBe(400);
  });
});
