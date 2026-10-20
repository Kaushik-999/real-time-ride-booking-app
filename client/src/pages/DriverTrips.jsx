import { useEffect, useState } from 'react';
import { driverApi, errorMessage } from '../services/api';
import { STATUS_TEXT, formatDateTime, formatDistance, formatMoney } from '../utils/format';

export default function DriverTrips() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    driverApi.trips(1).then(setData).catch((err) => setError(errorMessage(err)));
  }, []);

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="sign text-5xl">Trips and earnings</h1>
      {error && <p role="alert" className="mt-4 text-brake">{error}</p>}
      {data && (
        <>
          <p className="mt-6 text-fog">Earned from {data.earnings.completedTrips} completed trips</p>
          <p className="sign text-7xl">{formatMoney(data.earnings.totalPaise, data.earnings.currency)}</p>
          {data.items.length === 0 ? (
            <p className="mt-8">No trips yet. Go online from the Drive tab to start receiving rides.</p>
          ) : (
            <ul className="mt-8 divide-y divide-line border-y border-line">
              {data.items.map((r) => (
                <li key={r.id} className="grid grid-cols-[1fr_auto] gap-x-4 px-1 py-3">
                  <span className="truncate font-medium">{r.pickup.address} to {r.destination.address}</span>
                  <span className="text-right font-bold">{r.status === 'COMPLETED' ? formatMoney(r.finalFare, r.currency) : '—'}</span>
                  <span className="text-sm text-fog">{formatDateTime(r.completedAt || r.createdAt)}{r.tripDistanceMeters ? `, ${formatDistance(r.tripDistanceMeters)}` : ''}</span>
                  <span className="text-right text-sm">{STATUS_TEXT[r.status]}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
