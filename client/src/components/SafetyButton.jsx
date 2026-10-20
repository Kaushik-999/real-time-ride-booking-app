import { useState } from 'react';
import { errorMessage, rideApi } from '../services/api';

const ACTIVE = ['DRIVER_ASSIGNED', 'DRIVER_ARRIVED', 'IN_PROGRESS'];

function currentPosition() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 5000, maximumAge: 10000 }
    );
  });
}

/**
 * Safety button for an active ride. It shows exactly what the server
 * reported: it never says police were notified unless an emergency
 * integration confirmed it (`policeNotified: true`).
 */
export default function SafetyButton({ ride, emergencyNumber = '112' }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  if (!ride || !ACTIVE.includes(ride.status)) return null;

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const pos = await currentPosition();
      const data = await rideApi.reportSafety(ride.id, pos || {});
      setResult(data.incident.emergency);
      setConfirming(false);
    } catch (err) {
      setError(`Your alert was NOT recorded: ${errorMessage(err)} Call ${emergencyNumber} if you are in danger.`);
    } finally {
      setBusy(false);
    }
  };

  const number = (result && result.emergencyNumber) || emergencyNumber;
  return (
    <section className="mt-5" aria-label="Safety">
      {!confirming && !result && (
        <button type="button" className="btn w-full border-2 border-brake bg-white font-bold text-brake" onClick={() => setConfirming(true)}>
          Safety help
        </button>
      )}
      {confirming && (
        <div className="rounded-md border-2 border-brake bg-white p-3">
          <p className="font-semibold">Alert our safety team about this ride?</p>
          <p className="mt-1 text-sm">Your ride details and location (if you allow it) are shared with the safety team.</p>
          <div className="mt-3 flex gap-2">
            <button type="button" className="btn flex-1 bg-brake text-white" disabled={busy} onClick={send}>
              {busy ? 'Sending alert…' : 'Send safety alert'}
            </button>
            <button type="button" className="btn-quiet" onClick={() => setConfirming(false)}>
              Back
            </button>
          </div>
        </div>
      )}
      {result && (
        <div role="status" className="rounded-md border-2 border-brake bg-white p-3" data-testid="safety-result">
          <p className="font-semibold">Safety team alerted</p>
          <p className="mt-1 text-sm">{result.message}</p>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 rounded-md border border-brake bg-white p-3 text-sm text-brake">
          {error}
        </p>
      )}
      {(confirming || result || error) && (
        <a href={`tel:${number}`} className="btn mt-2 w-full bg-brake text-white">
          Call {number}
        </a>
      )}
    </section>
  );
}
