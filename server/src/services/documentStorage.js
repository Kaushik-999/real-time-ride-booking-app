'use strict';

/**
 * Private storage for sensitive driver documents.
 *
 * - Files are encrypted with AES-256-GCM (DOCUMENT_ENCRYPTION_KEY) before
 *   being written, so a copied disk or backup does not expose them.
 * - Names are random 32-hex "storage keys"; nothing about the driver or the
 *   document type appears in the path.
 * - The directory (DOCUMENT_STORAGE_DIR) is NOT served by Express or Vite.
 *   The only way to read a file is the authenticated, permission-checked,
 *   audited admin endpoint.
 * - Directories are created with mode 0700 and files with 0600.
 *
 * This is the local-disk implementation of a small interface
 * (put / get / remove). A cloud object store (e.g. S3 with server-side
 * encryption and no public access) could implement the same three functions.
 */
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const { encrypt, decrypt } = require('../utils/otpCrypto');

const KEY_PATTERN = /^[a-f0-9]{32}$/;

function fileFor(storageKey) {
  if (!KEY_PATTERN.test(storageKey)) throw new Error('invalid storage key'); // blocks path traversal
  return path.join(path.resolve(config.documents.storageDir), storageKey.slice(0, 2), `${storageKey}.bin`);
}

async function put(buffer) {
  const storageKey = crypto.randomBytes(16).toString('hex');
  const file = fileFor(storageKey);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, encrypt(config.documents.encryptionKey, buffer), { mode: 0o600, flag: 'wx' });
  return storageKey;
}

async function get(storageKey) {
  return decrypt(config.documents.encryptionKey, await fs.readFile(fileFor(storageKey)));
}

/** Idempotent: removing an already-removed file succeeds. */
async function remove(storageKey) {
  try {
    await fs.unlink(fileFor(storageKey));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

module.exports = { put, get, remove, fileFor };
