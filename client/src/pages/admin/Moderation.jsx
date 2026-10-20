import { useState } from 'react';
import ConfirmAction from '../../components/ConfirmAction';
import Pagination from '../../components/Pagination';
import { adminApi, errorMessage } from '../../services/api';
import { formatDateTime, formatMoney } from '../../utils/format';
import { Filter, Table, lower, usePaged } from './shared';

export function Reviews() {
  const [status, setStatus] = useState('PUBLISHED');
  const [maxRating, setMaxRating] = useState('2');
  const [page, setPage] = useState(1);
  const { data, error, reload } = usePaged(adminApi.reviews, { status, maxRating, page, limit: 20 });
  return (
    <div className="space-y-4">
      <div className="grid max-w-lg grid-cols-2 gap-3">
        <Filter label="Status" value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={[['PUBLISHED', 'Published'], ['HIDDEN', 'Hidden'], ['', 'All']]} />
        <Filter label="Rating" value={maxRating} onChange={(v) => { setMaxRating(v); setPage(1); }} options={[['2', '2 stars or less'], ['3', '3 stars or less'], ['', 'Any']]} />
      </div>
      {error && <p role="alert" className="text-brake">{error}</p>}
      {data && (
        <Table head={['When', 'From', 'About', 'Rating', 'Comment', '']}>
          {data.items.map((r) => (
            <tr key={r.id}>
              <td className="px-3 py-2">{formatDateTime(r.createdAt)}</td>
              <td className="px-3 py-2">{r.reviewer && r.reviewer.name}</td>
              <td className="px-3 py-2">{r.reviewee && r.reviewee.name}</td>
              <td className="px-3 py-2">{r.rating}</td>
              <td className="max-w-xs px-3 py-2">{r.comment}</td>
              <td className="px-3 py-2 text-right">
                {r.status === 'PUBLISHED' ? (
                  <ConfirmAction label="Hide" danger requireReason prompt="Hide this review? It is removed from the person's rating." onConfirm={async (reason) => { await adminApi.moderateReview(r.id, 'HIDDEN', reason); await reload(); }} />
                ) : (
                  <ConfirmAction label="Restore" prompt="Publish this review again?" onConfirm={async () => { await adminApi.moderateReview(r.id, 'PUBLISHED'); await reload(); }} />
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
      {data && <Pagination page={page} limit={data.limit} total={data.total} onPage={setPage} />}
    </div>
  );
}

export function ChatReports() {
  const [status, setStatus] = useState('OPEN');
  const [page, setPage] = useState(1);
  const [conversation, setConversation] = useState(null);
  const [convError, setConvError] = useState(null);
  const { data, error, reload } = usePaged(adminApi.chatReports, { status, page, limit: 20 });
  const openConversation = async (rideId) => {
    setConvError(null);
    try {
      setConversation({ rideId, ...(await adminApi.conversation(rideId)) });
    } catch (err) {
      setConvError(errorMessage(err));
    }
  };
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
      <div className="space-y-4">
        <div className="max-w-xs">
          <Filter label="Status" value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={[['OPEN', 'Open'], ['REVIEWED', 'Reviewed'], ['', 'All']]} />
        </div>
        {error && <p role="alert" className="text-brake">{error}</p>}
        {data && (
          <Table head={['Reported', 'By', 'Reason', '']}>
            {data.items.map((r) => (
              <tr key={r.id}>
                <td className="px-3 py-2">{formatDateTime(r.createdAt)}</td>
                <td className="px-3 py-2">{r.reporter && `${r.reporter.name} (${lower(r.reporter.role)})`}</td>
                <td className="px-3 py-2">{r.reason}</td>
                <td className="space-x-2 px-3 py-2 text-right">
                  <button type="button" className="underline" onClick={() => openConversation(r.rideId)}>Read conversation</button>
                  {r.status === 'OPEN' && <ConfirmAction label="Mark reviewed" prompt="Mark this report as reviewed?" onConfirm={async () => { await adminApi.resolveChatReport(r.id); await reload(); }} />}
                </td>
              </tr>
            ))}
          </Table>
        )}
        {data && <Pagination page={page} limit={data.limit} total={data.total} onPage={setPage} />}
      </div>
      {convError && <p role="alert" className="text-brake">{convError}</p>}
      {conversation && (
        <aside className="rounded-md border border-line bg-white p-4 text-sm" aria-label="Conversation">
          <p className="text-xs text-fog">Reading this conversation is recorded in the audit log.</p>
          <ol className="mt-2 space-y-1">
            {conversation.messages.map((m) => <li key={m.id}><span className="font-semibold">{lower(m.senderRole)}:</span> {m.body}</li>)}
          </ol>
        </aside>
      )}
    </div>
  );
}

export function Payments() {
  const [status, setStatus] = useState('');
  const [refund, setRefund] = useState('');
  const [page, setPage] = useState(1);
  const [notice, setNotice] = useState(null);
  const { data, error, reload } = usePaged(adminApi.payments, { status, refund, page, limit: 20 });
  return (
    <div className="space-y-4">
      <div className="grid max-w-lg grid-cols-2 gap-3">
        <Filter label="Status" value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={[['', 'All'], ['PENDING', 'Pending'], ['PROCESSING', 'Processing'], ['SUCCEEDED', 'Succeeded'], ['FAILED', 'Failed']]} />
        <Filter label="Refunds" value={refund} onChange={(v) => { setRefund(v); setPage(1); }} options={[['', 'Any'], ['requested', 'Refund requested']]} />
      </div>
      <p className="text-sm text-fog">The payment provider in this build is a test (mock) provider. It cannot move money, so refunds are recorded as requests to be paid out manually.</p>
      {notice && <p role="status" className="rounded-md border border-line bg-white p-3 text-sm">{notice}</p>}
      {error && <p role="alert" className="text-brake">{error}</p>}
      {data && (
        <Table head={['Created', 'Amount', 'Method', 'Status', 'Refund', '']}>
          {data.items.map((p) => (
            <tr key={p.id}>
              <td className="px-3 py-2">{formatDateTime(p.createdAt)}</td>
              <td className="px-3 py-2">{formatMoney(p.amount, p.currency)}</td>
              <td className="px-3 py-2">{lower(p.method)}</td>
              <td className="px-3 py-2">{lower(p.status)}</td>
              <td className="px-3 py-2">{p.refund && p.refund.status ? 'requested (manual)' : '—'}</td>
              <td className="px-3 py-2 text-right">
                {p.status === 'SUCCEEDED' && !(p.refund && p.refund.status) && (
                  <ConfirmAction label="Request refund" danger requireReason prompt="Record a refund request? No money moves automatically." onConfirm={async (reason) => { const r = await adminApi.requestRefund(p.id, reason); setNotice(r.notice); await reload(); }} />
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
      {data && <Pagination page={page} limit={data.limit} total={data.total} onPage={setPage} />}
    </div>
  );
}

export function AuditLog() {
  const [action, setAction] = useState('');
  const [page, setPage] = useState(1);
  const { data, error } = usePaged(adminApi.auditLogs, { action, page, limit: 50 });
  return (
    <div className="space-y-4">
      <div className="max-w-xs">
        <label htmlFor="audit-action" className="label">Action</label>
        <input id="audit-action" className="field" placeholder="e.g. DOCUMENT_VIEWED" value={action} onChange={(e) => { setAction(e.target.value.toUpperCase()); setPage(1); }} />
      </div>
      {error && <p role="alert" className="text-brake">{error}</p>}
      {data && (
        <Table head={['When', 'Who', 'Action', 'Target', 'Details']}>
          {data.items.map((a) => (
            <tr key={a.id}>
              <td className="px-3 py-2">{formatDateTime(a.createdAt)}</td>
              <td className="px-3 py-2">{a.actor ? a.actor.name : '—'}</td>
              <td className="px-3 py-2">{lower(a.action)}</td>
              <td className="px-3 py-2">{a.targetType} {a.targetId.slice(-6)}</td>
              <td className="max-w-xs px-3 py-2 text-xs">{a.metadata && (a.metadata.reason || a.metadata.note || (a.metadata.to ? `→ ${JSON.stringify(a.metadata.to)}` : ''))}</td>
            </tr>
          ))}
        </Table>
      )}
      {data && <Pagination page={page} limit={data.limit} total={data.total} onPage={setPage} />}
    </div>
  );
}
