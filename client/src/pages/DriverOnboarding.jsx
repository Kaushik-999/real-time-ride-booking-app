import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { driverApi, errorMessage } from '../services/api';
import { formatDateTime } from '../utils/format';

const DOC_LABELS = {
  PHOTO: 'Your photo',
  DRIVING_LICENSE: 'Driving licence',
  VEHICLE_RC: 'Vehicle registration certificate (RC)',
  VEHICLE_INSURANCE: 'Vehicle insurance',
  AADHAAR: 'Aadhaar (masked: hide the first 8 digits)',
  PAN: 'PAN card',
};
const STATUS_TEXT = {
  DOCUMENTS_REQUIRED: 'Add your details and documents',
  PENDING_REVIEW: 'Waiting for review',
  APPROVED: 'Approved',
  REJECTED: 'Changes needed',
  SUSPENDED: 'Account suspended',
};

/**
 * Driver onboarding: identity, documents, submission, review outcome and the
 * optional women-driver programme. Files go to private encrypted storage;
 * nobody but authorised reviewers can open them.
 */
export default function DriverOnboarding() {
  const [status, setStatus] = useState(null);
  const [docs, setDocs] = useState([]);
  const [identity, setIdentity] = useState({ legalName: '', dateOfBirth: '', licenseNumber: '' });
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const load = useCallback(async () => {
    try {
      const [st, d, me] = await Promise.all([driverApi.onboarding(), driverApi.documents(), driverApi.me()]);
      setStatus(st);
      setDocs(d.documents);
      const id = me.profile.identity || {};
      setIdentity({ legalName: id.legalName || '', dateOfBirth: id.dateOfBirth ? id.dateOfBirth.slice(0, 10) : '', licenseNumber: id.licenseNumber || '' });
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const run = async (name, fn, okText) => {
    setBusy(name);
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (okText) setNotice(okText);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  if (!status) return <p className="p-6 text-fog">{error || 'Loading…'}</p>;
  const current = (type) => docs.find((d) => d.type === type && ['SUBMITTED', 'ACCEPTED'].includes(d.status));
  const rejected = (type) => docs.find((d) => d.type === type && d.status === 'REJECTED');
  const types = [...status.requiredDocuments, ...status.optionalDocuments];

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="sign text-5xl">{STATUS_TEXT[status.approvalStatus]}</h1>
      {status.approvalStatus === 'APPROVED' && (
        <p className="mt-2">
          You can go online from the <Link to="/driver" className="font-semibold underline">Drive</Link> tab.
        </p>
      )}
      {status.approvalStatus === 'PENDING_REVIEW' && <p className="mt-2">Submitted {formatDateTime(status.submittedAt)}. We will let you know when an administrator has reviewed it.</p>}
      {status.rejectionReason && (
        <p className="mt-3 rounded-md border border-brake bg-white p-3 text-sm" role="alert">
          <span className="font-semibold">Reason: </span>
          {status.rejectionReason}
        </p>
      )}
      {error && <p role="alert" className="mt-3 rounded-md border border-brake bg-white p-3 text-sm text-brake">{error}</p>}
      {notice && <p role="status" className="mt-3 rounded-md border border-kerb bg-white p-3 text-sm">{notice}</p>}

      <section className="mt-8">
        <h2 className="text-xl font-bold">Identity details</h2>
        <p className="text-sm text-fog">We never ask for or store your Aadhaar or PAN number, only the document image for review.</p>
        <form
          className="mt-3 grid gap-3 sm:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault();
            run('identity', () => driverApi.updateIdentity(identity), 'Identity details saved.');
          }}
        >
          <div className="sm:col-span-3">
            <label className="label" htmlFor="legalName">Full name as on licence</label>
            <input id="legalName" className="field" disabled={!status.canUpload} value={identity.legalName} onChange={(e) => setIdentity({ ...identity, legalName: e.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor="dob">Date of birth</label>
            <input id="dob" type="date" className="field" disabled={!status.canUpload} value={identity.dateOfBirth} onChange={(e) => setIdentity({ ...identity, dateOfBirth: e.target.value })} />
          </div>
          <div className="sm:col-span-2">
            <label className="label" htmlFor="licence">Driving licence number</label>
            <input id="licence" className="field uppercase" disabled={!status.canUpload} value={identity.licenseNumber} onChange={(e) => setIdentity({ ...identity, licenseNumber: e.target.value })} />
          </div>
          {status.canUpload && (
            <button className="btn-quiet sm:col-span-3" disabled={busy === 'identity'}>{busy === 'identity' ? 'Saving…' : 'Save identity details'}</button>
          )}
        </form>
      </section>

      <section className="mt-8">
        <h2 className="text-xl font-bold">Documents</h2>
        <p className="text-sm text-fog">JPEG, PNG or PDF, up to {Math.round(status.maxUploadBytes / 1024 / 1024)} MB each.</p>
        <ul className="mt-3 divide-y divide-line border-y border-line">
          {types.map((type) => {
            const cur = current(type);
            const rej = rejected(type);
            return (
              <li key={type} className="py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-medium">
                      {DOC_LABELS[type]} {status.requiredDocuments.includes(type) ? '' : <span className="text-fog">(optional)</span>}
                    </p>
                    <p className="text-sm text-fog">
                      {cur ? `${cur.status === 'ACCEPTED' ? 'Accepted' : 'Uploaded'} ${formatDateTime(cur.createdAt)}` : rej ? `Rejected: ${rej.rejectionReason || 'please upload again'}` : 'Not uploaded'}
                    </p>
                  </div>
                  {status.canUpload && (
                    <label className="btn-quiet cursor-pointer px-3 py-1 text-sm">
                      {busy === type ? 'Uploading…' : cur ? 'Replace' : 'Upload'}
                      <input
                        type="file"
                        accept="image/jpeg,image/png,application/pdf"
                        className="sr-only"
                        aria-label={`Upload ${DOC_LABELS[type]}`}
                        disabled={Boolean(busy)}
                        onChange={(e) => {
                          const file = e.target.files && e.target.files[0];
                          e.target.value = '';
                          if (file) run(type, () => driverApi.uploadDocument(type, file), `${DOC_LABELS[type]} uploaded.`);
                        }}
                      />
                    </label>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      {status.canUpload && (
        <section className="mt-8">
          {!status.canSubmit && (
            <p className="text-sm text-fog">
              {status.identityComplete ? '' : 'Save your identity details. '}
              {status.missingDocuments.length ? `Still needed: ${status.missingDocuments.map((t) => DOC_LABELS[t]).join(', ')}.` : ''}
            </p>
          )}
          <button
            type="button"
            className="btn-primary mt-2 w-full"
            disabled={!status.canSubmit || busy === 'submit'}
            onClick={() => run('submit', () => driverApi.submitForReview(), 'Submitted for review.')}
          >
            {busy === 'submit' ? 'Submitting…' : 'Submit for review'}
          </button>
        </section>
      )}

      <section className="mt-10 rounded-md border border-line bg-white p-4">
        <h2 className="font-bold">Women-driver programme (optional)</h2>
        <p className="mt-1 text-sm">
          Passengers can ask for a woman driver. To receive those rides, ask to join; an administrator verifies eligibility using your submitted documents. We never
          decide this from your name or photo, and passengers never see this setting.
        </p>
        <p className="mt-2 text-sm">
          <span className="font-semibold">Status: </span>
          {{ NOT_REQUESTED: 'Not requested', PENDING: 'Waiting for verification', VERIFIED: 'Verified', REJECTED: 'Not verified' }[status.femaleDriverProgram.status]}
        </p>
        <div className="mt-3 flex gap-2">
          {['NOT_REQUESTED', 'REJECTED'].includes(status.femaleDriverProgram.status) && (
            <button type="button" className="btn-quiet" disabled={busy === 'fp'} onClick={() => run('fp', () => driverApi.femaleProgram('REQUEST'), 'Request sent.')}>
              I am a woman driver and want to join
            </button>
          )}
          {['PENDING', 'VERIFIED'].includes(status.femaleDriverProgram.status) && (
            <button type="button" className="btn-quiet" disabled={busy === 'fp'} onClick={() => run('fp', () => driverApi.femaleProgram('WITHDRAW'), 'You have left the programme.')}>
              Leave the programme
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
