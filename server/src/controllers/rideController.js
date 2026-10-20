'use strict';

const rideService = require('../services/rideService');
const fareService = require('../services/fareService');
const paymentService = require('../services/paymentService');
const { buildRideView } = require('../services/rideView');
const { ok } = require('../utils/asyncHandler');

exports.estimate = async (req, res) => {
  const { pickup, destination, vehicleType, passengerCount } = req.body;
  const estimate = await fareService.estimateTrip(pickup, destination, vehicleType, passengerCount);
  ok(res, { ...estimate, passengerCount });
};

exports.create = async (req, res) => {
  // passengerId comes from the verified JWT, never from the body.
  const { ride, created } = await rideService.createRide(req.user.id, req.body);
  ok(res, { ride: await buildRideView(ride, { viewer: req.user }), created }, created ? 201 : 200);
};

exports.get = async (req, res) => {
  const ride = await rideService.getRideForUser(req.params.rideId, req.user);
  ok(res, { ride: await buildRideView(ride, { viewer: req.user }) });
};

exports.events = async (req, res) => {
  await rideService.getRideForUser(req.params.rideId, req.user);
  const events = await rideService.listRideEvents(req.params.rideId);
  ok(res, {
    events: events.map((e) => ({
      id: String(e._id),
      eventType: e.eventType,
      previousStatus: e.previousStatus,
      newStatus: e.newStatus,
      createdAt: e.createdAt,
    })),
  });
};

exports.history = async (req, res) => {
  const result = await rideService.listPassengerRides(req.user.id, req.query);
  ok(res, { ...result, items: await Promise.all(result.items.map((r) => buildRideView(r, { includeDriverLocation: false, viewer: req.user }))) });
};

exports.cancel = async (req, res) => {
  const { ride, alreadyCancelled } = await rideService.cancelRide(req.params.rideId, req.user, req.body.reason);
  ok(res, { ride: await buildRideView(ride, { viewer: req.user }), alreadyCancelled });
};

const driverStep = (step) => async (req, res) => {
  const { ride, alreadyDone } = await rideService.driverTransition(req.params.rideId, req.user.id, step, { otp: req.body.otp });
  ok(res, { ride: await buildRideView(ride, { viewer: req.user }), alreadyDone });
};
exports.arrive = driverStep('arrive');
exports.start = driverStep('start');
exports.complete = driverStep('complete');

exports.getPayment = async (req, res) => ok(res, { payment: await paymentService.getPayment(req.params.rideId, req.user.id) });
exports.pay = async (req, res) => ok(res, { payment: await paymentService.startOnlinePayment(req.params.rideId, req.user.id) });
exports.cashCollected = async (req, res) =>
  ok(res, { payment: await paymentService.confirmCashCollected(req.params.rideId, req.user.id) });

exports.otp = async (req, res) => {
  const data = await require('../services/rideOtpService').revealForPassenger(req.params.rideId, req.user.id);
  res.set('Cache-Control', 'no-store, private');
  ok(res, { otp: data });
};
