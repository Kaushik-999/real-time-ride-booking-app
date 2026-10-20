'use strict';

// Central, validated configuration. Every tunable value is read from the
// environment exactly once, here, and validated with Zod so the process
// refuses to start with a broken configuration.
require('dotenv').config();
const { z } = require('zod');

const bool = (def) =>
  z
    .enum(['true', 'false'])
    .default(def ? 'true' : 'false')
    .transform((v) => v === 'true');

// Placeholder values from .env.example ("change-me" or empty) count as unset.
const secret = (min) =>
  z.preprocess((v) => (v === '' || v === 'change-me' ? undefined : v), z.string().min(min).optional());

const num = (def) => z.coerce.number().finite().default(def);
const int = (def) => z.coerce.number().int().default(def);

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: int(4000),
    MONGO_URI: z.string().min(1).default('mongodb://localhost:27017/uber?directConnection=true'),
    JWT_SECRET: secret(16),
    JWT_EXPIRES_IN: z.string().default('1h'),
    BCRYPT_ROUNDS: int(10),
    CORS_ORIGINS: z.string().default('http://localhost:5173'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

    // Rate limiting (requests per window per IP).
    RATE_LIMIT_WINDOW_MS: int(15 * 60 * 1000),
    AUTH_RATE_LIMIT_MAX: int(20),
    BOOKING_RATE_LIMIT_MAX: int(30),

    // Matching.
    MATCH_INITIAL_RADIUS_KM: num(3),
    MATCH_RADIUS_STEP_KM: num(3),
    MATCH_MAX_RADIUS_KM: num(12),
    OFFER_TIMEOUT_MS: int(15000),
    MATCH_CANDIDATE_PAGE_SIZE: int(10),
    LOCATION_FRESHNESS_MS: int(30000),
    MATCH_LEASE_MS: int(15000),
    OFFER_TIMERS_ENABLED: bool(true),
    MATCHING_AUTO_START: bool(true),

    // Recovery worker.
    RUN_WORKER_IN_PROCESS: bool(true),
    WORKER_INTERVAL_MS: int(5000),
    WORKER_STALE_SEARCH_MS: int(10000),
    WORKER_RESERVATION_GRACE_MS: int(30000),

    // Fare (all money in paise, the smallest INR unit: 100 paise = 1 rupee).
    FARE_CURRENCY: z.string().length(3).default('INR'),
    FARE_BASE_PAISE: int(5000),
    FARE_PER_KM_PAISE: int(1200),
    FARE_PER_MIN_PAISE: int(150),
    FARE_MINIMUM_PAISE: int(8000),
    FARE_AVG_SPEED_KMH: num(25),
    ROUTING_PROVIDER: z.enum(['straight_line', 'osrm']).default('straight_line'),
    OSRM_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
    ROUTING_TIMEOUT_MS: int(3000),

    // Payments (mock provider only; no card data is ever handled).
    PAYMENT_PROVIDER: z.enum(['mock']).default('mock'),
    PAYMENT_WEBHOOK_SECRET: secret(16),
    PAYMENT_MOCK_AUTO_SETTLE: bool(true),
    PAYMENT_MOCK_SETTLE_DELAY_MS: int(1500),

    // OTPs (login + trip verification). OTP_SECRET keys the HMAC used to
    // store codes as hashes; TRIP_OTP_ENCRYPTION_KEY (32 bytes, hex) encrypts
    // trip codes so only the passenger can view them again.
    OTP_SECRET: secret(16),
    TRIP_OTP_ENCRYPTION_KEY: z.preprocess((v) => (v === '' || v === 'change-me' ? undefined : v), z.string().regex(/^[0-9a-f]{64}$/i, 'must be 64 hex chars (32 bytes)').optional()),
    TRIP_OTP_TTL_MS: int(60 * 60 * 1000),
    TRIP_OTP_MAX_ATTEMPTS: int(5),
    TRIP_OTP_MAX_REGENERATIONS: int(5),
    LOGIN_OTP_TTL_MS: int(5 * 60 * 1000),
    LOGIN_OTP_MAX_ATTEMPTS: int(5),
    LOGIN_OTP_RESEND_COOLDOWN_MS: int(60 * 1000),
    LOGIN_OTP_MAX_PER_HOUR: int(5),

    // SMS delivery. dev_outbox stores messages in MongoDB for developers
    // (nothing is sent); twilio sends real SMS; disabled turns SMS features off.
    SMS_PROVIDER: z.enum(['dev_outbox', 'twilio', 'disabled']).optional(),
    TWILIO_ACCOUNT_SID: z.string().optional(),
    TWILIO_AUTH_TOKEN: z.string().optional(),
    TWILIO_FROM_NUMBER: z.string().optional(),

    // Google sign-in (OpenID Connect ID tokens). Empty = Google sign-in disabled.
    GOOGLE_CLIENT_ID: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(10).optional()),

    // Driver documents: private encrypted storage.
    DOCUMENT_STORAGE_DIR: z.string().default('./private-uploads'),
    DOCUMENT_ENCRYPTION_KEY: z.preprocess((v) => (v === '' || v === 'change-me' ? undefined : v), z.string().regex(/^[0-9a-f]{64}$/i, 'must be 64 hex chars (32 bytes)').optional()),
    DOCUMENT_MAX_BYTES: int(5 * 1024 * 1024),
    DRIVER_REQUIRED_DOCUMENTS: z.string().default('PHOTO,DRIVING_LICENSE,VEHICLE_RC,AADHAAR'),
    DOCUMENT_RETENTION_DAYS: int(30),

    // Reviews and chat.
    REVIEW_WINDOW_DAYS: int(14),
    CHAT_MAX_MESSAGE_LENGTH: int(500),
    CHAT_RATE_LIMIT_COUNT: int(10),
    CHAT_RATE_LIMIT_WINDOW_MS: int(10 * 1000),
    CHAT_READ_AFTER_RIDE_MS: int(24 * 3600 * 1000),
    CHAT_RETENTION_DAYS: int(30),

    // Safety / emergency integration. none = no external dispatch exists.
    EMERGENCY_PROVIDER: z.enum(['none', 'webhook']).default('none'),
    EMERGENCY_WEBHOOK_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
    EMERGENCY_WEBHOOK_SECRET: secret(16),
    EMERGENCY_MAX_ATTEMPTS: int(5),
    EMERGENCY_PHONE_NUMBER: z.string().default('112'),

    // Women-driver preference (can be switched off where it cannot be offered).
    FEMALE_DRIVER_PREFERENCE_ENABLED: bool(true),

    // Socket.IO cross-process delivery through MongoDB.
    SOCKET_ADAPTER: z.enum(['mongo', 'memory']).default('mongo'),

    // Optional bootstrap admin (created by `npm run seed:admin`).
    ADMIN_EMAIL: z.string().email().optional(),
    ADMIN_PASSWORD: secret(8),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production') {
      if (!env.JWT_SECRET || env.JWT_SECRET.length < 32) {
        ctx.addIssue({ code: 'custom', path: ['JWT_SECRET'], message: 'must be set (32+ chars) in production' });
      }
      if (!env.PAYMENT_WEBHOOK_SECRET) {
        ctx.addIssue({ code: 'custom', path: ['PAYMENT_WEBHOOK_SECRET'], message: 'must be set in production' });
      }
    }
    if (env.MATCH_MAX_RADIUS_KM < env.MATCH_INITIAL_RADIUS_KM) {
      ctx.addIssue({ code: 'custom', path: ['MATCH_MAX_RADIUS_KM'], message: 'must be >= initial radius' });
    }
    if (env.MATCH_RADIUS_STEP_KM <= 0 || env.MATCH_INITIAL_RADIUS_KM <= 0) {
      ctx.addIssue({ code: 'custom', path: ['MATCH_RADIUS_STEP_KM'], message: 'radii must be positive' });
    }
    if (env.NODE_ENV === 'production') {
      for (const key of ['OTP_SECRET', 'TRIP_OTP_ENCRYPTION_KEY', 'DOCUMENT_ENCRYPTION_KEY']) {
        if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: 'must be set in production' });
      }
      if (!env.SMS_PROVIDER || env.SMS_PROVIDER === 'dev_outbox') {
        ctx.addIssue({ code: 'custom', path: ['SMS_PROVIDER'], message: 'must be twilio or disabled in production' });
      }
    }
    if (env.SMS_PROVIDER === 'twilio' && !(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM_NUMBER)) {
      ctx.addIssue({ code: 'custom', path: ['SMS_PROVIDER'], message: 'twilio needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER' });
    }
    if (env.EMERGENCY_PROVIDER === 'webhook' && !(env.EMERGENCY_WEBHOOK_URL && env.EMERGENCY_WEBHOOK_SECRET)) {
      ctx.addIssue({ code: 'custom', path: ['EMERGENCY_PROVIDER'], message: 'webhook needs EMERGENCY_WEBHOOK_URL and EMERGENCY_WEBHOOK_SECRET' });
    }
    if (env.ROUTING_PROVIDER === 'osrm' && !env.OSRM_URL) {
      ctx.addIssue({ code: 'custom', path: ['OSRM_URL'], message: 'required when ROUTING_PROVIDER=osrm' });
    }
  });

function load(source = process.env) {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    // Only print variable names and messages, never values (they may be secrets).
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const env = parsed.data;

  // Development fallbacks so `docker compose up` works without a .env file.
  // Production refuses to start without real secrets (see superRefine above).
  const jwtSecret = env.JWT_SECRET || 'dev-only-insecure-jwt-secret-change-me';
  const webhookSecret = env.PAYMENT_WEBHOOK_SECRET || 'dev-only-insecure-webhook-secret';
  // Development-only fallback keys (clearly not secret). Production must set real ones.
  const devKey = (label) => require('crypto').createHash('sha256').update(`dev-only-insecure-${label}`).digest('hex');

  return {
    env: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
    port: env.PORT,
    mongoUri: env.MONGO_URI,
    logLevel: env.LOG_LEVEL,
    corsOrigins: env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    auth: { jwtSecret, jwtExpiresIn: env.JWT_EXPIRES_IN, bcryptRounds: env.BCRYPT_ROUNDS },
    rateLimit: {
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      authMax: env.AUTH_RATE_LIMIT_MAX,
      bookingMax: env.BOOKING_RATE_LIMIT_MAX,
    },
    matching: {
      initialRadiusKm: env.MATCH_INITIAL_RADIUS_KM,
      radiusStepKm: env.MATCH_RADIUS_STEP_KM,
      maxRadiusKm: env.MATCH_MAX_RADIUS_KM,
      offerTimeoutMs: env.OFFER_TIMEOUT_MS,
      candidatePageSize: env.MATCH_CANDIDATE_PAGE_SIZE,
      locationFreshnessMs: env.LOCATION_FRESHNESS_MS,
      leaseMs: env.MATCH_LEASE_MS,
      offerTimersEnabled: env.OFFER_TIMERS_ENABLED,
      autoStart: env.MATCHING_AUTO_START,
    },
    worker: {
      runInProcess: env.RUN_WORKER_IN_PROCESS,
      intervalMs: env.WORKER_INTERVAL_MS,
      staleSearchMs: env.WORKER_STALE_SEARCH_MS,
      reservationGraceMs: env.WORKER_RESERVATION_GRACE_MS,
    },
    fare: {
      currency: env.FARE_CURRENCY,
      basePaise: env.FARE_BASE_PAISE,
      perKmPaise: env.FARE_PER_KM_PAISE,
      perMinPaise: env.FARE_PER_MIN_PAISE,
      minimumPaise: env.FARE_MINIMUM_PAISE,
      avgSpeedKmh: env.FARE_AVG_SPEED_KMH,
    },
    routing: { provider: env.ROUTING_PROVIDER, osrmUrl: env.OSRM_URL, timeoutMs: env.ROUTING_TIMEOUT_MS },
    payments: {
      provider: env.PAYMENT_PROVIDER,
      webhookSecret,
      mockAutoSettle: env.PAYMENT_MOCK_AUTO_SETTLE,
      mockSettleDelayMs: env.PAYMENT_MOCK_SETTLE_DELAY_MS,
    },
    socket: { adapter: env.SOCKET_ADAPTER },
    otp: {
      secret: env.OTP_SECRET || 'dev-only-insecure-otp-secret',
      tripEncryptionKey: env.TRIP_OTP_ENCRYPTION_KEY || devKey('trip-otp'),
      tripTtlMs: env.TRIP_OTP_TTL_MS,
      tripMaxAttempts: env.TRIP_OTP_MAX_ATTEMPTS,
      tripMaxRegenerations: env.TRIP_OTP_MAX_REGENERATIONS,
      loginTtlMs: env.LOGIN_OTP_TTL_MS,
      loginMaxAttempts: env.LOGIN_OTP_MAX_ATTEMPTS,
      loginResendCooldownMs: env.LOGIN_OTP_RESEND_COOLDOWN_MS,
      loginMaxPerHour: env.LOGIN_OTP_MAX_PER_HOUR,
    },
    sms: {
      provider: env.SMS_PROVIDER || (env.NODE_ENV === 'production' ? 'disabled' : 'dev_outbox'),
      twilio: { accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN, from: env.TWILIO_FROM_NUMBER },
    },
    google: { clientId: env.GOOGLE_CLIENT_ID || null },
    documents: {
      storageDir: env.DOCUMENT_STORAGE_DIR,
      encryptionKey: env.DOCUMENT_ENCRYPTION_KEY || devKey('documents'),
      maxBytes: env.DOCUMENT_MAX_BYTES,
      required: env.DRIVER_REQUIRED_DOCUMENTS.split(',').map((s) => s.trim()).filter(Boolean),
      retentionDays: env.DOCUMENT_RETENTION_DAYS,
    },
    reviews: { windowDays: env.REVIEW_WINDOW_DAYS },
    chat: {
      maxLength: env.CHAT_MAX_MESSAGE_LENGTH,
      rateLimitCount: env.CHAT_RATE_LIMIT_COUNT,
      rateLimitWindowMs: env.CHAT_RATE_LIMIT_WINDOW_MS,
      readAfterRideMs: env.CHAT_READ_AFTER_RIDE_MS,
      retentionDays: env.CHAT_RETENTION_DAYS,
    },
    emergency: {
      provider: env.EMERGENCY_PROVIDER,
      webhookUrl: env.EMERGENCY_WEBHOOK_URL || null,
      webhookSecret: env.EMERGENCY_WEBHOOK_SECRET || null,
      maxAttempts: env.EMERGENCY_MAX_ATTEMPTS,
      phoneNumber: env.EMERGENCY_PHONE_NUMBER,
    },
    preferences: { femaleDriverEnabled: env.FEMALE_DRIVER_PREFERENCE_ENABLED },
    admin: { email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD },
  };
}

const config = load();
Object.defineProperty(config, 'load', { value: load, enumerable: false });
module.exports = Object.freeze(config);
