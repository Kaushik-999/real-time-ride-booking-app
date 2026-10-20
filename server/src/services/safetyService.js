'use strict';

/**
 * In-ride safety button.
 *
 * What pressing it DOES:
 *   1. Records a SafetyIncident (who, which ride, when, ride status, the
 *      other party, vehicle, latest location if available).
 *   2. Alerts this app's safety administrators in real time.
 *   3. If an external emergency integration is configured, sends it an alert
 *      after the database write, and retries until it confirms or gives up.
 *
 * What it does NOT do: it never claims police (or anyone outside this app)
 * were notified unless a configured integration explicitly confirmed it.
 * Without an integration the response says automated dispatch is unavailable
 * and shows the emergency phone number to call.
 *
 * Repeated presses during the same ride add to the open incident's history
 * instead of creating new incidents.
 */
const config = require('../config');
const logger = require('../utils/logger');
const { SafetyIncident, Ride, DriverLocation, DriverProfile, RideEvent } = require('../models');
const { INCIDENT_STATUS: I, DISPATCH_STATUS: D, ROLES, RIDE_EVENT } = require('../utils/constants');
const { badRequest, notFound, conflict } = require('../utils/errors');
const { withTransactionOrAbort, AbortTransaction, isDuplicateKeyError } = require('../utils/transaction');
const { toPoint, fromPoint, isValidLatLng } = require('../utils/geo');
const { DRIVER_ATTACHED } = require('./rideStateMachine');
const emergencyService = require('./emergencyService');
const notifier = require('../sockets/notifier');
const audit = require('./auditService');

const LEASE_MS = 30 * 1000;
const backoffMs = (attempts) => Math.min(5 * 60 * 1000, 5000 * 2 ** Math.max(0, attempts - 1));

/** Honest, user-facing description of what happened outside the app. */
function dispatchSummary(incident) {
  const d = incident.emergencyDispatch || {};
  const emergencyNumber = config.emergency.phoneNumber;
  const base = { status: d.status, policeNotified: d.status === D.ACCEPTED, emergencyNumber };
  switch (d.status) {
    case D.ACCEPTED:
      return { ...base, message: 'The emergency-response service confirmed it received your alert.', reference: d.externalReference || null };
    case D.PENDING:
      return { ...base, message: `Contacting the emergency-response service. It has NOT confirmed yet. If you are in danger, call ${emergencyNumber} now.` };
    case D.FAILED:
      return { ...base, message: `We could not reach the emergency-response service. Call ${emergencyNumber} now. Our safety team has your alert.` };
    default:
      return {
        ...base,
        message: `Automated police dispatch is not available in this app. Our safety team has been alerted. If you are in danger, call ${emergencyNumber} now.`,
      };
  }
}

function view(incident, { admin = false } = {}) {
  const i = incident.toObject ? incident.toObject() : incident;
  const out = {
    id: String(i._id),
    rideId: String(i.rideId),
    reporterRole: i.reporterRole,
    status: i.status,
    message: i.message || null,
    location: i.location && i.location.point ? { ...fromPoint(i.location.point), source: i.location.source, capturedAt: i.location.capturedAt } : null,
    emergency: dispatchSummary(i),
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
  };
  if (admin) {
    out.reporterId = String(i.reporterId);
    out.context = {
      rideStatus: i.context && i.context.rideStatus,
      passengerId: i.context && i.context.passengerId ? String(i.context.passengerId) : null,
      driverId: i.context && i.context.driverId ? String(i.context.driverId) : null,
      vehicleRegistration: i.context && i.context.vehicleRegistration,
    };
    out.dispatch = { ...(i.emergencyDispatch || {}), lockedUntil: undefined };
    out.history = (i.history || []).map((h) => ({ at: h.at, action: h.action, note: h.note || null, actorId: h.actorId ? String(h.actorId) : null }));
  }
  return out;
}

async function resolveLocation(ride, lat, lng) {
  if (lat !== undefined && lng !== undefined) {
    if (!isValidLatLng(lat, lng)) throw badRequest('Invalid location');
    return { point: toPoint({ lat, lng }), source: 'DEVICE', capturedAt: new Date() };
  }
  if (ride.driverId) {
    const loc = await DriverLocation.findOne({ driverId: ride.driverId }).lean();
    if (loc) return { point: loc.location, source: 'DRIVER_LAST_KNOWN', capturedAt: loc.updatedAt };
  }
  return { source: 'NONE' };
}

async function report(user, rideId, { lat, lng, message } = {}) {
  const ride = await Ride.findById(rideId).lean();
  const role =
    ride && String(ride.passengerId) === user.id ? ROLES.PASSENGER : ride && ride.driverId && String(ride.driverId) === user.id ? ROLES.DRIVER : null;
  if (!role || role !== user.role) throw notFound('Ride not found');
  if (!DRIVER_ATTACHED.includes(ride.status)) throw conflict('The safety button is available during an active ride', 'NOT_ACTIVE_RIDE');

  const location = await resolveLocation(ride, lat, lng);
  const profile = ride.driverId ? await DriverProfile.findOne({ userId: ride.driverId }).select('vehicle.registrationNumber').lean() : null;
  const provider = emergencyService.getProvider();
  const now = new Date();
  const text = typeof message === 'string' ? message.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, 500) : undefined;

  let incident;
  let duplicate = false;
  try {
    incident = await withTransactionOrAbort(async (session) => {
      const [created] = await SafetyIncident.create(
        [
          {
            rideId,
            reporterId: user.id,
            reporterRole: role,
            message: text,
            location,
            context: {
              rideStatus: ride.status,
              passengerId: ride.passengerId,
              driverId: ride.driverId,
              vehicleRegistration: profile ? profile.vehicle.registrationNumber : undefined,
            },
            emergencyDispatch: provider.configured
              ? { provider: provider.name, status: D.PENDING, attempts: 0, nextAttemptAt: now, updatedAt: now }
              : { provider: 'none', status: D.NOT_CONFIGURED, updatedAt: now },
            history: [{ at: now, actorId: user.id, action: 'REPORTED' }],
          },
        ],
        { session }
      );
      await RideEvent.create(
        [{ rideId, actorId: user.id, eventType: RIDE_EVENT.SAFETY_INCIDENT, previousStatus: ride.status, newStatus: ride.status, metadata: { incidentId: created._id } }],
        { session }
      );
      return created;
    });
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    // Already an open incident for this reporter and ride: add to it.
    duplicate = true;
    const update = { $push: { history: { at: now, actorId: user.id, action: 'REPEATED_ALERT' } } };
    if (location.source === 'DEVICE') update.$set = { location };
    incident = await SafetyIncident.findOneAndUpdate({ rideId, reporterId: user.id, active: true }, update, { new: true });
    if (!incident) throw conflict('Please retry', 'CONFLICT');
  }

  // After commit: alert safety admins, then try the external service (if any).
  notifier.toAdmins('safety:incident', { incidentId: String(incident._id), rideId: String(rideId), reporterRole: role, repeated: duplicate });
  logger.warn({ incidentId: String(incident._id), rideId: String(rideId), repeated: duplicate }, 'safety incident reported');
  if (!duplicate && incident.emergencyDispatch.status === D.PENDING) {
    incident = (await dispatchIncident(incident._id)) || incident;
  }
  return { incident: view(incident), duplicate };
}

/**
 * Try to deliver one incident to the external service. A lease (lockedUntil)
 * ensures only one process attempts a given incident at a time.
 */
async function dispatchIncident(incidentId) {
  const provider = emergencyService.getProvider();
  if (!provider.configured) return null;
  const now = new Date();
  const claimed = await SafetyIncident.findOneAndUpdate(
    {
      _id: incidentId,
      'emergencyDispatch.status': D.PENDING,
      'emergencyDispatch.nextAttemptAt': { $lte: now },
      $or: [{ 'emergencyDispatch.lockedUntil': null }, { 'emergencyDispatch.lockedUntil': { $lte: now } }],
    },
    { $set: { 'emergencyDispatch.lockedUntil': new Date(now.getTime() + LEASE_MS) }, $inc: { 'emergencyDispatch.attempts': 1 } },
    { new: true }
  );
  if (!claimed) return null;

  const alert = {
    incidentId: String(claimed._id),
    rideId: String(claimed.rideId),
    reporterRole: claimed.reporterRole,
    reportedAt: claimed.createdAt,
    location: claimed.location && claimed.location.point ? fromPoint(claimed.location.point) : null,
    vehicleRegistration: claimed.context ? claimed.context.vehicleRegistration || null : null,
  };
  const result = await provider.send(alert);
  const at = new Date();
  let update;
  if (result.accepted) {
    update = {
      $set: { 'emergencyDispatch.status': D.ACCEPTED, 'emergencyDispatch.externalReference': result.reference, 'emergencyDispatch.updatedAt': at, 'emergencyDispatch.lockedUntil': null },
      $push: { history: { at, action: 'DISPATCH_ACCEPTED', note: result.reference ? `reference ${result.reference}` : undefined } },
    };
  } else if (claimed.emergencyDispatch.attempts >= config.emergency.maxAttempts) {
    update = {
      $set: { 'emergencyDispatch.status': D.FAILED, 'emergencyDispatch.lastError': result.error, 'emergencyDispatch.updatedAt': at, 'emergencyDispatch.lockedUntil': null },
      $push: { history: { at, action: 'DISPATCH_FAILED', note: result.error } },
    };
  } else {
    update = {
      $set: {
        'emergencyDispatch.lastError': result.error,
        'emergencyDispatch.nextAttemptAt': new Date(at.getTime() + backoffMs(claimed.emergencyDispatch.attempts)),
        'emergencyDispatch.updatedAt': at,
        'emergencyDispatch.lockedUntil': null,
      },
      $push: { history: { at, action: 'DISPATCH_ATTEMPT_FAILED', note: result.error } },
    };
  }
  const updated = await SafetyIncident.findOneAndUpdate({ _id: incidentId, 'emergencyDispatch.status': D.PENDING }, update, { new: true });
  if (updated) {
    if (updated.emergencyDispatch.status === D.FAILED) {
      notifier.toAdmins('safety:dispatch-failed', { incidentId: String(updated._id) });
      logger.error({ incidentId: String(updated._id), error: result.error }, 'emergency dispatch failed permanently');
    }
    notifier.toUser(updated.reporterId, 'safety:updated', { incidentId: String(updated._id), dispatchStatus: updated.emergencyDispatch.status });
  }
  return updated;
}

/** Recovery-worker task: retry due dispatches. */
async function retryDueDispatches(limit = 20) {
  if (!emergencyService.getProvider().configured) return 0;
  const due = await SafetyIncident.find({ 'emergencyDispatch.status': D.PENDING, 'emergencyDispatch.nextAttemptAt': { $lte: new Date() } })
    .select('_id')
    .limit(limit)
    .lean();
  let n = 0;
  for (const i of due) if (await dispatchIncident(i._id)) n += 1;
  return n;
}

async function getForUser(user, incidentId) {
  const incident = await SafetyIncident.findById(incidentId);
  if (!incident || String(incident.reporterId) !== user.id) throw notFound('Incident not found');
  return view(incident);
}

function publicConfig() {
  return { emergencyNumber: config.emergency.phoneNumber, automatedDispatchAvailable: emergencyService.getProvider().configured };
}

// ---- Admin -----------------------------------------------------------------

async function adminList({ page, limit, status, dispatchStatus }) {
  const filter = {};
  if (status) filter.status = status;
  if (dispatchStatus) filter['emergencyDispatch.status'] = dispatchStatus;
  const [items, total] = await Promise.all([
    SafetyIncident.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    SafetyIncident.countDocuments(filter),
  ]);
  return { items: items.map((i) => view(i, { admin: true })), total, page, limit };
}

async function adminGet(incidentId) {
  const incident = await SafetyIncident.findById(incidentId);
  if (!incident) throw notFound('Incident not found');
  return view(incident, { admin: true });
}

const ACTIONS = {
  ACKNOWLEDGE: { to: I.ACKNOWLEDGED, from: [I.OPEN] },
  ESCALATE: { to: I.ESCALATED, from: [I.OPEN, I.ACKNOWLEDGED] },
  RESOLVE: { to: I.RESOLVED, from: [I.OPEN, I.ACKNOWLEDGED, I.ESCALATED] },
};

async function adminAction(admin, incidentId, { action, note }, { ip } = {}) {
  const now = new Date();
  if (action === 'RETRY_DISPATCH') {
    if (!emergencyService.getProvider().configured) throw conflict('No emergency integration is configured', 'NOT_CONFIGURED');
    const updated = await SafetyIncident.findOneAndUpdate(
      { _id: incidentId, 'emergencyDispatch.status': D.FAILED },
      {
        $set: { 'emergencyDispatch.status': D.PENDING, 'emergencyDispatch.attempts': 0, 'emergencyDispatch.nextAttemptAt': now },
        $push: { history: { at: now, actorId: admin.id, action: 'DISPATCH_RETRY_REQUESTED', note } },
      },
      { new: true }
    );
    if (!updated) throw conflict('Only failed dispatches can be retried', 'INVALID_TRANSITION');
    await audit.record({ actorId: admin.id, action: 'SAFETY_DISPATCH_RETRY', targetType: 'SafetyIncident', targetId: updated._id, metadata: { note: note || null }, ip });
    return view((await dispatchIncident(updated._id)) || updated, { admin: true });
  }
  const spec = ACTIONS[action];
  if (!spec) throw badRequest('Unknown action');
  if (action === 'RESOLVE' && !note) throw badRequest('A resolution note is required');
  const result = await withTransactionOrAbort(async (session) => {
    const updated = await SafetyIncident.findOneAndUpdate(
      { _id: incidentId, status: { $in: spec.from } },
      {
        $set: { status: spec.to, ...(spec.to === I.RESOLVED ? { active: false } : {}) },
        $push: { history: { at: now, actorId: admin.id, action, note } },
      },
      { new: true, session }
    );
    if (!updated) throw new AbortTransaction({ error: conflict(`Cannot ${action.toLowerCase()} this incident in its current state`, 'INVALID_TRANSITION') });
    await audit.record({ actorId: admin.id, action: `SAFETY_${action}`, targetType: 'SafetyIncident', targetId: updated._id, metadata: { note: note || null }, ip }, { session });
    return { incident: updated };
  });
  if (result.error) throw result.error;
  notifier.toUser(result.incident.reporterId, 'safety:updated', { incidentId: String(result.incident._id), status: result.incident.status });
  return view(result.incident, { admin: true });
}

module.exports = { report, dispatchIncident, retryDueDispatches, getForUser, publicConfig, adminList, adminGet, adminAction, dispatchSummary };
