'use strict';

const reviewService = require('../services/reviewService');
const { ok } = require('../utils/asyncHandler');

exports.submit = async (req, res) => ok(res, { review: await reviewService.submitReview(req.user, req.params.rideId, req.body) }, 201);
exports.mineForRide = async (req, res) => ok(res, { review: await reviewService.myReviewForRide(req.user, req.params.rideId) });
exports.received = async (req, res) => ok(res, await reviewService.receivedReviews(req.user, req.query));
exports.given = async (req, res) => ok(res, await reviewService.givenReviews(req.user, req.query));
exports.adminList = async (req, res) => ok(res, await reviewService.adminList(req.query));
exports.moderate = async (req, res) => ok(res, { review: await reviewService.moderate(req.user, req.params.reviewId, req.body, { ip: req.ip }) });
