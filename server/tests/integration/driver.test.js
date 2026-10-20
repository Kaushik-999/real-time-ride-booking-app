'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { useDatabase } = require('../helpers/db');
const { DriverLocation, DriverProfile } = require('../../src/models');
const f = require('../helpers/factory');

useDatabase();
const app = createApp();

describe('driver availability and location', () => {
  test('approved driver can go online and offline', async () => {
    const d = await f.createDriver({ availability: 'OFFLINE' });
    const on = await request(app).patch('/api/drivers/me/availability').set(f.auth(d.token)).send({ availability: 'AVAILABLE' });
    expect(on.status).toBe(200);
    expect(on.body.data.profile.availability).toBe('AVAILABLE');
    const off = await request(app).patch('/api/drivers/me/availability').set(f.auth(d.token)).send({ availability: 'OFFLINE' });
    expect(off.body.data.profile.availability).toBe('OFFLINE');
  });

  test('unapproved driver cannot go online', async () => {
    const d = await f.createDriver({ approved: false, availability: 'OFFLINE' });
    const res = await request(app).patch('/api/drivers/me/availability').set(f.auth(d.token)).send({ availability: 'AVAILABLE' });
    expect(res.status).toBe(403);
  });

  test('driver cannot set themselves RESERVED or ON_TRIP', async () => {
    const d = await f.createDriver();
    const res = await request(app).patch('/api/drivers/me/availability').set(f.auth(d.token)).send({ availability: 'ON_TRIP' });
    expect(res.status).toBe(400);
  });

  test('#52 driver cannot become AVAILABLE/OFFLINE while a ride owns their reservation', async () => {
    const d = await f.createDriver();
    const p = await f.createPassenger();
    const ride = await f.createRide(p);
    await DriverProfile.updateOne({ _id: d.profile._id }, { $set: { availability: 'ON_TRIP', activeRideId: ride._id } });
    for (const availability of ['AVAILABLE', 'OFFLINE']) {
      const res = await request(app).patch('/api/drivers/me/availability').set(f.auth(d.token)).send({ availability });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('DRIVER_BUSY');
    }
    const after = await DriverProfile.findById(d.profile._id);
    expect(after.availability).toBe('ON_TRIP');
    expect(String(after.activeRideId)).toBe(String(ride._id));
  });

  test('location update stores GeoJSON [lng, lat]', async () => {
    const d = await f.createDriver({ location: false });
    const res = await request(app).patch('/api/drivers/me/location').set(f.auth(d.token)).send({ lat: 12.97, lng: 77.59 });
    expect(res.status).toBe(200);
    const loc = await DriverLocation.findOne({ driverId: d.user._id });
    expect(loc.location.coordinates).toEqual([77.59, 12.97]);
  });

  test.each([
    [{ lat: 91, lng: 77 }],
    [{ lat: 12, lng: -181 }],
    [{ lat: '12', lng: 77 }],
    [{ lat: 12 }],
    [{ lat: 12, lng: 77, recordedAt: new Date(Date.now() - 120000).toISOString() }],
    [{ lat: 12, lng: 77, recordedAt: new Date(Date.now() + 120000).toISOString() }],
  ])('#12 rejects invalid or stale location %j', async (body) => {
    const d = await f.createDriver({ location: false });
    const res = await request(app).patch('/api/drivers/me/location').set(f.auth(d.token)).send(body);
    expect(res.status).toBe(400);
    expect(await DriverLocation.countDocuments({ driverId: d.user._id })).toBe(0);
  });

  test('#59 concurrent location updates never create duplicate DriverLocation documents', async () => {
    const d = await f.createDriver({ location: false });
    const results = await Promise.all(
      Array.from({ length: 15 }, (_, i) =>
        request(app).patch('/api/drivers/me/location').set(f.auth(d.token)).send({ lat: 12.97 + i * 0.0001, lng: 77.59 })
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await DriverLocation.countDocuments({ driverId: d.user._id })).toBe(1);
  });
});
