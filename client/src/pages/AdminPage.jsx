import { useState } from 'react';
import Overview from './admin/Overview';
import Drivers from './admin/Drivers';
import Users from './admin/Users';
import Rides from './admin/Rides';
import Safety from './admin/Safety';
import { AuditLog, ChatReports, Payments, Reviews } from './admin/Moderation';

// Tabs only organise the screen. Every action is also permission-checked on the server.
const TABS = [
  ['Overview', Overview],
  ['Safety', Safety],
  ['Drivers', Drivers],
  ['Users', Users],
  ['Rides', Rides],
  ['Reviews', Reviews],
  ['Chat reports', ChatReports],
  ['Payments', Payments],
  ['Audit log', AuditLog],
];

export default function AdminPage() {
  const [tab, setTab] = useState('Overview');
  const Current = TABS.find(([t]) => t === tab)[1];
  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="sign text-5xl">Operations</h1>
      <div className="my-6 flex gap-1 overflow-x-auto border-b border-line" role="tablist">
        {TABS.map(([t]) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-semibold ${tab === t ? 'border-asphalt' : 'border-transparent text-fog'}`}>
            {t}
          </button>
        ))}
      </div>
      <Current />
    </div>
  );
}
