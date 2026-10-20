'use strict';

// Create (or keep) the bootstrap admin account from ADMIN_EMAIL / ADMIN_PASSWORD.
//   docker compose exec backend npm run seed:admin
const bcrypt = require('bcryptjs');
const config = require('../src/config');
const { connectDb, disconnectDb } = require('../src/config/db');
const mongoose = require('mongoose');
const { User, ensureIndexes } = require('../src/models');
const { runMigrations } = require('../src/migrations');

async function main() {
  const { email, password } = config.admin;
  if (!email || !password) throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD (see .env.example)');
  await connectDb();
  await runMigrations(mongoose.connection.db);
  await ensureIndexes();
  const existing = await User.findOne({ email: email.toLowerCase() });
  if (existing) {
    console.log(`Admin ${email} already exists (role ${existing.role}); nothing changed.`);
  } else {
    const passwordHash = await bcrypt.hash(password, config.auth.bcryptRounds);
    await User.create({ name: 'Administrator', email, passwordHash, role: 'ADMIN', adminPermissions: ['*'] });
    console.log(`Created admin ${email}`);
  }
  await disconnectDb();
}

main().catch(async (err) => {
  console.error(err.message);
  await disconnectDb().catch(() => {});
  process.exit(1);
});
