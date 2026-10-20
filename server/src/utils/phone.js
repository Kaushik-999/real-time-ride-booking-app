'use strict';

/**
 * Canonical phone format: "+" followed by country code and number.
 * A bare 10-digit number is treated as Indian (+91), e.g.
 *   "98765 43210" -> "+919876543210", "+44 20 7946 0958" -> "+442079460958".
 * Returns null if the input cannot be a phone number.
 */
function normalizePhone(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/[\s\-().]/g, '').replace(/^\+/, '');
  if (!/^\d{7,15}$/.test(digits)) return null;
  if (hasPlus) return `+${digits}`;
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  return `+${digits}`;
}

/** "+919876543210" -> "+91******3210" for display without revealing the number. */
function maskPhone(phone) {
  if (!phone || phone.length < 6) return '****';
  return `${phone.slice(0, 3)}${'*'.repeat(Math.max(0, phone.length - 7))}${phone.slice(-4)}`;
}

module.exports = { normalizePhone, maskPhone };
