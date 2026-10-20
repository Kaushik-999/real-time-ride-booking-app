'use strict';

const onboarding = require('../services/driverOnboardingService');
const { ok } = require('../utils/asyncHandler');

exports.status = async (req, res) => ok(res, await onboarding.onboardingStatus(req.user.id));
exports.documents = async (req, res) => ok(res, { documents: await onboarding.listOwnDocuments(req.user.id) });
exports.upload = async (req, res) => ok(res, { document: await onboarding.uploadDocument(req.user.id, req.body.type, req.file) }, 201);
exports.updateIdentity = async (req, res) => ok(res, { profile: await onboarding.updateIdentity(req.user.id, req.body.identity) });
exports.submit = async (req, res) => ok(res, { profile: await onboarding.submitForReview(req.user.id) });
exports.femaleProgram = async (req, res) => ok(res, { profile: await onboarding.setFemaleProgramRequest(req.user.id, req.body.action) });

// Admin
exports.adminDetail = async (req, res) => ok(res, await onboarding.adminDriverDetail(req.params.driverId));
exports.adminDecision = async (req, res) =>
  ok(res, { profile: await onboarding.adminDecision(req.user, req.params.driverId, req.body, { ip: req.ip }) });
exports.adminFemaleVerification = async (req, res) =>
  ok(res, { profile: await onboarding.setFemaleVerification(req.user, req.params.driverId, req.body.status, req.body.note, { ip: req.ip }) });
exports.adminDocumentFile = async (req, res) => {
  const { buffer, mimeType, type } = await onboarding.readDocumentForAdmin(req.user, req.params.driverId, req.params.documentId, { ip: req.ip });
  res.set({
    'Content-Type': mimeType,
    'Content-Disposition': `inline; filename="${type.toLowerCase()}"`,
    // Never cache identity documents in browsers or proxies.
    'Cache-Control': 'no-store, private',
    'X-Content-Type-Options': 'nosniff',
  });
  res.send(buffer);
};
