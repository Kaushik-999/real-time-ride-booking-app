import { useState } from 'react';

/** Driver enters the passenger's 6-digit code. Only digits; submit enabled at 6. */
export default function OtpEntry({ label, actionLabel, busy, onSubmit, error }) {
  const [code, setCode] = useState('');
  const ready = /^\d{6}$/.test(code);
  return (
    <form
      className="mt-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !busy) onSubmit(code);
      }}
    >
      <label htmlFor="trip-otp" className="label">
        {label}
      </label>
      <div className="flex gap-2">
        <input
          id="trip-otp"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          className="field text-center text-2xl tracking-[0.4em]"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? 'trip-otp-error' : undefined}
        />
        <button type="submit" className="btn-dark shrink-0" disabled={!ready || busy}>
          {busy ? 'Checking…' : actionLabel}
        </button>
      </div>
      {error && (
        <p id="trip-otp-error" role="alert" className="mt-1 text-sm text-brake">
          {error}
        </p>
      )}
    </form>
  );
}
