'use strict';

const rateLimit = require('express-rate-limit');
const config = require('../config');

const handler = (_req, res) =>
  res.status(429).json({ success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests, slow down' } });

// Limiters are created per app instance so tests can build isolated apps.
function createRateLimiters(overrides = {}) {
  const windowMs = overrides.windowMs ?? config.rateLimit.windowMs;
  return {
    auth: rateLimit({
      windowMs,
      limit: overrides.authMax ?? config.rateLimit.authMax,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      handler,
    }),
    booking: rateLimit({
      windowMs,
      limit: overrides.bookingMax ?? config.rateLimit.bookingMax,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      // Per authenticated user when available, otherwise per IP.
      keyGenerator: (req) => (req.user ? `user:${req.user.id}` : req.ip),
      handler,
    }),
    // Trip-code submissions: per user, on top of the per-code attempt limit.
    otp: rateLimit({
      windowMs,
      limit: overrides.otpMax ?? 60,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      keyGenerator: (req) => (req.user ? `user:${req.user.id}` : req.ip),
      handler,
    }),
    // Document uploads: per user, generous enough for onboarding.
    upload: rateLimit({
      windowMs,
      limit: overrides.uploadMax ?? 30,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      keyGenerator: (req) => (req.user ? `user:${req.user.id}` : req.ip),
      handler,
    }),
  };
}

module.exports = { createRateLimiters };
