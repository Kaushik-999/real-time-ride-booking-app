import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { errorMessage, rideApi } from '../services/api';
import { STATUS_TEXT, formatDateTime, formatMoney } from '../utils/format';

export default function HistoryPage() {
  const [data, setData] = useState(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState(null);

  useEffect(() => {
    setError(null);
    rideApi.history(page).then(setData).catch((err) => setError(errorMessage(err)));
  }, [page]);

  const pages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1;
  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="sign mb-6 text-5xl">My rides</h1>
      {error && <p role="alert" className="text-brake">{error}</p>}
      {data && data.items.length === 0 && (
        <p>
          No rides yet. <Link to="/" className="font-semibold underline">Book your first ride</Link>.
        </p>
      )}
      <ul className="divide-y divide-line border-y border-line">
        {data &&
          data.items.map((r) => (
            <li key={r.id}>
              <Link to={`/ride/${r.id}`} className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 px-1 py-4 hover:bg-white">
                <span className="truncate font-medium">{r.destination.address}</span>
                <span className="text-right font-bold">{formatMoney(r.finalFare ?? r.estimatedFare, r.currency)}</span>
                <span className="text-sm text-fog">{formatDateTime(r.createdAt)}</span>
                <span className={`text-right text-sm ${r.status === 'COMPLETED' ? 'text-kerb' : r.status === 'CANCELLED' || r.status === 'NO_DRIVER_FOUND' ? 'text-brake' : ''}`}>
                  {STATUS_TEXT[r.status]}
                  {r.payment ? `, ${r.payment.status === 'SUCCEEDED' ? 'paid' : 'unpaid'}` : ''}
                </span>
              </Link>
            </li>
          ))}
      </ul>
      {pages > 1 && (
        <div className="mt-4 flex items-center gap-3">
          <button type="button" className="btn-quiet" disabled={page <= 1} onClick={() => setPage(page - 1)}>Newer</button>
          <span className="text-sm text-fog">Page {page} of {pages}</span>
          <button type="button" className="btn-quiet" disabled={page >= pages} onClick={() => setPage(page + 1)}>Older</button>
        </div>
      )}
    </div>
  );
}
