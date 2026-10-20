import { useState } from 'react';

// Address search uses OpenStreetMap's public Nominatim service directly from
// the browser (no key needed; light use only). The map click is the
// always-available alternative.
async function searchAddress(q) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=5&countrycodes=in&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('search failed');
  const rows = await res.json();
  return rows.map((r) => ({ address: r.display_name, lat: Number(r.lat), lng: Number(r.lon) }));
}

/**
 * One place (pickup or destination): an address the passenger can type or
 * edit, plus coordinates set by search or by clicking the map.
 */
export default function PlaceField({ id, label, value, onChange, picking, onPickOnMap, error }) {
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(null);

  const runSearch = async () => {
    if (!value.address || value.address.trim().length < 3) return;
    setSearching(true);
    setSearchError(null);
    try {
      const rows = await searchAddress(value.address.trim());
      setResults(rows);
      if (!rows.length) setSearchError('No matches. Try a landmark, or tap the map.');
    } catch {
      setSearchError('Address search is unavailable. Tap the map instead.');
    } finally {
      setSearching(false);
    }
  };

  return (
    <div>
      <label htmlFor={id} className="label">
        {label}
      </label>
      <div className="flex gap-2">
        <input
          id={id}
          className="field"
          value={value.address}
          placeholder="Type an address or tap the map"
          onChange={(e) => onChange({ ...value, address: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              runSearch();
            }
          }}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${id}-error` : undefined}
        />
        <button type="button" className="btn-quiet shrink-0 px-3" onClick={runSearch} disabled={searching}>
          {searching ? 'Searching…' : 'Search'}
        </button>
      </div>
      <button
        type="button"
        onClick={onPickOnMap}
        className={`mt-1 text-sm underline-offset-2 ${picking ? 'font-semibold text-asphalt underline' : 'text-fog hover:underline'}`}
        aria-pressed={picking}
      >
        {picking ? 'Tap the map to place this point' : value.lat != null ? 'Move on map' : 'Choose on map'}
      </button>
      {results.length > 0 && (
        <ul className="mt-1 max-h-40 overflow-auto rounded-md border border-line bg-white text-sm">
          {results.map((r) => (
            <li key={`${r.lat},${r.lng}`}>
              <button
                type="button"
                className="block w-full px-3 py-2 text-left hover:bg-chalk"
                onClick={() => {
                  onChange(r);
                  setResults([]);
                }}
              >
                {r.address}
              </button>
            </li>
          ))}
        </ul>
      )}
      {searchError && <p className="mt-1 text-sm text-fog">{searchError}</p>}
      {error && (
        <p id={`${id}-error`} className="mt-1 text-sm text-brake">
          {error}
        </p>
      )}
    </div>
  );
}
