import { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import BookingForm, { emptyPlace } from '../components/BookingForm';
import RideStatus from '../components/RideStatus';
import ConfirmAction from '../components/ConfirmAction';
import { LoginPage } from '../pages/AuthPages';
import { AuthContext } from '../context/AuthContext';
import { authApi, rideApi, vehiclesApi } from '../services/api';
import { baseRide } from './helpers';

vi.mock('../services/api', async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    rideApi: { ...actual.rideApi, create: vi.fn(), estimate: vi.fn() },
    vehiclesApi: { list: vi.fn() },
    authApi: { ...actual.authApi, providers: vi.fn(), requestOtp: vi.fn(), verifyOtp: vi.fn() },
  };
});
beforeEach(() => {
  vi.clearAllMocks();
  vehiclesApi.list.mockResolvedValue({
    vehicles: [
      { type: 'BIKE', label: 'Bike', maxPassengers: 1 },
      { type: 'AUTO', label: 'Auto', maxPassengers: 3 },
      { type: 'CAR', label: 'Car', maxPassengers: 4 },
      { type: 'CAR_XL', label: 'Car XL', maxPassengers: 7 },
    ],
  });
});

const A = { address: 'MG Road', lat: 12.9716, lng: 77.5946 };
const B = { address: 'Koramangala', lat: 12.9352, lng: 77.6245 };
function Harness() {
  const [picking, setPicking] = useState(null);
  return <BookingForm pickup={A} destination={B} onPickupChange={() => {}} onDestinationChange={() => {}} picking={picking} onPickingChange={setPicking} onBooked={() => {}} />;
}

describe('Booking: vehicle types, capacity, preference', () => {
  test('lists bike, auto, car and car XL from the server catalog', async () => {
    render(<Harness />);
    for (const label of ['Bike', 'Auto', 'Car', 'Car XL']) expect(await screen.findByText(label)).toBeInTheDocument();
  });

  test('a group larger than the vehicle switches to one that fits; too-small vehicles are disabled', async () => {
    render(<Harness />);
    await screen.findByText('Car XL');
    await userEvent.selectOptions(screen.getByLabelText('Riders'), '6');
    await waitFor(() => expect(screen.getByDisplayValue('CAR_XL')).toBeChecked());
    expect(screen.getByDisplayValue('CAR')).toBeDisabled();
    expect(screen.getByDisplayValue('BIKE')).toBeDisabled();
  });

  test('sends passenger count and the women-driver preference (never a price)', async () => {
    rideApi.create.mockResolvedValue({ ride: { id: 'r9' } });
    render(<Harness />);
    await screen.findByText('Car XL');
    await userEvent.selectOptions(screen.getByLabelText('Riders'), '2');
    await userEvent.click(screen.getByLabelText(/Women drivers only/));
    await userEvent.click(screen.getByRole('button', { name: 'Request ride' }));
    const body = rideApi.create.mock.calls[0][0];
    expect(body).toMatchObject({ passengerCount: 2, driverPreference: 'FEMALE_ONLY', vehicleType: 'CAR' });
    expect(body).not.toHaveProperty('estimatedFare');
  });

  test('the estimate shows each vehicle option price', async () => {
    rideApi.estimate.mockResolvedValue({ estimatedFare: 13100, currency: 'INR', distanceMeters: 5185, durationSeconds: 747, source: 'straight_line', options: [{ vehicleType: 'BIKE', estimatedFare: 6400 }, { vehicleType: 'CAR', estimatedFare: 13100 }] });
    render(<Harness />);
    await screen.findByText('Car XL');
    await userEvent.click(screen.getByRole('button', { name: 'See fare' }));
    expect(await screen.findByText(/Up to 1, ₹64/)).toBeInTheDocument();
  });

  test('preference unavailable is explained, not hidden', () => {
    render(<RideStatus ride={baseRide({ status: 'NO_DRIVER_FOUND', noDriverReason: 'PREFERENCE_UNAVAILABLE', driverPreference: 'FEMALE_ONLY', matchingRadiusKm: 12 })} />);
    expect(screen.getByTestId('preference-unavailable')).toHaveTextContent(/did not assign anyone else/);
    expect(screen.getByText('Women drivers only')).toBeInTheDocument();
  });
});

function renderLogin() {
  const ctx = { user: null, signIn: vi.fn(), token: null, loading: false };
  render(
    <MemoryRouter>
      <AuthContext.Provider value={ctx}>
        <LoginPage />
      </AuthContext.Provider>
    </MemoryRouter>
  );
  return ctx;
}

describe('Sign-in providers', () => {
  test('phone code login: request, dev-outbox notice, verify', async () => {
    authApi.providers.mockResolvedValue({ password: true, phoneOtp: true, google: false, googleClientId: null });
    authApi.requestOtp.mockResolvedValue({ message: 'If this number belongs to an account, a sign-in code has been sent.', delivery: 'DEV_OUTBOX_NOT_SENT' });
    authApi.verifyOtp.mockResolvedValue({ token: 't', user: { role: 'PASSENGER' } });
    const ctx = renderLogin();
    await userEvent.click(await screen.findByRole('tab', { name: 'Phone code' }));
    await userEvent.type(screen.getByLabelText('Mobile number'), '9876543210');
    await userEvent.click(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByTestId('dev-outbox-note')).toHaveTextContent(/no SMS was sent/);
    await userEvent.type(screen.getByLabelText('6-digit code'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(authApi.verifyOtp).toHaveBeenCalledWith('9876543210', '123456');
    expect(ctx.signIn).toHaveBeenCalled();
  });

  test('wrong code shows the generic server error', async () => {
    authApi.providers.mockResolvedValue({ password: true, phoneOtp: true, google: false });
    authApi.requestOtp.mockResolvedValue({ message: 'sent', delivery: 'SMS' });
    authApi.verifyOtp.mockRejectedValue({ response: { data: { error: { message: 'Invalid or expired code' } } } });
    renderLogin();
    await userEvent.click(await screen.findByRole('tab', { name: 'Phone code' }));
    await userEvent.type(screen.getByLabelText('Mobile number'), '9876543210');
    await userEvent.click(screen.getByRole('button', { name: 'Send code' }));
    await userEvent.type(await screen.findByLabelText('6-digit code'), '000000');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid or expired code');
  });

  test('no Google button and no phone tab when the server has them switched off', async () => {
    authApi.providers.mockResolvedValue({ password: true, phoneOtp: false, google: false, googleClientId: null });
    renderLogin();
    await waitFor(() => expect(authApi.providers).toHaveBeenCalled());
    expect(screen.queryByRole('tab', { name: 'Phone code' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('google-button')).not.toBeInTheDocument();
  });
});

describe('Admin confirmations', () => {
  test('destructive actions need confirmation and a reason, and show server errors', async () => {
    const onConfirm = vi.fn().mockRejectedValue({ response: { data: { error: { message: 'Driver currently holds a ride' } } } });
    render(<ConfirmAction label="Suspend" danger requireReason prompt="Suspend this driver?" onConfirm={onConfirm} />);
    await userEvent.click(screen.getByRole('button', { name: 'Suspend' }));
    const go = screen.getAllByRole('button', { name: 'Suspend' })[0];
    expect(go).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Reason (required)'), 'Complaint');
    await userEvent.click(screen.getAllByRole('button', { name: 'Suspend' })[0]);
    expect(onConfirm).toHaveBeenCalledWith('Complaint');
    expect(await screen.findByRole('alert')).toHaveTextContent('Driver currently holds a ride');
  });
});
