'use strict';

/**
 * Verifies Google ID tokens (OpenID Connect) without trusting the browser:
 *   - signature checked against Google's published public keys (JWKS),
 *   - `iss` must be Google, `aud` must be OUR client id (GOOGLE_CLIENT_ID),
 *   - `exp` / `iat` checked (expired tokens rejected),
 *   - only RS256 accepted.
 * Uses the `jose` library. Tests inject a local key set via setKeySetForTesting.
 */
const { createRemoteJWKSet, jwtVerify } = require('jose');
const config = require('../config');
const { AppError, unauthorized } = require('../utils/errors');

const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

let keySet = null;
function getKeySet() {
  if (!keySet) keySet = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
  return keySet;
}

function setKeySetForTesting(ks) {
  keySet = ks;
}

function isConfigured() {
  return Boolean(config.google.clientId);
}

/** Returns { subject, email, emailVerified, name } or throws 401/503. */
async function verifyGoogleIdToken(idToken, { clientId = config.google.clientId } = {}) {
  if (!clientId) throw new AppError(503, 'GOOGLE_NOT_CONFIGURED', 'Google sign-in is not configured on this server');
  let payload;
  try {
    ({ payload } = await jwtVerify(idToken, getKeySet(), {
      issuer: GOOGLE_ISSUERS,
      audience: clientId,
      algorithms: ['RS256'],
      clockTolerance: 30,
    }));
  } catch {
    // Never echo the reason (helps attackers); it is one of: bad signature,
    // wrong issuer/audience, expired, malformed.
    throw unauthorized('Google sign-in could not be verified');
  }
  if (typeof payload.sub !== 'string' || !payload.sub) throw unauthorized('Google sign-in could not be verified');
  return {
    subject: payload.sub,
    email: typeof payload.email === 'string' ? payload.email.toLowerCase() : null,
    emailVerified: payload.email_verified === true || payload.email_verified === 'true',
    name: typeof payload.name === 'string' ? payload.name.slice(0, 100) : null,
  };
}

module.exports = { verifyGoogleIdToken, isConfigured, setKeySetForTesting, GOOGLE_ISSUERS };
