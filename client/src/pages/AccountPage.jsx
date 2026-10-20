import { useCallback, useEffect, useState } from 'react';
import GoogleSignIn from '../components/GoogleSignIn';
import { useAuth } from '../context/AuthContext';
import { authApi, errorMessage, reviewsApi } from '../services/api';
import { formatDateTime } from '../utils/format';

/** Sign-in methods (explicit Google linking) and ratings received / given. */
export default function AccountPage() {
  const { user, refreshProfile } = useAuth();
  const [providers, setProviders] = useState(null);
  const [received, setReceived] = useState(null);
  const [given, setGiven] = useState(null);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    authApi.providers().then(setProviders).catch(() => {});
    reviewsApi.received().then(setReceived).catch((e) => setError(errorMessage(e)));
    reviewsApi.given().then(setGiven).catch(() => {});
  }, []);

  const onGoogle = useCallback(
    async (credential) => {
      setError(null);
      try {
        const r = await authApi.linkGoogle(credential);
        setMessage(r.alreadyLinked ? 'This Google account is already linked.' : 'Google is now linked. You can use it to sign in.');
        await refreshProfile();
      } catch (err) {
        setError(errorMessage(err));
      }
    },
    [refreshProfile]
  );

  const googleLinked = user && (user.authProviders || []).some((p) => p.provider === 'google');
  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="sign text-5xl">Account</h1>
      {error && <p role="alert" className="mt-3 text-brake">{error}</p>}
      {message && <p role="status" className="mt-3">{message}</p>}

      <section className="mt-6">
        <h2 className="text-xl font-bold">Sign-in methods</h2>
        <ul className="mt-2 space-y-1 text-sm">
          <li>Email: {user && user.email}</li>
          <li>Phone: {user && user.phone ? `${user.phone}${user.phoneVerifiedAt ? ' (verified)' : ' (not yet verified)'}` : 'not added'}</li>
          <li>Google: {googleLinked ? 'linked' : 'not linked'}</li>
        </ul>
        {providers && providers.google && !googleLinked && (
          <div className="mt-3">
            <p className="mb-2 text-sm text-fog">Linking needs you to sign in to Google now. We never link accounts just because the email matches.</p>
            <GoogleSignIn clientId={providers.googleClientId} onCredential={onGoogle} />
          </div>
        )}
      </section>

      <section className="mt-8">
        <h2 className="text-xl font-bold">Your rating</h2>
        {received && (
          <>
            <p className="sign text-6xl">{received.summary.count ? `★ ${received.summary.average}` : 'No ratings yet'}</p>
            {received.summary.count > 0 && <p className="text-sm text-fog">from {received.summary.count} rating{received.summary.count > 1 ? 's' : ''}</p>}
            <ul className="mt-4 divide-y divide-line border-y border-line">
              {received.items.map((r, i) => (
                <li key={i} className="py-3 text-sm">
                  <span className="font-semibold">{'★'.repeat(r.rating)}</span>
                  <span className="text-fog"> {formatDateTime(r.createdAt)}</span>
                  {r.comment && <p className="mt-1">{r.comment}</p>}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-fog">Ratings are anonymous: you see what was said, not who said it.</p>
          </>
        )}
      </section>

      <section className="mt-8">
        <h2 className="text-xl font-bold">Ratings you gave</h2>
        {given && given.items.length === 0 && <p className="text-sm text-fog">None yet. You can rate each completed ride from its page.</p>}
        <ul className="mt-2 divide-y divide-line border-y border-line">
          {given &&
            given.items.map((r) => (
              <li key={r.id} className="py-3 text-sm">
                <span className="font-semibold">{'★'.repeat(r.rating)}</span>
                <span className="text-fog"> {formatDateTime(r.createdAt)}</span>
                {r.status === 'HIDDEN' && <span className="text-fog"> (hidden by moderators)</span>}
                {r.comment && <p className="mt-1">{r.comment}</p>}
              </li>
            ))}
        </ul>
      </section>
    </div>
  );
}
