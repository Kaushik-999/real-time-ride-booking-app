import { Link, NavLink, Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const NAV = {
  PASSENGER: [
    { to: '/', label: 'Book' },
    { to: '/history', label: 'My rides' },
    { to: '/account', label: 'Account' },
  ],
  DRIVER: [
    { to: '/driver', label: 'Drive' },
    { to: '/driver/trips', label: 'Trips and earnings' },
    { to: '/driver/onboarding', label: 'Documents' },
    { to: '/account', label: 'Account' },
  ],
  ADMIN: [{ to: '/admin', label: 'Operations' }],
};

export const homeFor = (role) => (role === 'DRIVER' ? '/driver' : role === 'ADMIN' ? '/admin' : '/');

export function RequireRole({ roles }) {
  const { user, loading, token } = useAuth();
  const location = useLocation();
  if (loading) return <p className="p-6 text-fog">Loading…</p>;
  if (!token || !user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (roles && !roles.includes(user.role)) return <Navigate to={homeFor(user.role)} replace />;
  return <Outlet />;
}

export default function AppShell() {
  const { user, logout } = useAuth();
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-4 border-b border-line bg-chalk px-4 py-2">
        <Link to={homeFor(user && user.role)} className="sign text-2xl">
          Ride
        </Link>
        <nav className="flex gap-1 overflow-x-auto" aria-label="Main">
          {(NAV[user && user.role] || []).map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end
              className={({ isActive }) => `whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium ${isActive ? 'bg-asphalt text-chalk' : 'hover:bg-line'}`}
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3 text-sm">
          <span className="hidden text-fog sm:inline">{user && user.name}</span>
          <button type="button" onClick={logout} className="font-medium underline-offset-2 hover:underline">
            Sign out
          </button>
        </div>
      </header>
      <main className="relative min-h-0 flex-1">
        <Outlet />
      </main>
    </div>
  );
}

/** Map-first layout: map fills the page; the sheet sits left (desktop) or bottom (mobile). */
export function MapLayout({ map, children }) {
  return (
    <div className="relative h-full">
      <div className="absolute inset-0 z-0">{map}</div>
      <aside className="absolute inset-x-0 bottom-0 z-[500] max-h-[62%] overflow-y-auto rounded-t-xl border-t border-line bg-chalk p-5 shadow-[0_-4px_16px_rgba(31,41,51,0.12)] md:inset-y-4 md:left-4 md:right-auto md:max-h-none md:w-[400px] md:rounded-xl md:border">
        {children}
      </aside>
    </div>
  );
}
