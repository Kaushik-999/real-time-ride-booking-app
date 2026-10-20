import { useState } from 'react';
import ConfirmAction from '../../components/ConfirmAction';
import Pagination from '../../components/Pagination';
import { adminApi } from '../../services/api';
import { formatDateTime } from '../../utils/format';
import { Filter, Table, lower, usePaged } from './shared';

function UserDetail({ userId, onChanged }) {
  const { data, error, reload } = usePaged(() => adminApi.user(userId), { userId });
  if (error) return <p role="alert" className="text-brake">{error}</p>;
  if (!data) return <p className="text-fog">Loading…</p>;
  const { user, verification, suspension, stats } = data;
  const refresh = async () => {
    await reload();
    onChanged();
  };
  return (
    <aside className="rounded-md border border-line bg-white p-4 text-sm" aria-label="User detail">
      <h3 className="sign text-3xl">{user.name}</h3>
      <p className="text-fog">{user.email}, {lower(user.role)}, joined {formatDateTime(user.createdAt)}</p>
      <h4 className="mt-3 font-semibold">Sign-in and verification</h4>
      <ul>
        <li>Password sign-in: {verification.emailPasswordLogin ? 'yes' : 'no'}</li>
        <li>Phone: {verification.phone ? `${verification.phone.number} (${verification.phone.verified ? 'verified' : 'not verified'})` : 'none'}</li>
        <li>Linked: {verification.linkedProviders.length ? verification.linkedProviders.join(', ') : 'none'}</li>
        {verification.driverApproval && <li>Driver review: {lower(verification.driverApproval)}</li>}
      </ul>
      <h4 className="mt-3 font-semibold">Activity</h4>
      <p>Rating: {user.rating.count ? `${user.rating.average} from ${user.rating.count}` : 'none'}; safety incidents involved: {stats.safetyIncidentsInvolved}</p>
      {suspension && <p className="mt-3 text-brake">Suspended {formatDateTime(suspension.at)}: {suspension.reason}</p>}
      {user.role !== 'ADMIN' && (
        <div className="mt-3">
          {user.accountStatus === 'ACTIVE' ? (
            <ConfirmAction label="Suspend account" danger requireReason prompt="Suspend this account? The person is signed out and cannot book or drive." onConfirm={async (reason) => { await adminApi.setAccountStatus(userId, 'SUSPENDED', reason); await refresh(); }} />
          ) : (
            <ConfirmAction label="Reinstate account" prompt="Reinstate this account?" onConfirm={async () => { await adminApi.setAccountStatus(userId, 'ACTIVE'); await refresh(); }} />
          )}
        </div>
      )}
    </aside>
  );
}

export default function Users() {
  const [role, setRole] = useState('PASSENGER');
  const [accountStatus, setAccountStatus] = useState('');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(null);
  const { data, error, reload } = usePaged(adminApi.users, { role, accountStatus, q: query, page, limit: 20 });
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
      <div className="space-y-4">
        <form className="grid grid-cols-1 gap-3 md:grid-cols-4" onSubmit={(e) => { e.preventDefault(); setQuery(q); setPage(1); }}>
          <Filter label="Role" value={role} onChange={(v) => { setRole(v); setPage(1); }} options={[['PASSENGER', 'Passengers'], ['DRIVER', 'Drivers'], ['ADMIN', 'Admins'], ['', 'Everyone']]} />
          <Filter label="Account" value={accountStatus} onChange={(v) => { setAccountStatus(v); setPage(1); }} options={[['', 'Any'], ['ACTIVE', 'Active'], ['SUSPENDED', 'Suspended']]} />
          <div className="md:col-span-2">
            <label htmlFor="user-q" className="label">Search name, email or phone</label>
            <div className="flex gap-2">
              <input id="user-q" className="field" value={q} onChange={(e) => setQ(e.target.value)} />
              <button className="btn-quiet">Search</button>
            </div>
          </div>
        </form>
        {error && <p role="alert" className="text-brake">{error}</p>}
        {data && (
          <Table head={['Name', 'Email', 'Role', 'Account', '']}>
            {data.items.map((u) => (
              <tr key={u.id}>
                <td className="px-3 py-2">{u.name}</td>
                <td className="px-3 py-2">{u.email}</td>
                <td className="px-3 py-2">{lower(u.role)}</td>
                <td className={`px-3 py-2 ${u.accountStatus === 'SUSPENDED' ? 'text-brake' : ''}`}>{lower(u.accountStatus)}</td>
                <td className="px-3 py-2 text-right"><button type="button" className="underline" onClick={() => setOpen(u.id)}>Open</button></td>
              </tr>
            ))}
          </Table>
        )}
        {data && <Pagination page={page} limit={data.limit} total={data.total} onPage={setPage} />}
      </div>
      {open && <UserDetail key={open} userId={open} onChanged={reload} />}
    </div>
  );
}
