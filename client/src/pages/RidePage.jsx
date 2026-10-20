import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import MapView from '../components/MapView';
import RideStatus from '../components/RideStatus';
import TripCodeCard from '../components/TripCodeCard';
import ChatPanel from '../components/ChatPanel';
import SafetyButton from '../components/SafetyButton';
import ReviewForm from '../components/ReviewForm';
import { MapLayout } from '../components/AppShell';
import { useAuth } from '../context/AuthContext';
import { useRideTracking } from '../hooks/useRideTracking';
import { errorMessage, rideApi, safetyApi } from '../services/api';
import { DRIVER_ATTACHED, newRequestKey } from '../utils/format';

// Mirrors the server's default rings (MATCH_* env vars) for display only.
export const SEARCH_RINGS_KM = [3, 6, 9, 12];
const CANCELLABLE = ['SEARCHING', 'DRIVER_ASSIGNED', 'DRIVER_ARRIVED'];

export default function RidePage() {
  const { rideId } = useParams();
  const { socket, user } = useAuth();
  const navigate = useNavigate();
  const { ride, setRide, error, loading, refresh } = useRideTracking(rideId, socket);
  const [emergencyNumber, setEmergencyNumber] = useState('112');
  useEffect(() => {
    safetyApi.config().then((c) => setEmergencyNumber(c.emergencyNumber)).catch(() => {});
  }, []);
  const isPassenger = user && user.role === 'PASSENGER';

  // Book again with the same trip, explicitly choosing the driver preference.
  const rebook = (driverPreference) =>
    act('rebook', async () => {
      const result = await rideApi.create({
        pickup: ride.pickup,
        destination: ride.destination,
        vehicleType: ride.vehicleType,
        passengerCount: ride.passengerCount || 1,
        paymentMethod: ride.paymentMethod,
        driverPreference,
        requestKey: newRequestKey(),
      });
      navigate(`/ride/${result.ride.id}`);
      return null;
    });
  const [busy, setBusy] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const act = async (name, fn) => {
    setBusy(name);
    setActionError(null);
    try {
      const data = await fn();
      if (data && data.ride) setRide(data.ride);
      else await refresh();
    } catch (err) {
      setActionError(errorMessage(err));
      refresh();
    } finally {
      setBusy(null);
      setConfirmCancel(false);
    }
  };

  const driverPos = ride && DRIVER_ATTACHED.includes(ride.status) ? ride.driverLocation : null;
  const map = (
    <MapView
      pickup={ride && ride.pickup}
      destination={ride && ride.destination}
      driver={driverPos}
      searchRings={ride && ride.status === 'SEARCHING' ? { radiiKm: SEARCH_RINGS_KM, activeKm: ride.matchingRadiusKm || SEARCH_RINGS_KM[0] } : null}
    />
  );

  return (
    <MapLayout map={map}>
      {loading && !ride && <p className="text-fog">Loading your ride…</p>}
      {error && !ride && (
        <div role="alert">
          <p className="font-semibold text-brake">{error}</p>
          <button type="button" className="btn-quiet mt-3" onClick={refresh}>Try again</button>
        </div>
      )}
      {ride && (
        <>
          <RideStatus ride={ride} />
          {isPassenger && <TripCodeCard ride={ride} socket={socket} />}
          {error && <p className="mt-3 text-sm text-fog">Showing the last known state. {error}</p>}
          {driverPos && driverPos.fresh === false && <p className="mt-3 text-sm text-fog">Driver location is a little out of date.</p>}
          {actionError && <p role="alert" className="mt-4 rounded-md border border-brake bg-white p-3 text-sm text-brake">{actionError}</p>}

          <div className="mt-6 flex flex-wrap gap-2">
            {ride.payment && ride.payment.method === 'ONLINE' && ['PENDING', 'FAILED'].includes(ride.payment.status) && (
              <button type="button" className="btn-primary flex-1" disabled={busy === 'pay'} onClick={() => act('pay', () => rideApi.pay(ride.id))}>
                {busy === 'pay' ? 'Paying…' : 'Pay now'}
              </button>
            )}
            {CANCELLABLE.includes(ride.status) &&
              (confirmCancel ? (
                <div className="w-full rounded-md border border-brake bg-white p-3">
                  <p className="mb-3 text-sm">Cancel this ride?</p>
                  <div className="flex gap-2">
                    <button type="button" className="btn-danger flex-1" disabled={busy === 'cancel'} onClick={() => act('cancel', () => rideApi.cancel(ride.id))}>
                      {busy === 'cancel' ? 'Cancelling…' : 'Cancel ride'}
                    </button>
                    <button type="button" className="btn-quiet flex-1" onClick={() => setConfirmCancel(false)}>Keep ride</button>
                  </div>
                </div>
              ) : (
                <button type="button" className="btn-danger" onClick={() => setConfirmCancel(true)}>Cancel ride</button>
              ))}
            {isPassenger && ride.status === 'NO_DRIVER_FOUND' && ride.noDriverReason === 'PREFERENCE_UNAVAILABLE' && (
              <div className="w-full space-y-2" aria-label="Choose what to do next">
                <button type="button" className="btn-dark w-full" disabled={busy === 'rebook'} onClick={() => rebook('FEMALE_ONLY')}>
                  Search again for women drivers
                </button>
                <button type="button" className="btn-quiet w-full" disabled={busy === 'rebook'} onClick={() => rebook('ANY')}>
                  Book with any eligible driver instead
                </button>
              </div>
            )}
            {['COMPLETED', 'CANCELLED', 'NO_DRIVER_FOUND'].includes(ride.status) && (
              <Link to="/" className="btn-dark flex-1">Book another ride</Link>
            )}
          </div>
          {isPassenger && ride.driverId && <ChatPanel ride={ride} socket={socket} myRole="PASSENGER" />}
          {isPassenger && <SafetyButton ride={ride} emergencyNumber={emergencyNumber} />}
          {isPassenger && <ReviewForm ride={ride} myRole="PASSENGER" />}
        </>
      )}
    </MapLayout>
  );
}
