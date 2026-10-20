'use strict';

const mongoose = require('mongoose');
const { useDatabase } = require('../helpers/db');
const { runMigrations, MIGRATIONS } = require('../../src/migrations');
const { DriverProfile, User, Ride } = require('../../src/models');
const f = require('../helpers/factory');

useDatabase();
const db = () => mongoose.connection.db;

/** Insert documents in the PRE-upgrade shape, bypassing Mongoose defaults. */
async function insertLegacyData() {
  const u = await db().collection('users').insertOne({ name: 'Old driver', email: 'old@test.dev', passwordHash: 'x', role: 'DRIVER' });
  const admin = await db().collection('users').insertOne({ name: 'Old admin', email: 'oldadmin@test.dev', passwordHash: 'x', role: 'ADMIN' });
  await db().collection('driverprofiles').insertMany([
    { userId: u.insertedId, vehicle: { type: 'AUTO', registrationNumber: 'KA01OLD001' }, approvalStatus: 'PENDING', availability: 'OFFLINE', activeRideId: null },
    { userId: new mongoose.Types.ObjectId(), vehicle: { type: 'CAR', registrationNumber: 'KA01OLD002' }, approvalStatus: 'APPROVED', availability: 'AVAILABLE', activeRideId: null },
  ]);
  await db().collection('rides').insertOne({ passengerId: u.insertedId, status: 'NO_DRIVER_FOUND', requestKey: 'legacy-key-1', active: false });
  return { driverUserId: u.insertedId, adminId: admin.insertedId };
}

describe('data migrations', () => {
  test('upgrade legacy documents to the new shape', async () => {
    const { driverUserId, adminId } = await insertLegacyData();
    const applied = await runMigrations(db());
    expect(applied).toEqual(MIGRATIONS.map((m) => m.id));

    const pending = await DriverProfile.findOne({ userId: driverUserId }).lean();
    expect(pending.approvalStatus).toBe('DOCUMENTS_REQUIRED');
    expect(pending.vehicle.capacity).toBe(3); // AUTO catalog default
    expect(pending.femaleDriverProgram.status).toBe('NOT_REQUESTED');
    const approved = await DriverProfile.findOne({ 'vehicle.registrationNumber': 'KA01OLD002' }).lean();
    expect(approved.approvalStatus).toBe('APPROVED'); // approved drivers keep working
    expect(approved.vehicle.capacity).toBe(4);

    const ride = await Ride.findOne({ requestKey: 'legacy-key-1' }).lean();
    expect(ride).toMatchObject({ passengerCount: 1, driverPreference: 'ANY', noDriverReason: 'NO_ELIGIBLE_DRIVER' });

    const admin = await User.findById(adminId).lean();
    expect(admin.adminPermissions).toEqual(['*']);
    expect(admin.accountStatus).toBe('ACTIVE');
  });

  test('re-running is a no-op and concurrent runners apply each migration once', async () => {
    await insertLegacyData();
    const [a, b] = await Promise.all([runMigrations(db()), runMigrations(db())]);
    expect([...a, ...b].sort()).toEqual(MIGRATIONS.map((m) => m.id).sort());
    expect(await runMigrations(db())).toEqual([]);
    const marks = await db().collection('migrations').find().toArray();
    expect(marks.every((m) => m.status === 'done')).toBe(true);
  });

  test('a migrated legacy approved driver is still matched', async () => {
    const legacy = await db().collection('users').insertOne({ name: 'Legacy', email: 'legacy@test.dev', passwordHash: 'x', role: 'DRIVER' });
    await db().collection('driverprofiles').insertOne({
      userId: legacy.insertedId,
      vehicle: { type: 'CAR', registrationNumber: 'KA01OLD003' },
      approvalStatus: 'APPROVED',
      availability: 'AVAILABLE',
      activeRideId: null,
    });
    await db().collection('driverlocations').insertOne({ driverId: legacy.insertedId, location: { type: 'Point', coordinates: [f.ORIGIN.lng + 0.005, f.ORIGIN.lat] }, updatedAt: new Date() });
    await runMigrations(db());
    const ride = await f.createRide(await f.createPassenger());
    const r = await require('../../src/services/matchingService').advanceMatching(ride._id);
    expect(r.outcome).toBe('offered');
    expect(String(r.offer.driverId)).toBe(String(legacy.insertedId));
  });

  test('a failing migration is recorded and retried on the next start', async () => {
    let calls = 0;
    const flaky = [{ id: 'test-flaky', up: async () => { calls += 1; if (calls === 1) throw new Error('boom'); return {}; } }];
    await expect(runMigrations(db(), { migrations: flaky })).rejects.toThrow('boom');
    expect((await db().collection('migrations').findOne({ _id: 'test-flaky' })).status).toBe('failed');
    expect(await runMigrations(db(), { migrations: flaky })).toEqual(['test-flaky']);
  });
});
