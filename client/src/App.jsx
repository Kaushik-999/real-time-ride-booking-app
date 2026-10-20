import { Navigate, Route, Routes } from 'react-router-dom';
import AppShell, { RequireRole } from './components/AppShell';
import { LoginPage, RegisterPage } from './pages/AuthPages';
import PassengerHome from './pages/PassengerHome';
import RidePage from './pages/RidePage';
import HistoryPage from './pages/HistoryPage';
import DriverHome from './pages/DriverHome';
import DriverTrips from './pages/DriverTrips';
import AdminPage from './pages/AdminPage';
import DriverOnboarding from './pages/DriverOnboarding';
import AccountPage from './pages/AccountPage';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route element={<RequireRole />}>
        <Route element={<AppShell />}>
          <Route element={<RequireRole roles={['PASSENGER']} />}>
            <Route path="/" element={<PassengerHome />} />
            <Route path="/history" element={<HistoryPage />} />
          </Route>
          <Route path="/ride/:rideId" element={<RidePage />} />
          <Route element={<RequireRole roles={['PASSENGER', 'DRIVER']} />}>
            <Route path="/account" element={<AccountPage />} />
          </Route>
          <Route element={<RequireRole roles={['DRIVER']} />}>
            <Route path="/driver" element={<DriverHome />} />
            <Route path="/driver/trips" element={<DriverTrips />} />
            <Route path="/driver/onboarding" element={<DriverOnboarding />} />
          </Route>
          <Route element={<RequireRole roles={['ADMIN']} />}>
            <Route path="/admin" element={<AdminPage />} />
          </Route>
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
