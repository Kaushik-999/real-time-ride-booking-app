'use strict';

// API process entry point: HTTP + Socket.IO (+ the recovery worker when
// RUN_WORKER_IN_PROCESS=true, convenient for running without Docker).
const http = require('http');
const config = require('./config');
const logger = require('./utils/logger');
const { connectDb, disconnectDb } = require('./config/db');
const { ensureIndexes } = require('./models');
const { runMigrations } = require('./migrations');
const { createApp } = require('./app');
const { createSocketServer } = require('./sockets');
const offerTimers = require('./services/offerTimers');
const { RecoveryWorker } = require('./workers/recoveryWorker');

async function main() {
  await connectDb();
  await runMigrations(require('mongoose').connection.db);
  await ensureIndexes();

  const app = createApp();
  const server = http.createServer(app);
  const io = await createSocketServer(server);

  let worker = null;
  if (config.worker.runInProcess) {
    worker = new RecoveryWorker();
    worker.start();
  }

  await new Promise((resolve) => server.listen(config.port, resolve));
  logger.info({ port: config.port, env: config.env }, 'API listening');

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down gracefully');
    const force = setTimeout(() => {
      logger.error('forced exit after shutdown timeout');
      process.exit(1);
    }, 15000);
    force.unref();
    try {
      // Stop accepting new connections, let in-flight requests finish.
      await new Promise((resolve) => io.close(() => resolve()));
      await new Promise((resolve) => server.close(() => resolve()));
      if (worker) await worker.stop();
      offerTimers.clearAll(); // pending offers will be expired by the recovery worker
      await disconnectDb();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled promise rejection'));
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start API');
  process.exit(1);
});
