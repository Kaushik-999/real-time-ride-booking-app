import { useEffect, useState } from 'react';
import { errorMessage, rideApi } from '../services/api';

function Stars({ name, value, onChange, label }) {
  return (
    <fieldset>
      <legend className="label">{label}</legend>
      <div className="flex gap-1" role="radiogroup" aria-label={label}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={value === n}
            aria-label={`${n} star${n > 1 ? 's' : ''}`}
            onClick={() => onChange(n)}
            className={`h-10 w-10 rounded-md border text-xl ${n <= (value || 0) ? 'border-asphalt bg-rickshaw' : 'border-line bg-white text-fog'}`}
            data-name={name}
          >
            ★
          </button>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * Rate the other person after a completed ride. Passengers can also rate
 * the vehicle/service. Shows the existing review instead of the form if
 * one was already submitted.
 */
export default function ReviewForm({ ride, myRole }) {
  const [existing, setExisting] = useState(undefined);
  const [rating, setRating] = useState(null);
  const [serviceRating, setServiceRating] = useState(null);
  const [comment, setComment] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!ride || ride.status !== 'COMPLETED') return;
    rideApi
      .myReview(ride.id)
      .then((d) => setExisting(d.review))
      .catch(() => setExisting(null));
  }, [ride && ride.id, ride && ride.status]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!ride || ride.status !== 'COMPLETED' || existing === undefined) return null;
  if (existing) {
    return (
      <p className="mt-5 text-sm" data-testid="review-done">
        You rated this ride {existing.rating} out of 5. Thank you.
      </p>
    );
  }
  const who = myRole === 'PASSENGER' ? 'your driver' : 'your passenger';
  const submit = async (e) => {
    e.preventDefault();
    if (!rating) {
      setError(`Choose a rating for ${who}.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body = { rating, ...(comment.trim() ? { comment: comment.trim() } : {}) };
      if (myRole === 'PASSENGER' && serviceRating) body.serviceRating = serviceRating;
      const data = await rideApi.review(ride.id, body);
      setExisting(data.review);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="mt-5 space-y-3 rounded-md border border-line bg-white p-3" aria-label="Rate this ride">
      <Stars name="rating" label={`Rate ${who}`} value={rating} onChange={setRating} />
      {myRole === 'PASSENGER' && <Stars name="service" label="Rate the vehicle and service (optional)" value={serviceRating} onChange={setServiceRating} />}
      <div>
        <label htmlFor="review-comment" className="label">
          Comment (optional)
        </label>
        <textarea id="review-comment" className="field" rows={2} maxLength={500} value={comment} onChange={(e) => setComment(e.target.value)} />
      </div>
      {error && (
        <p role="alert" className="text-sm text-brake">
          {error}
        </p>
      )}
      <button type="submit" className="btn-dark w-full" disabled={busy}>
        {busy ? 'Sending…' : 'Submit rating'}
      </button>
    </form>
  );
}
