import { useEffect, useRef, useState } from 'react';
import PlaceField from './PlaceField';
import { errorMessage, rideApi, vehiclesApi } from '../services/api';
import { VEHICLE_FALLBACK, formatDistance, formatDuration, formatMoney, newRequestKey, toLatLng } from '../utils/format';

export function validateBooking({ pickup, destination, passengerCount, vehicle }) {
  const errors = {};
  if (vehicle && passengerCount > vehicle.maxPassengers) {
    errors.passengerCount = `A ${vehicle.label} can carry at most ${vehicle.maxPassengers} passenger${vehicle.maxPassengers > 1 ? 's' : ''}.`;
  }
  if (!pickup.address.trim()) errors.pickup = 'Enter a pickup address.';
  else if (!toLatLng(pickup)) errors.pickup = 'Place the pickup on the map or pick a search result.';
  if (!destination.address.trim()) errors.destination = 'Enter a destination address.';
  else if (!toLatLng(destination)) errors.destination = 'Place the destination on the map or pick a search result.';
  if (!errors.pickup && !errors.destination && pickup.lat === destination.lat && pickup.lng === destination.lng) {
    errors.destination = 'Destination must be different from pickup.';
  }
  return errors;
}

const emptyPlace = { address: '', lat: null, lng: null };

/**
 * Passenger booking: choose places, see the server's fare estimate, request.
 * The fare shown is whatever the server returns; the request never sends a
 * price. The requestKey is kept across retries of the same booking so a
 * double-click or network retry cannot create two rides.
 */
export default function BookingForm({ pickup, destination, onPickupChange, onDestinationChange, picking, onPickingChange, onBooked, initial = {} }) {
  const [vehicles, setVehicles] = useState(VEHICLE_FALLBACK);
  const [vehicleType, setVehicleType] = useState(initial.vehicleType || 'CAR');
  const [passengerCount, setPassengerCount] = useState(initial.passengerCount || 1);
  const [driverPreference, setDriverPreference] = useState(initial.driverPreference || 'ANY');
  const [paymentMethod, setPaymentMethod] = useState('CASH');
  const [errors, setErrors] = useState({});
  const [estimate, setEstimate] = useState(null);
  const [estimating, setEstimating] = useState(false);
  const [booking, setBooking] = useState(false);
  const [apiError, setApiError] = useState(null);
  const requestKey = useRef(newRequestKey());

  useEffect(() => {
    vehiclesApi
      .list()
      .then((d) => setVehicles(d.vehicles))
      .catch(() => {}); // fall back to the built-in list; the server still validates
  }, []);
  const vehicle = vehicles.find((v) => v.type === vehicleType) || vehicles[0];
  const maxGroup = Math.max(...vehicles.map((v) => v.maxPassengers));

  // If the group no longer fits the chosen vehicle, move to the first one that fits.
  useEffect(() => {
    if (vehicle && vehicle.maxPassengers < passengerCount) {
      const fit = vehicles.find((v) => v.maxPassengers >= passengerCount);
      if (fit) setVehicleType(fit.type);
    }
  }, [passengerCount, vehicles]); // eslint-disable-line react-hooks/exhaustive-deps

  // Any change to the trip invalidates the estimate and starts a new booking attempt.
  useEffect(() => {
    setEstimate(null);
    requestKey.current = newRequestKey();
  }, [pickup.lat, pickup.lng, destination.lat, destination.lng, vehicleType, paymentMethod, passengerCount, driverPreference]);

  const check = () => {
    const e = validateBooking({ pickup, destination, passengerCount, vehicle });
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const getEstimate = async () => {
    if (!check()) return;
    setEstimating(true);
    setApiError(null);
    try {
      setEstimate(
        await rideApi.estimate({
          pickup: { lat: pickup.lat, lng: pickup.lng },
          destination: { lat: destination.lat, lng: destination.lng },
          vehicleType,
          passengerCount,
        })
      );
    } catch (err) {
      setApiError(errorMessage(err));
    } finally {
      setEstimating(false);
    }
  };

  const requestRide = async (e) => {
    e.preventDefault();
    if (!check() || booking) return;
    setBooking(true);
    setApiError(null);
    try {
      const result = await rideApi.create({
        pickup: { address: pickup.address.trim(), lat: pickup.lat, lng: pickup.lng },
        destination: { address: destination.address.trim(), lat: destination.lat, lng: destination.lng },
        vehicleType,
        passengerCount,
        driverPreference,
        paymentMethod,
        requestKey: requestKey.current,
      });
      onBooked(result.ride);
    } catch (err) {
      setApiError(errorMessage(err));
    } finally {
      setBooking(false);
    }
  };

  return (
    <form onSubmit={requestRide} noValidate className="space-y-4" aria-busy={booking}>
      <PlaceField
        id="pickup"
        label="Pickup"
        value={pickup}
        onChange={onPickupChange}
        picking={picking === 'pickup'}
        onPickOnMap={() => onPickingChange(picking === 'pickup' ? null : 'pickup')}
        error={errors.pickup}
      />
      <PlaceField
        id="destination"
        label="Destination"
        value={destination}
        onChange={onDestinationChange}
        picking={picking === 'destination'}
        onPickOnMap={() => onPickingChange(picking === 'destination' ? null : 'destination')}
        error={errors.destination}
      />

      <div>
        <label htmlFor="riders" className="label">
          Riders
        </label>
        <select id="riders" className="field" value={passengerCount} onChange={(e) => setPassengerCount(Number(e.target.value))}>
          {Array.from({ length: maxGroup }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>
              {n} {n === 1 ? 'person' : 'people'}
            </option>
          ))}
        </select>
        {errors.passengerCount && (
          <p className="mt-1 text-sm text-brake" role="alert">
            {errors.passengerCount}
          </p>
        )}
      </div>

      <fieldset>
        <legend className="label">Vehicle</legend>
        <div className="grid grid-cols-2 gap-2">
          {vehicles.map((v) => {
            const fits = v.maxPassengers >= passengerCount;
            const option = estimate && estimate.options ? estimate.options.find((o) => o.vehicleType === v.type) : null;
            return (
              <label
                key={v.type}
                className={`rounded-md border px-3 py-2 ${!fits ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'} ${vehicleType === v.type ? 'border-asphalt bg-asphalt text-chalk' : 'border-line bg-white'}`}
              >
                <input type="radio" name="vehicle" value={v.type} className="sr-only" checked={vehicleType === v.type} disabled={!fits} onChange={() => setVehicleType(v.type)} />
                <span className="block font-semibold">{v.label}</span>
                <span className="block text-xs opacity-80">
                  Up to {v.maxPassengers}
                  {option ? `, ${formatMoney(option.estimatedFare, estimate.currency)}` : ''}
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <fieldset>
        <legend className="label">Driver</legend>
        <div className="space-y-1 text-sm">
          <label className="flex items-start gap-2">
            <input type="radio" name="pref" value="ANY" checked={driverPreference === 'ANY'} onChange={() => setDriverPreference('ANY')} className="mt-1" />
            <span>Any eligible driver</span>
          </label>
          <label className="flex items-start gap-2">
            <input type="radio" name="pref" value="FEMALE_ONLY" checked={driverPreference === 'FEMALE_ONLY'} onChange={() => setDriverPreference('FEMALE_ONLY')} className="mt-1" />
            <span>
              Women drivers only
              <span className="block text-xs text-fog">Only drivers whose eligibility our team verified. If none is available we will tell you, not switch drivers.</span>
            </span>
          </label>
        </div>
      </fieldset>

      <div>
        <label htmlFor="payment" className="label">
          Pay with
        </label>
        <select id="payment" className="field" value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}>
          <option value="CASH">Cash to driver</option>
          <option value="ONLINE">Online (test payment)</option>
        </select>
      </div>

      {estimate && (
        <div className="rounded-md border-2 border-asphalt bg-white p-3" data-testid="estimate">
          <p className="text-3xl font-extrabold">{formatMoney(estimate.estimatedFare, estimate.currency)}</p>
          <p className="text-sm text-fog">
            {formatDistance(estimate.distanceMeters)}, about {formatDuration(estimate.durationSeconds)}.{' '}
            {estimate.source === 'straight_line' ? 'Estimated from straight-line distance; the final fare uses the actual trip.' : 'Final fare uses the actual trip.'}
          </p>
        </div>
      )}

      {apiError && (
        <p role="alert" className="rounded-md border border-brake bg-white p-3 text-sm text-brake">
          {apiError}
        </p>
      )}

      <div className="flex gap-2">
        <button type="button" className="btn-quiet flex-1" onClick={getEstimate} disabled={estimating || booking}>
          {estimating ? 'Calculating…' : 'See fare'}
        </button>
        <button type="submit" className="btn-primary flex-[2]" disabled={booking}>
          {booking ? 'Requesting…' : 'Request ride'}
        </button>
      </div>
    </form>
  );
}

export { emptyPlace };
