'use strict';

/** Forward rejected promises from async route handlers to the error handler. */
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Standard success envelope. */
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

module.exports = { asyncHandler, ok };
