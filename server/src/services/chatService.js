'use strict';

/**
 * In-ride chat between a ride's passenger and its ASSIGNED driver.
 *
 * Rules (checked against the database on EVERY call, never inferred from
 * socket room membership):
 *   - Only the passenger and the assigned driver are participants.
 *   - Sending is allowed while a driver is attached (DRIVER_ASSIGNED,
 *     DRIVER_ARRIVED, IN_PROGRESS).
 *   - After the ride ends (COMPLETED / CANCELLED), participants can still
 *     READ the history for CHAT_READ_AFTER_RIDE_MS (default 24 h), then it
 *     disappears from their apps.
 *   - Messages are deleted CHAT_RETENTION_DAYS after they were sent, unless
 *     the ride has a chat report or a safety incident (kept for review).
 *   - Admins can read a conversation only through the chat-report review
 *     endpoint (permission chat:read), and every read is audited.
 *
 * Message bodies are never written to logs.
 */
const config = require('../config');
const { ChatMessage, ChatReport, Ride, SafetyIncident } = require('../models');
const { RIDE_STATUS, ROLES } = require('../utils/constants');
const { AppError, badRequest, notFound, forbidden, conflict } = require('../utils/errors');
const { isDuplicateKeyError } = require('../utils/transaction');
const { DRIVER_ATTACHED } = require('./rideStateMachine');
const notifier = require('../sockets/notifier');
const audit = require('./auditService');

const cleanBody = (s) => (typeof s === 'string' ? s.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim() : '');

// Per-user sliding-window rate limit (in memory, per process).
const recentSends = new Map();
function checkRate(userId) {
  const now = Date.now();
  const windowStart = now - config.chat.rateLimitWindowMs;
  const list = (recentSends.get(userId) || []).filter((t) => t > windowStart);
  if (list.length >= config.chat.rateLimitCount) {
    recentSends.set(userId, list);
    throw new AppError(429, 'CHAT_RATE_LIMITED', 'You are sending messages too quickly');
  }
  list.push(now);
  recentSends.set(userId, list);
}
const resetRateLimitForTests = () => recentSends.clear();

function roleInRide(ride, userId) {
  if (String(ride.passengerId) === String(userId)) return ROLES.PASSENGER;
  if (ride.driverId && String(ride.driverId) === String(userId)) return ROLES.DRIVER;
  return null;
}

function endedAt(ride) {
  return ride.completedAt || ride.cancelledAt || ride.updatedAt;
}

/** Load the ride and check this user may read (or write) its chat. */
async function authorize(rideId, userId, mode) {
  const ride = await Ride.findById(rideId).select('passengerId driverId status completedAt cancelledAt updatedAt').lean();
  const role = ride && roleInRide(ride, userId);
  if (!role) throw notFound('Ride not found'); // non-participants learn nothing
  if (DRIVER_ATTACHED.includes(ride.status)) return { ride, role };
  if (mode === 'write') throw conflict('Chat is closed for this ride', 'CHAT_CLOSED');
  const ended = [RIDE_STATUS.COMPLETED, RIDE_STATUS.CANCELLED].includes(ride.status) && ride.driverId;
  if (!ended) throw conflict('Chat opens once a driver is assigned', 'CHAT_NOT_OPEN');
  if (Date.now() - new Date(endedAt(ride)).getTime() > config.chat.readAfterRideMs) {
    throw new AppError(410, 'CHAT_EXPIRED', 'This conversation is no longer available');
  }
  return { ride, role };
}

const view = (m) => ({
  id: String(m._id),
  rideId: String(m.rideId),
  senderId: String(m.senderId),
  senderRole: m.senderRole,
  body: m.body,
  clientMessageId: m.clientMessageId,
  createdAt: m.createdAt,
});

async function sendMessage(user, rideId, { body, clientMessageId }) {
  const text = cleanBody(body);
  if (!text) throw badRequest('Message cannot be empty');
  if (text.length > config.chat.maxLength) throw badRequest(`Message is longer than ${config.chat.maxLength} characters`);
  if (typeof clientMessageId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(clientMessageId)) throw badRequest('clientMessageId must be 8-64 URL-safe characters');

  const { ride, role } = await authorize(rideId, user.id, 'write');
  // Sockets authenticate once at connect; re-check the account is still active.
  const { User } = require('../models');
  if (!(await User.exists({ _id: user.id, accountStatus: 'ACTIVE' }))) throw new AppError(403, 'ACCOUNT_SUSPENDED', 'This account is suspended');
  // Idempotent retry: the same clientMessageId returns the stored message.
  const existing = await ChatMessage.findOne({ rideId, senderId: user.id, clientMessageId }).lean();
  if (existing) return { message: view(existing), duplicate: true };
  checkRate(user.id);

  let msg;
  try {
    msg = await ChatMessage.create({ rideId, senderId: user.id, senderRole: role, body: text, clientMessageId });
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const again = await ChatMessage.findOne({ rideId, senderId: user.id, clientMessageId }).lean();
    return { message: view(again), duplicate: true };
  }
  // Persisted first; then delivered to both participants' personal rooms.
  const payload = view(msg);
  notifier.toUser(ride.passengerId, 'chat:message', payload);
  notifier.toUser(ride.driverId, 'chat:message', payload);
  return { message: payload, duplicate: false };
}

/** Messages in time order. `before` (ISO date) pages backwards. */
async function history(user, rideId, { before, limit = 50 } = {}) {
  const { role } = await authorize(rideId, user.id, 'read');
  const filter = { rideId };
  if (before) filter.createdAt = { $lt: new Date(before) };
  const rows = await ChatMessage.find(filter).sort({ createdAt: -1, _id: -1 }).limit(Math.min(limit, 100)).lean();
  return { role, messages: rows.reverse().map(view) };
}

async function reportMessage(user, rideId, messageId, reason) {
  await authorize(rideId, user.id, 'read');
  const msg = await ChatMessage.findOne({ _id: messageId, rideId }).lean();
  if (!msg) throw notFound('Message not found');
  if (String(msg.senderId) === String(user.id)) throw badRequest('You cannot report your own message');
  try {
    const report = await ChatReport.create({ rideId, messageId, reporterId: user.id, reason: cleanBody(reason).slice(0, 300) || 'Reported' });
    notifier.toAdmins('chat:report', { reportId: String(report._id), rideId: String(rideId) });
    return report;
  } catch (err) {
    if (isDuplicateKeyError(err)) throw conflict('You already reported this message', 'ALREADY_REPORTED');
    throw err;
  }
}

// ---- Admin -----------------------------------------------------------------

async function adminListReports({ page, limit, status }) {
  const filter = status ? { status } : {};
  const [items, total] = await Promise.all([
    ChatReport.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).populate('reporterId', 'name role').lean(),
    ChatReport.countDocuments(filter),
  ]);
  return {
    items: items.map((r) => ({
      id: String(r._id),
      rideId: String(r.rideId),
      messageId: String(r.messageId),
      reason: r.reason,
      status: r.status,
      reporter: r.reporterId ? { id: String(r.reporterId._id), name: r.reporterId.name, role: r.reporterId.role } : null,
      createdAt: r.createdAt,
    })),
    total,
    page,
    limit,
  };
}

/** Admins may read a conversation only if it was reported or has a safety incident. Audited. */
async function adminConversation(admin, rideId, { ip } = {}) {
  const [reported, incident] = await Promise.all([ChatReport.exists({ rideId }), SafetyIncident.exists({ rideId })]);
  if (!reported && !incident) throw forbidden('Conversations can only be reviewed when reported or linked to a safety incident');
  const rows = await ChatMessage.find({ rideId }).sort({ createdAt: 1, _id: 1 }).lean();
  await audit.record({ actorId: admin.id, action: 'CHAT_VIEWED', targetType: 'Ride', targetId: rideId, metadata: { messages: rows.length }, ip });
  return { messages: rows.map(view) };
}

async function adminResolveReport(admin, reportId, { ip } = {}) {
  const report = await ChatReport.findOneAndUpdate(
    { _id: reportId, status: 'OPEN' },
    { $set: { status: 'REVIEWED', reviewedBy: admin.id, reviewedAt: new Date() } },
    { new: true }
  );
  if (!report) throw conflict('Report not found or already reviewed', 'NO_CHANGE');
  await audit.record({ actorId: admin.id, action: 'CHAT_REPORT_REVIEWED', targetType: 'ChatReport', targetId: report._id, metadata: { rideId: String(report.rideId) }, ip });
  return report;
}

/** Recovery-worker task: delete old messages unless held for a report/incident. */
async function purgeOldMessages() {
  const cutoff = new Date(Date.now() - config.chat.retentionDays * 24 * 3600 * 1000);
  const [reported, incidents] = await Promise.all([ChatReport.distinct('rideId'), SafetyIncident.distinct('rideId')]);
  const res = await ChatMessage.deleteMany({ createdAt: { $lt: cutoff }, rideId: { $nin: [...reported, ...incidents] } });
  return res.deletedCount;
}

module.exports = {
  sendMessage,
  history,
  reportMessage,
  adminListReports,
  adminConversation,
  adminResolveReport,
  purgeOldMessages,
  resetRateLimitForTests,
};
