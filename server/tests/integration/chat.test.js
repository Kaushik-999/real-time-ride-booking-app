'use strict';

const request = require('supertest');
const { useDatabase } = require('../helpers/db');
const f = require('../helpers/factory');
const m = require('../helpers/matching');
const { startServer, waitForEvent, emitWithAck } = require('../helpers/server');
const matching = require('../../src/services/matchingService');
const offerService = require('../../src/services/offerService');
const chatService = require('../../src/services/chatService');
const logger = require('../../src/utils/logger');
const { ChatMessage, ChatReport, Ride, AuditLog, SafetyIncident } = require('../../src/models');

useDatabase();
let srv;
beforeEach(async () => {
  chatService.resetRateLimitForTests();
  srv = await startServer({ adapter: 'memory' });
});
afterEach(async () => {
  jest.restoreAllMocks();
  await srv.close();
});
const api = () => request(srv.app);
let n = 0;
const cid = () => `msg-${Date.now()}-${(n += 1)}`;

async function assignedRide() {
  const passenger = await f.createPassenger();
  const driver = await f.createDriver({ distanceKm: 1 });
  const ride = await f.createRide(passenger);
  await matching.advanceMatching(ride._id);
  await offerService.acceptOffer((await m.pendingOffer(ride._id))._id, driver.id);
  return { passenger, driver, ride, rideId: String(ride._id) };
}

describe('Passenger-driver chat', () => {
  test('passenger and driver exchange messages in real time; messages are persisted', async () => {
    const { passenger, driver, rideId } = await assignedRide();
    const ps = await srv.connect(passenger.token);
    const ds = await srv.connect(driver.token);
    const sent = await emitWithAck(ps, 'chat:send', { rideId, body: 'I am at the gate', clientMessageId: cid() });
    expect(sent).toMatchObject({ ok: true, duplicate: false, message: { body: 'I am at the gate', senderRole: 'PASSENGER' } });
    const got = await waitForEvent(ds, 'chat:message');
    expect(got.body).toBe('I am at the gate');
    await emitWithAck(ds, 'chat:send', { rideId, body: 'Coming in 2 minutes', clientMessageId: cid() });
    await waitForEvent(ps, 'chat:message', (p) => p.senderRole === 'DRIVER');
    expect(await ChatMessage.countDocuments({ rideId })).toBe(2);
    const hist = await api().get(`/api/rides/${rideId}/messages`).set(f.auth(driver.token));
    expect(hist.body.data.messages.map((x) => x.body)).toEqual(['I am at the gate', 'Coming in 2 minutes']);
  });

  test('unrelated passengers and drivers can neither read nor send', async () => {
    const { passenger, rideId } = await assignedRide();
    await api().post(`/api/rides/${rideId}/messages`).set(f.auth(passenger.token)).send({ body: 'hello', clientMessageId: cid() }).expect(201);
    const otherP = await f.createPassenger();
    const otherD = await f.createDriver({ distanceKm: 3 });
    for (const u of [otherP, otherD]) {
      expect((await api().get(`/api/rides/${rideId}/messages`).set(f.auth(u.token))).status).toBe(404);
      expect((await api().post(`/api/rides/${rideId}/messages`).set(f.auth(u.token)).send({ body: 'hi', clientMessageId: cid() })).status).toBe(404);
      const s = await srv.connect(u.token);
      expect(await emitWithAck(s, 'chat:send', { rideId, body: 'sneaky', clientMessageId: cid() })).toMatchObject({ ok: false, error: 'NOT_FOUND' });
      expect(await emitWithAck(s, 'chat:history', { rideId })).toMatchObject({ ok: false, error: 'NOT_FOUND' });
    }
    expect(await ChatMessage.countDocuments({ rideId })).toBe(1);
  });

  test('joining the ride room does not grant chat access (authorisation is checked per message)', async () => {
    const { rideId } = await assignedRide();
    const otherP = await f.createPassenger();
    const s = await srv.connect(otherP.token);
    s.emit('ride:subscribe', { rideId }); // refused, but even if it had worked...
    expect(await emitWithAck(s, 'chat:history', { rideId })).toMatchObject({ ok: false });
  });

  test('a driver who was only offered (not assigned) is not a participant', async () => {
    const passenger = await f.createPassenger();
    const offered = await f.createDriver({ distanceKm: 1 });
    const ride = await f.createRide(passenger);
    await matching.advanceMatching(ride._id);
    expect((await api().get(`/api/rides/${ride._id}/messages`).set(f.auth(offered.token))).status).toBe(404);
    // and while SEARCHING, even the passenger cannot chat yet
    expect((await api().post(`/api/rides/${ride._id}/messages`).set(f.auth(passenger.token)).send({ body: 'hi', clientMessageId: cid() })).status).toBe(409);
  });

  test('reconnecting restores the authorised history', async () => {
    const { passenger, driver, rideId } = await assignedRide();
    const ds = await srv.connect(driver.token);
    await emitWithAck(ds, 'chat:send', { rideId, body: 'one', clientMessageId: cid() });
    const ps1 = await srv.connect(passenger.token);
    ps1.disconnect();
    await emitWithAck(ds, 'chat:send', { rideId, body: 'sent while you were offline', clientMessageId: cid() });
    const ps2 = await srv.connect(passenger.token);
    const hist = await emitWithAck(ps2, 'chat:history', { rideId });
    expect(hist.ok).toBe(true);
    expect(hist.messages.map((x) => x.body)).toEqual(['one', 'sent while you were offline']);
  });

  test('retrying a send with the same clientMessageId does not duplicate the message', async () => {
    const { passenger, rideId } = await assignedRide();
    const ps = await srv.connect(passenger.token);
    const id = cid();
    const results = await Promise.all(Array.from({ length: 4 }, () => emitWithAck(ps, 'chat:send', { rideId, body: 'once', clientMessageId: id })));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(await ChatMessage.countDocuments({ rideId })).toBe(1);
  });

  test('message size and content limits', async () => {
    const { passenger, rideId } = await assignedRide();
    const ps = await srv.connect(passenger.token);
    expect(await emitWithAck(ps, 'chat:send', { rideId, body: 'x'.repeat(501), clientMessageId: cid() })).toMatchObject({ ok: false, error: 'BAD_REQUEST' });
    expect(await emitWithAck(ps, 'chat:send', { rideId, body: '   \u0000  ', clientMessageId: cid() })).toMatchObject({ ok: false, error: 'BAD_REQUEST' });
    expect(await emitWithAck(ps, 'chat:send', { rideId, body: 'ok', clientMessageId: 'bad id!' })).toMatchObject({ ok: false, error: 'BAD_REQUEST' });
    expect((await api().post(`/api/rides/${rideId}/messages`).set(f.auth(passenger.token)).send({ body: 'x'.repeat(2001), clientMessageId: cid() })).status).toBe(400);
    expect(await ChatMessage.countDocuments({ rideId })).toBe(0);
  });

  test('sending too fast is rate limited', async () => {
    const { passenger, rideId } = await assignedRide();
    const ps = await srv.connect(passenger.token);
    const results = [];
    for (let i = 0; i < 12; i += 1) results.push(await emitWithAck(ps, 'chat:send', { rideId, body: `m${i}`, clientMessageId: cid() }));
    expect(results.filter((r) => r.ok)).toHaveLength(10);
    expect(results.slice(10).every((r) => r.error === 'CHAT_RATE_LIMITED')).toBe(true);
  });

  test('after the ride ends chat is read-only, then expires', async () => {
    const { passenger, driver, ride, rideId } = await assignedRide();
    await api().post(`/api/rides/${rideId}/messages`).set(f.auth(passenger.token)).send({ body: 'thanks', clientMessageId: cid() }).expect(201);
    await m.driveTrip(ride._id, driver.id);
    expect((await api().post(`/api/rides/${rideId}/messages`).set(f.auth(driver.token)).send({ body: 'bye', clientMessageId: cid() })).body.error.code).toBe('CHAT_CLOSED');
    expect((await api().get(`/api/rides/${rideId}/messages`).set(f.auth(driver.token))).status).toBe(200);
    await Ride.updateOne({ _id: rideId }, { $set: { completedAt: new Date(Date.now() - 25 * 3600 * 1000) } });
    expect((await api().get(`/api/rides/${rideId}/messages`).set(f.auth(passenger.token))).status).toBe(410);
  });

  test('message contents are never logged', async () => {
    const spies = ['info', 'warn', 'error', 'debug'].map((l) => jest.spyOn(logger, l));
    const { passenger, rideId } = await assignedRide();
    const ps = await srv.connect(passenger.token);
    await emitWithAck(ps, 'chat:send', { rideId, body: 'my flat is 4B, secret-xyz', clientMessageId: cid() });
    expect(JSON.stringify(spies.flatMap((s) => s.mock.calls))).not.toContain('secret-xyz');
  });

  test('participants can report a message; admins with chat:read review it (audited); others cannot', async () => {
    const { passenger, driver, rideId } = await assignedRide();
    const msg = (await api().post(`/api/rides/${rideId}/messages`).set(f.auth(driver.token)).send({ body: 'rude text', clientMessageId: cid() })).body.data.message;
    expect((await api().post(`/api/rides/${rideId}/messages/${msg.id}/report`).set(f.auth(driver.token)).send({ reason: 'own message' })).status).toBe(400);
    await api().post(`/api/rides/${rideId}/messages/${msg.id}/report`).set(f.auth(passenger.token)).send({ reason: 'Rude language' }).expect(201);
    expect((await api().post(`/api/rides/${rideId}/messages/${msg.id}/report`).set(f.auth(passenger.token)).send({ reason: 'again' })).status).toBe(409);
    const noPerm = await f.createAdmin({ adminPermissions: ['rides:read'] });
    expect((await api().get(`/api/admin/rides/${rideId}/messages`).set(f.auth(noPerm.token))).status).toBe(403);
    const admin = await f.createAdmin({ adminPermissions: ['chat:read'] });
    const reports = await api().get('/api/admin/chat-reports?status=OPEN').set(f.auth(admin.token));
    expect(reports.body.data.items).toHaveLength(1);
    const conv = await api().get(`/api/admin/rides/${rideId}/messages`).set(f.auth(admin.token));
    expect(conv.body.data.messages.map((x) => x.body)).toEqual(['rude text']);
    expect(await AuditLog.countDocuments({ action: 'CHAT_VIEWED', actorId: admin.id })).toBe(1);
    await api().patch(`/api/admin/chat-reports/${reports.body.data.items[0].id}`).set(f.auth(admin.token)).send({}).expect(200);
    expect((await ChatReport.findOne()).status).toBe('REVIEWED');
  });

  test('admins cannot read unreported conversations', async () => {
    const { passenger, rideId } = await assignedRide();
    await api().post(`/api/rides/${rideId}/messages`).set(f.auth(passenger.token)).send({ body: 'private', clientMessageId: cid() }).expect(201);
    const admin = await f.createAdmin();
    expect((await api().get(`/api/admin/rides/${rideId}/messages`).set(f.auth(admin.token))).status).toBe(403);
  });

  test('retention: old messages are purged unless held for a report or safety incident', async () => {
    const a = await assignedRide();
    await api().post(`/api/rides/${a.rideId}/messages`).set(f.auth(a.passenger.token)).send({ body: 'old a', clientMessageId: cid() }).expect(201);
    const b = await assignedRide(); // a's driver is ON_TRIP, so b gets its own driver
    await api().post(`/api/rides/${b.rideId}/messages`).set(f.auth(b.passenger.token)).send({ body: 'old b', clientMessageId: cid() }).expect(201);
    await SafetyIncident.create({ rideId: b.rideId, reporterId: b.passenger.user._id, reporterRole: 'PASSENGER' });
    // Raw collection: Mongoose ignores updates to the immutable createdAt timestamp.
    await ChatMessage.collection.updateMany({}, { $set: { createdAt: new Date(Date.now() - 40 * 24 * 3600 * 1000) } });
    expect(await chatService.purgeOldMessages()).toBe(1);
    expect(await ChatMessage.countDocuments({ rideId: a.rideId })).toBe(0);
    expect(await ChatMessage.countDocuments({ rideId: b.rideId })).toBe(1);
  });
});
