import { useState } from 'react';
import ConfirmAction from '../../components/ConfirmAction';
import Pagination from '../../components/Pagination';
import { adminApi } from '../../services/api';
import { STATUS_TEXT, formatDateTime, formatMoney } from '../../utils/format';
import { Filter, Table, lower, usePaged } from './shared';

const STATUSES = ['', 'SEARCHING', 'DRIVER_ASSIGNED', 'DRIVER_ARRIVED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_DRIVER_FOUND'];

function RideDetail({ rideId, onChanged }) {
  const { data, error, reload } = usePaged(() => adminApi.ride(rideId), { rideId });
  if (error) return <p role="alert" className="text-brake">{error}</p>;
  if (!data) return <p className="text-fog">Loading…</p>;
  const r = data.ride;
  const cancellable = ['SEARCHING', 'DRIVER_ASSIGNED', 'DRIVER_ARRIVED'].includes(r.status);
  return (
    <aside className="rounded-md border border-line bg-white p-4 text-sm" aria-label="Ride detail">
      <h3 className="sign text-3xl">{STATUS_TEXT[r.status]}</h3>
      <p className="text-fog">Ride {r.id}</p>
      <p className="mt-1">{r.vehicleType}, {r.passengerCount || 1} rider(s){r.driverPreference === 'FEMALE_ONLY' ? ', women drivers only' : ''}{r.noDriverReason ? `, ${lower(r.noDriverReason)}` : ''}</p>
      {data.safetyIncidents.length > 0 && (
        <p className="mt-2 font-semibold text-brake">{data.safetyIncidents.length} safety incident(s): {data.safetyIncidents.map((i) => lower(i.status)).join(', ')}</p>
      )}
      {data.chatReports > 0 && <p className="text-brake">{data.chatReports} chat report(s)</p>}
      <h4 className="mt-4 font-semibold">Offers</h4>
      <ol className="mt-1 list-decimal space-y-1 pl-5">
        {data.offers.map((o) => <li key={o.id}>{lower(o.status)}, ring {o.ringIndex + 1}, {Math.round(o.distanceMeters)} m away</li>)}
        {data.offers.length === 0 && <li className="list-none text-fog">No offers were sent.</li>}
      </ol>
      <h4 className="mt-4 font-semibold">Timeline</h4>
      <ol className="mt-1 space-y-1">
        {data.events.map((e) => <li key={e.id}><span className="text-fog">{formatDateTime(e.createdAt)}</span> {lower(e.eventType)}</li>)}
      </ol>
      {data.payment && <p className="mt-4"><span className="font-semibold">Payment:</span> {lower(data.payment.status)} ({lower(data.payment.method)})</p>}
      {cancellable && (
        <div className="mt-4">
          <ConfirmAction label="Cancel ride" danger requireReason prompt="Cancel this ride for the passenger? Any driver is released." onConfirm={async (reason) => { await adminApi.cancelRide(rideId, reason); await reload(); onChanged(); }} />
        </div>
      )}
    </aside>
  );
}

export default function Rides() {
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(null);
  const { data, error, reload } = usePaged(adminApi.rides, { status, page, limit: 20 });
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_400px]">
      <div className="space-y-4">
        <div className="max-w-xs">
          <Filter label="Status" value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={STATUSES.map((s) => [s, s ? STATUS_TEXT[s] : 'All rides'])} />
        </div>
        {error && <p role="alert" className="text-brake">{error}</p>}
        {data && (
          <Table head={['Created', 'Status', 'Vehicle', 'Fare', 'Radius', '']}>
            {data.items.map((r) => (
              <tr key={r.id}>
                <td className="px-3 py-2">{formatDateTime(r.createdAt)}</td>
                <td className="px-3 py-2">{STATUS_TEXT[r.status]}</td>
                <td className="px-3 py-2">{r.vehicleType}</td>
                <td className="px-3 py-2">{formatMoney(r.finalFare ?? r.estimatedFare, r.currency)}</td>
                <td className="px-3 py-2">{r.matchingRadiusKm ? `${r.matchingRadiusKm} km` : '—'}</td>
                <td className="px-3 py-2 text-right"><button type="button" className="font-medium underline" onClick={() => setOpen(r.id)}>Inspect</button></td>
              </tr>
            ))}
          </Table>
        )}
        {data && <Pagination page={page} limit={data.limit} total={data.total} onPage={setPage} />}
      </div>
      {open && <RideDetail key={open} rideId={open} onChanged={reload} />}
    </div>
  );
}
