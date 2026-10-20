import { useCallback, useEffect, useState } from 'react';
import { errorMessage, rideApi } from '../services/api';

const NEEDS_CODE = ['DRIVER_ASSIGNED', 'DRIVER_ARRIVED', 'IN_PROGRESS'];

/**
 * The passenger's one-time code. Shown only in the passenger's own app; the
 * driver types it in at pickup (start) and at drop-off (completion).
 * Re-fetched when the ride status changes or the server says a new code is ready.
 */
export default function TripCodeCard({ ride, socket }) {
  const [otp, setOtp] = useState(null);
  const [error, setError] = useState(null);
  const active = ride && NEEDS_CODE.includes(ride.status);

  const load = useCallback(async () => {
    if (!active) return;
    try {
      const data = await rideApi.otp(ride.id);
      setOtp(data.otp);
      setError(null);
    } catch (err) {
      setOtp(null);
      setError(errorMessage(err));
    }
  }, [active, ride && ride.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    load();
  }, [load, ride && ride.status]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!socket || !active) return undefined;
    const onReady = (p) => p && p.rideId === ride.id && load();
    socket.on('ride:otp-available', onReady);
    return () => socket.off('ride:otp-available', onReady);
  }, [socket, active, ride && ride.id, load]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!active) return null;
  const forStart = otp ? otp.purpose === 'TRIP_START' : ride.status !== 'IN_PROGRESS';
  return (
    <section className="mt-4 rounded-md border-2 border-asphalt bg-white p-4" aria-label="Trip code" data-testid="trip-code">
      <p className="text-sm font-semibold">{forStart ? 'Your pickup code' : 'Your drop-off code'}</p>
      {otp ? (
        <>
          <p className="sign mt-1 text-6xl tracking-[0.2em]" aria-live="polite">
            {otp.code}
          </p>
          <p className="mt-1 text-sm text-fog">
            {forStart
              ? 'Tell this code to your driver only when you are in the car. The trip starts after the driver enters it.'
              : 'Tell this code to your driver when you reach your destination.'}
          </p>
        </>
      ) : (
        <p className="mt-1 text-sm text-fog">{error || 'Loading your code…'}</p>
      )}
    </section>
  );
}
