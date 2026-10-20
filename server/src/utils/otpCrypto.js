'use strict';

// Cryptographic helpers for one-time codes and encrypted storage.
const crypto = require('crypto');

/** Uniformly random numeric code, e.g. "048213" (crypto.randomInt, not Math.random). */
function generateNumericCode(digits = 6) {
  let out = '';
  for (let i = 0; i < digits; i += 1) out += String(crypto.randomInt(0, 10));
  return out;
}

/**
 * Keyed hash of a code bound to its context (ride, purpose, person).
 * Even someone who can read the database cannot reverse it, and the same
 * code for a different ride produces a different hash.
 */
function hmacCode(secret, ...parts) {
  return crypto.createHmac('sha256', secret).update(parts.map(String).join('|')).digest('hex');
}

/** Constant-time comparison of two hex strings. */
function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/** AES-256-GCM. Output: base64(iv | authTag | ciphertext). Tampering makes decrypt throw. */
function encrypt(keyHex, plaintext) {
  const key = Buffer.from(keyHex, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8')), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]);
}

function decrypt(keyHex, payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
}

const encryptString = (keyHex, text) => encrypt(keyHex, text).toString('base64');
const decryptString = (keyHex, b64) => decrypt(keyHex, b64).toString('utf8');

module.exports = { generateNumericCode, hmacCode, safeEqualHex, encrypt, decrypt, encryptString, decryptString };
