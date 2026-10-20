'use strict';

const paymentService = require('../services/paymentService');
const { ok } = require('../utils/asyncHandler');
const { unauthorized } = require('../utils/errors');

/**
 * Provider -> server callback. Authenticated by an HMAC-SHA256 signature of
 * the raw request body (header `X-Signature`) using PAYMENT_WEBHOOK_SECRET,
 * so a client cannot forge "payment succeeded".
 */
exports.webhook = async (req, res) => {
  if (!paymentService.verifySignature(req.rawBody, req.get('x-signature'))) throw unauthorized('Invalid signature');
  const { payment, duplicate } = await paymentService.applyProviderResult(req.body);
  ok(res, { paymentId: String(payment._id), status: payment.status, duplicate });
};
