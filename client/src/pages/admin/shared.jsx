import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../services/api';

export function Table({ head, children }) {
  return (
    <div className="overflow-x-auto rounded-md border border-line bg-white">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-line text-fog">
          <tr>
            {head.map((h) => (
              <th key={h} className="px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
    </div>
  );
}

export function Filter({ label, value, onChange, options }) {
  const id = `f-${label.replace(/\s+/g, '-').toLowerCase()}`;
  return (
    <div>
      <label htmlFor={id} className="label">
        {label}
      </label>
      <select id={id} className="field" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * Load a paginated admin list; reloads when params change.
 * Responses can arrive out of order (e.g. a quick filter change): only the
 * newest request may update the screen, so a slow older answer can never
 * overwrite a newer one.
 */
export function usePaged(fetcher, params) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const latest = useRef(0);
  const key = JSON.stringify(params);
  const load = useCallback(async () => {
    const requestId = (latest.current += 1);
    setError(null);
    try {
      const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== '' && v != null));
      const result = await fetcher(clean);
      if (requestId === latest.current) setData(result);
    } catch (err) {
      if (requestId === latest.current) setError(errorMessage(err));
    }
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    load();
  }, [load]);
  return { data, error, reload: load };
}

export const lower = (s) => (s ? s.toLowerCase().replace(/_/g, ' ') : '');
