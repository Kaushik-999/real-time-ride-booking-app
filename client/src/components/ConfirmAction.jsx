import { useState } from 'react';
import { errorMessage } from '../services/api';

/**
 * A button that asks for confirmation (and optionally a reason) before
 * running an important or destructive admin action.
 */
export default function ConfirmAction({ label, confirmLabel, prompt, onConfirm, requireReason = false, danger = false, className = '' }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  if (!open) {
    return (
      <button type="button" className={`${danger ? 'btn-danger' : 'btn-quiet'} px-3 py-1 text-sm ${className}`} onClick={() => setOpen(true)}>
        {label}
      </button>
    );
  }
  const ok = !requireReason || reason.trim().length >= 3;
  return (
    <div className="mt-2 rounded-md border border-line bg-white p-3 text-sm" role="group" aria-label={prompt}>
      <p className="font-medium">{prompt}</p>
      {requireReason && (
        <>
          <label className="label mt-2" htmlFor={`reason-${label}`}>
            Reason (required)
          </label>
          <input id={`reason-${label}`} className="field" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
        </>
      )}
      {error && (
        <p role="alert" className="mt-1 text-brake">
          {error}
        </p>
      )}
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          className={`${danger ? 'btn bg-brake text-white' : 'btn-dark'} px-3 py-1 text-sm`}
          disabled={!ok || busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await onConfirm(reason.trim() || undefined);
              setOpen(false);
              setReason('');
            } catch (err) {
              setError(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Working…' : confirmLabel || label}
        </button>
        <button type="button" className="btn-quiet px-3 py-1 text-sm" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
