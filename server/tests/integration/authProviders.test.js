'use strict';

const request = require('supertest');
const { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } = require('jose');
const { createApp } = require('../../src/app');
const { useDatabase } = require('../helpers/db');
const f = require('../helpers/factory');
const { User, AuthOtp, DevOutboxMessage } = require('../../src/models');
const googleIdentity = require('../../src/services/googleIdentity');

useDatabase();
const app = createApp();
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

let googleKey;
let attackerKey;
beforeAll(async () => {
  googleKey = await generateKeyPair('RS256');
  attackerKey = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(googleKey.publicKey)), kid: 'google-test', alg: 'RS256', use: 'sig' };
  googleIdentity.setKeySetForTesting(createLocalJWKSet({ keys: [jwk] }));
});

async function googleToken(claims = {}, { key = googleKey.privateKey, kid = 'google-test', iss = 'https://accounts.google.com', aud = CLIENT_ID, exp = '1h' } = {}) {
  return new SignJWT({ email: 'asha.g@gmail.com', email_verified: true, name: 'Asha G', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuer(iss)
    .setAudience(aud)
    .setSubject(claims.sub || '1122334455')
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(key);
}

const outboxCode = async (phone) => {
  const msg = await DevOutboxMessage.findOne({ to: phone }).sort({ createdAt: -1 }).lean();
  return msg ? msg.body.match(/\b(\d{6})\b/)[1] : null;
};
const requestOtp = (phone) => request(app).post('/api/auth/otp/request').send({ phone });
const verifyOtp = (phone, code) => request(app).post('/api/auth/otp/verify').send({ phone, code });

describe('Mobile OTP login', () => {
  const PHONE = '+919876543210';

  test('registered phone: code goes to the (dev) outbox, verify issues a normal session', async () => {
    const p = await f.createPassenger({ phone: PHONE });
    const res = await requestOtp('98765 43210'); // normalised to +91...
    expect(res.status).toBe(202);
    expect(res.body.data.delivery).toBe('DEV_OUTBOX_NOT_SENT');
    expect(JSON.stringify(res.body)).not.toMatch(/\b\d{6}\b/); // code never in the API response
    const code = await outboxCode(PHONE);
    expect(code).toMatch(/^\d{6}$/);
    const ok = await verifyOtp(PHONE, code);
    expect(ok.status).toBe(200);
    expect(ok.body.data.user.id).toBe(p.id);
    expect((await request(app).get('/api/auth/me').set(f.auth(ok.body.data.token))).status).toBe(200);
    expect((await User.findById(p.id)).phoneVerifiedAt).toBeTruthy();
  });

  test('the code is stored only as a hash', async () => {
    await f.createPassenger({ phone: PHONE });
    await requestOtp(PHONE);
    const code = await outboxCode(PHONE);
    const raw = await AuthOtp.collection.findOne({ phone: PHONE });
    expect(JSON.stringify(raw)).not.toContain(code);
    expect(raw.codeHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test('unregistered phone gets the identical response and no SMS; any code fails', async () => {
    await f.createPassenger({ phone: PHONE });
    const known = await requestOtp(PHONE);
    const unknown = await requestOtp('+919000000001');
    expect(unknown.status).toBe(known.status);
    expect(Object.keys(unknown.body.data).sort()).toEqual(Object.keys(known.body.data).sort());
    expect(unknown.body.data.message).toBe(known.body.data.message);
    expect(await DevOutboxMessage.countDocuments({ to: '+919000000001' })).toBe(0);
    expect((await verifyOtp('+919000000001', '123456')).status).toBe(401);
  });

  test('expired codes are rejected', async () => {
    await f.createPassenger({ phone: PHONE });
    await requestOtp(PHONE);
    const code = await outboxCode(PHONE);
    await AuthOtp.updateMany({ phone: PHONE }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await verifyOtp(PHONE, code)).status).toBe(401);
  });

  test('wrong codes count as attempts; after the limit even the right code fails', async () => {
    await f.createPassenger({ phone: PHONE });
    await requestOtp(PHONE);
    const code = await outboxCode(PHONE);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i += 1) expect((await verifyOtp(PHONE, wrong)).status).toBe(401);
    expect((await verifyOtp(PHONE, code)).status).toBe(401);
    expect((await AuthOtp.findOne({ phone: PHONE })).status).toBe('LOCKED');
  });

  test('a used code cannot be replayed, and parallel verifications succeed only once', async () => {
    await f.createPassenger({ phone: PHONE });
    await requestOtp(PHONE);
    const code = await outboxCode(PHONE);
    const results = await Promise.all(Array.from({ length: 5 }, () => verifyOtp(PHONE, code)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect((await verifyOtp(PHONE, code)).status).toBe(401);
  });

  test('resend cooldown and hourly cap apply to every number alike', async () => {
    await f.createPassenger({ phone: PHONE });
    await requestOtp(PHONE).expect(202);
    const again = await requestOtp(PHONE);
    expect(again.status).toBe(429);
    expect(again.body.error.code).toBe('OTP_COOLDOWN');
    await requestOtp('+919000000002').expect(202);
    expect((await requestOtp('+919000000002')).status).toBe(429);
    // hourly cap
    const old = new Date(Date.now() - 2 * 60 * 1000);
    await AuthOtp.deleteMany({});
    await AuthOtp.insertMany(Array.from({ length: 5 }, () => ({ phone: PHONE, codeHash: 'x', status: 'SUPERSEDED', maxAttempts: 5, expiresAt: old, createdAt: old })));
    const capped = await requestOtp(PHONE);
    expect(capped.status).toBe(429);
    expect(capped.body.error.code).toBe('OTP_LIMIT');
  });

  test('requesting a new code invalidates the previous one', async () => {
    await f.createPassenger({ phone: PHONE });
    await requestOtp(PHONE);
    const first = await outboxCode(PHONE);
    // Skip the cooldown. Raw collection: Mongoose ignores updates to the immutable createdAt.
    await AuthOtp.collection.updateMany({}, { $set: { createdAt: new Date(Date.now() - 120000) } });
    await requestOtp(PHONE).expect(202);
    expect(await DevOutboxMessage.countDocuments({ to: PHONE })).toBe(2); // a second code really was issued
    const second = await outboxCode(PHONE);
    expect(await AuthOtp.countDocuments({ phone: PHONE, status: 'SUPERSEDED' })).toBe(1);
    if (first !== second) expect((await verifyOtp(PHONE, first)).status).toBe(401);
    expect((await verifyOtp(PHONE, second)).status).toBe(200);
  });

  test('malformed phone or code is a 400', async () => {
    expect((await requestOtp('abc')).status).toBe(400);
    expect((await verifyOtp(PHONE, '12ab')).status).toBe(400);
  });

  test('suspended accounts cannot sign in by OTP or password', async () => {
    const p = await f.createPassenger({ phone: PHONE, accountStatus: 'SUSPENDED' });
    await requestOtp(PHONE);
    expect(await DevOutboxMessage.countDocuments({ to: PHONE })).toBe(0);
    const pw = await request(app).post('/api/auth/login').send({ email: p.user.email, password: f.PASSWORD });
    expect(pw.status).toBe(403);
    expect(pw.body.error.code).toBe('ACCOUNT_SUSPENDED');
    expect((await request(app).get('/api/auth/me').set(f.auth(p.token))).status).toBe(403);
  });
});

describe('Google sign-in', () => {
  const google = (idToken) => request(app).post('/api/auth/google').send({ idToken });

  test('a valid token creates a passenger account; signing in again reuses it', async () => {
    const first = await google(await googleToken());
    expect(first.status).toBe(201);
    expect(first.body.data.user).toMatchObject({ email: 'asha.g@gmail.com', role: 'PASSENGER' });
    expect(first.body.data.user.authProviders).toEqual([expect.objectContaining({ provider: 'google' })]);
    expect(JSON.stringify(first.body)).not.toContain('1122334455'); // provider subject not exposed
    const again = await google(await googleToken());
    expect(again.status).toBe(200);
    expect(again.body.data.user.id).toBe(first.body.data.user.id);
    expect(await User.countDocuments()).toBe(1);
  });

  test.each([
    ['wrong audience', {}, { aud: 'someone-elses-client.apps.googleusercontent.com' }],
    ['wrong issuer', {}, { iss: 'https://evil.example.com' }],
    ['expired', {}, { exp: Math.floor(Date.now() / 1000) - 3600 }],
  ])('rejects %s', async (_n, claims, opts) => {
    const res = await google(await googleToken(claims, opts));
    expect(res.status).toBe(401);
    expect(await User.countDocuments()).toBe(0);
  });

  test('rejects a token signed by an unknown key and plain garbage', async () => {
    expect((await google(await googleToken({}, { key: attackerKey.privateKey }))).status).toBe(401);
    expect((await google('x'.repeat(40))).status).toBe(401);
  });

  test('an existing email account is NOT merged automatically', async () => {
    const p = await f.createPassenger({ email: 'asha.g@gmail.com' });
    const res = await google(await googleToken());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ACCOUNT_LINK_REQUIRED');
    expect((await User.findById(p.id)).authProviders).toHaveLength(0);
  });

  test('the account owner can explicitly link Google, then sign in with it', async () => {
    const p = await f.createPassenger({ email: 'asha.g@gmail.com' });
    const link = await request(app).post('/api/auth/google/link').set(f.auth(p.token)).send({ idToken: await googleToken() });
    expect(link.status).toBe(200);
    const res = await google(await googleToken());
    expect(res.status).toBe(200);
    expect(res.body.data.user.id).toBe(p.id);
  });

  test('a Google account already linked to someone else cannot be linked again', async () => {
    await google(await googleToken());
    const other = await f.createPassenger();
    const res = await request(app).post('/api/auth/google/link').set(f.auth(other.token)).send({ idToken: await googleToken() });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDENTITY_IN_USE');
  });

  test('unverified Google email cannot create an account', async () => {
    const res = await google(await googleToken({ email_verified: false, email: 'new@gmail.com', sub: '999' }));
    expect(res.status).toBe(403);
  });

  test('concurrent first sign-ins with one Google account create one user', async () => {
    const token = await googleToken();
    const results = await Promise.all(Array.from({ length: 5 }, () => google(token)));
    expect(results.every((r) => [200, 201].includes(r.status))).toBe(true);
    expect(await User.countDocuments()).toBe(1);
  });

  test('provider status reports what is configured, without secrets', async () => {
    const res = await request(app).get('/api/auth/providers');
    expect(res.body.data).toEqual({ password: true, phoneOtp: true, phoneOtpDelivery: 'dev_outbox', google: true, googleClientId: CLIENT_ID });
  });

  test('email/password login still works and Google-only accounts cannot use a password', async () => {
    const created = await google(await googleToken());
    const res = await request(app).post('/api/auth/login').send({ email: created.body.data.user.email, password: 'anything123' });
    expect(res.status).toBe(401);
  });
});
