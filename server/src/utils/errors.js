'use strict';

// Application errors carry an HTTP status and a stable machine-readable code.
// The error handler turns them into the standard JSON error response.
class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const badRequest = (message, details) => new AppError(400, 'BAD_REQUEST', message, details);
const unauthorized = (message = 'Authentication required') => new AppError(401, 'UNAUTHORIZED', message);
const forbidden = (message = 'You do not have permission to do this') => new AppError(403, 'FORBIDDEN', message);
const notFound = (message = 'Not found') => new AppError(404, 'NOT_FOUND', message);
const conflict = (message, code = 'CONFLICT') => new AppError(409, code, message);

module.exports = { AppError, badRequest, unauthorized, forbidden, notFound, conflict };
