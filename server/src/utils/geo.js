'use strict';

// Geographic helpers. GeoJSON (and MongoDB) always order coordinates as
// [longitude, latitude]; these helpers keep that conversion in one place.

const EARTH_RADIUS_M = 6371008.8;

const toRad = (deg) => (deg * Math.PI) / 180;

function isValidLatLng(lat, lng) {
  return (
    typeof lat === 'number' &&
    typeof lng === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

/** { lat, lng } -> GeoJSON Point with [lng, lat]. */
function toPoint({ lat, lng }) {
  return { type: 'Point', coordinates: [lng, lat] };
}

/** GeoJSON Point -> { lat, lng }. */
function fromPoint(point) {
  if (!point || !Array.isArray(point.coordinates)) return null;
  const [lng, lat] = point.coordinates;
  return { lat, lng };
}

/** Great-circle (straight-line) distance in metres between two { lat, lng }. */
function haversineMeters(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Point `distanceM` metres from `origin` along `bearingDeg` (0 = north,
 * 90 = east). Used by tests and the dev seed script to place drivers at
 * exact distances.
 */
function destinationPoint(origin, distanceM, bearingDeg = 90) {
  const δ = distanceM / EARTH_RADIUS_M;
  const θ = toRad(bearingDeg);
  const φ1 = toRad(origin.lat);
  const λ1 = toRad(origin.lng);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: (φ2 * 180) / Math.PI, lng: ((((λ2 * 180) / Math.PI + 540) % 360) - 180) };
}

module.exports = { EARTH_RADIUS_M, isValidLatLng, toPoint, fromPoint, haversineMeters, destinationPoint };
