'use strict';

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const config = require('./config');
const logger = require('./utils/logger');
const { buildRouter } = require('./routes');
const { createRateLimiters } = require('./middleware/rateLimiters');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

/**
 * Build the Express application (no network listening here, so tests can
 * use it directly with Supertest).
 */
function createApp({ rateLimits } = {}) {
  const app = express();
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(
    cors({
      origin(origin, cb) {
        // Allow same-origin / non-browser requests (no Origin header) and the configured frontends.
        if (!origin || config.corsOrigins.includes(origin)) return cb(null, true);
        return cb(null, false);
      },
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      maxAge: 600,
    })
  );
  app.use(
    express.json({
      limit: '50kb',
      // Keep the exact bytes for webhook signature verification.
      verify: (req, _res, buf) => {
        if (req.originalUrl.startsWith('/api/payments/webhook')) req.rawBody = buf.toString('utf8');
      },
    })
  );

  // Access log: method, path, status, duration. No headers/bodies (they can hold tokens/passwords).
  app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      if (req.path === '/api/health') return;
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      logger.info({ method: req.method, path: req.path, status: res.statusCode, ms: Math.round(ms) }, 'request');
    });
    next();
  });

  app.use('/api', buildRouter({ limiters: createRateLimiters(rateLimits) }));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
