import { useEffect } from 'react';
import { Circle, MapContainer, Marker, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import { toLatLng } from '../utils/format';

export const DEFAULT_CENTER = [12.9716, 77.5946]; // Bengaluru

const pin = (bg, ring, label) =>
  L.divIcon({
    className: '',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    html: `<div style="width:28px;height:28px;border-radius:50%;background:${bg};border:3px solid ${ring};display:grid;place-items:center;font:700 12px Archivo,sans-serif;color:${ring};box-shadow:0 1px 3px rgba(31,41,51,.35)">${label}</div>`,
  });

const ICONS = {
  pickup: pin('#F3F4EF', '#1F2933', 'A'),
  destination: pin('#1F2933', '#F3F4EF', 'B'),
  driver: pin('#F5C518', '#1F2933', '▲'),
  self: pin('#F5C518', '#1F2933', '●'),
};

function ClickHandler({ onPick }) {
  useMapEvents({
    click(e) {
      if (onPick) onPick({ lat: Number(e.latlng.lat.toFixed(6)), lng: Number(e.latlng.lng.toFixed(6)) });
    },
  });
  return null;
}

function FitTo({ points }) {
  const map = useMap();
  const key = points.map((p) => p.join(',')).join('|');
  useEffect(() => {
    if (points.length === 1) map.setView(points[0], Math.max(map.getZoom(), 13));
    if (points.length > 1) {
      // Keep both pins clear of the trip sheet (left on desktop, bottom on mobile).
      const desktop = window.innerWidth >= 768;
      map.fitBounds(points, {
        paddingTopLeft: desktop ? [440, 60] : [40, 40],
        paddingBottomRight: desktop ? [60, 60] : [40, Math.round(window.innerHeight * 0.62)],
        maxZoom: 15,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, map]);
  return null;
}

/**
 * Map with optional pickup (A), destination (B), driver marker and the
 * driver-search rings. Every coordinate goes through toLatLng(), so invalid
 * data is simply not drawn rather than drawn in the wrong place.
 *
 * searchRings: { radiiKm: [3,6,9,12], activeKm: 6 } while searching.
 */
export default function MapView({ pickup, destination, driver, self, searchRings, onPick, className = '' }) {
  const a = toLatLng(pickup);
  const b = toLatLng(destination);
  const d = toLatLng(driver);
  const s = toLatLng(self);
  const fit = [a, b].filter(Boolean);

  return (
    <MapContainer center={a || s || DEFAULT_CENTER} zoom={13} className={`h-full w-full ${className}`} zoomControl={false}>
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <ClickHandler onPick={onPick} />
      <FitTo points={fit.length ? fit : s ? [s] : []} />
      {a && searchRings &&
        searchRings.radiiKm.map((km) => {
          const active = km === searchRings.activeKm;
          return (
            <Circle
              key={km}
              center={a}
              radius={km * 1000}
              pathOptions={{
                color: active ? '#F5C518' : '#1F2933',
                weight: active ? 4 : 2,
                opacity: active ? 0.9 : km < searchRings.activeKm ? 0.25 : 0.6,
                dashArray: active ? null : '6 8',
                fill: false,
                className: active ? 'ring-active' : '',
              }}
            />
          );
        })}
      {a && <Marker position={a} icon={ICONS.pickup} title="Pickup" />}
      {b && <Marker position={b} icon={ICONS.destination} title="Destination" />}
      {d && <Marker position={d} icon={ICONS.driver} title="Driver" />}
      {s && <Marker position={s} icon={ICONS.self} title="You" />}
    </MapContainer>
  );
}
