'use strict';

const mongoose = require('mongoose');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errors');
const { isDuplicateKeyError } = require('../utils/transaction');

function notFoundHandler(req, res) {
  res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` } });
}

/**
 * Converts any thrown error into the standard JSON error shape:
 *   { success: false, error: { code, message, details? } }
 * Stack traces and internal messages are logged, never sent to clients.
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  let status = 500;
  let body = { code: 'INTERNAL_ERROR', message: 'Something went wrong' };

  if (err instanceof AppError) {
    status = err.status;
    body = { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) };
  } else if (err.type === 'entity.parse.failed') {
    status = 400;
    body = { code: 'BAD_REQUEST', message: 'Malformed JSON body' };
  } else if (err.type === 'entity.too.large') {
    status = 413;
    body = { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' };
  } else if (err.name === 'MulterError') {
    status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    body = { code: err.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : 'BAD_UPLOAD', message: err.code === 'LIMIT_FILE_SIZE' ? 'File is too large' : 'Invalid upload' };
  } else if (err instanceof mongoose.Error.CastError) {
    status = 400;
    body = { code: 'BAD_REQUEST', message: `Invalid value for ${err.path}` };
  } else if (err instanceof mongoose.Error.ValidationError) {
    status = 400;
    body = { code: 'BAD_REQUEST', message: 'Validation failed' };
  } else if (isDuplicateKeyError(err)) {
    status = 409;
    body = { code: 'DUPLICATE', message: 'A record with these details already exists' };
  }

  if (status >= 500) {
    logger.error({ err, method: req.method, path: req.path }, 'unhandled request error');
  } else {
    logger.debug({ code: body.code, method: req.method, path: req.path }, 'request rejected');
  }
  res.status(status).json({ success: false, error: body });
}

module.exports = { notFoundHandler, errorHandler };
