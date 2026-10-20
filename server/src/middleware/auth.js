'use strict';

const { verifyToken } = require('../services/authService');
const { User } = require('../models');
const { AppError, unauthorized, forbidden } = require('../utils/errors');

/**
 * Authentication: requires a valid `Authorization: Bearer <jwt>` header.
 * The user id and role come only from the verified token + database,
 * never from the request body or query string.
 */
async function authenticate(req, _res, next) {
  try {
    const header = req.get('authorization') || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) throw unauthorized();

    const payload = verifyToken(token); // throws 401 on bad/expired token
    // Re-load so a deleted user or changed role takes effect immediately.
    const user = await User.findById(payload.sub).lean();
    if (!user) throw unauthorized('User no longer exists');
    if (user.accountStatus === 'SUSPENDED') throw new AppError(403, 'ACCOUNT_SUSPENDED', 'This account is suspended. Contact support.');

    req.user = { id: String(user._id), role: user.role, name: user.name, email: user.email, adminPermissions: user.adminPermissions || [] };
    next();
  } catch (err) {
    next(err);
  }
}

/** Authorization: only the listed roles may continue. */
function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden());
    next();
  };
}

/**
 * Admin permission check (on top of requireRole(ADMIN)). An admin needs the
 * named permission, or '*' (bootstrap super admin).
 */
function requirePermission(permission) {
  return (req, _res, next) => {
    if (!req.user || req.user.role !== 'ADMIN') return next(forbidden());
    const perms = req.user.adminPermissions || [];
    if (!perms.includes('*') && !perms.includes(permission)) return next(forbidden(`Missing admin permission: ${permission}`));
    next();
  };
}

module.exports = { authenticate, requireRole, requirePermission };
