'use strict';

const chatService = require('../services/chatService');
const { ok } = require('../utils/asyncHandler');

exports.history = async (req, res) => ok(res, await chatService.history(req.user, req.params.rideId, req.query));
exports.send = async (req, res) => {
  const result = await chatService.sendMessage(req.user, req.params.rideId, req.body);
  ok(res, result, result.duplicate ? 200 : 201);
};
exports.report = async (req, res) => {
  const report = await chatService.reportMessage(req.user, req.params.rideId, req.params.messageId, req.body.reason);
  ok(res, { report: { id: String(report._id), status: report.status } }, 201);
};
exports.adminReports = async (req, res) => ok(res, await chatService.adminListReports(req.query));
exports.adminConversation = async (req, res) => ok(res, await chatService.adminConversation(req.user, req.params.rideId, { ip: req.ip }));
exports.adminResolve = async (req, res) => {
  const report = await chatService.adminResolveReport(req.user, req.params.reportId, { ip: req.ip });
  ok(res, { report: { id: String(report._id), status: report.status } });
};
