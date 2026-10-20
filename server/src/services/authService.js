'use strict';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('../config');
const logger = require('../utils/logger');
const { User, DriverProfile, AuthOtp } = require('../models');
const { ROLES, ACCOUNT_STATUS, OTP_STATUS } = require('../utils/constants');
const { AppError, unauthorized, conflict, forbidden } = require('../utils/errors');
const { withTransaction, isDuplicateKeyError } = require('../utils/transaction');
const { generateNumericCode, hmacCode, safeEqualHex } = require('../utils/otpCrypto');
const { maskPhone } = require('../utils/phone');
const smsService = require('./smsService');
const googleIdentity = require('./googleIdentity');

// A real bcrypt hash of a random string, compared against when the email is
// unknown so that login takes the same time whether or not the user exists.
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser-not-a-real-password', 10);

function signToken(user) {
  return jwt.sign({ sub: String(user._id), role: user.role }, config.auth.jwtSecret, {
    expiresIn: config.auth.jwtExpiresIn,
    algorithm: 'HS256',
  });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, config.auth.jwtSecret, { algorithms: ['HS256'] });
  } catch {
    throw unauthorized('Invalid or expired token');
  }
}

const suspended = () => new AppError(403, 'ACCOUNT_SUSPENDED', 'This account is suspended. Contact support.');

function issueSession(user) {
  if (user.accountStatus === ACCOUNT_STATUS.SUSPENDED) throw suspended();
  return { user: user.toJSON(), token: signToken(user) };
}

/**
 * Register a passenger or driver. For drivers the User and DriverProfile
 * are created in one transaction so we never end up with a driver user
 * that has no profile (or a profile pointing at no user).
 */
async function register({ name, email, password, phone, role, vehicle, identity }) {
  const passwordHash = await bcrypt.hash(password, config.auth.bcryptRounds);
  try {
    const user = await withTransaction(async (session) => {
      const [created] = await User.create([{ name, email, phone, passwordHash, role }], { session });
      if (role === ROLES.DRIVER) {
        await DriverProfile.create([{ userId: created._id, vehicle, identity }], { session });
      }
      return created;
    });
    return issueSession(user);
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      const field = Object.keys(err.keyPattern || {})[0] || 'field';
      const label = field.includes('registrationNumber') ? 'vehicle registration number' : field;
      throw conflict(`An account with this ${label} already exists`, 'DUPLICATE');
    }
    throw err;
  }
}

async function login({ email, password }) {
  const user = await User.findOne({ email }).select('+passwordHash');
  // Accounts created with Google have no password: compare against the dummy hash.
  const valid = await bcrypt.compare(password, user && user.passwordHash ? user.passwordHash : DUMMY_HASH);
  // Same message for unknown email and wrong password: don't reveal which accounts exist.
  if (!user || !user.passwordHash || !valid) throw unauthorized('Invalid email or password');
  return issueSession(user);
}

async function getProfile(userId) {
  const user = await User.findById(userId);
  if (!user) throw unauthorized('User no longer exists');
  const result = { user: user.toJSON() };
  if (user.role === ROLES.DRIVER) {
    const profile = await DriverProfile.findOne({ userId });
    result.driverProfile = profile ? profile.toJSON() : null;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Mobile OTP login
// ---------------------------------------------------------------------------

const loginOtpHash = (phone, code) => hmacCode(config.otp.secret, 'LOGIN', phone, code);
const GENERIC_OTP_ERROR = 'Invalid or expired code';

/**
 * Start an OTP login. The response is identical for registered and
 * unregistered numbers: a challenge is always recorded (cooldowns apply
 * equally), but an SMS is only sent to registered, active accounts.
 */
async function requestLoginOtp(phone) {
  if (!smsService.isAvailable()) throw new AppError(503, 'SMS_UNAVAILABLE', 'Phone sign-in is not available on this server');
  const now = Date.now();
  const latest = await AuthOtp.findOne({ phone }).sort({ createdAt: -1 }).lean();
  if (latest && now - latest.createdAt.getTime() < config.otp.loginResendCooldownMs) {
    const retryAfterSeconds = Math.ceil((config.otp.loginResendCooldownMs - (now - latest.createdAt.getTime())) / 1000);
    throw new AppError(429, 'OTP_COOLDOWN', `Please wait ${retryAfterSeconds} seconds before requesting another code`, { retryAfterSeconds });
  }
  const lastHour = await AuthOtp.countDocuments({ phone, createdAt: { $gte: new Date(now - 3600 * 1000) } });
  if (lastHour >= config.otp.loginMaxPerHour) throw new AppError(429, 'OTP_LIMIT', 'Too many codes requested. Try again later.');

  const user = await User.findOne({ phone, accountStatus: ACCOUNT_STATUS.ACTIVE }).select('_id').lean();
  const code = generateNumericCode(6);
  await AuthOtp.updateMany({ phone, status: OTP_STATUS.ACTIVE }, { $set: { status: OTP_STATUS.SUPERSEDED } });
  try {
    await AuthOtp.create({
      phone,
      userId: user ? user._id : null,
      codeHash: loginOtpHash(phone, code),
      maxAttempts: config.otp.loginMaxAttempts,
      expiresAt: new Date(now + config.otp.loginTtlMs),
    });
  } catch (err) {
    // A concurrent request for the same phone won the race.
    if (isDuplicateKeyError(err)) throw new AppError(429, 'OTP_COOLDOWN', 'A code was just requested. Please wait.', { retryAfterSeconds: 60 });
    throw err;
  }
  if (user) {
    // Sent only after the challenge is safely stored. A delivery failure is
    // logged but not revealed (it would reveal that the number is registered).
    await smsService.trySendSms({
      to: phone,
      body: `Your Ride sign-in code is ${code}. It expires in ${Math.round(config.otp.loginTtlMs / 60000)} minutes. Never share it.`,
      purpose: 'LOGIN',
    });
  }
  return {
    message: 'If this number belongs to an account, a sign-in code has been sent.',
    phone: maskPhone(phone),
    expiresInSeconds: Math.round(config.otp.loginTtlMs / 1000),
    resendAfterSeconds: Math.round(config.otp.loginResendCooldownMs / 1000),
    // Tells developers when codes go to the local outbox instead of a phone.
    delivery: config.sms.provider === 'dev_outbox' ? 'DEV_OUTBOX_NOT_SENT' : 'SMS',
  };
}

async function verifyLoginOtp(phone, code) {
  const now = new Date();
  // Count the attempt atomically BEFORE comparing, so parallel guesses can't exceed the limit.
  const challenge = await AuthOtp.findOneAndUpdate(
    { phone, status: OTP_STATUS.ACTIVE, expiresAt: { $gt: now }, $expr: { $lt: ['$attempts', '$maxAttempts'] } },
    { $inc: { attempts: 1 } },
    { new: true }
  ).select('+codeHash');
  if (!challenge) throw unauthorized(GENERIC_OTP_ERROR);

  if (!safeEqualHex(challenge.codeHash, loginOtpHash(phone, code))) {
    if (challenge.attempts >= challenge.maxAttempts) {
      await AuthOtp.updateOne({ _id: challenge._id, status: OTP_STATUS.ACTIVE }, { $set: { status: OTP_STATUS.LOCKED } });
    }
    throw unauthorized(GENERIC_OTP_ERROR);
  }
  // Single use: only one concurrent verification can flip ACTIVE -> VERIFIED.
  const used = await AuthOtp.updateOne({ _id: challenge._id, status: OTP_STATUS.ACTIVE }, { $set: { status: OTP_STATUS.VERIFIED, verifiedAt: now } });
  if (used.modifiedCount !== 1 || !challenge.userId) throw unauthorized(GENERIC_OTP_ERROR);

  const user = await User.findOneAndUpdate({ _id: challenge.userId, phone }, { $set: { phoneVerifiedAt: now } }, { new: true });
  if (!user) throw unauthorized(GENERIC_OTP_ERROR);
  return issueSession(user);
}

// ---------------------------------------------------------------------------
// Google sign-in
// ---------------------------------------------------------------------------

/**
 * Sign in (or sign up as a passenger) with a Google ID token.
 * - Known Google account (matched by Google's `sub`) -> sign in.
 * - Email already used by another account -> 409 ACCOUNT_LINK_REQUIRED.
 *   We NEVER merge automatically; the owner signs in the usual way and links Google.
 * - New and email verified by Google -> new PASSENGER account.
 */
async function googleSignIn(idToken) {
  const g = await googleIdentity.verifyGoogleIdToken(idToken);
  const existing = await User.findOne({ authProviders: { $elemMatch: { provider: 'google', subject: g.subject } } });
  if (existing) return { ...issueSession(existing), created: false };

  const emailOwner = g.email ? await User.findOne({ email: g.email }) : null;
  if (emailOwner) {
    // A parallel request for this same Google account may have just created it.
    const linked = emailOwner.authProviders.some((p) => p.provider === 'google' && p.subject === g.subject);
    if (linked) return { ...issueSession(emailOwner), created: false };
    throw new AppError(
      409,
      'ACCOUNT_LINK_REQUIRED',
      'An account with this email already exists. Sign in with your password or phone, then link Google from your profile.'
    );
  }
  if (!g.email || !g.emailVerified) throw forbidden('Your Google account email is not verified');

  try {
    const user = await User.create({
      name: g.name || g.email.split('@')[0],
      email: g.email,
      role: ROLES.PASSENGER,
      authProviders: [{ provider: 'google', subject: g.subject, email: g.email, emailVerified: true }],
    });
    logger.info({ userId: String(user._id) }, 'account created with google');
    return { ...issueSession(user), created: true };
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    // Two sign-ups with the same Google account raced: the winner exists now.
    const winner = await User.findOne({ authProviders: { $elemMatch: { provider: 'google', subject: g.subject } } });
    if (winner) return { ...issueSession(winner), created: false };
    throw conflict('An account with this email already exists', 'ACCOUNT_LINK_REQUIRED');
  }
}

/** Explicitly link Google to the signed-in account (the user proves both). */
async function linkGoogle(userId, idToken) {
  const g = await googleIdentity.verifyGoogleIdToken(idToken);
  if (!g.emailVerified) throw forbidden('Your Google account email is not verified');
  const owner = await User.findOne({ authProviders: { $elemMatch: { provider: 'google', subject: g.subject } } }).select('_id').lean();
  if (owner && String(owner._id) !== String(userId)) throw conflict('This Google account is linked to a different user', 'IDENTITY_IN_USE');
  if (owner) return { user: (await User.findById(userId)).toJSON(), alreadyLinked: true };
  try {
    const user = await User.findOneAndUpdate(
      { _id: userId, 'authProviders.provider': { $ne: 'google' } },
      { $push: { authProviders: { provider: 'google', subject: g.subject, email: g.email, emailVerified: true } } },
      { new: true }
    );
    if (!user) throw conflict('A different Google account is already linked', 'PROVIDER_ALREADY_LINKED');
    return { user: user.toJSON(), alreadyLinked: false };
  } catch (err) {
    if (isDuplicateKeyError(err)) throw conflict('This Google account is linked to a different user', 'IDENTITY_IN_USE');
    throw err;
  }
}

function providerStatus() {
  return {
    password: true,
    phoneOtp: smsService.isAvailable(),
    phoneOtpDelivery: config.sms.provider,
    google: googleIdentity.isConfigured(),
    // The OAuth client id is public by design (it is embedded in the web page).
    googleClientId: config.google.clientId,
  };
}

module.exports = {
  register,
  login,
  getProfile,
  signToken,
  verifyToken,
  requestLoginOtp,
  verifyLoginOtp,
  googleSignIn,
  linkGoogle,
  providerStatus,
};
