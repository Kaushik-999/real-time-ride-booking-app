'use strict';

const express = require('express');
const { z } = require('zod');
const { authenticate, requireRole, requirePermission: perm } = require('../middleware/auth');
const { singleDocument } = require('../middleware/upload');
const { validate } = require('../middleware/validate');
const { asyncHandler: h } = require('../utils/asyncHandler');
const { schemas } = require('../utils/validators');
const { ROLES } = require('../utils/constants');
const { dbHealth } = require('../config/db');
const auth = require('../controllers/authController');
const rides = require('../controllers/rideController');
const drivers = require('../controllers/driverController');
const admin = require('../controllers/adminController');
const payments = require('../controllers/paymentController');
const onboarding = require('../controllers/onboardingController');
const reviews = require('../controllers/reviewController');
const chat = require('../controllers/chatController');
const safety = require('../controllers/safetyController');

const { PASSENGER, DRIVER, ADMIN } = ROLES;
const rideParam = { params: schemas.idParam('rideId') };

function buildRouter({ limiters }) {
  const api = express.Router();

  // ---- Health -------------------------------------------------------------
  api.get(
    '/health',
    h(async (_req, res) => {
      const db = await dbHealth().catch(() => ({ ok: false }));
      res.status(db.ok ? 200 : 503).json({ success: db.ok, data: { status: db.ok ? 'ok' : 'degraded', db, uptimeSeconds: Math.round(process.uptime()) } });
    })
  );

  // ---- Vehicle catalog (public) --------------------------------------------
  api.get('/vehicles', (_req, res) => res.json({ success: true, data: { vehicles: require('../config/vehicles').publicCatalog() } }));

  // ---- Auth ---------------------------------------------------------------
  api.post('/auth/register', limiters.auth, validate({ body: schemas.register }), h(auth.register));
  api.post('/auth/login', limiters.auth, validate({ body: schemas.login }), h(auth.login));
  api.get('/auth/me', authenticate, h(auth.me));
  api.get('/auth/providers', h(auth.providers));
  api.post('/auth/otp/request', limiters.auth, validate({ body: schemas.otpRequest }), h(auth.requestOtp));
  api.post('/auth/otp/verify', limiters.auth, validate({ body: schemas.otpVerify }), h(auth.verifyOtp));
  api.post('/auth/google', limiters.auth, validate({ body: schemas.googleToken }), h(auth.google));
  api.post('/auth/google/link', authenticate, limiters.auth, validate({ body: schemas.googleToken }), h(auth.linkGoogle));

  // ---- Rides (passenger) --------------------------------------------------
  api.post('/rides/estimate', authenticate, requireRole(PASSENGER), validate({ body: schemas.estimate }), h(rides.estimate));
  api.post('/rides', authenticate, requireRole(PASSENGER), limiters.booking, validate({ body: schemas.createRide }), h(rides.create));
  api.get('/rides/history', authenticate, requireRole(PASSENGER), validate({ query: schemas.pagination }), h(rides.history));
  api.get('/rides/:rideId', authenticate, validate(rideParam), h(rides.get));
  api.get('/rides/:rideId/events', authenticate, validate(rideParam), h(rides.events));
  api.post(
    '/rides/:rideId/cancel',
    authenticate,
    // Admins cancel through POST /api/admin/rides/:rideId/cancel (permission + audit).
    requireRole(PASSENGER),
    validate({ ...rideParam, body: schemas.cancel }),
    h(rides.cancel)
  );
  api.get('/rides/:rideId/payment', authenticate, requireRole(PASSENGER), validate(rideParam), h(rides.getPayment));
  api.post('/rides/:rideId/pay', authenticate, requireRole(PASSENGER), validate({ ...rideParam, body: schemas.emptyBody }), h(rides.pay));

  // ---- Rides (driver lifecycle) -------------------------------------------
  api.post('/rides/:rideId/arrive', authenticate, requireRole(DRIVER), validate({ ...rideParam, body: schemas.emptyBody }), h(rides.arrive));
  // Start and complete require the passenger's one-time code.
  for (const step of ['start', 'complete']) {
    api.post(`/rides/:rideId/${step}`, authenticate, requireRole(DRIVER), limiters.otp, validate({ ...rideParam, body: schemas.tripOtp }), h(rides[step]));
  }
  // The passenger (only) can view the current trip code.
  api.get('/rides/:rideId/otp', authenticate, requireRole(PASSENGER), validate(rideParam), h(rides.otp));
  api.post(
    '/rides/:rideId/cash-collected',
    authenticate,
    requireRole(DRIVER),
    validate({ ...rideParam, body: schemas.emptyBody }),
    h(rides.cashCollected)
  );

  // ---- Reviews ------------------------------------------------------------
  api.post('/rides/:rideId/reviews', authenticate, requireRole(PASSENGER, DRIVER), validate({ ...rideParam, body: schemas.review }), h(reviews.submit));
  api.get('/rides/:rideId/reviews/mine', authenticate, requireRole(PASSENGER, DRIVER), validate(rideParam), h(reviews.mineForRide));
  api.get('/reviews/received', authenticate, requireRole(PASSENGER, DRIVER), validate({ query: schemas.pagination }), h(reviews.received));
  api.get('/reviews/given', authenticate, requireRole(PASSENGER, DRIVER), validate({ query: schemas.pagination }), h(reviews.given));

  // ---- Chat (REST fallback + history; live delivery is over Socket.IO) -----
  api.get('/rides/:rideId/messages', authenticate, requireRole(PASSENGER, DRIVER), validate({ ...rideParam, query: schemas.chatHistoryQuery }), h(chat.history));
  api.post('/rides/:rideId/messages', authenticate, requireRole(PASSENGER, DRIVER), validate({ ...rideParam, body: schemas.chatSend }), h(chat.send));
  api.post(
    '/rides/:rideId/messages/:messageId/report',
    authenticate,
    requireRole(PASSENGER, DRIVER),
    validate({
      params: z.object({ rideId: schemas.idParam('rideId').shape.rideId, messageId: schemas.idParam('messageId').shape.messageId }).strict(),
      body: schemas.chatReport,
    }),
    h(chat.report)
  );

  // ---- Safety -------------------------------------------------------------
  api.get('/safety/config', authenticate, h(safety.config));
  api.post('/rides/:rideId/safety-incidents', authenticate, requireRole(PASSENGER, DRIVER), validate({ ...rideParam, body: schemas.safetyReport }), h(safety.report));
  api.get('/safety/incidents/:incidentId', authenticate, validate({ params: schemas.idParam('incidentId') }), h(safety.get));

  // ---- Driver -------------------------------------------------------------
  const me = express.Router();
  me.use(authenticate, requireRole(DRIVER));
  me.get('/', h(drivers.me));
  me.patch('/availability', validate({ body: schemas.availability }), h(drivers.setAvailability));
  me.patch('/location', validate({ body: schemas.location }), h(drivers.updateLocation));
  me.put('/vehicle', validate({ body: schemas.updateVehicle }), h(drivers.updateVehicle));
  me.get('/offers', h(drivers.offers));
  me.get('/active-ride', h(drivers.activeRide));
  me.get('/trips', validate({ query: schemas.pagination }), h(drivers.trips));
  // Onboarding: identity, documents, submission, women-driver programme.
  me.get('/onboarding', h(onboarding.status));
  me.get('/documents', h(onboarding.documents));
  me.post('/documents', limiters.upload, singleDocument, validate({ body: schemas.documentUpload }), h(onboarding.upload));
  me.put('/identity', validate({ body: schemas.updateIdentity }), h(onboarding.updateIdentity));
  me.post('/submit-for-review', validate({ body: schemas.emptyBody }), h(onboarding.submit));
  me.post('/female-program', validate({ body: schemas.femaleProgram }), h(onboarding.femaleProgram));
  api.use('/drivers/me', me);

  const offerParam = { params: schemas.idParam('offerId'), body: schemas.emptyBody };
  api.post('/offers/:offerId/accept', authenticate, requireRole(DRIVER), validate(offerParam), h(drivers.acceptOffer));
  api.post('/offers/:offerId/reject', authenticate, requireRole(DRIVER), validate(offerParam), h(drivers.rejectOffer));

  // ---- Admin --------------------------------------------------------------
  // Every route needs the ADMIN role AND a specific permission (or '*').
  const adm = express.Router();
  adm.use(authenticate, requireRole(ADMIN));
  const driverParam = { params: schemas.idParam('driverId') };
  adm.get('/users', perm('users:read'), validate({ query: schemas.adminUsersQuery }), h(admin.searchUsers));
  adm.get('/users/:userId', perm('users:read'), validate({ params: schemas.idParam('userId') }), h(admin.userDetail));
  adm.patch('/users/:userId/status', perm('users:manage'), validate({ params: schemas.idParam('userId'), body: schemas.accountStatus }), h(admin.setAccountStatus));
  adm.patch('/users/:userId/permissions', perm('users:manage'), validate({ params: schemas.idParam('userId'), body: schemas.adminPermissions }), h(admin.setPermissions));
  adm.get('/drivers', perm('drivers:review'), validate({ query: schemas.adminDriversQuery }), h(admin.drivers));
  adm.get('/drivers/:driverId', perm('drivers:review'), validate(driverParam), h(onboarding.adminDetail));
  adm.patch('/drivers/:driverId/approval', perm('drivers:review'), validate({ ...driverParam, body: schemas.driverDecision }), h(onboarding.adminDecision));
  adm.patch(
    '/drivers/:driverId/female-verification',
    perm('drivers:review'),
    validate({ ...driverParam, body: schemas.femaleVerification }),
    h(onboarding.adminFemaleVerification)
  );
  adm.get(
    '/drivers/:driverId/documents/:documentId/file',
    perm('documents:read'),
    validate({ params: z.object({ driverId: schemas.idParam('driverId').shape.driverId, documentId: schemas.idParam('documentId').shape.documentId }).strict() }),
    h(onboarding.adminDocumentFile)
  );
  adm.patch('/drivers/:driverId/vehicle', perm('drivers:review'), validate({ ...driverParam, body: schemas.adminVehicle }), h(admin.setVehicleCapacity));
  adm.get('/rides', perm('rides:read'), validate({ query: schemas.adminRidesQuery }), h(admin.searchRides));
  adm.get('/rides/:rideId', perm('rides:read'), validate(rideParam), h(admin.rideDetailWithContext));
  adm.post('/rides/:rideId/cancel', perm('rides:manage'), validate({ ...rideParam, body: schemas.adminCancel }), h(admin.cancelRide));
  adm.get('/payments', perm('payments:read'), validate({ query: schemas.adminPaymentsQuery }), h(admin.payments));
  adm.post('/payments/:paymentId/refund-request', perm('payments:refund'), validate({ params: schemas.idParam('paymentId'), body: schemas.refundRequest }), h(admin.requestRefund));
  adm.get('/audit-logs', perm('audit:read'), validate({ query: schemas.auditQuery }), h(admin.auditLogs));
  adm.get('/reviews', perm('reviews:moderate'), validate({ query: schemas.adminReviewsQuery }), h(reviews.adminList));
  adm.patch(
    '/reviews/:reviewId/moderation',
    perm('reviews:moderate'),
    validate({ params: schemas.idParam('reviewId'), body: schemas.reviewModeration }),
    h(reviews.moderate)
  );
  adm.get('/chat-reports', perm('chat:read'), validate({ query: schemas.adminChatReportsQuery }), h(chat.adminReports));
  adm.patch('/chat-reports/:reportId', perm('chat:read'), validate({ params: schemas.idParam('reportId'), body: schemas.emptyBody }), h(chat.adminResolve));
  adm.get('/rides/:rideId/messages', perm('chat:read'), validate(rideParam), h(chat.adminConversation));
  adm.get('/safety-incidents', perm('safety:manage'), validate({ query: schemas.adminSafetyQuery }), h(safety.adminList));
  adm.get('/safety-incidents/:incidentId', perm('safety:manage'), validate({ params: schemas.idParam('incidentId') }), h(safety.adminGet));
  adm.patch(
    '/safety-incidents/:incidentId',
    perm('safety:manage'),
    validate({ params: schemas.idParam('incidentId'), body: schemas.safetyAction }),
    h(safety.adminAction)
  );
  adm.get('/metrics', h(admin.extendedMetrics));
  api.use('/admin', adm);

  // ---- Payments -----------------------------------------------------------
  api.post('/payments/webhook', validate({ body: schemas.paymentWebhook }), h(payments.webhook));

  return api;
}

module.exports = { buildRouter };
