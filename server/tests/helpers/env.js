'use strict';

// Runs before any test module is loaded, so config/index.js sees these values.
// Each Jest worker gets its own database so test files can run in parallel.
const worker = process.env.JEST_WORKER_ID || '1';
const base = process.env.MONGO_URI_TEST || 'mongodb://localhost:27017/?directConnection=true';
const url = new URL(base);
url.pathname = `/uber_test_${worker}`;

Object.assign(process.env, {
  NODE_ENV: 'test',
  MONGO_URI: url.toString(),
  LOG_LEVEL: process.env.TEST_LOG_LEVEL || 'silent',
  JWT_SECRET: 'test-secret-that-is-long-enough-123456',
  PAYMENT_WEBHOOK_SECRET: 'test-webhook-secret-123456',
  BCRYPT_ROUNDS: '4',
  AUTH_RATE_LIMIT_MAX: '1000',
  BOOKING_RATE_LIMIT_MAX: '1000',
  // Tests drive matching and timeouts explicitly for determinism.
  MATCHING_AUTO_START: 'false',
  OFFER_TIMERS_ENABLED: 'false',
  PAYMENT_MOCK_AUTO_SETTLE: 'false',
  SOCKET_ADAPTER: 'memory',
  RUN_WORKER_IN_PROCESS: 'false',
  OTP_SECRET: 'test-otp-secret-123456789',
  SMS_PROVIDER: 'dev_outbox',
  GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
  DOCUMENT_STORAGE_DIR: require('path').join(require('os').tmpdir(), `uber-test-docs-${worker}`),
});
