import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import GoogleSignIn from '../components/GoogleSignIn';
import { authApi, errorMessage } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { homeFor } from '../components/AppShell';

function AuthFrame({ title, children, footer }) {
  return (
    <div className="grid min-h-full place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <p className="sign mb-8 text-6xl">Ride</p>
        <h1 className="mb-6 text-2xl font-bold">{title}</h1>
        {children}
        <p className="mt-6 text-sm text-fog">{footer}</p>
      </div>
    </div>
  );
}

function PhoneLogin({ onSignedIn }) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const request = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setSent(await authApi.requestOtp(phone));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const verify = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await authApi.verifyOtp(phone, code));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (!sent) {
    return (
      <form onSubmit={request} className="space-y-4">
        <div>
          <label htmlFor="phone" className="label">Mobile number</label>
          <input id="phone" type="tel" autoComplete="tel" required className="field" placeholder="98765 43210" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
        {error && <p role="alert" className="text-sm text-brake">{error}</p>}
        <button className="btn-dark w-full" disabled={busy}>{busy ? 'Sending…' : 'Send code'}</button>
      </form>
    );
  }
  return (
    <form onSubmit={verify} className="space-y-4">
      <p className="text-sm">{sent.message}</p>
      {sent.delivery === 'DEV_OUTBOX_NOT_SENT' && (
        <p className="rounded-md border border-line bg-white p-2 text-xs" data-testid="dev-outbox-note">
          Development mode: no SMS was sent. Read the code with <code>npm run dev:outbox</code> on the server.
        </p>
      )}
      <div>
        <label htmlFor="otp" className="label">6-digit code</label>
        <input id="otp" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required className="field tracking-[0.3em]" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
      </div>
      {error && <p role="alert" className="text-sm text-brake">{error}</p>}
      <button className="btn-dark w-full" disabled={busy || code.length !== 6}>{busy ? 'Checking…' : 'Sign in'}</button>
      <button type="button" className="text-sm underline" onClick={() => { setSent(null); setCode(''); }}>Use a different number</button>
    </form>
  );
}

export function LoginPage() {
  const { signIn, user } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState('email');
  const [providers, setProviders] = useState(null);
  const [form, setForm] = useState({ email: '', password: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    authApi.providers().then(setProviders).catch(() => setProviders({ password: true }));
  }, []);

  const finish = useCallback(
    (result) => {
      signIn(result);
      navigate(homeFor(result.user.role), { replace: true });
    },
    [signIn, navigate]
  );
  const onGoogle = useCallback(
    async (credential) => {
      setError(null);
      try {
        finish(await authApi.google(credential));
      } catch (err) {
        setError(errorMessage(err));
      }
    },
    [finish]
  );
  if (user) return <Navigate to={homeFor(user.role)} replace />;

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      finish(await authApi.login(form));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame title="Sign in" footer={<>New here? <Link to="/register" className="font-semibold text-asphalt underline">Create an account</Link></>}>
      {providers && providers.phoneOtp && (
        <div className="mb-5 grid grid-cols-2 rounded-md border border-line bg-white p-1" role="tablist" aria-label="Sign-in method">
          {[['email', 'Email'], ['phone', 'Phone code']].map(([value, label]) => (
            <button key={value} type="button" role="tab" aria-selected={mode === value} onClick={() => { setMode(value); setError(null); }} className={`rounded px-3 py-2 text-sm font-semibold ${mode === value ? 'bg-asphalt text-chalk' : ''}`}>
              {label}
            </button>
          ))}
        </div>
      )}
      {mode === 'phone' ? (
        <PhoneLogin onSignedIn={finish} />
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label htmlFor="email" className="label">Email</label>
            <input id="email" type="email" autoComplete="email" required className="field" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </div>
          <div>
            <label htmlFor="password" className="label">Password</label>
            <input id="password" type="password" autoComplete="current-password" required className="field" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </div>
          {error && <p role="alert" className="text-sm text-brake">{error}</p>}
          <button className="btn-dark w-full" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
      )}
      {providers && providers.google && (
        <div className="mt-6 border-t border-line pt-5">
          <GoogleSignIn clientId={providers.googleClientId} onCredential={onGoogle} />
          {mode === 'phone' && error && <p role="alert" className="mt-2 text-sm text-brake">{error}</p>}
        </div>
      )}
    </AuthFrame>
  );
}

export function RegisterPage() {
  const { signIn, user } = useAuth();
  const navigate = useNavigate();
  const [role, setRole] = useState('PASSENGER');
  const [form, setForm] = useState({ name: '', email: '', phone: '', password: '' });
  const [vehicle, setVehicle] = useState({ type: 'CAR', registrationNumber: '', model: '', color: '', capacity: '' });
  const [identity, setIdentity] = useState({ legalName: '', dateOfBirth: '', licenseNumber: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  if (user) return <Navigate to={homeFor(user.role)} replace />;

  const submit = async (e) => {
    e.preventDefault();
    if (form.password.length < 8 || !/\d/.test(form.password) || !/[A-Za-z]/.test(form.password)) {
      setError('Use at least 8 characters with a letter and a number.');
      return;
    }
    setBusy(true);
    setError(null);
    const body = { name: form.name, email: form.email, password: form.password, role };
    if (form.phone.trim()) body.phone = form.phone.trim();
    if (role === 'DRIVER') {
      body.vehicle = { type: vehicle.type, registrationNumber: vehicle.registrationNumber };
      if (vehicle.model.trim()) body.vehicle.model = vehicle.model.trim();
      if (vehicle.color.trim()) body.vehicle.color = vehicle.color.trim();
      if (vehicle.capacity) body.vehicle.capacity = Number(vehicle.capacity);
      body.identity = { legalName: identity.legalName.trim(), dateOfBirth: identity.dateOfBirth, licenseNumber: identity.licenseNumber.trim() };
    }
    try {
      const result = await authApi.register(body);
      signIn(result);
      navigate(result.user.role === 'DRIVER' ? '/driver/onboarding' : homeFor(result.user.role), { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const setV = (k) => (e) => setVehicle({ ...vehicle, [k]: e.target.value });

  return (
    <AuthFrame title="Create an account" footer={<>Already registered? <Link to="/login" className="font-semibold text-asphalt underline">Sign in</Link></>}>
      <div className="mb-5 grid grid-cols-2 rounded-md border border-line bg-white p-1" role="radiogroup" aria-label="Account type">
        {[
          ['PASSENGER', 'I need rides'],
          ['DRIVER', 'I want to drive'],
        ].map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={role === value}
            onClick={() => setRole(value)}
            className={`rounded px-3 py-2 text-sm font-semibold ${role === value ? 'bg-asphalt text-chalk' : ''}`}
          >
            {label}
          </button>
        ))}
      </div>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label htmlFor="name" className="label">Full name</label>
          <input id="name" required className="field" value={form.name} onChange={set('name')} />
        </div>
        <div>
          <label htmlFor="email" className="label">Email</label>
          <input id="email" type="email" required className="field" value={form.email} onChange={set('email')} />
        </div>
        <div>
          <label htmlFor="phone" className="label">Phone (optional)</label>
          <input id="phone" type="tel" className="field" value={form.phone} onChange={set('phone')} />
        </div>
        <div>
          <label htmlFor="password" className="label">Password</label>
          <input id="password" type="password" autoComplete="new-password" required className="field" value={form.password} onChange={set('password')} />
          <p className="mt-1 text-xs text-fog">At least 8 characters, with a letter and a number.</p>
        </div>
        {role === 'DRIVER' && (
          <fieldset className="space-y-3 rounded-md border border-line p-3">
            <legend className="px-1 text-sm font-semibold">Your vehicle</legend>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="vtype" className="label">Type</label>
                <select id="vtype" className="field" value={vehicle.type} onChange={setV('type')}>
                  <option value="CAR">Car</option>
                  <option value="CAR_XL">Car XL (6+ seats)</option>
                  <option value="AUTO">Auto</option>
                  <option value="BIKE">Bike</option>
                </select>
              </div>
              <div>
                <label htmlFor="reg" className="label">Registration</label>
                <input id="reg" required className="field uppercase" placeholder="KA01AB1234" value={vehicle.registrationNumber} onChange={setV('registrationNumber')} />
              </div>
              <div>
                <label htmlFor="model" className="label">Model</label>
                <input id="model" className="field" value={vehicle.model} onChange={setV('model')} />
              </div>
              <div>
                <label htmlFor="color" className="label">Colour</label>
                <input id="color" className="field" value={vehicle.color} onChange={setV('color')} />
              </div>
              <div>
                <label htmlFor="capacity" className="label">Passenger seats</label>
                <input id="capacity" type="number" min="1" max="7" className="field" placeholder="Default for type" value={vehicle.capacity} onChange={setV('capacity')} />
              </div>
            </div>
            <div className="space-y-3 border-t border-line pt-3">
              <p className="text-sm font-semibold">Identity (as on your driving licence)</p>
              <div>
                <label htmlFor="legalName" className="label">Full legal name</label>
                <input id="legalName" required className="field" value={identity.legalName} onChange={(e) => setIdentity({ ...identity, legalName: e.target.value })} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="dob" className="label">Date of birth</label>
                  <input id="dob" type="date" required className="field" value={identity.dateOfBirth} onChange={(e) => setIdentity({ ...identity, dateOfBirth: e.target.value })} />
                </div>
                <div>
                  <label htmlFor="licence" className="label">Licence number</label>
                  <input id="licence" required className="field uppercase" value={identity.licenseNumber} onChange={(e) => setIdentity({ ...identity, licenseNumber: e.target.value })} />
                </div>
              </div>
            </div>
            <p className="text-xs text-fog">Next you will upload your documents. An administrator reviews them before you can go online.</p>
          </fieldset>
        )}
        {error && <p role="alert" className="text-sm text-brake">{error}</p>}
        <button className="btn-dark w-full" disabled={busy}>{busy ? 'Creating account…' : 'Create account'}</button>
      </form>
    </AuthFrame>
  );
}
