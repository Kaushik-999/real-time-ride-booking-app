'use strict';

const safetyService = require('../services/safetyService');
const { ok } = require('../utils/asyncHandler');

exports.report = async (req, res) => {
  const { incident, duplicate } = await safetyService.report(req.user, req.params.rideId, req.body);
  ok(res, { incident, duplicate }, duplicate ? 200 : 201);
};
exports.get = async (req, res) => ok(res, { incident: await safetyService.getForUser(req.user, req.params.incidentId) });
exports.config = async (_req, res) => ok(res, safetyService.publicConfig());
exports.adminList = async (req, res) => ok(res, await safetyService.adminList(req.query));
exports.adminGet = async (req, res) => ok(res, { incident: await safetyService.adminGet(req.params.incidentId) });
exports.adminAction = async (req, res) => ok(res, { incident: await safetyService.adminAction(req.user, req.params.incidentId, req.body, { ip: req.ip }) });
