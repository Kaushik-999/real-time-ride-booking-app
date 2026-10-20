'use strict';

/**
 * Adapter for an AUTHORISED external emergency-response service.
 *
 * Providers (EMERGENCY_PROVIDER):
 *   none    - default. No external service exists. Nothing is sent outside
 *             this application, and the app must say so.
 *   webhook - POSTs a signed JSON alert to EMERGENCY_WEBHOOK_URL. It counts
 *             as delivered ONLY if the service answers 2xx with
 *             {"accepted": true, "reference": "..."}. Anything else (timeout,
 *             error status, unexpected body) is a failure and is retried.
 *
 * This module never pretends an alert was accepted. In particular, looking
 * up a "nearest police station" is NOT an alert and is not implemented as one.
 */
const crypto = require('crypto');
const config = require('../config');

function createNoneProvider() {
  return { name: 'none', configured: false };
}

function createWebhookProvider({ url, secret, timeoutMs = 8000 }) {
  return {
    name: 'webhook',
    configured: true,
    async send(alert) {
      const body = JSON.stringify(alert);
      const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');
      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Signature': signature },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        return { accepted: false, error: err.name === 'TimeoutError' ? 'timeout' : 'network error' };
      }
      if (!res.ok) return { accepted: false, error: `service responded ${res.status}` };
      const json = await res.json().catch(() => null);
      if (!json || json.accepted !== true) return { accepted: false, error: 'service did not confirm acceptance' };
      return { accepted: true, reference: typeof json.reference === 'string' ? json.reference.slice(0, 200) : null };
    },
  };
}

let provider =
  config.emergency.provider === 'webhook'
    ? createWebhookProvider({ url: config.emergency.webhookUrl, secret: config.emergency.webhookSecret })
    : createNoneProvider();

const getProvider = () => provider;
/** Tests (and only tests) swap in a provider pointing at a local fake service. */
function setProviderForTesting(p) {
  provider = p;
}

module.exports = { getProvider, setProviderForTesting, createWebhookProvider, createNoneProvider };
