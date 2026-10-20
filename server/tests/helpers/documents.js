'use strict';

// Tiny synthetic files with valid magic bytes. NOT real identity documents.
const crypto = require('crypto');

const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(64)]);
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(64)]);
const pdf = () => Buffer.from(`%PDF-1.4\n% synthetic test file ${crypto.randomBytes(8).toString('hex')}\n%%EOF\n`);

/** Upload a document as the driver through the real multipart endpoint. */
function upload(request, app, token, type, { buffer = png(), filename = 'doc.png', contentType = 'image/png' } = {}) {
  return request(app)
    .post('/api/drivers/me/documents')
    .set('Authorization', `Bearer ${token}`)
    .field('type', type)
    .attach('file', buffer, { filename, contentType });
}

const REQUIRED = ['PHOTO', 'DRIVING_LICENSE', 'VEHICLE_RC', 'AADHAAR'];

/** Register-shaped driver who has uploaded everything and submitted. */
async function submittedDriver(request, app, f) {
  const d = await f.createDriver({ approved: false, availability: 'OFFLINE' });
  const { DriverProfile } = require('../../src/models');
  await DriverProfile.updateOne(
    { _id: d.profile._id },
    { $set: { approvalStatus: 'DOCUMENTS_REQUIRED', identity: { legalName: 'Test Driver', dateOfBirth: new Date('1990-01-01'), licenseNumber: 'KA0120190001' } } }
  );
  for (const t of REQUIRED) {
    const res = await upload(request, app, d.token, t);
    if (res.status !== 201) throw new Error(`upload ${t} failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  const sub = await request(app).post('/api/drivers/me/submit-for-review').set('Authorization', `Bearer ${d.token}`).send({});
  if (sub.status !== 200) throw new Error(`submit failed ${JSON.stringify(sub.body)}`);
  return d;
}

module.exports = { png, jpeg, pdf, upload, submittedDriver, REQUIRED };
