import { useEffect, useRef, useState } from 'react';

const SCRIPT = 'https://accounts.google.com/gsi/client';

function loadScript() {
  if (window.google && window.google.accounts) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${SCRIPT}"]`);
    const el = existing || document.createElement('script');
    el.addEventListener('load', resolve, { once: true });
    el.addEventListener('error', reject, { once: true });
    if (!existing) {
      el.src = SCRIPT;
      el.async = true;
      document.head.appendChild(el);
    }
  });
}

/**
 * "Sign in with Google" using Google Identity Services. Google returns an ID
 * token (credential) which we send to OUR server; the server verifies its
 * signature, issuer, audience and expiry before trusting anything in it.
 * Rendered only when the server reports a Google client id.
 */
export default function GoogleSignIn({ clientId, onCredential }) {
  const ref = useRef(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!clientId) return;
    let cancelled = false;
    loadScript()
      .then(() => {
        if (cancelled || !ref.current) return;
        window.google.accounts.id.initialize({ client_id: clientId, callback: (resp) => onCredential(resp.credential) });
        window.google.accounts.id.renderButton(ref.current, { theme: 'outline', size: 'large', width: 320, text: 'continue_with' });
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [clientId, onCredential]);
  if (!clientId) return null;
  return failed ? <p className="text-sm text-fog">Google sign-in could not load. Use email or phone instead.</p> : <div ref={ref} data-testid="google-button" />;
}
