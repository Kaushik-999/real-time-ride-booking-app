import { useState } from 'react';
import ConfirmAction from '../../components/ConfirmAction';
import Pagination from '../../components/Pagination';
import { adminApi, errorMessage } from '../../services/api';
import { formatDateTime } from '../../utils/format';
import { Filter, Table, lower, usePaged } from './shared';

function DriverReview({ driverId, onChanged, onClose }) {
  const { data, error, reload } = usePaged(() => adminApi.driver(driverId), { driverId });
  const [docError, setDocError] = useState(null);
  const [rejectDocs, setRejectDocs] = useState({});
  const [capacity, setCapacity] = useState('');

  const refresh = async () => {
    await reload();
    onChanged();
  };
  const viewDocument = async (doc) => {
    setDocError(null);
    try {
      // Fetched with the admin's token; opened from memory, never via a public URL.
      const blob = await adminApi.documentFile(driverId, doc.id);
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) {
      setDocError(errorMessage(err));
    }
  };
  if (error) return <p role="alert" className="text-brake">{error}</p>;
  if (!data) return <p className="text-fog">Loading…</p>;
  const { user, profile, documents, requiredDocuments } = data;
  const current = documents.filter((d) => ['SUBMITTED', 'ACCEPTED'].includes(d.status));
  const decisions = Object.entries(rejectDocs)
    .filter(([, v]) => v)
    .map(([documentId]) => ({ documentId, status: 'REJECTED' }));

  return (
    <aside className="rounded-md border border-line bg-white p-4 text-sm" aria-label="Driver review">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="sign text-3xl">{user.name}</h3>
          <p className="text-fog">{user.email}</p>
        </div>
        <button type="button" className="text-sm underline" onClick={onClose}>Close</button>
      </div>
      <p className="mt-2"><span className="font-semibold">Status:</span> {lower(profile.approvalStatus)}</p>
      {profile.review && profile.review.reviewedAt && (
        <p className="text-fog">
          Last decision {formatDateTime(profile.review.reviewedAt)} by {profile.review.reviewedBy ? profile.review.reviewedBy.name : 'unknown'}
          {profile.review.rejectionReason ? `: ${profile.review.rejectionReason}` : ''}
        </p>
      )}
      <h4 className="mt-4 font-semibold">Identity</h4>
      <p>{profile.identity && profile.identity.legalName ? `${profile.identity.legalName}, born ${formatDateTime(profile.identity.dateOfBirth).split(',')[0]}, licence ${profile.identity.licenseNumber}` : 'Not provided'}</p>
      <h4 className="mt-4 font-semibold">Vehicle</h4>
      <p>
        {profile.vehicle.type} {profile.vehicle.registrationNumber}, {profile.vehicle.capacity} seats
      </p>
      <div className="mt-1 flex items-end gap-2">
        <div>
          <label className="label" htmlFor="cap">Correct seats</label>
          <input id="cap" type="number" min="1" max="7" className="field w-24" value={capacity} onChange={(e) => setCapacity(e.target.value)} />
        </div>
        <ConfirmAction label="Save seats" prompt="Change this vehicle's passenger capacity?" requireReason onConfirm={async (reason) => { await adminApi.setCapacity(driverId, Number(capacity), reason); await refresh(); }} />
      </div>
      <h4 className="mt-4 font-semibold">Documents</h4>
      {docError && <p role="alert" className="text-brake">{docError}</p>}
      <ul className="mt-1 space-y-1">
        {requiredDocuments.filter((t) => !current.some((d) => d.type === t)).map((t) => (
          <li key={t} className="text-brake">Missing: {lower(t)}</li>
        ))}
        {current.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{lower(d.type)}</span>
            <span className="text-fog">{lower(d.status)}, {formatDateTime(d.createdAt)}</span>
            <button type="button" className="underline" onClick={() => viewDocument(d)}>View</button>
            {profile.approvalStatus === 'PENDING_REVIEW' && (
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={Boolean(rejectDocs[d.id])} onChange={(e) => setRejectDocs({ ...rejectDocs, [d.id]: e.target.checked })} />
                needs re-upload
              </label>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-1 text-xs text-fog">Opening a document is recorded in the audit log.</p>
      <div className="mt-4 flex flex-wrap gap-2">
        {['PENDING_REVIEW', 'SUSPENDED'].includes(profile.approvalStatus) && decisions.length === 0 && (
          <ConfirmAction label={profile.approvalStatus === 'SUSPENDED' ? 'Reinstate' : 'Approve'} prompt="Approve this driver to receive rides?" onConfirm={async () => { await adminApi.decide(driverId, { approvalStatus: 'APPROVED' }); await refresh(); }} />
        )}
        {['PENDING_REVIEW', 'DOCUMENTS_REQUIRED'].includes(profile.approvalStatus) && (
          <ConfirmAction label="Reject" danger requireReason prompt="Reject this application? The reason is shown to the driver." onConfirm={async (reason) => { await adminApi.decide(driverId, { approvalStatus: 'REJECTED', reason, documentDecisions: decisions }); await refresh(); }} />
        )}
        {profile.approvalStatus === 'APPROVED' && (
          <ConfirmAction label="Suspend" danger requireReason prompt="Suspend this driver? They go offline immediately (not while on a ride)." onConfirm={async (reason) => { await adminApi.decide(driverId, { approvalStatus: 'SUSPENDED', reason }); await refresh(); }} />
        )}
      </div>
      <h4 className="mt-5 font-semibold">Women-driver programme</h4>
      <p>Status: {lower(profile.femaleDriverProgram ? profile.femaleDriverProgram.status : 'NOT_REQUESTED')}</p>
      {profile.femaleDriverProgram && profile.femaleDriverProgram.status === 'PENDING' && (
        <div className="mt-1 flex gap-2">
          <ConfirmAction label="Verify" prompt="Confirm you checked eligibility against the submitted identity documents." requireReason onConfirm={async (note) => { await adminApi.femaleVerification(driverId, 'VERIFIED', note); await refresh(); }} />
          <ConfirmAction label="Decline" danger requireReason prompt="Decline the request?" onConfirm={async (note) => { await adminApi.femaleVerification(driverId, 'REJECTED', note); await refresh(); }} />
        </div>
      )}
      {profile.femaleDriverProgram && profile.femaleDriverProgram.status === 'VERIFIED' && (
        <ConfirmAction label="Revoke" danger requireReason prompt="Remove this driver from the programme?" onConfirm={async (note) => { await adminApi.femaleVerification(driverId, 'NOT_REQUESTED', note); await refresh(); }} />
      )}
    </aside>
  );
}

export default function Drivers() {
  const [approvalStatus, setApprovalStatus] = useState('PENDING_REVIEW');
  const [femaleProgram, setFemaleProgram] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(null);
  const { data, error, reload } = usePaged(adminApi.drivers, { approvalStatus, femaleProgram, page, limit: 20 });
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_420px]">
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 md:max-w-lg">
          <Filter label="Review status" value={approvalStatus} onChange={(v) => { setApprovalStatus(v); setPage(1); }} options={[['PENDING_REVIEW', 'Waiting for review'], ['DOCUMENTS_REQUIRED', 'Documents required'], ['APPROVED', 'Approved'], ['REJECTED', 'Rejected'], ['SUSPENDED', 'Suspended'], ['', 'All']]} />
          <Filter label="Women-driver programme" value={femaleProgram} onChange={(v) => { setFemaleProgram(v); setPage(1); }} options={[['', 'Any'], ['PENDING', 'Waiting'], ['VERIFIED', 'Verified']]} />
        </div>
        {error && <p role="alert" className="text-brake">{error}</p>}
        {data && data.items.length === 0 && <p className="text-fog">No drivers in this list.</p>}
        {data && data.items.length > 0 && (
          <Table head={['Driver', 'Vehicle', 'Status', 'Submitted', '']}>
            {data.items.map((d) => (
              <tr key={d.id}>
                <td className="px-3 py-2"><p className="font-medium">{d.name}</p><p className="text-fog">{d.email}</p></td>
                <td className="px-3 py-2">{d.vehicle.type} {d.vehicle.registrationNumber}</td>
                <td className="px-3 py-2">{lower(d.approvalStatus)}</td>
                <td className="px-3 py-2">{d.submittedAt ? formatDateTime(d.submittedAt) : '—'}</td>
                <td className="px-3 py-2 text-right"><button type="button" className="font-medium underline" onClick={() => setOpen(d.userId)}>Review</button></td>
              </tr>
            ))}
          </Table>
        )}
        {data && <Pagination page={page} limit={data.limit} total={data.total} onPage={setPage} />}
      </div>
      {open && <DriverReview key={open} driverId={open} onChanged={reload} onClose={() => setOpen(null)} />}
    </div>
  );
}
