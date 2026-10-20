'use strict';

const config = require('../config');
const { User, DriverProfile, DriverLocation, Ride, RideOffer, RideEvent, Payment } = require('../models');
const { RIDE_STATUS } = require('../utils/constants');
const { notFound } = require('../utils/errors');
const { fromPoint } = require('../utils/geo');

async function listDrivers({ page, limit, approvalStatus, femaleProgram }) {
  const filter = approvalStatus ? { approvalStatus } : {};
  if (femaleProgram) filter['femaleDriverProgram.status'] = femaleProgram;
  const [profiles, total] = await Promise.all([
    DriverProfile.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    DriverProfile.countDocuments(filter),
  ]);
  const userIds = profiles.map((p) => p.userId);
  const [users, locations] = await Promise.all([
    User.find({ _id: { $in: userIds } }).select('name email phone').lean(),
    DriverLocation.find({ driverId: { $in: userIds } }).lean(),
  ]);
  const userById = new Map(users.map((u) => [String(u._id), u]));
  const locById = new Map(locations.map((l) => [String(l.driverId), l]));
  const freshSince = Date.now() - config.matching.locationFreshnessMs;
  const items = profiles.map((p) => {
    const u = userById.get(String(p.userId));
    const loc = locById.get(String(p.userId));
    return {
      id: String(p._id),
      userId: String(p.userId),
      name: u ? u.name : null,
      email: u ? u.email : null,
      phone: u ? u.phone || null : null,
      vehicle: p.vehicle,
      identity: p.identity ? { legalName: p.identity.legalName || null } : null,
      approvalStatus: p.approvalStatus,
      femaleDriverProgram: p.femaleDriverProgram ? p.femaleDriverProgram.status : 'NOT_REQUESTED',
      submittedAt: p.review ? p.review.submittedAt || null : null,
      availability: p.availability,
      activeRideId: p.activeRideId ? String(p.activeRideId) : null,
      location: loc ? { ...fromPoint(loc.location), updatedAt: loc.updatedAt, fresh: loc.updatedAt.getTime() >= freshSince } : null,
      createdAt: p.createdAt,
    };
  });
  return { items, total, page, limit };
}

/** Correct a vehicle's passenger capacity (within the catalog maximum). Audited. */
async function setVehicleCapacity(admin, driverUserId, { capacity, reason }, { ip } = {}) {
  const { getVehicle } = require('../config/vehicles');
  const { withTransactionOrAbort, AbortTransaction } = require('../utils/transaction');
  const audit = require('./auditService');
  const { badRequest, conflict } = require('../utils/errors');
  const profile = await DriverProfile.findOne({ userId: driverUserId }).lean();
  if (!profile) throw notFound('Driver not found');
  const entry = getVehicle(profile.vehicle.type);
  if (entry && capacity > entry.maxCapacity) throw badRequest(`A ${entry.label} can carry at most ${entry.maxCapacity} passengers`);
  const result = await withTransactionOrAbort(async (session) => {
    const updated = await DriverProfile.findOneAndUpdate(
      { userId: driverUserId, activeRideId: null },
      { $set: { 'vehicle.capacity': capacity } },
      { new: true, session }
    );
    if (!updated) throw new AbortTransaction({ error: conflict('Driver currently holds a ride; try again later', 'DRIVER_BUSY') });
    await audit.record(
      { actorId: admin.id, action: 'VEHICLE_CAPACITY_CHANGED', targetType: 'DriverProfile', targetId: driverUserId, metadata: { from: profile.vehicle.capacity, to: capacity, reason: reason || null }, ip },
      { session }
    );
    return { profile: updated };
  });
  if (result.error) throw result.error;
  return result.profile;
}

async function getRideDetail(rideId) {
  const ride = await Ride.findById(rideId);
  if (!ride) throw notFound('Ride not found');
  const [events, offers, payment] = await Promise.all([
    RideEvent.find({ rideId }).sort({ createdAt: 1, _id: 1 }),
    RideOffer.find({ rideId }).sort({ offeredAt: 1 }),
    Payment.findOne({ rideId }),
  ]);
  return { ride, events, offers, payment };
}

const countBy = (Model, field, match = {}) =>
  Model.aggregate([{ $match: match }, { $group: { _id: `$${field}`, count: { $sum: 1 } } }]).then((rows) =>
    Object.fromEntries(rows.map((r) => [r._id, r.count]))
  );

async function metrics() {
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const [usersByRole, ridesByStatus, driversByAvailability, driversByApproval, offersByStatus, revenue, assignTimes] = await Promise.all([
    countBy(User, 'role'),
    countBy(Ride, 'status'),
    countBy(DriverProfile, 'availability'),
    countBy(DriverProfile, 'approvalStatus'),
    countBy(RideOffer, 'status'),
    Payment.aggregate([{ $match: { status: 'SUCCEEDED' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
    Ride.aggregate([
      { $match: { assignedAt: { $ne: null }, createdAt: { $gte: since } } },
      { $project: { ms: { $subtract: ['$assignedAt', '$matchingStartedAt'] } } },
      { $group: { _id: null, avg: { $avg: '$ms' } } },
    ]),
  ]);
  const totalRides = Object.values(ridesByStatus).reduce((a, b) => a + b, 0);
  const failed = (ridesByStatus[RIDE_STATUS.NO_DRIVER_FOUND] || 0) + (ridesByStatus[RIDE_STATUS.CANCELLED] || 0);
  return {
    usersByRole,
    ridesByStatus,
    driversByAvailability,
    driversByApproval,
    offersByStatus,
    totalRides,
    failedOrCancelledRides: failed,
    collectedRevenuePaise: revenue[0] ? revenue[0].total : 0,
    avgTimeToAssignMsLast24h: assignTimes[0] ? Math.round(assignTimes[0].avg) : null,
    currency: config.fare.currency,
  };
}

module.exports = { listDrivers, setVehicleCapacity, getRideDetail, metrics };

// ---------------------------------------------------------------------------
// Upgrade: user management, ride search, payments, permissions, metrics
// ---------------------------------------------------------------------------
const audit = require('./auditService');
const { withTransactionOrAbort, AbortTransaction } = require('../utils/transaction');
const errors = require('../utils/errors');
const { ROLES, ADMIN_PERMISSIONS, ACCOUNT_STATUS, DRIVER_AVAILABILITY } = require('../utils/constants');
const notifier = require('../sockets/notifier');
const mongoose = require('mongoose');

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function searchUsers({ page, limit, role, q, accountStatus }) {
  const filter = {};
  if (role) filter.role = role;
  if (accountStatus) filter.accountStatus = accountStatus;
  if (q) {
    const rx = new RegExp(escapeRegex(q.trim()), 'i');
    filter.$or = [{ name: rx }, { email: rx }, { phone: rx }];
  }
  const [items, total] = await Promise.all([
    User.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    User.countDocuments(filter),
  ]);
  return { items, total, page, limit };
}

async function userDetail(userId) {
  const { SafetyIncident, Review } = require('../models');
  const user = await User.findById(userId);
  if (!user) throw errors.notFound('User not found');
  const oid = new mongoose.Types.ObjectId(String(userId));
  const [ridesAsPassenger, ridesAsDriver, incidents, reviewsGiven, profile] = await Promise.all([
    countBy(Ride, 'status', { passengerId: oid }),
    countBy(Ride, 'status', { driverId: oid }),
    SafetyIncident.countDocuments({ $or: [{ reporterId: oid }, { 'context.passengerId': oid }, { 'context.driverId': oid }] }),
    Review.countDocuments({ reviewerId: oid }),
    user.role === ROLES.DRIVER ? DriverProfile.findOne({ userId }).lean() : null,
  ]);
  return {
    user: user.toJSON(),
    verification: {
      emailPasswordLogin: Boolean(await User.exists({ _id: userId, passwordHash: { $type: 'string' } })),
      phone: user.phone ? { number: user.phone, verified: Boolean(user.phoneVerifiedAt), verifiedAt: user.phoneVerifiedAt || null } : null,
      linkedProviders: (user.authProviders || []).map((p) => p.provider),
      driverApproval: profile ? profile.approvalStatus : null,
      femaleDriverProgram: profile && profile.femaleDriverProgram ? profile.femaleDriverProgram.status : null,
    },
    suspension: user.suspension && user.suspension.at ? { reason: user.suspension.reason, at: user.suspension.at } : null,
    stats: { ridesAsPassenger, ridesAsDriver, safetyIncidentsInvolved: incidents, reviewsGiven },
  };
}

/** Suspend or reinstate a passenger/driver. Admin accounts cannot be suspended here. */
async function setAccountStatus(admin, userId, { accountStatus, reason }, { ip } = {}) {
  if (String(userId) === admin.id) throw errors.forbidden('You cannot change your own account status');
  if (accountStatus === ACCOUNT_STATUS.SUSPENDED && !reason) throw errors.badRequest('A reason is required to suspend an account');
  const target = await User.findById(userId).lean();
  if (!target) throw errors.notFound('User not found');
  if (target.role === ROLES.ADMIN) throw errors.forbidden('Administrator accounts cannot be suspended from the dashboard');
  const from = accountStatus === ACCOUNT_STATUS.SUSPENDED ? ACCOUNT_STATUS.ACTIVE : ACCOUNT_STATUS.SUSPENDED;

  const result = await withTransactionOrAbort(async (session) => {
    if (target.role === ROLES.DRIVER && accountStatus === ACCOUNT_STATUS.SUSPENDED) {
      // A driver holding a ride must finish (or lose) it first.
      const res = await DriverProfile.updateOne({ userId, activeRideId: null }, { $set: { availability: DRIVER_AVAILABILITY.OFFLINE } }, { session });
      if (res.matchedCount === 0 && (await DriverProfile.exists({ userId }).session(session))) {
        throw new AbortTransaction({ error: errors.conflict('Driver currently holds a ride; try again after it ends', 'DRIVER_BUSY') });
      }
    }
    const set =
      accountStatus === ACCOUNT_STATUS.SUSPENDED
        ? { accountStatus, suspension: { reason, by: admin.id, at: new Date() } }
        : { accountStatus };
    const updated = await User.findOneAndUpdate({ _id: userId, accountStatus: from }, { $set: set, ...(accountStatus === ACCOUNT_STATUS.ACTIVE ? { $unset: { suspension: 1 } } : {}) }, { new: true, session });
    if (!updated) throw new AbortTransaction({ error: errors.conflict(`Account is already ${accountStatus}`, 'NO_CHANGE') });
    await audit.record({ actorId: admin.id, action: `ACCOUNT_${accountStatus}`, targetType: 'User', targetId: userId, metadata: { reason: reason || null, role: target.role }, ip }, { session });
    return { user: updated };
  });
  if (result.error) throw result.error;
  if (accountStatus === ACCOUNT_STATUS.SUSPENDED) notifier.toUser(userId, 'account:suspended', {});
  return result.user;
}

/** Only super admins ('*') may change other admins' permissions. */
async function setAdminPermissions(admin, userId, permissions, { ip } = {}) {
  if (!(admin.adminPermissions || []).includes('*')) throw errors.forbidden('Only a super administrator can change permissions');
  if (String(userId) === admin.id) throw errors.forbidden('You cannot change your own permissions');
  const unknown = permissions.filter((p) => !ADMIN_PERMISSIONS.includes(p) && p !== '*');
  if (unknown.length) throw errors.badRequest(`Unknown permissions: ${unknown.join(', ')}`);
  const before = await User.findOne({ _id: userId, role: ROLES.ADMIN }).lean();
  if (!before) throw errors.notFound('Administrator not found');
  const updated = await User.findOneAndUpdate({ _id: userId, role: ROLES.ADMIN }, { $set: { adminPermissions: permissions } }, { new: true });
  await audit.record({ actorId: admin.id, action: 'ADMIN_PERMISSIONS_CHANGED', targetType: 'User', targetId: userId, metadata: { from: before.adminPermissions || [], to: permissions }, ip });
  return updated;
}

async function searchRides({ page, limit, status, passengerId, driverId, from, to, vehicleType }) {
  const filter = {};
  if (status) filter.status = status;
  if (passengerId) filter.passengerId = passengerId;
  if (driverId) filter.driverId = driverId;
  if (vehicleType) filter.vehicleType = vehicleType;
  if (from || to) filter.createdAt = { ...(from ? { $gte: new Date(from) } : {}), ...(to ? { $lte: new Date(to) } : {}) };
  const [items, total] = await Promise.all([
    Ride.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    Ride.countDocuments(filter),
  ]);
  return { items, total, page, limit };
}

async function rideDetailWithContext(rideId) {
  const { SafetyIncident, ChatReport } = require('../models');
  const base = await getRideDetail(rideId);
  const [incidents, chatReports] = await Promise.all([
    SafetyIncident.find({ rideId }).select('status reporterRole emergencyDispatch.status createdAt').lean(),
    ChatReport.countDocuments({ rideId }),
  ]);
  return {
    ...base,
    safetyIncidents: incidents.map((i) => ({ id: String(i._id), status: i.status, reporterRole: i.reporterRole, dispatchStatus: i.emergencyDispatch.status, createdAt: i.createdAt })),
    chatReports,
  };
}

async function adminCancelRide(admin, rideId, reason, { ip } = {}) {
  const rideService = require('./rideService');
  const { ride, alreadyCancelled } = await rideService.cancelRide(rideId, { id: admin.id, role: ROLES.ADMIN }, `Cancelled by operations: ${reason}`);
  if (!alreadyCancelled) {
    await audit.record({ actorId: admin.id, action: 'RIDE_CANCELLED_BY_ADMIN', targetType: 'Ride', targetId: rideId, metadata: { reason }, ip });
  }
  return { ride, alreadyCancelled };
}

async function listPayments({ page, limit, status, method, refund }) {
  const filter = {};
  if (status) filter.status = status;
  if (method) filter.method = method;
  if (refund) filter['refund.status'] = 'REQUESTED_MANUAL';
  const [items, total] = await Promise.all([
    Payment.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    Payment.countDocuments(filter),
  ]);
  return { items, total, page, limit };
}

/**
 * Record a refund REQUEST. The mock payment provider cannot move money, so
 * this does not change the payment status and does not claim a refund happened.
 */
async function requestRefund(admin, paymentId, reason, { ip } = {}) {
  if (!reason) throw errors.badRequest('A reason is required');
  const result = await withTransactionOrAbort(async (session) => {
    const updated = await Payment.findOneAndUpdate(
      { _id: paymentId, status: 'SUCCEEDED', 'refund.status': { $in: [null, undefined] } },
      { $set: { refund: { status: 'REQUESTED_MANUAL', reason, requestedBy: admin.id, requestedAt: new Date() } } },
      { new: true, session }
    );
    if (!updated) {
      const p = await Payment.findById(paymentId).session(session).lean();
      if (!p) throw new AbortTransaction({ error: errors.notFound('Payment not found') });
      if (p.refund && p.refund.status) throw new AbortTransaction({ error: errors.conflict('A refund was already requested', 'NO_CHANGE') });
      throw new AbortTransaction({ error: errors.conflict(`Only successful payments can be refunded (this one is ${p.status})`, 'INVALID_TRANSITION') });
    }
    await audit.record({ actorId: admin.id, action: 'REFUND_REQUESTED', targetType: 'Payment', targetId: paymentId, metadata: { reason, amount: updated.amount }, ip }, { session });
    return { payment: updated };
  });
  if (result.error) throw result.error;
  return {
    payment: result.payment,
    notice: 'Refund request recorded. No money has been moved: the configured payment provider (mock) cannot issue refunds. Issue it manually and keep the reference.',
  };
}

async function extendedMetrics() {
  const { SafetyIncident, Review, ChatReport } = require('../models');
  const base = await metrics();
  const [openIncidents, dispatchFailed, pendingDriverReviews, hiddenReviews, openChatReports, refundRequests, noDriverByReason] = await Promise.all([
    SafetyIncident.countDocuments({ status: { $ne: 'RESOLVED' } }),
    SafetyIncident.countDocuments({ 'emergencyDispatch.status': 'FAILED' }),
    DriverProfile.countDocuments({ approvalStatus: 'PENDING_REVIEW' }),
    Review.countDocuments({ status: 'HIDDEN' }),
    ChatReport.countDocuments({ status: 'OPEN' }),
    Payment.countDocuments({ 'refund.status': 'REQUESTED_MANUAL' }),
    countBy(Ride, 'noDriverReason', { status: 'NO_DRIVER_FOUND' }),
  ]);
  return { ...base, openSafetyIncidents: openIncidents, failedEmergencyDispatches: dispatchFailed, pendingDriverReviews, hiddenReviews, openChatReports, refundRequests, noDriverByReason };
}

module.exports.searchUsers = searchUsers;
module.exports.userDetail = userDetail;
module.exports.setAccountStatus = setAccountStatus;
module.exports.setAdminPermissions = setAdminPermissions;
module.exports.searchRides = searchRides;
module.exports.rideDetailWithContext = rideDetailWithContext;
module.exports.adminCancelRide = adminCancelRide;
module.exports.listPayments = listPayments;
module.exports.requestRefund = requestRefund;
module.exports.extendedMetrics = extendedMetrics;
