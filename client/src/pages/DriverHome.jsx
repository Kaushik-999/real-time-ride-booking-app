import { useCallback, useEffect, useState } from 'react';
import MapView from '../components/MapView';
import OfferCard from '../components/OfferCard';
import OtpEntry from '../components/OtpEntry';
import ChatPanel from '../components/ChatPanel';
import SafetyButton from '../components/SafetyButton';
import ReviewForm from '../components/ReviewForm';
import { Link } from 'react-router-dom';
import { MapLayout } from '../components/AppShell';
import { useAuth } from '../context/AuthContext';
import { useLocationReporter } from '../hooks/useLocationReporter';
import { driverApi, errorMessage, rideApi } from '../services/api';
import { STATUS_TEXT, formatMoney } from '../utils/format';

const RIDE_EVENTS = ['ride:driver-assigned', 'ride:cancelled', 'ride:completed', 'ride:started', 'ride:driver-arrived'];
const NEXT_STEP = {
  DRIVER_ASSIGNED: { action: 'arrive', label: "I've arrived at pickup" },
  DRIVER_ARRIVED: { action: 'start', label: 'Start trip', code: "Passenger's pickup code" },
  IN_PROGRESS: { action: 'complete', label: 'Complete trip', code: "Passenger's drop-off code" },
};

export default function DriverHome() {
  const { socket } = useAuth();
  const [profile, setProfile] = useState(null);
  const [offers, setOffers] = useState([]);
  const [ride, setRide] = useState(null);
  const [finished, setFinished] = useState(null);
  const [position, setPosition] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  const online = profile && profile.availability !== 'OFFLINE';
  const reporter = useLocationReporter(Boolean(online), position);

  const reload = useCallback(async () => {
    try {
      const [p, o, a] = await Promise.all([driverApi.me(), driverApi.offers(), driverApi.activeRide()]);
      setProfile(p.profile);
      setOffers(o.offers);
      setRide(a.ride);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  // Socket events only trigger a re-fetch; the server decides what is true.
  useEffect(() => {
    if (!socket) return undefined;
    const events = ['driver:offer', 'driver:offer-expired', 'connect', ...RIDE_EVENTS];
    events.forEach((e) => socket.on(e, reload));
    return () => events.forEach((e) => socket.off(e, reload));
  }, [socket, reload]);

  // Safety net for missed events while online.
  useEffect(() => {
    if (!online) return undefined;
    const t = setInterval(reload, 8000);
    return () => clearInterval(t);
  }, [online, reload]);

  const run = async (name, fn) => {
    setBusy(name);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(errorMessage(err));
      return null;
    } finally {
      setBusy(null);
      reload();
    }
  };

  const toggleOnline = () =>
    run('toggle', async () => {
      const next = online ? 'OFFLINE' : 'AVAILABLE';
      const r = await driverApi.setAvailability(next);
      setProfile(r.profile);
    });

  const accept = (offer) => run('accept', () => driverApi.accept(offer.id));
  const reject = (offer) => run('reject', () => driverApi.reject(offer.id));
  const [codeError, setCodeError] = useState(null);
  const step = async (action, otp) => {
    setCodeError(null);
    setBusy(action);
    setError(null);
    try {
      const r = await rideApi[action](ride.id, otp);
      if (action === 'complete') setFinished(r.ride);
    } catch (err) {
      // Wrong / expired codes are shown next to the code box.
      if (otp) setCodeError(errorMessage(err));
      else setError(errorMessage(err));
    } finally {
      setBusy(null);
      reload();
    }
  };

  if (!profile) return <p className="p-6 text-fog">{error || 'Loading…'}</p>;

  const approved = profile.approvalStatus === 'APPROVED';
  const next = ride && NEXT_STEP[ride.status];
  const map = (
    <MapView
      self={position || reporter.position}
      pickup={ride ? ride.pickup : offers[0] && offers[0].ride ? { lat: offers[0].ride.pickup.location.coordinates[1], lng: offers[0].ride.pickup.location.coordinates[0] } : null}
      destination={ride && !ride.destinationHidden ? ride.destination : null}
      onPick={setPosition}
    />
  );

  return (
    <MapLayout map={map}>
      {!approved && (
        <div className="mb-4 rounded-md border border-line bg-white p-3 text-sm" data-testid="onboarding-banner">
          {
            {
              DOCUMENTS_REQUIRED: 'Add your identity details and documents to start driving.',
              PENDING_REVIEW: 'Your documents are waiting for review. You can go online once an administrator approves them.',
              REJECTED: 'Your application needs changes before you can drive.',
              SUSPENDED: 'Your driver account is suspended. Contact support.',
            }[profile.approvalStatus]
          }{' '}
          <Link to="/driver/onboarding" className="font-semibold underline">
            {profile.approvalStatus === 'PENDING_REVIEW' ? 'View application' : 'Open application'}
          </Link>
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <h1 className={`sign text-5xl ${online ? 'text-kerb' : 'text-fog'}`}>{online ? (ride ? 'On a ride' : 'Online') : 'Offline'}</h1>
        {!ride && profile.availability !== 'RESERVED' && (
          <button type="button" className={online ? 'btn-quiet' : 'btn-primary'} disabled={!approved || busy === 'toggle' || (!online && !position && !reporter.useGps)} onClick={toggleOnline}>
            {online ? 'Go offline' : 'Go online'}
          </button>
        )}
      </div>
      <p className="mt-1 text-sm text-fog">
        {profile.vehicle.type} {profile.vehicle.registrationNumber}
        {reporter.lastSentAt ? `. Location sent ${reporter.lastSentAt.toLocaleTimeString()}` : ''}
      </p>

      {!position && !reporter.useGps && (
        <div className="mt-4 rounded-md border border-line bg-white p-3 text-sm">
          <p className="mb-2">Set your position to receive ride offers: tap the map, or use this device&apos;s location.</p>
          <button type="button" className="btn-quiet" onClick={() => reporter.setUseGps(true)}>Use my location</button>
        </div>
      )}
      {(reporter.error || error) && <p role="alert" className="mt-3 rounded-md border border-brake bg-white p-3 text-sm text-brake">{error || reporter.error}</p>}

      <div className="mt-5 space-y-3">
        {offers.map((o) => (
          <OfferCard key={o.id} offer={o} onAccept={accept} onReject={reject} busy={busy === 'accept' || busy === 'reject' ? busy : null} />
        ))}
      </div>

      {ride && (
        <section className="mt-5 rounded-md border-2 border-asphalt bg-white p-4">
          <h2 className="sign text-3xl">{STATUS_TEXT[ride.status]}</h2>
          <p className="mt-2 text-sm"><span className="font-semibold">Passenger:</span> {ride.passenger && ride.passenger.name}</p>
          <p className="text-sm"><span className="font-semibold">Pickup:</span> {ride.pickup.address}</p>
          <p className="text-sm" data-testid="driver-destination">
            <span className="font-semibold">Drop:</span>{' '}
            {ride.destinationHidden || !ride.destination ? 'shown after you enter the passenger\'s pickup code' : ride.destination.address}
          </p>
          <p className="text-sm"><span className="font-semibold">Riders:</span> {ride.passengerCount || 1}</p>
          <p className="text-sm"><span className="font-semibold">Estimated fare:</span> {formatMoney(ride.estimatedFare, ride.currency)} ({ride.paymentMethod === 'CASH' ? 'cash' : 'online'})</p>
          {ride.status === 'IN_PROGRESS' && <p className="mt-2 text-xs text-fog">Keep your position updating during the trip; the final fare uses the distance you actually drive.</p>}
          {next && !next.code && (
            <button type="button" className="btn-dark mt-4 w-full" disabled={Boolean(busy)} onClick={() => step(next.action)}>
              {busy === next.action ? 'Saving…' : next.label}
            </button>
          )}
          {next && next.code && (
            <OtpEntry key={next.action} label={next.code} actionLabel={next.label} busy={busy === next.action} error={codeError} onSubmit={(code) => step(next.action, code)} />
          )}
          <ChatPanel ride={ride} socket={socket} myRole="DRIVER" />
          <SafetyButton ride={ride} />
        </section>
      )}

      {finished && !ride && (
        <section className="mt-5 rounded-md border border-kerb bg-white p-4">
          <h2 className="sign text-3xl text-kerb">Trip complete</h2>
          <p className="mt-1 text-2xl font-bold">{formatMoney(finished.finalFare, finished.currency)}</p>
          {finished.paymentMethod === 'CASH' && (
            <button type="button" className="btn-dark mt-3 w-full" disabled={busy === 'cash'} onClick={() => run('cash', async () => { await rideApi.cashCollected(finished.id); setFinished(null); })}>
              {busy === 'cash' ? 'Saving…' : 'Cash collected'}
            </button>
          )}
          {finished.paymentMethod !== 'CASH' && <button type="button" className="btn-quiet mt-3 w-full" onClick={() => setFinished(null)}>Done</button>}
          <ReviewForm ride={finished} myRole="DRIVER" />
        </section>
      )}

      {online && !ride && offers.length === 0 && <p className="mt-6 text-fog">Waiting for ride requests near you.</p>}
    </MapLayout>
  );
}
