'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { useDatabase } = require('../helpers/db');
const f = require('../helpers/factory');
const m = require('../helpers/matching');
const matching = require('../../src/services/matchingService');
const offerService = require('../../src/services/offerService');
const { calculateFare, calculateFinalFare, ratesFor } = require('../../src/services/fareService');
const { loadCatalog } = require('../../src/config/vehicles');
const { RideOffer, DriverProfile, AuditLog } = require('../../src/models');

useDatabase();
const app = createApp();
const api = () => request(app);

describe('Vehicle types and passenger capacity', () => {
  test('the public catalog lists bike, auto, car and car XL with their capacities', async () => {
    const res = await api().get('/api/vehicles');
    expect(res.status).toBe(200);
    expect(res.body.data.vehicles).toEqual([
      { type: 'BIKE', label: 'Bike', category: 'BIKE', maxPassengers: 1, defaultCapacity: 1 },
      { type: 'AUTO', label: 'Auto', category: 'AUTO', maxPassengers: 3, defaultCapacity: 3 },
      { type: 'CAR', label: 'Car', category: 'CAR', maxPassengers: 4, defaultCapacity: 4 },
      { type: 'CAR_XL', label: 'Car XL', category: 'CAR', maxPassengers: 7, defaultCapacity: 6 },
    ]);
  });

  test('each vehicle type is priced with its own fare table', async () => {
    const p = await f.createPassenger();
    const est = async (vehicleType) =>
      (await api().post('/api/rides/estimate').set(f.auth(p.token)).send({ pickup: f.ORIGIN, destination: f.DESTINATION, vehicleType })).body.data;
    const bike = await est('BIKE');
    const car = await est('CAR');
    const xl = await est('CAR_XL');
    const route = { distanceMeters: car.distanceMeters, durationSeconds: car.durationSeconds };
    expect(bike.estimatedFare).toBe(calculateFare(route, ratesFor('BIKE')).totalPaise);
    expect(car.estimatedFare).toBe(calculateFare(route, ratesFor('CAR')).totalPaise);
    expect(xl.estimatedFare).toBe(calculateFare(route, ratesFor('CAR_XL')).totalPaise);
    expect(bike.estimatedFare).toBeLessThan(car.estimatedFare);
    expect(car.estimatedFare).toBeLessThan(xl.estimatedFare);
    expect(car.options.map((o) => o.vehicleType)).toEqual(['BIKE', 'AUTO', 'CAR', 'CAR_XL']);
  });

  test('estimate options only include vehicles that fit the group', async () => {
    const p = await f.createPassenger();
    const res = await api().post('/api/rides/estimate').set(f.auth(p.token)).send({ pickup: f.ORIGIN, destination: f.DESTINATION, vehicleType: 'CAR_XL', passengerCount: 5 });
    expect(res.body.data.options.map((o) => o.vehicleType)).toEqual(['CAR_XL']);
  });

  test.each([
    ['BIKE', 2],
    ['AUTO', 4],
    ['CAR', 5],
    ['CAR_XL', 8],
  ])('%s with %i passengers is rejected (above capacity)', async (vehicleType, passengerCount) => {
    const p = await f.createPassenger();
    const res = await api().post('/api/rides').set(f.auth(p.token)).send(f.bookingBody({ vehicleType, passengerCount }));
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.error.details)).toMatch(/at most/);
  });

  test.each([[0], [-1], ['3'], [2.5], [null]])('client-manipulated passengerCount %p is rejected', async (passengerCount) => {
    const p = await f.createPassenger();
    expect((await api().post('/api/rides').set(f.auth(p.token)).send(f.bookingBody({ passengerCount }))).status).toBe(400);
  });

  test('bike, auto, car and car XL can each be booked with a valid group size', async () => {
    for (const [vehicleType, passengerCount] of [['BIKE', 1], ['AUTO', 3], ['CAR', 4], ['CAR_XL', 6]]) {
      const p = await f.createPassenger();
      const res = await api().post('/api/rides').set(f.auth(p.token)).send(f.bookingBody({ vehicleType, passengerCount }));
      expect(res.status).toBe(201);
      expect(res.body.data.ride).toMatchObject({ vehicleType, passengerCount });
    }
  });

  test('matching excludes other vehicle types and vehicles that are too small', async () => {
    const drivers = [
      await f.createDriver({ distanceKm: 0.5, vehicleType: 'BIKE' }),
      await f.createDriver({ distanceKm: 0.7, vehicleType: 'AUTO' }),
      await f.createDriver({ distanceKm: 0.9, vehicleType: 'CAR', capacity: 3 }), // small car
      await f.createDriver({ distanceKm: 1.2, vehicleType: 'CAR_XL' }),
      await f.createDriver({ distanceKm: 2.0, vehicleType: 'CAR', capacity: 4 }),
    ];
    const ride = await f.createRide(await f.createPassenger(), { vehicleType: 'CAR', passengerCount: 4 });
    const r = await matching.advanceMatching(ride._id);
    expect(String(r.offer.driverId)).toBe(drivers[4].id);
  });

  test('a CAR_XL request is never offered to a regular car', async () => {
    await f.createDriver({ distanceKm: 0.5, vehicleType: 'CAR' });
    const xl = await f.createDriver({ distanceKm: 4, vehicleType: 'CAR_XL' });
    const ride = await f.createRide(await f.createPassenger(), { vehicleType: 'CAR_XL', passengerCount: 5 });
    const r = await matching.advanceMatching(ride._id);
    expect(String(r.offer.driverId)).toBe(xl.id);
    expect(r.offer.ringIndex).toBe(1); // still progressive-radius
  });

  test('an incompatible driver cannot be assigned even with a (forged) pending offer', async () => {
    const bike = await f.createDriver({ distanceKm: 0.5, vehicleType: 'BIKE' });
    const ride = await f.createRide(await f.createPassenger(), { vehicleType: 'CAR', passengerCount: 2 });
    await DriverProfile.updateOne({ userId: bike.id }, { $set: { availability: 'RESERVED', activeRideId: ride._id } });
    const offer = await RideOffer.create({ rideId: ride._id, driverId: bike.user._id, ringIndex: 0, expiresAt: new Date(Date.now() + 15000) });
    const res = await api().post(`/api/offers/${offer._id}/accept`).set(f.auth(bike.token)).send({});
    expect(res.status).toBe(409);
    expect((await m.rideOf(ride._id)).status).toBe('SEARCHING');
  });

  test('the assigned vehicle (type, label, capacity) is shown to the passenger', async () => {
    const p = await f.createPassenger();
    const d = await f.createDriver({ distanceKm: 1, vehicleType: 'AUTO' });
    const ride = await f.createRide(p, { vehicleType: 'AUTO', passengerCount: 2 });
    await matching.advanceMatching(ride._id);
    await offerService.acceptOffer((await m.pendingOffer(ride._id))._id, d.id);
    const res = await api().get(`/api/rides/${ride._id}`).set(f.auth(p.token));
    expect(res.body.data.ride).toMatchObject({ vehicleType: 'AUTO', vehicleLabel: 'Auto', passengerCount: 2 });
    expect(res.body.data.ride.driver.vehicle).toMatchObject({ type: 'AUTO', label: 'Auto', capacity: 3 });
  });

  test('final fare uses the vehicle type fare table', () => {
    const startedAt = new Date('2026-01-01T10:00:00Z');
    const done = new Date('2026-01-01T10:20:00Z');
    const base = { tripDistanceMeters: 8000, startedAt, estimate: { distanceMeters: 8000 } };
    expect(calculateFinalFare({ ...base, vehicleType: 'BIKE' }, done).totalPaise).toBe(calculateFare({ distanceMeters: 8000, durationSeconds: 1200 }, ratesFor('BIKE')).totalPaise);
    expect(calculateFinalFare({ ...base, vehicleType: 'BIKE' }, done).totalPaise).toBeLessThan(calculateFinalFare({ ...base, vehicleType: 'CAR' }, done).totalPaise);
  });

  test('the catalog is configuration-driven and validated', () => {
    const custom = loadCatalog(JSON.stringify({ E_RICKSHAW: { label: 'E-rickshaw', category: 'AUTO', defaultCapacity: 4, maxCapacity: 4, fare: { basePaise: 2000, perKmPaise: 700, perMinPaise: 50, minimumPaise: 2500 } } }));
    expect(Object.keys(custom)).toEqual(['E_RICKSHAW']);
    expect(() => loadCatalog('{not json')).toThrow(/not valid JSON/);
    expect(() => loadCatalog(JSON.stringify({ CAR: { label: 'Car', category: 'CAR', defaultCapacity: 6, maxCapacity: 4, fare: { basePaise: 1, perKmPaise: 1, perMinPaise: 1, minimumPaise: 1 } } }))).toThrow(/defaultCapacity/);
  });

  test('driver vehicle capacity cannot exceed the catalog maximum; admins can correct it (audited)', async () => {
    const d = await f.createDriver({ vehicleType: 'AUTO' });
    const other = await f.createUser('DRIVER');
    await expect(
      DriverProfile.create({ userId: other.user._id, vehicle: { type: 'AUTO', registrationNumber: 'KA01CAP0009', capacity: 9 } })
    ).rejects.toThrow(/capacity exceeds/);
    const admin = await f.createAdmin();
    expect((await api().patch(`/api/admin/drivers/${d.id}/vehicle`).set(f.auth(admin.token)).send({ capacity: 5 })).status).toBe(400);
    const ok = await api().patch(`/api/admin/drivers/${d.id}/vehicle`).set(f.auth(admin.token)).send({ capacity: 2, reason: 'Back seat damaged' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.profile.vehicle.capacity).toBe(2);
    expect(await AuditLog.countDocuments({ action: 'VEHICLE_CAPACITY_CHANGED' })).toBe(1);
  });
});
