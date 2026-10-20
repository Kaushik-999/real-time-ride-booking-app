import { useEffect, useRef, useState } from 'react';
import { driverApi, errorMessage } from '../services/api';
import { toLatLng } from '../utils/format';

const REPORT_EVERY_MS = 5000;

/**
 * While `enabled`, sends the driver's position to the server every 5 s so
 * it stays "fresh" (the server ignores drivers silent for 30 s).
 * Position comes from the browser's GPS when allowed, otherwise from the
 * point the driver set on the map (handy for local testing).
 */
export function useLocationReporter(enabled, manualPosition) {
  const [gpsPosition, setGpsPosition] = useState(null);
  const [lastSentAt, setLastSentAt] = useState(null);
  const [error, setError] = useState(null);
  const latest = useRef(null);
  const [useGps, setUseGps] = useState(false);

  useEffect(() => {
    if (!enabled || !useGps || !navigator.geolocation) return undefined;
    const id = navigator.geolocation.watchPosition(
      (p) => setGpsPosition({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => {
        setError('Location permission denied. Set your position on the map instead.');
        setUseGps(false);
      },
      { enableHighAccuracy: true, maximumAge: 5000 }
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [enabled, useGps]);

  latest.current = useGps && gpsPosition ? gpsPosition : manualPosition;

  useEffect(() => {
    if (!enabled) return undefined;
    let stopped = false;
    const send = async () => {
      const pos = toLatLng(latest.current);
      if (!pos) return;
      try {
        await driverApi.updateLocation({ lat: pos[0], lng: pos[1] });
        if (!stopped) {
          setLastSentAt(new Date());
          setError(null);
        }
      } catch (err) {
        if (!stopped) setError(errorMessage(err));
      }
    };
    send();
    const t = setInterval(send, REPORT_EVERY_MS);
    return () => {
      stopped = true;
      clearInterval(t);
    };
    // A new map pick is sent at once; GPS changes ride the 5 s interval.
  }, [enabled, manualPosition]);

  return { position: latest.current, lastSentAt, error, useGps, setUseGps };
}
