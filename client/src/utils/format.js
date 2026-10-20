// Money arrives from the API as integer paise (100 paise = ₹1).
export function formatMoney(paise, currency = 'INR') {
  if (!Number.isFinite(paise)) return '—';
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(paise / 100);
}

export function formatDistance(meters) {
  if (!Number.isFinite(meters)) return '—';
  return meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(1)} km`;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const min = Math.max(1, Math.round(seconds / 60));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

export function formatDateTime(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

/** A valid map position, or null. Never let NaN/out-of-range values reach the map. */
export function toLatLng(value) {
  if (!value) return null;
  const lat = Number(value.lat);
  const lng = Number(value.lng);
  if (typeof value.lat !== 'number' || typeof value.lng !== 'number') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return [lat, lng];
}

/** One key per booking attempt; re-sent unchanged when the request is retried. */
export function newRequestKey() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export const STATUS_TEXT = {
  SEARCHING: 'Finding you a driver',
  DRIVER_ASSIGNED: 'Driver on the way',
  DRIVER_ARRIVED: 'Driver is at pickup',
  IN_PROGRESS: 'On the way',
  COMPLETED: 'Ride complete',
  CANCELLED: 'Ride cancelled',
  NO_DRIVER_FOUND: 'No driver nearby',
};

export const VEHICLE_FALLBACK = [
  { type: 'BIKE', label: 'Bike', maxPassengers: 1 },
  { type: 'AUTO', label: 'Auto', maxPassengers: 3 },
  { type: 'CAR', label: 'Car', maxPassengers: 4 },
];

export const ACTIVE_STATUSES = ['SEARCHING', 'DRIVER_ASSIGNED', 'DRIVER_ARRIVED', 'IN_PROGRESS'];
export const DRIVER_ATTACHED = ['DRIVER_ASSIGNED', 'DRIVER_ARRIVED', 'IN_PROGRESS'];
