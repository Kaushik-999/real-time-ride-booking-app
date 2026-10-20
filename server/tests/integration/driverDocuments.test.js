'use strict';

const fs = require('fs');
const request = require('supertest');
const { createApp } = require('../../src/app');
const { useDatabase } = require('../helpers/db');
const f = require('../helpers/factory');
const docs = require('../helpers/documents');
const storage = require('../../src/services/documentStorage');
const onboarding = require('../../src/services/driverOnboardingService');
const { DriverDocument, DriverProfile, AuditLog, RideOffer } = require('../../src/models');
const matching = require('../../src/services/matchingService');

useDatabase();
const app = createApp();
const api = () => request(app);

async function newDriver() {
  const d = await f.createDriver({ approved: false, availability: 'OFFLINE' });
  await DriverProfile.updateOne(
    { _id: d.profile._id },
    { $set: { approvalStatus: 'DOCUMENTS_REQUIRED', identity: { legalName: 'Test Driver', dateOfBirth: new Date('1990-01-01'), licenseNumber: 'KA0120190001' } } }
  );
  return d;
}
const decide = (admin, driverId, body) => api().patch(`/api/admin/drivers/${driverId}/approval`).set(f.auth(admin.token)).send(body);

describe('Driver registration and document verification', () => {
  test('a new driver starts with documents required and cannot go online', async () => {
    const d = await newDriver();
    const st = await api().get('/api/drivers/me/onboarding').set(f.auth(d.token));
    expect(st.body.data).toMatchObject({ approvalStatus: 'DOCUMENTS_REQUIRED', canSubmit: false, missingDocuments: docs.REQUIRED });
    expect((await api().patch('/api/drivers/me/availability').set(f.auth(d.token)).send({ availability: 'AVAILABLE' })).status).toBe(403);
  });

  test('uploads are stored encrypted in private storage and the storage key is never exposed', async () => {
    const d = await newDriver();
    const file = docs.png();
    const res = await docs.upload(request, app, d.token, 'PHOTO', { buffer: file });
    expect(res.status).toBe(201);
    expect(res.body.data.document).toMatchObject({ type: 'PHOTO', mimeType: 'image/png', status: 'SUBMITTED' });
    expect(JSON.stringify(res.body)).not.toMatch(/storageKey|private-uploads/);
    const stored = await DriverDocument.findById(res.body.data.document.id).select('+storageKey');
    const onDisk = fs.readFileSync(storage.fileFor(stored.storageKey));
    expect(onDisk.includes(file)).toBe(false); // ciphertext, not the original bytes
    expect(onDisk.subarray(0, 4).equals(file.subarray(0, 4))).toBe(false);
    expect((await storage.get(stored.storageKey)).equals(file)).toBe(true);
    expect((fs.statSync(storage.fileFor(stored.storageKey)).mode & 0o777).toString(8)).toBe('600');
  });

  test.each([
    ['text disguised as PNG', { buffer: Buffer.from('hello I am not an image at all'), filename: 'x.png', contentType: 'image/png' }, 415],
    ['executable', { buffer: Buffer.from('MZ\x90\x00 fake exe content here'), filename: 'x.exe', contentType: 'application/octet-stream' }, 415],
    ['PDF declared as JPEG', { buffer: docs.pdf(), filename: 'x.jpg', contentType: 'image/jpeg' }, 415],
    ['oversized file', { buffer: Buffer.concat([docs.png(), Buffer.alloc(5 * 1024 * 1024)]), filename: 'big.png', contentType: 'image/png' }, 413],
  ])('rejects %s', async (_n, opts, status) => {
    const d = await newDriver();
    const res = await docs.upload(request, app, d.token, 'PHOTO', opts);
    expect(res.status).toBe(status);
    expect(await DriverDocument.countDocuments()).toBe(0);
  });

  test('unknown document type and missing file are rejected', async () => {
    const d = await newDriver();
    expect((await docs.upload(request, app, d.token, 'PASSPORT_SCAN')).status).toBe(400);
    const nofile = await api().post('/api/drivers/me/documents').set(f.auth(d.token)).field('type', 'PHOTO');
    expect(nofile.status).toBe(400);
  });

  test('cannot submit until identity and all required documents exist; then PENDING_REVIEW locks uploads', async () => {
    const d = await newDriver();
    await docs.upload(request, app, d.token, 'PHOTO').expect(201);
    const early = await api().post('/api/drivers/me/submit-for-review').set(f.auth(d.token)).send({});
    expect(early.status).toBe(400);
    expect(early.body.error.message).toMatch(/DRIVING_LICENSE/);
    for (const t of ['DRIVING_LICENSE', 'VEHICLE_RC', 'AADHAAR']) await docs.upload(request, app, d.token, t, { buffer: docs.pdf(), filename: 'x.pdf', contentType: 'application/pdf' }).expect(201);
    await api().post('/api/drivers/me/submit-for-review').set(f.auth(d.token)).send({}).expect(200);
    expect((await DriverProfile.findById(d.profile._id)).approvalStatus).toBe('PENDING_REVIEW');
    expect((await docs.upload(request, app, d.token, 'PAN')).status).toBe(409);
    expect((await api().patch('/api/drivers/me/availability').set(f.auth(d.token)).send({ availability: 'AVAILABLE' })).status).toBe(403);
  });

  test('admin approval records reviewer + audit entry, accepts documents, and lets the driver go online', async () => {
    const d = await docs.submittedDriver(request, app, f);
    const admin = await f.createAdmin();
    const res = await decide(admin, d.id, { approvalStatus: 'APPROVED' });
    expect(res.status).toBe(200);
    const p = await DriverProfile.findById(d.profile._id);
    expect(p.approvalStatus).toBe('APPROVED');
    expect(String(p.review.reviewedBy)).toBe(admin.id);
    expect(p.review.reviewedAt).toBeInstanceOf(Date);
    expect(await DriverDocument.countDocuments({ driverId: d.id, status: 'ACCEPTED' })).toBe(4);
    expect(await AuditLog.countDocuments({ action: 'DRIVER_APPROVED', targetId: d.id, actorId: admin.id })).toBe(1);
    expect((await api().patch('/api/drivers/me/availability').set(f.auth(d.token)).send({ availability: 'AVAILABLE' })).status).toBe(200);
  });

  test('rejection needs a reason, is shown to the driver, and the driver can fix and resubmit', async () => {
    const d = await docs.submittedDriver(request, app, f);
    const admin = await f.createAdmin();
    expect((await decide(admin, d.id, { approvalStatus: 'REJECTED' })).status).toBe(400);
    const license = await DriverDocument.findOne({ driverId: d.id, type: 'DRIVING_LICENSE' });
    const rej = await decide(admin, d.id, {
      approvalStatus: 'REJECTED',
      reason: 'Licence photo is blurry',
      documentDecisions: [{ documentId: String(license._id), status: 'REJECTED', reason: 'Blurry' }],
    });
    expect(rej.status).toBe(200);
    const st = await api().get('/api/drivers/me/onboarding').set(f.auth(d.token));
    expect(st.body.data).toMatchObject({ approvalStatus: 'REJECTED', rejectionReason: 'Licence photo is blurry', missingDocuments: ['DRIVING_LICENSE'], canSubmit: false });
    expect((await DriverDocument.findById(license._id)).deleteAfter).toBeInstanceOf(Date); // retention scheduled
    await docs.upload(request, app, d.token, 'DRIVING_LICENSE').expect(201);
    await api().post('/api/drivers/me/submit-for-review').set(f.auth(d.token)).send({}).expect(200);
    expect((await DriverProfile.findById(d.profile._id)).approvalStatus).toBe('PENDING_REVIEW');
  });

  test('a rejected driver can neither be offered nor accept rides', async () => {
    const d = await f.createDriver({ distanceKm: 1 });
    const ride = await f.createRide(await f.createPassenger());
    await matching.advanceMatching(ride._id);
    const offer = await RideOffer.findOne({ rideId: ride._id });
    await DriverProfile.updateOne({ _id: d.profile._id }, { $set: { approvalStatus: 'REJECTED' } });
    expect((await api().post(`/api/offers/${offer._id}/accept`).set(f.auth(d.token)).send({})).status).toBe(403);
    const ride2 = await f.createRide(await f.createPassenger());
    await DriverProfile.updateOne({ _id: d.profile._id }, { $set: { availability: 'AVAILABLE', activeRideId: null } });
    expect((await matching.advanceMatching(ride2._id)).outcome).toBe('no_driver_found');
  });

  test('approving with a rejected/missing required document is refused', async () => {
    const d = await docs.submittedDriver(request, app, f);
    const admin = await f.createAdmin();
    const rc = await DriverDocument.findOne({ driverId: d.id, type: 'VEHICLE_RC' });
    const res = await decide(admin, d.id, { approvalStatus: 'APPROVED', documentDecisions: [{ documentId: String(rc._id), status: 'REJECTED' }] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DOCUMENTS_INCOMPLETE');
    expect((await DriverProfile.findById(d.profile._id)).approvalStatus).toBe('PENDING_REVIEW');
    expect((await DriverDocument.findById(rc._id)).status).toBe('SUBMITTED'); // whole decision rolled back
  });

  test('invalid transitions are refused (e.g. approving a driver who never submitted)', async () => {
    const d = await newDriver();
    const admin = await f.createAdmin();
    expect((await decide(admin, d.id, { approvalStatus: 'APPROVED' })).status).toBe(409);
  });

  test('suspension needs a reason, takes the driver offline, and blocks going online', async () => {
    const d = await f.createDriver();
    const admin = await f.createAdmin();
    expect((await decide(admin, d.id, { approvalStatus: 'SUSPENDED' })).status).toBe(400);
    await decide(admin, d.id, { approvalStatus: 'SUSPENDED', reason: 'Safety complaint under investigation' }).expect(200);
    expect(await DriverProfile.findById(d.profile._id)).toMatchObject({ approvalStatus: 'SUSPENDED', availability: 'OFFLINE' });
    expect((await api().patch('/api/drivers/me/availability').set(f.auth(d.token)).send({ availability: 'AVAILABLE' })).status).toBe(403);
    await decide(admin, d.id, { approvalStatus: 'APPROVED' }).expect(200);
  });

  test('documents are not publicly accessible; only permitted admins can read them, and reads are audited', async () => {
    const d = await docs.submittedDriver(request, app, f);
    const doc = await DriverDocument.findOne({ driverId: d.id, type: 'AADHAAR' }).select('+storageKey');
    const url = `/api/admin/drivers/${d.id}/documents/${doc._id}/file`;
    // No public/static route exists for the storage directory.
    for (const p of ['/private-uploads', `/private-uploads/${doc.storageKey.slice(0, 2)}/${doc.storageKey}.bin`, `/uploads/${doc.storageKey}`]) {
      expect((await api().get(p)).status).toBe(404);
    }
    expect((await api().get(url)).status).toBe(401);
    expect((await api().get(url).set(f.auth(d.token))).status).toBe(403);
    const ridesOnlyAdmin = await f.createAdmin({ adminPermissions: ['rides:read'] });
    expect((await api().get(url).set(f.auth(ridesOnlyAdmin.token))).status).toBe(403);
    const reviewer = await f.createAdmin({ adminPermissions: ['documents:read'] });
    const ok = await api().get(url).set(f.auth(reviewer.token)).buffer(true).parse((res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(ok.status).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store, private');
    expect((await storage.get(doc.storageKey)).equals(ok.body)).toBe(true);
    expect(await AuditLog.countDocuments({ action: 'DOCUMENT_VIEWED', actorId: reviewer.id })).toBe(1);
  });

  test('admins without the review permission cannot approve drivers', async () => {
    const d = await docs.submittedDriver(request, app, f);
    const limited = await f.createAdmin({ adminPermissions: ['users:read'] });
    expect((await decide(limited, d.id, { approvalStatus: 'APPROVED' })).status).toBe(403);
    expect((await DriverProfile.findById(d.profile._id)).approvalStatus).toBe('PENDING_REVIEW');
  });

  test('women-driver programme: driver must consent; only an admin can verify; actions are audited', async () => {
    const d = await f.createDriver();
    expect((await api().post('/api/drivers/me/female-program').set(f.auth(d.token)).send({ action: 'REQUEST' })).status).toBe(400);
    await api().post('/api/drivers/me/female-program').set(f.auth(d.token)).send({ action: 'REQUEST', consent: true }).expect(200);
    const admin = await f.createAdmin();
    const res = await api().patch(`/api/admin/drivers/${d.id}/female-verification`).set(f.auth(admin.token)).send({ status: 'VERIFIED', note: 'Checked against submitted ID' });
    expect(res.status).toBe(200);
    expect((await DriverProfile.findById(d.profile._id)).femaleDriverProgram.status).toBe('VERIFIED');
    expect(await AuditLog.countDocuments({ action: 'FEMALE_PROGRAM_VERIFIED' })).toBe(1);
    // the driver cannot set VERIFIED themselves
    expect((await api().patch(`/api/admin/drivers/${d.id}/female-verification`).set(f.auth(d.token)).send({ status: 'VERIFIED' })).status).toBe(403);
  });

  test('retention: superseded/rejected files are deleted after the retention date', async () => {
    const d = await newDriver();
    const first = await docs.upload(request, app, d.token, 'PHOTO');
    await docs.upload(request, app, d.token, 'PHOTO').expect(201);
    const old = await DriverDocument.findById(first.body.data.document.id).select('+storageKey');
    expect(old.status).toBe('SUPERSEDED');
    await DriverDocument.updateOne({ _id: old._id }, { $set: { deleteAfter: new Date(Date.now() - 1000) } });
    expect(await onboarding.purgeExpiredDocuments()).toBe(1);
    expect(fs.existsSync(storage.fileFor(old.storageKey))).toBe(false);
    expect((await DriverDocument.findById(old._id)).fileDeletedAt).toBeInstanceOf(Date);
    expect(await onboarding.purgeExpiredDocuments()).toBe(0); // idempotent
    const admin = await f.createAdmin();
    expect((await api().get(`/api/admin/drivers/${d.id}/documents/${old._id}/file`).set(f.auth(admin.token))).status).toBe(410);
  });

  test('concurrent uploads of the same type leave exactly one current document', async () => {
    const d = await newDriver();
    const results = await Promise.all(Array.from({ length: 4 }, () => docs.upload(request, app, d.token, 'PHOTO')));
    expect(results.filter((r) => r.status === 201).length).toBeGreaterThanOrEqual(1);
    expect(await DriverDocument.countDocuments({ driverId: d.id, type: 'PHOTO', status: { $in: ['SUBMITTED', 'ACCEPTED'] } })).toBe(1);
  });

  test('no Aadhaar/PAN number is stored anywhere in the profile or document metadata', async () => {
    const d = await docs.submittedDriver(request, app, f);
    const raw = JSON.stringify([await DriverProfile.collection.findOne({ userId: d.user._id }), await DriverDocument.collection.find({ driverId: d.user._id }).toArray()]);
    expect(raw).not.toMatch(/aadhaarNumber|panNumber|\b\d{4}\s?\d{4}\s?\d{4}\b/);
  });
});
