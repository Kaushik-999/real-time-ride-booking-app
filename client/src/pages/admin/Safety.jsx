import { useState } from 'react';
import ConfirmAction from '../../components/ConfirmAction';
import Pagination from '../../components/Pagination';
import { adminApi } from '../../services/api';
import { formatDateTime } from '../../utils/format';
import { Filter, Table, lower, usePaged } from './shared';

const DISPATCH_TEXT = {
  NOT_CONFIGURED: 'No external dispatch (not configured)',
  PENDING: 'External service has not confirmed yet',
  ACCEPTED: 'External service confirmed receipt',
  FAILED: 'External dispatch FAILED',
};

function IncidentDetail({ id, onChanged }) {
  const { data, error, reload } = usePaged(() => adminApi.incident(id), { id });
  if (error) return <p role="alert" className="text-brake">{error}</p>;
  if (!data) return <p className="text-fog">Loading…</p>;
  const i = data.incident;
  const act = (action, label, opts = {}) => (
    <ConfirmAction label={label} requireReason={opts.reason} danger={opts.danger} prompt={`${label} this incident?`} onConfirm={async (note) => { await adminApi.incidentAction(id, action, note); await reload(); onChanged(); }} />
  );
  return (
    <aside className="rounded-md border-2 border-brake bg-white p-4 text-sm" aria-label="Incident detail">
      <h3 className="sign text-3xl">{lower(i.status)}</h3>
      <p>Raised by the {lower(i.reporterRole)} {formatDateTime(i.createdAt)} on ride {i.rideId}</p>
      {i.message && <p className="mt-1">"{i.message}"</p>}
      <p className="mt-1">Location: {i.location ? `${i.location.lat.toFixed(5)}, ${i.location.lng.toFixed(5)} (${lower(i.location.source)})` : 'not available'}</p>
      <p>Vehicle: {i.context.vehicleRegistration || '—'}</p>
      <p className={`mt-2 font-semibold ${i.emergency.status === 'FAILED' ? 'text-brake' : ''}`}>{DISPATCH_TEXT[i.emergency.status]}</p>
      <h4 className="mt-3 font-semibold">History</h4>
      <ol className="mt-1 space-y-1">
        {i.history.map((h, n) => <li key={n}><span className="text-fog">{formatDateTime(h.at)}</span> {lower(h.action)}{h.note ? `: ${h.note}` : ''}</li>)}
      </ol>
      <div className="mt-4 flex flex-wrap gap-2">
        {i.status === 'OPEN' && act('ACKNOWLEDGE', 'Acknowledge')}
        {['OPEN', 'ACKNOWLEDGED'].includes(i.status) && act('ESCALATE', 'Escalate internally', { reason: true })}
        {i.status !== 'RESOLVED' && act('RESOLVE', 'Resolve', { reason: true })}
        {i.emergency.status === 'FAILED' && act('RETRY_DISPATCH', 'Retry external dispatch')}
      </div>
      <p className="mt-2 text-xs text-fog">"Escalate" moves the case to the senior safety team inside this app. It does not contact police.</p>
    </aside>
  );
}

export default function Safety() {
  const [status, setStatus] = useState('OPEN');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(null);
  const { data, error, reload } = usePaged(adminApi.incidents, { status, page, limit: 20 });
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_400px]">
      <div className="space-y-4">
        <div className="max-w-xs">
          <Filter label="Status" value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={[['OPEN', 'Open'], ['ACKNOWLEDGED', 'Acknowledged'], ['ESCALATED', 'Escalated'], ['RESOLVED', 'Resolved'], ['', 'All']]} />
        </div>
        {error && <p role="alert" className="text-brake">{error}</p>}
        {data && data.items.length === 0 && <p className="text-fog">No incidents here.</p>}
        {data && data.items.length > 0 && (
          <Table head={['Raised', 'By', 'Status', 'External dispatch', '']}>
            {data.items.map((i) => (
              <tr key={i.id}>
                <td className="px-3 py-2">{formatDateTime(i.createdAt)}</td>
                <td className="px-3 py-2">{lower(i.reporterRole)}</td>
                <td className="px-3 py-2">{lower(i.status)}</td>
                <td className={`px-3 py-2 ${i.emergency.status === 'FAILED' ? 'text-brake' : ''}`}>{lower(i.emergency.status)}</td>
                <td className="px-3 py-2 text-right"><button type="button" className="underline" onClick={() => setOpen(i.id)}>Open</button></td>
              </tr>
            ))}
          </Table>
        )}
        {data && <Pagination page={page} limit={data.limit} total={data.total} onPage={setPage} />}
      </div>
      {open && <IncidentDetail key={open} id={open} onChanged={reload} />}
    </div>
  );
}
