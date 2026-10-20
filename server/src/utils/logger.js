'use strict';

// Structured JSON logging with pino. Sensitive fields are redacted so
// passwords, tokens and secrets never reach the logs.
const pino = require('pino');
const config = require('../config');

const REDACT_PATHS = [
  'password',
  '*.password',
  'passwordHash',
  '*.passwordHash',
  'token',
  '*.token',
  'authorization',
  '*.authorization',
  'headers.authorization',
  'req.headers.authorization',
  'signature',
  '*.signature',
  'secret',
  '*.secret',
  'otp',
  '*.otp',
];

function createLogger(destination, level = config.logLevel) {
  return pino(
    {
      level,
      base: { service: process.env.SERVICE_NAME || 'uber-api' },
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    },
    destination
  );
}

module.exports = createLogger();
module.exports.createLogger = createLogger;
module.exports.REDACT_PATHS = REDACT_PATHS;
