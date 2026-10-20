import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import MapView from '../components/MapView';
import BookingForm, { emptyPlace } from '../components/BookingForm';
import { MapLayout } from '../components/AppShell';
import { rideApi } from '../services/api';
import { ACTIVE_STATUSES } from '../utils/format';

export default function PassengerHome() {
  const navigate = useNavigate();
  const [pickup, setPickup] = useState(emptyPlace);
  const [destination, setDestination] = useState(emptyPlace);
  const [picking, setPicking] = useState('pickup');

  // A passenger can have one active ride; if there is one, go straight to it.
  useEffect(() => {
    rideApi
      .history(1)
      .then((h) => {
        const active = h.items.find((r) => ACTIVE_STATUSES.includes(r.status));
        if (active) navigate(`/ride/${active.id}`, { replace: true });
      })
      .catch(() => {});
  }, [navigate]);

  const onPick = (pos) => {
    if (!picking) return;
    const label = `Pinned point ${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}`;
    if (picking === 'pickup') {
      setPickup((p) => ({ ...pos, address: p.address && !p.address.startsWith('Pinned point') ? p.address : label }));
      setPicking(destination.lat == null ? 'destination' : null);
    } else {
      setDestination((d) => ({ ...pos, address: d.address && !d.address.startsWith('Pinned point') ? d.address : label }));
      setPicking(null);
    }
  };

  return (
    <MapLayout map={<MapView pickup={pickup} destination={destination} onPick={onPick} className={picking ? 'cursor-crosshair' : ''} />}>
      <h1 className="sign mb-5 text-4xl">Where to?</h1>
      <BookingForm
        pickup={pickup}
        destination={destination}
        onPickupChange={setPickup}
        onDestinationChange={setDestination}
        picking={picking}
        onPickingChange={setPicking}
        onBooked={(ride) => navigate(`/ride/${ride.id}`)}
      />
    </MapLayout>
  );
}
