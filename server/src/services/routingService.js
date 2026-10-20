'use strict';

// Distance/duration between two points.
// - "straight_line" (default): great-circle distance + average speed. This is
//   an ESTIMATE; real roads are usually longer.
// - "osrm": asks an OSRM routing server (ROUTING_PROVIDER=osrm, OSRM_URL=...)
//   for the actual driving route, and falls back to straight-line if the
//   router is slow or unavailable.
const config = require('../config');
const logger = require('../utils/logger');
const { haversineMeters } = require('../utils/geo');

function straightLine(from, to) {
  const distanceMeters = Math.round(haversineMeters(from, to));
  const metresPerSecond = (config.fare.avgSpeedKmh * 1000) / 3600;
  return { distanceMeters, durationSeconds: Math.round(distanceMeters / metresPerSecond), source: 'straight_line' };
}

async function osrmRoute(from, to) {
  const url = `${config.routing.osrmUrl.replace(/\/$/, '')}/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=false`;
  const res = await fetch(url, { signal: AbortSignal.timeout(config.routing.timeoutMs) });
  if (!res.ok) throw new Error(`OSRM responded ${res.status}`);
  const body = await res.json();
  const route = body.routes && body.routes[0];
  if (!route || !Number.isFinite(route.distance) || !Number.isFinite(route.duration)) throw new Error('OSRM returned no route');
  return { distanceMeters: Math.round(route.distance), durationSeconds: Math.round(route.duration), source: 'osrm' };
}

async function getRoute(from, to) {
  if (config.routing.provider === 'osrm') {
    try {
      return await osrmRoute(from, to);
    } catch (err) {
      logger.warn({ err: err.message }, 'routing provider failed; using straight-line estimate');
    }
  }
  return straightLine(from, to);
}

module.exports = { getRoute, straightLine };
