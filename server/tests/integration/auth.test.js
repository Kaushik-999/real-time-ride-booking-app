'use strict';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const { createApp } = require('../../src/app');
const { useDatabase } = require('../helpers/db');
const { User, DriverProfile } = require('../../src/models');
const f = require('../helpers/factory');

useDatabase();
const app = createApp();

const registerBody = (o = {}) => ({ name: 'Asha', email: `asha-${f.uniq()}@test.dev`, password: 'Secret123', ...o });

describe('A. Authentication and authorization', () => {
  test('#1 a new passenger can register', async () => {
    const body = registerBody();
    const res = await request(app).post('/api/auth/register').send(body);
    expect(res.status).toBe(201);
    expect(res.body.data.user).toMatchObject({ email: body.email, role: 'PASSENGER' });
    expect(res.body.data.token).toEqual(expect.any(String));
    // #96 hash never returned; stored hash is not the password
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|Secret123/);
    const stored = await User.findOne({ email: body.email }).select('+passwordHash');
    expect(stored.passwordHash).toMatch(/^\$2[aby]\$/);
  });

  test('a driver registers with a vehicle in one step', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send(
        registerBody({
          role: 'DRIVER',
          vehicle: { type: 'CAR', registrationNumber: 'ka 01-ab 1234' },
          identity: { legalName: 'Ravi Kumar', dateOfBirth: '1990-04-02', licenseNumber: 'ka01 2019 0001234' },
        })
      );
    expect(res.status).toBe(201);
    const profile = await DriverProfile.findOne({ userId: res.body.data.user.id });
    expect(profile).toMatchObject({ approvalStatus: 'DOCUMENTS_REQUIRED', availability: 'OFFLINE' });
    expect(profile.vehicle.capacity).toBe(4); // catalog default for CAR
    expect(profile.vehicle.registrationNumber).toBe('KA01AB1234');
  });

  test('#2 duplicate email is rejected (case-insensitive)', async () => {
    const body = registerBody();
    await request(app).post('/api/auth/register').send(body).expect(201);
    const res = await request(app).post('/api/auth/register').send({ ...body, email: body.email.toUpperCase() });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE');
  });

  test.each([
    ['short password', { password: 'a1' }],
    ['password without digit', { password: 'abcdefghij' }],
    ['bad email', { email: 'not-an-email' }],
    ['self-registering as admin', { role: 'ADMIN' }],
    ['driver without vehicle', { role: 'DRIVER' }],
    ['driver without identity', { role: 'DRIVER', vehicle: { type: 'CAR', registrationNumber: 'KA01AB9999' } }],
    ['under-age driver', { role: 'DRIVER', vehicle: { type: 'CAR', registrationNumber: 'KA01AB9998' }, identity: { legalName: 'Kid', dateOfBirth: '2015-01-01', licenseNumber: 'KA0120190001' } }],
    ['capacity above vehicle maximum', { role: 'DRIVER', vehicle: { type: 'BIKE', registrationNumber: 'KA01AB9997', capacity: 3 }, identity: { legalName: 'Ravi', dateOfBirth: '1990-01-01', licenseNumber: 'KA0120190001' } }],
    ['unknown field', { isAdmin: true }],
  ])('#3 rejects malformed registration: %s', async (_name, override) => {
    const res = await request(app).post('/api/auth/register').send(registerBody(override));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  test('#4 correct login succeeds, #5 wrong password fails', async () => {
    const body = registerBody();
    await request(app).post('/api/auth/register').send(body).expect(201);
    const good = await request(app).post('/api/auth/login').send({ email: body.email, password: body.password });
    expect(good.status).toBe(200);
    expect(good.body.data.token).toEqual(expect.any(String));
    const bad = await request(app).post('/api/auth/login').send({ email: body.email, password: 'Wrong1234' });
    expect(bad.status).toBe(401);
    const unknown = await request(app).post('/api/auth/login').send({ email: 'nobody@test.dev', password: 'Wrong1234' });
    expect(unknown.status).toBe(401);
    expect(unknown.body.error.message).toBe(bad.body.error.message); // no account enumeration
  });

  test('#6 protected endpoints reject missing, malformed, forged and expired tokens', async () => {
    const p = await f.createPassenger();
    expect((await request(app).get('/api/auth/me')).status).toBe(401);
    expect((await request(app).get('/api/auth/me').set('Authorization', 'Bearer nope')).status).toBe(401);
    const forged = jwt.sign({ sub: p.id, role: 'ADMIN' }, 'wrong-secret-wrong-secret-wrong');
    expect((await request(app).get('/api/auth/me').set(f.auth(forged))).status).toBe(401);
    const expired = jwt.sign({ sub: p.id, role: 'PASSENGER', exp: Math.floor(Date.now() / 1000) - 10 }, process.env.JWT_SECRET);
    expect((await request(app).get('/api/auth/me').set(f.auth(expired))).status).toBe(401);
    const me = await request(app).get('/api/auth/me').set(f.auth(p.token));
    expect(me.status).toBe(200);
    expect(me.body.data.user.id).toBe(p.id);
  });

  test('role comes from the database, not from a tampered token claim', async () => {
    const p = await f.createPassenger();
    const tampered = jwt.sign({ sub: p.id, role: 'ADMIN' }, process.env.JWT_SECRET);
    const res = await request(app).get('/api/admin/metrics').set(f.auth(tampered));
    expect(res.status).toBe(403);
  });

  test('role-based access: passenger cannot use driver or admin endpoints', async () => {
    const p = await f.createPassenger();
    expect((await request(app).patch('/api/drivers/me/availability').set(f.auth(p.token)).send({ availability: 'AVAILABLE' })).status).toBe(403);
    expect((await request(app).get('/api/admin/rides').set(f.auth(p.token))).status).toBe(403);
    const d = await f.createDriver();
    expect((await request(app).post('/api/rides').set(f.auth(d.token)).send(f.bookingBody())).status).toBe(403);
  });
});
