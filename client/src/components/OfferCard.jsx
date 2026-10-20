import { useEffect, useState } from 'react';
import { formatDistance, formatMoney } from '../utils/format';

export default function OfferCard({ offer, onAccept, onReject, busy }) {
  const [left, setLeft] = useState(() => Math.max(0, new Date(offer.expiresAt) - Date.now()));
  useEffect(() => {
    const t = setInterval(() => setLeft(Math.max(0, new Date(offer.expiresAt) - Date.now())), 250);
    return () => clearInterval(t);
  }, [offer.expiresAt]);
  const seconds = Math.ceil(left / 1000);
  const expired = left <= 0;

  return (
    <div className="rounded-lg border-2 border-asphalt bg-rickshaw p-4" role="alertdialog" aria-labelledby={`offer-${offer.id}`}>
      <div className="flex items-baseline justify-between">
        <h2 id={`offer-${offer.id}`} className="sign text-4xl">New ride</h2>
        <span className="sign text-4xl" aria-label={`${seconds} seconds left`}>{expired ? '0' : seconds}s</span>
      </div>
      <p className="mt-1 font-semibold">{formatMoney(offer.ride && offer.ride.estimatedFare, offer.ride && offer.ride.currency)} estimated</p>
      <p className="text-sm">Pickup {formatDistance(offer.distanceToPickupMeters)} away</p>
      {offer.ride && (
        <dl className="mt-3 space-y-1 text-sm">
          <div><dt className="inline font-semibold">Pickup: </dt><dd className="inline">{offer.ride.pickup.address}</dd></div>
          <div><dt className="inline font-semibold">Riders: </dt><dd className="inline">{offer.ride.passengerCount || 1}</dd></div>
          {offer.ride.estimate && (
            <div><dt className="inline font-semibold">Trip length: </dt><dd className="inline">about {formatDistance(offer.ride.estimate.distanceMeters)}</dd></div>
          )}
          <div className="text-xs">The destination is shown after the passenger gives you their pickup code.</div>
        </dl>
      )}
      <div className="mt-4 flex gap-2">
        <button type="button" className="btn-dark flex-[2]" disabled={busy || expired} onClick={() => onAccept(offer)}>
          {busy === 'accept' ? 'Accepting…' : 'Accept'}
        </button>
        <button type="button" className="btn flex-1 border border-asphalt" disabled={busy || expired} onClick={() => onReject(offer)}>
          {busy === 'reject' ? 'Declining…' : 'Decline'}
        </button>
      </div>
    </div>
  );
}
