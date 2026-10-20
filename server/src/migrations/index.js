'use strict';

/**
 * Data migrations for existing databases.
 *
 * Each migration has a unique id and an idempotent `up(db)` that only touches
 * documents still in the old shape (filters use `$exists: false` or old
 * values), so running it twice changes nothing the second time.
 *
 * Coordination: progress is recorded in the `migrations` collection. A
 * process claims a migration by inserting `{ _id: id, status: 'running' }`
 * (the unique _id makes the claim atomic), so the API and the worker
 * starting at the same time never run the same migration concurrently.
 * Nothing is ever deleted.
 */
const logger = require('../utils/logger');
const { CATALOG } = require('../config/vehicles');

const MIGRATIONS = [
  {
    id: '2026-10-20-001-driver-profiles-v2',
    description: 'Driver review states, vehicle capacity, women-driver programme, service ratings',
    async up(db) {
      const profiles = db.collection('driverprofiles');
      const results = {};
      // Old "PENDING" meant "not yet approved"; those drivers have not uploaded documents.
      results.pending = (await profiles.updateMany({ approvalStatus: 'PENDING' }, { $set: { approvalStatus: 'DOCUMENTS_REQUIRED' } })).modifiedCount;
      results.capacity = 0;
      for (const [type, entry] of Object.entries(CATALOG)) {
        const r = await profiles.updateMany(
          { 'vehicle.type': type, 'vehicle.capacity': { $exists: false } },
          { $set: { 'vehicle.capacity': entry.defaultCapacity } }
        );
        results.capacity += r.modifiedCount;
      }
      results.femaleProgram = (
        await profiles.updateMany({ 'femaleDriverProgram.status': { $exists: false } }, { $set: { femaleDriverProgram: { status: 'NOT_REQUESTED' } } })
      ).modifiedCount;
      results.serviceRating = (
        await profiles.updateMany({ serviceRatingStats: { $exists: false } }, { $set: { serviceRatingStats: { sum: 0, count: 0 } } })
      ).modifiedCount;
      return results;
    },
  },
  {
    id: '2026-10-20-002-rides-v2',
    description: 'Passenger count, driver preference, no-driver reason',
    async up(db) {
      const rides = db.collection('rides');
      return {
        passengerCount: (await rides.updateMany({ passengerCount: { $exists: false } }, { $set: { passengerCount: 1 } })).modifiedCount,
        driverPreference: (await rides.updateMany({ driverPreference: { $exists: false } }, { $set: { driverPreference: 'ANY' } })).modifiedCount,
        noDriverReason: (
          await rides.updateMany({ status: 'NO_DRIVER_FOUND', noDriverReason: { $exists: false } }, { $set: { noDriverReason: 'NO_ELIGIBLE_DRIVER' } })
        ).modifiedCount,
      };
    },
  },
  {
    id: '2026-10-20-003-users-v2',
    description: 'Account status, rating stats, admin permissions',
    async up(db) {
      const users = db.collection('users');
      return {
        accountStatus: (await users.updateMany({ accountStatus: { $exists: false } }, { $set: { accountStatus: 'ACTIVE' } })).modifiedCount,
        ratingStats: (await users.updateMany({ ratingStats: { $exists: false } }, { $set: { ratingStats: { sum: 0, count: 0 } } })).modifiedCount,
        // Admins that existed before permission scopes keep full access.
        adminPermissions: (
          await users.updateMany({ role: 'ADMIN', adminPermissions: { $exists: false } }, { $set: { adminPermissions: ['*'] } })
        ).modifiedCount,
      };
    },
  },
  {
    id: '2026-10-20-004-normalize-phones',
    description: 'Store phone numbers in canonical +<country><number> form for OTP login',
    async up(db) {
      const { normalizePhone } = require('../utils/phone');
      const users = db.collection('users');
      let updated = 0;
      let skipped = 0;
      for await (const u of users.find({ phone: { $type: 'string' } }, { projection: { phone: 1 } })) {
        const n = normalizePhone(u.phone);
        if (!n || n === u.phone) continue;
        try {
          await users.updateOne({ _id: u._id }, { $set: { phone: n } });
          updated += 1;
        } catch (err) {
          if (err.code !== 11000) throw err;
          skipped += 1; // another account already has the canonical number: leave for manual review
        }
      }
      return { updated, skippedDuplicates: skipped };
    },
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function claim(col, id) {
  try {
    await col.insertOne({ _id: id, status: 'running', startedAt: new Date() });
    return true;
  } catch (err) {
    if (err.code !== 11000) throw err;
  }
  // Retry a previously failed attempt.
  const retried = await col.findOneAndUpdate({ _id: id, status: 'failed' }, { $set: { status: 'running', startedAt: new Date() } });
  return Boolean(retried);
}

/** Apply pending migrations. Returns the ids applied by THIS call. */
async function runMigrations(db, { migrations = MIGRATIONS, waitMs = 30000 } = {}) {
  const col = db.collection('migrations');
  const applied = [];
  for (const m of migrations) {
    if (await claim(col, m.id)) {
      try {
        const result = await m.up(db);
        await col.updateOne({ _id: m.id }, { $set: { status: 'done', finishedAt: new Date(), result } });
        applied.push(m.id);
        logger.info({ migration: m.id, result }, 'migration applied');
      } catch (err) {
        await col.updateOne({ _id: m.id }, { $set: { status: 'failed', error: String(err.message).slice(0, 300) } });
        throw err;
      }
      continue;
    }
    // Another process holds it: wait until it reports done.
    const deadline = Date.now() + waitMs;
    for (;;) {
      const doc = await col.findOne({ _id: m.id });
      if (doc && doc.status === 'done') break;
      if (doc && doc.status === 'failed') throw new Error(`migration ${m.id} failed in another process: ${doc.error}`);
      if (Date.now() > deadline) throw new Error(`timed out waiting for migration ${m.id}`);
      await sleep(250);
    }
  }
  return applied;
}

module.exports = { runMigrations, MIGRATIONS };
