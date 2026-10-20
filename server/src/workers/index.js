'use strict';

// Standalone recovery-worker process: `npm run worker`.
// Shares source code and the MongoDB database with the API, but has no HTTP
// server. Socket.IO events it produces are delivered through MongoDB to the
// API processes (see sockets/index.js createMongoEmitter).
process.env.SERVICE_NAME = process.env.SERVICE_NAME || 'uber-worker';

const config = require('../config');
const logger = require('../utils/logger');
const { connectDb, disconnectDb } = require('../config/db');
const { ensureIndexes } = require('../models');
const { runMigrations } = require('../migrations');
const { createMongoEmitter } = require('../sockets');
const notifier = require('../sockets/notifier');
const offerTimers = require('../services/offerTimers');
const { RecoveryWorker } = require('./recoveryWorker');

async function main() {
  await connectDb();
  await runMigrations(require('mongoose').connection.db);
  await ensureIndexes();
  if (config.socket.adapter === 'mongo') notifier.setTarget(await createMongoEmitter());

  const worker = new RecoveryWorker();
  worker.start();

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'worker shutting down');
    const force = setTimeout(() => process.exit(1), 15000);
    force.unref();
    await worker.stop();
    offerTimers.clearAll();
    await disconnectDb();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'worker failed to start');
  process.exit(1);
});
