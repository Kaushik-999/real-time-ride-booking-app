'use strict';

const adminService = require('../services/adminService');
const { ok } = require('../utils/asyncHandler');

exports.drivers = async (req, res) => ok(res, await adminService.listDrivers(req.query));
exports.setVehicleCapacity = async (req, res) =>
  ok(res, { profile: await adminService.setVehicleCapacity(req.user, req.params.driverId, req.body, { ip: req.ip }) });
exports.searchUsers = async (req, res) => ok(res, await adminService.searchUsers(req.query));
exports.userDetail = async (req, res) => ok(res, await adminService.userDetail(req.params.userId));
exports.setAccountStatus = async (req, res) =>
  ok(res, { user: await adminService.setAccountStatus(req.user, req.params.userId, req.body, { ip: req.ip }) });
exports.setPermissions = async (req, res) =>
  ok(res, { user: await adminService.setAdminPermissions(req.user, req.params.userId, req.body.permissions, { ip: req.ip }) });
exports.searchRides = async (req, res) => ok(res, await adminService.searchRides(req.query));
exports.rideDetailWithContext = async (req, res) => ok(res, await adminService.rideDetailWithContext(req.params.rideId));
exports.cancelRide = async (req, res) => ok(res, await adminService.adminCancelRide(req.user, req.params.rideId, req.body.reason, { ip: req.ip }));
exports.payments = async (req, res) => ok(res, await adminService.listPayments(req.query));
exports.requestRefund = async (req, res) => ok(res, await adminService.requestRefund(req.user, req.params.paymentId, req.body.reason, { ip: req.ip }));
exports.auditLogs = async (req, res) => ok(res, await require('../services/auditService').list(req.query));
exports.extendedMetrics = async (_req, res) => ok(res, await adminService.extendedMetrics());
