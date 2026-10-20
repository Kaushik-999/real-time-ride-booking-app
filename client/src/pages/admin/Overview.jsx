import { useEffect, useState } from 'react';
import { adminApi, errorMessage } from '../../services/api';
import { STATUS_TEXT, formatMoney } from '../../utils/format';
import { lower } from './shared';

export default function Overview() {
  const [m, setM] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    adminApi.metrics().then(setM).catch((e) => setError(errorMessage(e)));
  }, []);
  if (error) return <p role="alert" className="text-brake">{error}</p>;
  if (!m) return <p className="text-fog">Loading…</p>;
  const stat = (label, value, alert) => (
    <div className={`border-l-4 pl-3 ${alert ? 'border-brake' : 'border-asphalt'}`}>
      <p className="text-sm text-fog">{label}</p>
      <p className={`sign text-5xl ${alert ? 'text-brake' : ''}`}>{value}</p>
    </div>
  );
  return (
    <div className="space-y-8">
      <div className="grid grid-cols-2 gap-6 md:grid-cols-4">
        {stat('Open safety incidents', m.openSafetyIncidents, m.openSafetyIncidents > 0)}
        {stat('Failed emergency dispatches', m.failedEmergencyDispatches, m.failedEmergencyDispatches > 0)}
        {stat('Drivers waiting for review', m.pendingDriverReviews)}
        {stat('Open chat reports', m.openChatReports)}
        {stat('Rides', m.totalRides)}
        {stat('Failed or cancelled', m.failedOrCancelledRides)}
        {stat('Collected', formatMoney(m.collectedRevenuePaise, m.currency))}
        {stat('Refund requests', m.refundRequests)}
      </div>
      <div className="grid gap-6 md:grid-cols-3">
        {[
          ['Rides by status', m.ridesByStatus],
          ['No driver found, by reason', m.noDriverByReason],
          ['Drivers by review status', m.driversByApproval],
          ['Drivers by availability', m.driversByAvailability],
          ['Offers by outcome', m.offersByStatus],
          ['Users by role', m.usersByRole],
        ].map(([title, obj]) => (
          <div key={title}>
            <h3 className="mb-2 font-semibold">{title}</h3>
            <ul className="divide-y divide-line border-y border-line text-sm">
              {Object.entries(obj || {}).length === 0 && <li className="py-2 text-fog">None yet</li>}
              {Object.entries(obj || {}).map(([k, v]) => (
                <li key={k} className="flex justify-between py-1.5">
                  <span>{STATUS_TEXT[k] || lower(k)}</span>
                  <span className="font-semibold">{v}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
