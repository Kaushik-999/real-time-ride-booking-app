import { DRIVER_ATTACHED, STATUS_TEXT, formatDistance, formatDuration, formatMoney } from '../utils/format';

function DriverCard({ driver }) {
  return (
    <div className="mt-4 flex items-center gap-3 rounded-md border border-line bg-white p-3" data-testid="driver-card">
      <div className="grid h-11 w-11 place-items-center rounded-full bg-rickshaw text-lg font-bold" aria-hidden>
        {driver.name ? driver.name[0] : '?'}
      </div>
      <div className="min-w-0">
        <p className="font-semibold">{driver.name}</p>
        {driver.rating && driver.rating.count > 0 && (
          <p className="text-sm" aria-label={`Rated ${driver.rating.average} out of 5`}>
            ★ {driver.rating.average} <span className="text-fog">({driver.rating.count})</span>
          </p>
        )}
        {driver.vehicle && (
          <p className="text-sm text-fog">
            {[driver.vehicle.color, driver.vehicle.model, driver.vehicle.label || driver.vehicle.type].filter(Boolean).join(' ')}
          </p>
        )}
      </div>
      {driver.vehicle && (
        <span className="ml-auto rounded border-2 border-asphalt bg-white px-2 py-0.5 font-bold tracking-wide">
          {driver.vehicle.registrationNumber}
        </span>
      )}
    </div>
  );
}

/**
 * The ride's state, written large like a road sign. The driver card is shown
 * ONLY when the server says a driver is attached (status + driver details) -
 * never on the strength of a socket event alone.
 */
export default function RideStatus({ ride }) {
  if (!ride) return null;
  const showDriver = DRIVER_ATTACHED.includes(ride.status) && ride.driver;
  const tone =
    ride.status === 'CANCELLED' || ride.status === 'NO_DRIVER_FOUND'
      ? 'text-brake'
      : ride.status === 'COMPLETED'
        ? 'text-kerb'
        : 'text-asphalt';

  return (
    <section aria-live="polite" data-testid="ride-status" data-status={ride.status}>
      <h2 className={`sign text-5xl ${tone}`}>{STATUS_TEXT[ride.status] || ride.status}</h2>

      {ride.status === 'SEARCHING' && (
        <p className="mt-2 text-fog">
          {ride.matchingRadiusKm ? `Asking drivers within ${ride.matchingRadiusKm} km, nearest first.` : 'Asking the nearest drivers first.'}
        </p>
      )}
      {ride.status === 'DRIVER_ARRIVED' && <p className="mt-2">Meet your driver at the pickup point.</p>}
      {ride.status === 'NO_DRIVER_FOUND' && ride.noDriverReason === 'PREFERENCE_UNAVAILABLE' && (
        <p className="mt-2" data-testid="preference-unavailable">
          No verified woman driver within {ride.matchingRadiusKm || 12} km accepted this ride. We did not assign anyone else. You were not charged.
        </p>
      )}
      {ride.status === 'NO_DRIVER_FOUND' && ride.noDriverReason !== 'PREFERENCE_UNAVAILABLE' && (
        <p className="mt-2">Nobody within {ride.matchingRadiusKm || 12} km accepted this ride. You were not charged. Try again in a few minutes.</p>
      )}
      {ride.status === 'CANCELLED' && <p className="mt-2">{ride.cancelReason ? `Reason: ${ride.cancelReason}` : 'This ride will not be charged.'}</p>}

      {showDriver && <DriverCard driver={ride.driver} />}

      <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
        <div className="col-span-2">
          <dt className="text-fog">From</dt>
          <dd className="font-medium">{ride.pickup && ride.pickup.address}</dd>
        </div>
        <div className="col-span-2">
          <dt className="text-fog">To</dt>
          <dd className="font-medium">{ride.destination && ride.destination.address}</dd>
        </div>
        {ride.status === 'COMPLETED' && Number.isFinite(ride.finalFare) ? (
          <div>
            <dt className="text-fog">Fare</dt>
            <dd className="text-xl font-bold" data-testid="final-fare">
              {formatMoney(ride.finalFare, ride.currency)}
            </dd>
          </div>
        ) : (
          <div>
            <dt className="text-fog">Estimated fare</dt>
            <dd className="text-xl font-bold">{formatMoney(ride.estimatedFare, ride.currency)}</dd>
          </div>
        )}
        <div>
          <dt className="text-fog">Vehicle</dt>
          <dd className="font-medium">
            {ride.vehicleLabel || ride.vehicleType}, {ride.passengerCount || 1} {ride.passengerCount > 1 ? 'riders' : 'rider'}
          </dd>
        </div>
        {ride.driverPreference === 'FEMALE_ONLY' && (
          <div>
            <dt className="text-fog">Driver preference</dt>
            <dd className="font-medium">Women drivers only</dd>
          </div>
        )}
        <div>
          <dt className="text-fog">Trip</dt>
          <dd className="font-medium">
            {ride.estimate && `${formatDistance(ride.estimate.distanceMeters)}, about ${formatDuration(ride.estimate.durationSeconds)}`}
          </dd>
        </div>
        {ride.payment && (
          <div className="col-span-2">
            <dt className="text-fog">Payment</dt>
            <dd className="font-medium" data-testid="payment-status">
              {ride.payment.method === 'CASH' ? 'Cash' : 'Online'}: {PAYMENT_TEXT[ride.payment.status] || ride.payment.status}
            </dd>
          </div>
        )}
      </dl>
    </section>
  );
}

const PAYMENT_TEXT = {
  PENDING: 'not paid yet',
  PROCESSING: 'processing',
  SUCCEEDED: 'paid',
  FAILED: 'failed, please try again',
  REFUNDED: 'refunded',
};
