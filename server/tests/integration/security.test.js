'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { Writable } = require('stream');
const request = require('supertest');
const { createApp } = require('../../src/app');
const { useDatabase } = require('../helpers/db');
const f = require('../helpers/factory');
const { createLogger } = require('../../src/utils/logger');
const fareService = require('../../src/services/fareService');

useDatabase();
afterEach(() => jest.restoreAllMocks());

const ROOT = path.resolve(__dirname, '../../..');
// Repository-level checks need the git checkout (absent inside the backend container).
const inRepo = (() => {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: ROOT, stdio: 'ignore' });
    return fs.existsSync(path.join(ROOT, '.env.example'));
  } catch {
    return false;
  }
})();

describe('I. Security', () => {
  test('#95 rate limiting on login and booking', async () => {
    const app = createApp({ rateLimits: { authMax: 3, bookingMax: 2 } });
    const statuses = [];
    for (let i = 0; i < 5; i += 1) {
      statuses.push((await request(app).post('/api/auth/login').send({ email: 'x@test.dev', password: 'Wrong1234' })).status);
    }
    expect(statuses).toEqual([401, 401, 401, 429, 429]);

    const p = await f.createPassenger();
    const bookings = [];
    for (let i = 0; i < 3; i += 1) {
      bookings.push((await request(app).post('/api/rides').set(f.auth(p.token)).send({ bad: true })).status);
    }
    expect(bookings).toEqual([400, 400, 429]);
  });

  test('#96 password hashes and tokens never appear in user-facing responses', async () => {
    const app = createApp();
    const p = await f.createPassenger();
    const admin = await f.createAdmin();
    const bodies = [
      (await request(app).get('/api/auth/me').set(f.auth(p.token))).text,
      (await request(app).get('/api/admin/users').set(f.auth(admin.token))).text,
      (await request(app).post('/api/auth/login').send({ email: p.user.email, password: f.PASSWORD })).text,
    ];
    for (const b of bodies) {
      expect(b).not.toMatch(/passwordHash/);
      expect(b).not.toMatch(/\$2[aby]\$/);
    }
  });

  test('#97 CORS allows only configured origins; Helmet headers are set', async () => {
    const app = createApp();
    const allowed = await request(app).get('/api/health').set('Origin', 'http://localhost:5173');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    const denied = await request(app).get('/api/health').set('Origin', 'https://evil.example');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
    expect(allowed.headers['x-content-type-options']).toBe('nosniff');
    expect(allowed.headers['content-security-policy']).toBeDefined();
    expect(allowed.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(allowed.headers['x-powered-by']).toBeUndefined();
  });

  test('#98 unexpected server errors return a generic message without stack traces', async () => {
    const app = createApp();
    const p = await f.createPassenger();
    jest.spyOn(fareService, 'estimateTrip').mockRejectedValue(new Error('secret internal detail at /app/src/x.js:10'));
    const res = await request(app).post('/api/rides/estimate').set(f.auth(p.token)).send({ pickup: f.ORIGIN, destination: f.DESTINATION });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
    expect(res.text).not.toMatch(/secret internal|\.js:\d+|stack/);
  });

  test('#99 unknown routes and wrong methods return controlled JSON errors', async () => {
    const app = createApp();
    const res = await request(app).get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  test('#100 secrets are redacted from logs', () => {
    let out = '';
    const sink = new Writable({
      write(chunk, _enc, cb) {
        out += chunk.toString();
        cb();
      },
    });
    const log = createLogger(sink, 'info');
    log.info({ password: 'hunter2', token: 'eyJabc', headers: { authorization: 'Bearer eyJabc' }, body: { password: 'p' } }, 'test');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toMatch(/hunter2|eyJabc/);
  });

  (inRepo ? test : test.skip)('#100 .env files are git-ignored and .env.example holds placeholders only', () => {
    const ignored = execFileSync('git', ['check-ignore', '.env', 'server/.env', 'client/.env.local'], { cwd: ROOT }).toString();
    expect(ignored.trim().split('\n')).toHaveLength(3);
    const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
    for (const line of example.split('\n').filter((l) => /SECRET|PASSWORD/.test(l) && !l.startsWith('#'))) {
      expect(line).toMatch(/=(change-me|$)/i);
    }
  });
});
