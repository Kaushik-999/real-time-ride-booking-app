'use strict';

const mongoose = require('mongoose');

/**
 * Run `fn(session)` inside a MongoDB multi-document transaction.
 *
 * - All writes made with `{ session }` commit together or not at all.
 * - `withTransaction` automatically retries the whole callback on transient
 *   errors such as write conflicts (two transactions touching the same
 *   document), so `fn` must be safe to run more than once: it must re-read
 *   state and re-check conditions rather than rely on outside variables.
 * - Never wait for users or call external services inside `fn`; keep it short.
 *
 * Returns whatever `fn` returned on the successful attempt.
 */
async function withTransaction(fn) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(
      async () => {
        result = await fn(session);
      },
      { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } }
    );
    return result;
  } finally {
    await session.endSession();
  }
}

/** Abort the current transaction attempt with a value instead of an error. */
class AbortTransaction extends Error {
  constructor(value) {
    super('transaction aborted');
    this.value = value;
  }
}

/**
 * Like withTransaction, but `fn` may throw `new AbortTransaction(value)` to
 * roll back every write in this attempt and return `value`.
 */
async function withTransactionOrAbort(fn) {
  try {
    return await withTransaction(fn);
  } catch (err) {
    if (err instanceof AbortTransaction) return err.value;
    throw err;
  }
}

const isDuplicateKeyError = (err) => Boolean(err) && (err.code === 11000 || err.codeName === 'DuplicateKey');

module.exports = { withTransaction, withTransactionOrAbort, AbortTransaction, isDuplicateKeyError };
