import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage, rideApi } from '../services/api';
import { ACTIVE_STATUSES, DRIVER_ATTACHED, toLatLng } from '../utils/format';

const STATUS_EVENTS = [
  'ride:searching',
  'ride:driver-assigned',
  'ride:driver-arrived',
  'ride:started',
  'ride:completed',
  'ride:cancelled',
  'ride:no-driver-found',
  'payment:updated',
];
const POLL_MS = 15000;

/**
 * Keeps one ride's state fresh.
 * - The REST API is the source of truth: every status event triggers a
 *   re-fetch instead of trusting the event payload.
 * - Bursts/duplicates of events collapse into one fetch at a time.
 * - On (re)connect we re-subscribe and re-fetch, so nothing missed while
 *   offline is lost. A slow poll covers silently dropped connections.
 * - Driver location events update the marker only if the coordinates are valid.
 */
export function useRideTracking(rideId, socket) {
  const [ride, setRide] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const inFlight = useRef(null);
  const again = useRef(false);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    if (!rideId) return;
    if (inFlight.current) {
      again.current = true;
      return inFlight.current;
    }
    const run = (async () => {
      do {
        again.current = false;
        try {
          const data = await rideApi.get(rideId);
          if (mounted.current) {
            setRide(data.ride);
            setError(null);
          }
        } catch (err) {
          if (mounted.current) setError(errorMessage(err));
        }
      } while (again.current && mounted.current);
    })();
    inFlight.current = run;
    try {
      await run;
    } finally {
      inFlight.current = null;
      if (mounted.current) setLoading(false);
    }
  }, [rideId]);

  useEffect(() => {
    mounted.current = true;
    setLoading(true);
    setRide(null);
    refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  useEffect(() => {
    if (!socket || !rideId) return undefined;
    const subscribe = () => socket.emit('ride:subscribe', { rideId }, () => {});
    const onStatus = (payload) => {
      if (payload && payload.rideId === rideId) refresh();
    };
    const onLocation = (payload) => {
      if (!payload || payload.rideId !== rideId) return;
      const pos = toLatLng(payload);
      if (!pos) return; // ignore malformed positions
      setRide((r) =>
        r && DRIVER_ATTACHED.includes(r.status)
          ? { ...r, driverLocation: { lat: pos[0], lng: pos[1], heading: payload.heading ?? null, updatedAt: payload.updatedAt, fresh: true } }
          : r
      );
    };
    const onConnect = () => {
      subscribe();
      refresh();
    };

    if (socket.connected) subscribe();
    socket.on('connect', onConnect);
    STATUS_EVENTS.forEach((e) => socket.on(e, onStatus));
    socket.on('driver:location-updated', onLocation);
    return () => {
      socket.off('connect', onConnect);
      STATUS_EVENTS.forEach((e) => socket.off(e, onStatus));
      socket.off('driver:location-updated', onLocation);
      socket.emit('ride:unsubscribe', { rideId });
    };
  }, [socket, rideId, refresh]);

  const active = ride && ACTIVE_STATUSES.includes(ride.status);
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [active, refresh]);

  return { ride, setRide, error, loading, refresh };
}
