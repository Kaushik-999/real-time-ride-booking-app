'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { useDatabase } = require('../helpers/db');
const f = require('../helpers/factory');
const m = require('../helpers/matching');
const matching = require('../../src/services/matchingService');
const offerService = require('../../src/services/offerService');
const { AuditLog, Payment, User, DriverProfile, SafetyIncident } = require('../../src/models');

useDatabase();
const app = createApp();
const api = () => request(app);
const ID = '507f1f77bcf86cd799439011';

// [method, url, permission needed, body]
const ENDPOINTS = [
  ['get', '/api/admin/users', 'users:read'],
  ['get', `/api/admin/users/${ID}`, 'users:read'],
  ['patch', `/api/admin/users/${ID}/status`, 'users:manage', { accountStatus: 'SUSPENDED', reason: 'test' }],
  ['patch', `/api/admin/users/${ID}/permissions`, 'users:manage', { permissions: [] }],
  ['get', '/api/admin/drivers', 'drivers:review'],
  ['get', `/api/admin/drivers/${ID}`, 'drivers:review'],
  ['patch', `/api/admin/drivers/${ID}/approval`, 'drivers:review', { approvalStatus: 'APPROVED' }],
  ['patch', `/api/admin/drivers/${ID}/female-verification`, 'drivers:review', { status: 'VERIFIED' }],
  ['patch', `/api/admin/drivers/${ID}/vehicle`, 'drivers:review', { capacity: 2 }],
  ['get', `/api/admin/drivers/${ID}/documents/${ID}/file`, 'documents:read'],
  ['get', '/api/admin/rides', 'rides:read'],
  ['get', `/api/admin/rides/${ID}`, 'rides:read'],
  ['post', `/api/admin/rides/${ID}/cancel`, 'rides:manage', { reason: 'test' }],
  ['get', `/api/admin/rides/${ID}/messages`, 'chat:read'],
  ['get', '/api/admin/chat-reports', 'chat:read'],
  ['get', '/api/admin/reviews', 'reviews:moderate'],
  ['patch', `/api/admin/reviews/${ID}/moderation`, 'reviews:moderate', { status: 'HIDDEN', reason: 'x' }],
  ['get', '/api/admin/safety-incidents', 'safety:manage'],
  ['patch', `/api/admin/safety-incidents/${ID}`, 'safety:manage', { action: 'ACKNOWLEDGE' }],
  ['get', '/api/admin/payments', 'payments:read'],
  ['post', `/api/admin/payments/${ID}/refund-request`, 'payments:refund', { reason: 'test' }],
  ['get', '/api/admin/audit-logs', 'audit:read'],
];

async function completedRide(paymentMethod = 'CASH') {
  const passenger = await f.createPassenger();
  const driver = await f.createDriver({ distanceKm: 1 });
  const ride = await f.createRide(passenger, { paymentMethod });
  await matching.advanceMatching(ride._id);
  await offerService.acceptOffer((await m.pendingOffer(ride._id))._id, driver.id);
  await m.driveTrip(ride._id, driver.id);
  await DriverProfile.updateOne({ userId: driver.id }, { $set: { availability: 'OFFLINE' } });
  return { passenger, driver, ride };
}

describe('Admin management and audit', () => {
  test('non-admins get 403 from every admin endpoint; unauthenticated get 401', async () => {
    const p = await f.createPassenger();
    const d = await f.createDriver();
    for (const [method, url, , body] of ENDPOINTS) {
      expect((await api()[method](url).send(body || {})).status).toBe(401);
      expect((await api()[method](url).set(f.auth(p.token)).send(body || {})).status).toBe(403);
      expect((await api()[method](url).set(f.auth(d.token)).send(body || {})).status).toBe(403);
    }
  });

  test('admins lacking the specific permission get 403 (backend-enforced, not hidden buttons)', async () => {
    for (const [method, url, permission, body] of ENDPOINTS) {
      const others = ['users:read', 'rides:read', 'audit:read'].filter((x) => x !== permission);
      const admin = await f.createAdmin({ adminPermissions: others.slice(0, 1) });
      const res = await api()[method](url).set(f.auth(admin.token)).send(body || {});
      expect([method, url, res.status]).toEqual([method, url, 403]);
    }
  });

  test('passenger management: search, filter, paginate, detail with verification status', async () => {
    const admin = await f.createAdmin();
    await f.createPassenger({ name: 'Asha Rao', phone: '+919811111111', phoneVerifiedAt: new Date() });
    await f.createPassenger({ name: 'Ravi Kumar' });
    await f.createPassenger({ name: 'Asha Iyer', accountStatus: 'SUSPENDED' });
    const res = await api().get('/api/admin/users?role=PASSENGER&q=asha&limit=1&page=1').set(f.auth(admin.token));
    expect(res.body.data).toMatchObject({ total: 2, page: 1, limit: 1 });
    const susp = await api().get('/api/admin/users?accountStatus=SUSPENDED').set(f.auth(admin.token));
    expect(susp.body.data.items.map((u) => u.name)).toEqual(['Asha Iyer']);
    // regex characters in q are treated literally
    expect((await api().get('/api/admin/users?q=.*').set(f.auth(admin.token))).body.data.total).toBe(0);
    const asha = (await User.findOne({ name: 'Asha Rao' })).id;
    const detail = await api().get(`/api/admin/users/${asha}`).set(f.auth(admin.token));
    expect(detail.body.data.verification).toMatchObject({ emailPasswordLogin: true, phone: { verified: true }, linkedProviders: [] });
    expect(JSON.stringify(detail.body)).not.toMatch(/passwordHash/);
  });

  test('suspension: reason required, audited, blocks the user, cannot target admins or self, reversible', async () => {
    const admin = await f.createAdmin();
    const p = await f.createPassenger();
    const url = `/api/admin/users/${p.id}/status`;
    expect((await api().patch(url).set(f.auth(admin.token)).send({ accountStatus: 'SUSPENDED' })).status).toBe(400);
    await api().patch(url).set(f.auth(admin.token)).send({ accountStatus: 'SUSPENDED', reason: 'Fraudulent bookings' }).expect(200);
    expect((await api().get('/api/auth/me').set(f.auth(p.token))).status).toBe(403);
    expect(await AuditLog.countDocuments({ action: 'ACCOUNT_SUSPENDED', targetId: p.id, actorId: admin.id })).toBe(1);
    const otherAdmin = await f.createAdmin();
    expect((await api().patch(`/api/admin/users/${otherAdmin.id}/status`).set(f.auth(admin.token)).send({ accountStatus: 'SUSPENDED', reason: 'x y z' })).status).toBe(403);
    expect((await api().patch(`/api/admin/users/${admin.id}/status`).set(f.auth(admin.token)).send({ accountStatus: 'SUSPENDED', reason: 'x y z' })).status).toBe(403);
    await api().patch(url).set(f.auth(admin.token)).send({ accountStatus: 'ACTIVE' }).expect(200);
    expect((await api().get('/api/auth/me').set(f.auth(p.token))).status).toBe(200);
  });

  test('a driver holding a ride cannot be suspended until it ends', async () => {
    const admin = await f.createAdmin();
    const passenger = await f.createPassenger();
    const driver = await f.createDriver({ distanceKm: 1 });
    const ride = await f.createRide(passenger);
    await matching.advanceMatching(ride._id);
    await offerService.acceptOffer((await m.pendingOffer(ride._id))._id, driver.id);
    const res = await api().patch(`/api/admin/users/${driver.id}/status`).set(f.auth(admin.token)).send({ accountStatus: 'SUSPENDED', reason: 'Complaint' });
    expect(res.status).toBe(409);
    expect((await User.findById(driver.id)).accountStatus).toBe('ACTIVE');
  });

  test('ride search filters and admin cancellation (reason required, audited, releases driver)', async () => {
    const admin = await f.createAdmin();
    const passenger = await f.createPassenger();
    const driver = await f.createDriver({ distanceKm: 1 });
    const ride = await f.createRide(passenger);
    await matching.advanceMatching(ride._id);
    await offerService.acceptOffer((await m.pendingOffer(ride._id))._id, driver.id);
    const found = await api().get(`/api/admin/rides?status=DRIVER_ASSIGNED&passengerId=${passenger.id}`).set(f.auth(admin.token));
    expect(found.body.data.items.map((r) => r.id)).toEqual([String(ride._id)]);
    expect((await api().get(`/api/admin/rides?driverId=${ID}`).set(f.auth(admin.token))).body.data.total).toBe(0);
    expect((await api().post(`/api/admin/rides/${ride._id}/cancel`).set(f.auth(admin.token)).send({})).status).toBe(400);
    const res = await api().post(`/api/admin/rides/${ride._id}/cancel`).set(f.auth(admin.token)).send({ reason: 'Passenger called support' });
    expect(res.status).toBe(200);
    expect((await m.rideOf(ride._id)).status).toBe('CANCELLED');
    expect(await m.profileOf(driver)).toMatchObject({ availability: 'AVAILABLE', activeRideId: null });
    expect(await AuditLog.countDocuments({ action: 'RIDE_CANCELLED_BY_ADMIN' })).toBe(1);
    // passengers' cancel route no longer accepts admins (they must use the audited route)
    expect((await api().post(`/api/rides/${ride._id}/cancel`).set(f.auth(admin.token)).send({})).status).toBe(403);
  });

  test('ride inspection shows safety incidents consistently with the incident records', async () => {
    const admin = await f.createAdmin();
    const passenger = await f.createPassenger();
    const driver = await f.createDriver({ distanceKm: 1 });
    const ride = await f.createRide(passenger);
    await matching.advanceMatching(ride._id);
    await offerService.acceptOffer((await m.pendingOffer(ride._id))._id, driver.id);
    await api().post(`/api/rides/${ride._id}/safety-incidents`).set(f.auth(passenger.token)).send({}).expect(201);
    const detail = await api().get(`/api/admin/rides/${ride._id}`).set(f.auth(admin.token));
    const incidents = await api().get('/api/admin/safety-incidents').set(f.auth(admin.token));
    expect(detail.body.data.safetyIncidents).toHaveLength(1);
    expect(detail.body.data.safetyIncidents[0].id).toBe(incidents.body.data.items[0].id);
    expect(incidents.body.data.items[0].rideId).toBe(String(ride._id));
    expect(await SafetyIncident.countDocuments()).toBe(1);
  });

  test('refunds are recorded as manual requests, never as completed refunds', async () => {
    const admin = await f.createAdmin();
    const { ride, driver } = await completedRide('CASH');
    await api().post(`/api/rides/${ride._id}/cash-collected`).set(f.auth(driver.token)).send({}).expect(200);
    const pay = await Payment.findOne({ rideId: ride._id });
    const url = `/api/admin/payments/${pay._id}/refund-request`;
    const res = await api().post(url).set(f.auth(admin.token)).send({ reason: 'Driver overcharged' });
    expect(res.status).toBe(200);
    expect(res.body.data.notice).toMatch(/No money has been moved/);
    const after = await Payment.findById(pay._id);
    expect(after.status).toBe('SUCCEEDED'); // NOT "REFUNDED"
    expect(after.refund.status).toBe('REQUESTED_MANUAL');
    expect((await api().post(url).set(f.auth(admin.token)).send({ reason: 'again' })).status).toBe(409);
    expect(await AuditLog.countDocuments({ action: 'REFUND_REQUESTED' })).toBe(1);
    const list = await api().get('/api/admin/payments?refund=requested').set(f.auth(admin.token));
    expect(list.body.data.total).toBe(1);
  });

  test('a refund cannot be requested for an unpaid payment', async () => {
    const admin = await f.createAdmin();
    const { ride } = await completedRide('ONLINE');
    const pay = await Payment.findOne({ rideId: ride._id });
    expect((await api().post(`/api/admin/payments/${pay._id}/refund-request`).set(f.auth(admin.token)).send({ reason: 'test refund' })).status).toBe(409);
  });

  test('audit log lists sensitive actions with pagination and filters', async () => {
    const admin = await f.createAdmin();
    for (let i = 0; i < 3; i += 1) {
      const p = await f.createPassenger();
      await api().patch(`/api/admin/users/${p.id}/status`).set(f.auth(admin.token)).send({ accountStatus: 'SUSPENDED', reason: `case ${i}` }).expect(200);
    }
    const page = await api().get('/api/admin/audit-logs?action=ACCOUNT_SUSPENDED&limit=2&page=2').set(f.auth(admin.token));
    expect(page.body.data).toMatchObject({ total: 3, page: 2, limit: 2 });
    expect(page.body.data.items).toHaveLength(1);
    expect(page.body.data.items[0]).toMatchObject({ action: 'ACCOUNT_SUSPENDED', targetType: 'User', actor: { id: admin.id } });
  });

  test('only super admins can change admin permissions; changes are audited', async () => {
    const superAdmin = await f.createAdmin();
    const limited = await f.createAdmin({ adminPermissions: ['users:manage'] });
    const target = await f.createAdmin({ adminPermissions: ['rides:read'] });
    expect((await api().patch(`/api/admin/users/${target.id}/permissions`).set(f.auth(limited.token)).send({ permissions: ['*'] })).status).toBe(403);
    expect((await api().patch(`/api/admin/users/${target.id}/permissions`).set(f.auth(superAdmin.token)).send({ permissions: ['bogus'] })).status).toBe(400);
    await api().patch(`/api/admin/users/${target.id}/permissions`).set(f.auth(superAdmin.token)).send({ permissions: ['rides:read', 'safety:manage'] }).expect(200);
    expect((await User.findById(target.id)).adminPermissions).toEqual(['rides:read', 'safety:manage']);
    expect(await AuditLog.countDocuments({ action: 'ADMIN_PERMISSIONS_CHANGED' })).toBe(1);
  });

  test('driver detail for reviewers never exposes storage keys; metrics cover the new features', async () => {
    const admin = await f.createAdmin();
    const d = await f.createDriver();
    const detail = await api().get(`/api/admin/drivers/${d.id}`).set(f.auth(admin.token));
    expect(detail.status).toBe(200);
    expect(JSON.stringify(detail.body)).not.toMatch(/storageKey|passwordHash/);
    const metrics = await api().get('/api/admin/metrics').set(f.auth(admin.token));
    expect(metrics.body.data).toMatchObject({
      openSafetyIncidents: 0,
      failedEmergencyDispatches: 0,
      pendingDriverReviews: 0,
      hiddenReviews: 0,
      openChatReports: 0,
      refundRequests: 0,
    });
  });
});
