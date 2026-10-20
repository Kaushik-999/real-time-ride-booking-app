'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { useDatabase } = require('../helpers/db');
const { User, DriverProfile, DriverLocation, Ride, RideOffer, Payment, RideEvent } = require('../../src/models');
const f = require('../helpers/factory');

useDatabase();
const app = createApp();

const indexNames = async (Model) => (await Model.collection.indexes()).map((i) => ({ key: i.key, unique: Boolean(i.unique), name: i.name }));

describe('health check', () => {
  test('reports database and replica set', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ok');
    expect(res.body.data.db.replicaSet).toBeTruthy();
  });
});

describe('#60 database unique indexes', () => {
  test('declared indexes exist', async () => {
    const has = (list, key, unique) => list.some((i) => JSON.stringify(i.key) === JSON.stringify(key) && (!unique || i.unique));
    expect(has(await indexNames(User), { email: 1 }, true)).toBe(true);
    expect(has(await indexNames(DriverProfile), { userId: 1 }, true)).toBe(true);
    expect(has(await indexNames(DriverProfile), { 'vehicle.registrationNumber': 1 }, true)).toBe(true);
    expect(has(await indexNames(DriverLocation), { driverId: 1 }, true)).toBe(true);
    expect(has(await indexNames(DriverLocation), { location: '2dsphere' }, false)).toBe(true);
    expect(has(await indexNames(Ride), { passengerId: 1, requestKey: 1 }, true)).toBe(true);
    expect(has(await indexNames(RideOffer), { rideId: 1, driverId: 1 }, true)).toBe(true);
    expect(has(await indexNames(Payment), { rideId: 1 }, true)).toBe(true);
    expect(has(await indexNames(RideEvent), { rideId: 1, createdAt: 1 }, false)).toBe(true);
  });

  test('duplicate email is rejected by the database itself', async () => {
    await User.create({ name: 'a', email: 'dup@test.dev', passwordHash: 'x', role: 'PASSENGER' });
    await expect(User.create({ name: 'b', email: 'DUP@test.dev', passwordHash: 'x', role: 'PASSENGER' })).rejects.toMatchObject({ code: 11000 });
  });

  test('one driver profile per user and unique registration numbers', async () => {
    const d = await f.createDriver();
    await expect(DriverProfile.create({ userId: d.user._id, vehicle: { type: 'CAR', registrationNumber: 'ZZ99ZZ9999' } })).rejects.toMatchObject({ code: 11000 });
    const other = await f.createUser('DRIVER');
    await expect(
      DriverProfile.create({ userId: other.user._id, vehicle: { type: 'CAR', registrationNumber: d.profile.vehicle.registrationNumber } })
    ).rejects.toMatchObject({ code: 11000 });
  });

  test('one location document per driver', async () => {
    const d = await f.createDriver();
    await expect(DriverLocation.create({ driverId: d.user._id, location: { type: 'Point', coordinates: [77, 12] } })).rejects.toMatchObject({ code: 11000 });
  });

  test('ride requestKey unique per passenger, one PENDING offer per ride, one payment per ride', async () => {
    const p = await f.createPassenger();
    const ride = await f.createRide(p, { requestKey: 'same-key-123' });
    await expect(f.createRide(p, { requestKey: 'same-key-123' })).rejects.toMatchObject({ code: 11000 });

    const d1 = await f.createDriver();
    const d2 = await f.createDriver();
    const exp = new Date(Date.now() + 10000);
    await RideOffer.create({ rideId: ride._id, driverId: d1.user._id, ringIndex: 0, expiresAt: exp });
    await expect(RideOffer.create({ rideId: ride._id, driverId: d2.user._id, ringIndex: 0, expiresAt: exp })).rejects.toMatchObject({ code: 11000 });
    await expect(RideOffer.create({ rideId: ride._id, driverId: d1.user._id, ringIndex: 0, status: 'REJECTED', expiresAt: exp })).rejects.toMatchObject({ code: 11000 });

    await Payment.create({ rideId: ride._id, passengerId: p.user._id, amount: 100, method: 'CASH' });
    await expect(Payment.create({ rideId: ride._id, passengerId: p.user._id, amount: 100, method: 'CASH' })).rejects.toMatchObject({ code: 11000 });
  });

  test('GeoJSON coordinates are validated as [lng, lat]', async () => {
    const d = await f.createUser('DRIVER');
    await expect(DriverLocation.create({ driverId: d.user._id, location: { type: 'Point', coordinates: [77.5, 95] } })).rejects.toThrow(/coordinates/);
  });
});
