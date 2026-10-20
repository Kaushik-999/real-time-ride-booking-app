'use strict';

const mongoose = require('mongoose');
const config = require('./index');
const logger = require('../utils/logger');

mongoose.set('strictQuery', true);

async function connectDb(uri = config.mongoUri) {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  logger.info({ db: mongoose.connection.name }, 'connected to MongoDB');
  return mongoose.connection;
}

async function disconnectDb() {
  await mongoose.disconnect();
}

/**
 * Health information for /api/health. Reports whether the connection is up
 * and whether we are talking to a replica set (required for transactions).
 */
async function dbHealth() {
  if (mongoose.connection.readyState !== 1) return { ok: false, state: mongoose.connection.readyState };
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  return { ok: true, replicaSet: hello.setName || null, isWritablePrimary: Boolean(hello.isWritablePrimary) };
}

module.exports = { connectDb, disconnectDb, dbHealth };
