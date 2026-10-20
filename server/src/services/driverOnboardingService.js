'use strict';

/**
 * Driver onboarding: identity details, document uploads, submission for
 * review, admin decisions, women-driver programme, retention.
 *
 *   DOCUMENTS_REQUIRED --submit--> PENDING_REVIEW --approve--> APPROVED
 *                                       |                         |
 *                                       +--reject--> REJECTED     +--suspend--> SUSPENDED
 *   REJECTED --(fix documents)--submit--> PENDING_REVIEW
 *
 * Nothing here checks a government database. "Approved" means an
 * administrator looked at the uploaded documents and accepted them.
 */
const crypto = require('crypto');
const config = require('../config');
const logger = require('../utils/logger');
const { DriverProfile, DriverDocument, User } = require('../models');
const {
  APPROVAL_STATUS: A,
  DOCUMENT_STATUS: D,
  DOCUMENT_TYPES,
  FEMALE_PROGRAM_STATUS: F,
  DRIVER_AVAILABILITY,
} = require('../utils/constants');
const { AppError, badRequest, notFound, conflict } = require('../utils/errors');
const { withTransactionOrAbort, AbortTransaction, isDuplicateKeyError } = require('../utils/transaction');
const storage = require('./documentStorage');
const audit = require('./auditService');

const REQUIRED = config.documents.required;
for (const t of REQUIRED) {
  if (!DOCUMENT_TYPES.includes(t)) throw new Error(`Invalid configuration: DRIVER_REQUIRED_DOCUMENTS contains unknown type ${t}`);
}
const UPLOAD_ALLOWED_STATES = [A.DOCUMENTS_REQUIRED, A.REJECTED];
const retentionDate = () => new Date(Date.now() + config.documents.retentionDays * 24 * 3600 * 1000);

/** Identify the real file type from its first bytes (never trust the file name or header). */
function sniffMime(buf) {
  if (!buf || buf.length < 8) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}

async function getProfileOrThrow(driverUserId, session) {
  const q = DriverProfile.findOne({ userId: driverUserId });
  if (session) q.session(session);
  const profile = await q;
  if (!profile) throw notFound('Driver profile not found');
  return profile;
}

function identityComplete(profile) {
  const i = profile.identity || {};
  return Boolean(i.legalName && i.dateOfBirth && i.licenseNumber);
}

async function onboardingStatus(driverUserId) {
  const profile = await getProfileOrThrow(driverUserId);
  const docs = await DriverDocument.find({ driverId: driverUserId, status: { $in: [D.SUBMITTED, D.ACCEPTED] } }).lean();
  const present = new Set(docs.map((d) => d.type));
  const missing = REQUIRED.filter((t) => !present.has(t));
  return {
    approvalStatus: profile.approvalStatus,
    rejectionReason: profile.approvalStatus === A.REJECTED || profile.approvalStatus === A.SUSPENDED ? profile.review && profile.review.rejectionReason : null,
    submittedAt: profile.review ? profile.review.submittedAt || null : null,
    reviewedAt: profile.review ? profile.review.reviewedAt || null : null,
    identityComplete: identityComplete(profile),
    requiredDocuments: REQUIRED,
    optionalDocuments: DOCUMENT_TYPES.filter((t) => !REQUIRED.includes(t)),
    missingDocuments: missing,
    canUpload: UPLOAD_ALLOWED_STATES.includes(profile.approvalStatus),
    canSubmit: UPLOAD_ALLOWED_STATES.includes(profile.approvalStatus) && missing.length === 0 && identityComplete(profile),
    femaleDriverProgram: { status: profile.femaleDriverProgram ? profile.femaleDriverProgram.status : F.NOT_REQUESTED },
    maxUploadBytes: config.documents.maxBytes,
    allowedFileTypes: ['image/jpeg', 'image/png', 'application/pdf'],
  };
}

async function listOwnDocuments(driverUserId) {
  return DriverDocument.find({ driverId: driverUserId, fileDeletedAt: null }).sort({ createdAt: -1 });
}

async function updateIdentity(driverUserId, identity) {
  const updated = await DriverProfile.findOneAndUpdate(
    { userId: driverUserId, approvalStatus: { $in: UPLOAD_ALLOWED_STATES } },
    { $set: { identity } },
    { new: true, runValidators: true }
  );
  if (!updated) throw conflict('Identity details can only be changed before submission or after a rejection', 'ONBOARDING_LOCKED');
  return updated;
}

/**
 * Store an uploaded document. Replaces the previous current document of the
 * same type (the old one becomes SUPERSEDED and is purged after the
 * retention period).
 */
async function uploadDocument(driverUserId, type, file) {
  if (!DOCUMENT_TYPES.includes(type)) throw badRequest(`type must be one of ${DOCUMENT_TYPES.join(', ')}`);
  if (!file || !file.buffer || !file.size) throw badRequest('Attach a file in the "file" field');
  if (file.size > config.documents.maxBytes) throw new AppError(413, 'FILE_TOO_LARGE', 'File is too large');
  const mime = sniffMime(file.buffer);
  if (!mime) throw new AppError(415, 'UNSUPPORTED_FILE', 'Only JPEG, PNG or PDF files are accepted');
  if (file.mimetype && file.mimetype !== mime) throw new AppError(415, 'UNSUPPORTED_FILE', 'File content does not match its declared type');

  const profile = await getProfileOrThrow(driverUserId);
  if (!UPLOAD_ALLOWED_STATES.includes(profile.approvalStatus)) {
    throw conflict('Documents cannot be changed while under review or after approval', 'ONBOARDING_LOCKED');
  }

  // Write the encrypted file first; if the database step fails we remove it.
  const storageKey = await storage.put(file.buffer);
  try {
    const result = await withTransactionOrAbort(async (session) => {
      const fresh = await getProfileOrThrow(driverUserId, session);
      if (!UPLOAD_ALLOWED_STATES.includes(fresh.approvalStatus)) {
        throw new AbortTransaction({ error: conflict('Documents cannot be changed while under review or after approval', 'ONBOARDING_LOCKED') });
      }
      await DriverDocument.updateMany(
        { driverId: driverUserId, type, status: { $in: [D.SUBMITTED, D.ACCEPTED] } },
        { $set: { status: D.SUPERSEDED, deleteAfter: retentionDate() } },
        { session }
      );
      const [doc] = await DriverDocument.create(
        [
          {
            driverId: driverUserId,
            type,
            storageKey,
            mimeType: mime,
            sizeBytes: file.size,
            sha256: crypto.createHash('sha256').update(file.buffer).digest('hex'),
          },
        ],
        { session }
      );
      return { doc };
    });
    if (result.error) throw result.error;
    return result.doc;
  } catch (err) {
    await storage.remove(storageKey).catch(() => {});
    if (isDuplicateKeyError(err)) throw conflict('Another upload of this document type is in progress; try again', 'CONFLICT');
    throw err;
  }
}

async function submitForReview(driverUserId) {
  const status = await onboardingStatus(driverUserId);
  if (!status.canUpload) throw conflict(`Cannot submit while ${status.approvalStatus}`, 'INVALID_TRANSITION');
  if (!status.identityComplete) throw badRequest('Complete your identity details first');
  if (status.missingDocuments.length) throw badRequest(`Missing documents: ${status.missingDocuments.join(', ')}`);
  const updated = await DriverProfile.findOneAndUpdate(
    { userId: driverUserId, approvalStatus: { $in: UPLOAD_ALLOWED_STATES } },
    {
      $set: { approvalStatus: A.PENDING_REVIEW, availability: DRIVER_AVAILABILITY.OFFLINE, 'review.submittedAt': new Date() },
      $unset: { 'review.rejectionReason': 1 },
    },
    { new: true }
  );
  if (!updated) throw conflict('Submission state changed; refresh and try again', 'INVALID_TRANSITION');
  return updated;
}

/** Driver asks to be (or stop being) eligible for women-driver-only requests. */
async function setFemaleProgramRequest(driverUserId, action) {
  if (!config.preferences.femaleDriverEnabled) throw new AppError(409, 'FEATURE_DISABLED', 'The women-driver preference is not offered here');
  const filter = { userId: driverUserId };
  let update;
  if (action === 'REQUEST') {
    filter['femaleDriverProgram.status'] = { $in: [F.NOT_REQUESTED, F.REJECTED] };
    update = { $set: { 'femaleDriverProgram.status': F.PENDING, 'femaleDriverProgram.requestedAt': new Date() } };
  } else {
    filter['femaleDriverProgram.status'] = { $in: [F.PENDING, F.VERIFIED, F.REJECTED] };
    update = { $set: { 'femaleDriverProgram.status': F.NOT_REQUESTED } };
  }
  const updated = await DriverProfile.findOneAndUpdate(filter, update, { new: true });
  if (!updated) throw conflict('No change: request already in that state', 'INVALID_TRANSITION');
  return updated;
}

// ---------------------------------------------------------------------------
// Admin side
// ---------------------------------------------------------------------------

// Allowed admin transitions: target status -> statuses it may be reached from.
// (REJECTED is handled by reject() below.)
const ADMIN_TRANSITIONS = {
  [A.APPROVED]: [A.PENDING_REVIEW, A.SUSPENDED],
  [A.REJECTED]: [A.PENDING_REVIEW],
  [A.SUSPENDED]: [A.APPROVED],
  [A.PENDING_REVIEW]: [A.SUSPENDED, A.APPROVED],
};
const REASON_REQUIRED = [A.REJECTED, A.SUSPENDED];

/**
 * Admin decision on a driver. documentDecisions lets the admin accept or
 * reject individual documents (a rejected document must be re-uploaded).
 */
async function decide(admin, driverUserId, { approvalStatus, reason, documentDecisions = [] }, { ip } = {}) {
  if (approvalStatus === 'PENDING') approvalStatus = A.PENDING_REVIEW; // legacy API value
  if (REASON_REQUIRED.includes(approvalStatus) && !reason) throw badRequest(`A reason is required to set ${approvalStatus}`);

  const result = await withTransactionOrAbort(async (session) => {
    const profile = await getProfileOrThrow(driverUserId, session);
    const from = profile.approvalStatus;
    const allowed = (ADMIN_TRANSITIONS[approvalStatus] || []).includes(from);
    if (!allowed) throw new AbortTransaction({ error: conflict(`Cannot change a driver from ${from} to ${approvalStatus}`, 'INVALID_TRANSITION') });

    for (const d of documentDecisions) {
      const res = await DriverDocument.updateOne(
        { _id: d.documentId, driverId: driverUserId, status: { $in: [D.SUBMITTED, D.ACCEPTED] } },
        {
          $set: {
            status: d.status,
            reviewedBy: admin.id,
            reviewedAt: new Date(),
            rejectionReason: d.status === D.REJECTED ? d.reason || reason || 'Rejected' : null,
            deleteAfter: d.status === D.REJECTED ? retentionDate() : null,
          },
        },
        { session }
      );
      if (res.matchedCount === 0) throw new AbortTransaction({ error: badRequest(`Document ${d.documentId} is not a current document of this driver`) });
    }

    if (approvalStatus === A.APPROVED && from === A.PENDING_REVIEW) {
      const current = await DriverDocument.find({ driverId: driverUserId, status: { $in: [D.SUBMITTED, D.ACCEPTED] } }).session(session).lean();
      const types = new Set(current.map((d) => d.type));
      const missing = REQUIRED.filter((t) => !types.has(t));
      if (missing.length) throw new AbortTransaction({ error: conflict(`Cannot approve: missing or rejected documents ${missing.join(', ')}`, 'DOCUMENTS_INCOMPLETE') });
      await DriverDocument.updateMany(
        { driverId: driverUserId, status: D.SUBMITTED },
        { $set: { status: D.ACCEPTED, reviewedBy: admin.id, reviewedAt: new Date() } },
        { session }
      );
    }

    const set = {
      approvalStatus,
      'review.reviewedAt': new Date(),
      'review.reviewedBy': admin.id,
      'review.rejectionReason': REASON_REQUIRED.includes(approvalStatus) ? reason : null,
    };
    const filter = { _id: profile._id, approvalStatus: from };
    if (approvalStatus !== A.APPROVED) {
      // Leaving APPROVED takes the driver offline; never while they hold a ride.
      filter.activeRideId = null;
      set.availability = DRIVER_AVAILABILITY.OFFLINE;
    }
    const updated = await DriverProfile.findOneAndUpdate(filter, { $set: set }, { new: true, session });
    if (!updated) throw new AbortTransaction({ error: conflict('Driver currently holds a ride or changed state; try again later', 'DRIVER_BUSY') });

    await audit.record(
      {
        actorId: admin.id,
        action: `DRIVER_${approvalStatus}`,
        targetType: 'DriverProfile',
        targetId: driverUserId,
        metadata: { from, to: approvalStatus, reason: reason || null, documentDecisions: documentDecisions.map((d) => ({ documentId: d.documentId, status: d.status })) },
        ip,
      },
      { session }
    );
    return { profile: updated };
  });
  if (result.error) throw result.error;
  return result.profile;
}

/**
 * Legacy path kept for the old "reject a driver who was never submitted":
 * a REJECTED decision on a DOCUMENTS_REQUIRED/PENDING_REVIEW driver.
 */
async function reject(admin, driverUserId, reason, documentDecisions, opts) {
  if (!reason) throw badRequest('A reason is required to reject a driver');
  const result = await withTransactionOrAbort(async (session) => {
    const profile = await getProfileOrThrow(driverUserId, session);
    if (![A.PENDING_REVIEW, A.DOCUMENTS_REQUIRED].includes(profile.approvalStatus)) {
      throw new AbortTransaction({ error: conflict(`Cannot reject a driver who is ${profile.approvalStatus}`, 'INVALID_TRANSITION') });
    }
    for (const d of documentDecisions || []) {
      await DriverDocument.updateOne(
        { _id: d.documentId, driverId: driverUserId, status: { $in: [D.SUBMITTED, D.ACCEPTED] } },
        { $set: { status: d.status, reviewedBy: admin.id, reviewedAt: new Date(), rejectionReason: d.status === D.REJECTED ? d.reason || reason : null, deleteAfter: d.status === D.REJECTED ? retentionDate() : null } },
        { session }
      );
    }
    const updated = await DriverProfile.findOneAndUpdate(
      { _id: profile._id, approvalStatus: profile.approvalStatus, activeRideId: null },
      {
        $set: {
          approvalStatus: A.REJECTED,
          availability: DRIVER_AVAILABILITY.OFFLINE,
          'review.reviewedAt': new Date(),
          'review.reviewedBy': admin.id,
          'review.rejectionReason': reason,
        },
      },
      { new: true, session }
    );
    if (!updated) throw new AbortTransaction({ error: conflict('Driver changed state; try again', 'INVALID_TRANSITION') });
    await audit.record(
      { actorId: admin.id, action: 'DRIVER_REJECTED', targetType: 'DriverProfile', targetId: driverUserId, metadata: { from: profile.approvalStatus, reason }, ip: opts && opts.ip },
      { session }
    );
    return { profile: updated };
  });
  if (result.error) throw result.error;
  return result.profile;
}

async function adminDecision(admin, driverUserId, body, opts) {
  if (body.approvalStatus === A.REJECTED) return reject(admin, driverUserId, body.reason, body.documentDecisions, opts);
  return decide(admin, driverUserId, body, opts);
}

async function setFemaleVerification(admin, driverUserId, status, note, { ip } = {}) {
  const fromAllowed = { [F.VERIFIED]: [F.PENDING], [F.REJECTED]: [F.PENDING], [F.NOT_REQUESTED]: [F.VERIFIED, F.PENDING, F.REJECTED] }[status];
  if (!fromAllowed) throw badRequest('status must be VERIFIED, REJECTED or NOT_REQUESTED');
  const result = await withTransactionOrAbort(async (session) => {
    const updated = await DriverProfile.findOneAndUpdate(
      { userId: driverUserId, 'femaleDriverProgram.status': { $in: fromAllowed } },
      { $set: { 'femaleDriverProgram.status': status, 'femaleDriverProgram.reviewedAt': new Date(), 'femaleDriverProgram.reviewedBy': admin.id } },
      { new: true, session }
    );
    if (!updated) throw new AbortTransaction({ error: conflict('The driver has not requested this, or it is already in that state', 'INVALID_TRANSITION') });
    await audit.record(
      { actorId: admin.id, action: `FEMALE_PROGRAM_${status}`, targetType: 'DriverProfile', targetId: driverUserId, metadata: { note: note || null }, ip },
      { session }
    );
    return { profile: updated };
  });
  if (result.error) throw result.error;
  return result.profile;
}

async function adminDriverDetail(driverUserId) {
  const [user, profile, documents] = await Promise.all([
    User.findById(driverUserId),
    DriverProfile.findOne({ userId: driverUserId }).populate('review.reviewedBy', 'name email').lean(),
    DriverDocument.find({ driverId: driverUserId }).sort({ createdAt: -1 }),
  ]);
  if (!user || !profile) throw notFound('Driver not found');
  return {
    user: user.toJSON(),
    profile: {
      ...profile,
      id: String(profile._id),
      review: profile.review
        ? { ...profile.review, reviewedBy: profile.review.reviewedBy ? { id: String(profile.review.reviewedBy._id), name: profile.review.reviewedBy.name } : null }
        : null,
    },
    documents,
    requiredDocuments: REQUIRED,
  };
}

/** Decrypt a document for an authorised admin; every access is audited. */
async function readDocumentForAdmin(admin, driverUserId, documentId, { ip } = {}) {
  const doc = await DriverDocument.findOne({ _id: documentId, driverId: driverUserId }).select('+storageKey');
  if (!doc) throw notFound('Document not found');
  if (doc.fileDeletedAt) throw new AppError(410, 'DOCUMENT_DELETED', 'This file was deleted under the retention policy');
  const buffer = await storage.get(doc.storageKey);
  await audit.record({ actorId: admin.id, action: 'DOCUMENT_VIEWED', targetType: 'DriverDocument', targetId: doc._id, metadata: { driverId: driverUserId, type: doc.type }, ip });
  return { buffer, mimeType: doc.mimeType, type: doc.type };
}

/** Recovery-worker task: delete files of rejected/superseded documents past retention. */
async function purgeExpiredDocuments(limit = 50) {
  const due = await DriverDocument.find({ deleteAfter: { $lte: new Date() }, fileDeletedAt: null }).select('+storageKey').limit(limit);
  let purged = 0;
  for (const d of due) {
    await storage.remove(d.storageKey); // idempotent
    const res = await DriverDocument.updateOne({ _id: d._id, fileDeletedAt: null }, { $set: { fileDeletedAt: new Date() } });
    purged += res.modifiedCount;
  }
  if (purged) logger.info({ purged }, 'purged expired driver documents');
  return purged;
}

module.exports = {
  sniffMime,
  onboardingStatus,
  listOwnDocuments,
  updateIdentity,
  uploadDocument,
  submitForReview,
  setFemaleProgramRequest,
  adminDecision,
  setFemaleVerification,
  adminDriverDetail,
  readDocumentForAdmin,
  purgeExpiredDocuments,
  REQUIRED,
};
