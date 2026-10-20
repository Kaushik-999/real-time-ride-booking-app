'use strict';

const authService = require('../services/authService');
const { ok } = require('../utils/asyncHandler');

exports.register = async (req, res) => ok(res, await authService.register(req.body), 201);
exports.login = async (req, res) => ok(res, await authService.login(req.body));
exports.me = async (req, res) => ok(res, await authService.getProfile(req.user.id));
exports.providers = async (_req, res) => ok(res, authService.providerStatus());
exports.requestOtp = async (req, res) => ok(res, await authService.requestLoginOtp(req.body.phone), 202);
exports.verifyOtp = async (req, res) => ok(res, await authService.verifyLoginOtp(req.body.phone, req.body.code));
exports.google = async (req, res) => {
  const result = await authService.googleSignIn(req.body.idToken);
  ok(res, result, result.created ? 201 : 200);
};
exports.linkGoogle = async (req, res) => ok(res, await authService.linkGoogle(req.user.id, req.body.idToken));
