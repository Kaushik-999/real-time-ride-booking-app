'use strict';

const driverService = require('../services/driverService');
const offerService = require('../services/offerService');
const { buildRideView } = require('../services/rideView');
const { ok } = require('../utils/asyncHandler');

exports.me = async (req, res) => ok(res, { profile: await driverService.getProfile(req.user.id) });

exports.setAvailability = async (req, res) =>
  ok(res, { profile: await driverService.setAvailability(req.user.id, req.body.availability) });

exports.updateLocation = async (req, res) => ok(res, { location: await driverService.updateLocation(req.user.id, req.body) });

exports.updateVehicle = async (req, res) => ok(res, { profile: await driverService.updateVehicle(req.user.id, req.body.vehicle) });

exports.offers = async (req, res) => ok(res, { offers: await offerService.listPendingOffers(req.user.id) });

exports.activeRide = async (req, res) => {
  const ride = await driverService.getActiveRide(req.user.id);
  ok(res, { ride: ride ? await buildRideView(ride, { includeDriverLocation: false, viewer: req.user }) : null });
};

exports.trips = async (req, res) => {
  const result = await driverService.listTrips(req.user.id, req.query);
  ok(res, { ...result, items: await Promise.all(result.items.map((r) => buildRideView(r, { includeDriverLocation: false, viewer: req.user }))) });
};

exports.acceptOffer = async (req, res) => {
  const { ride, alreadyAccepted } = await offerService.acceptOffer(req.params.offerId, req.user.id);
  ok(res, { ride: await buildRideView(ride, { includeDriverLocation: false, viewer: req.user }), alreadyAccepted });
};

exports.rejectOffer = async (req, res) => {
  const { offer, alreadyRejected } = await offerService.rejectOffer(req.params.offerId, req.user.id);
  ok(res, { offer: { id: String(offer._id), status: offer.status }, alreadyRejected });
};
