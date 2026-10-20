import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import TripCodeCard from '../components/TripCodeCard';
import OtpEntry from '../components/OtpEntry';
import OfferCard from '../components/OfferCard';
import { rideApi } from '../services/api';
import { baseRide, fakeSocket } from './helpers';

vi.mock('../services/api', async (orig) => {
  const actual = await orig();
  return { ...actual, rideApi: { ...actual.rideApi, otp: vi.fn() } };
});
beforeEach(() => vi.clearAllMocks());

describe('Trip code (passenger)', () => {
  test('shows the pickup code while a driver is assigned', async () => {
    rideApi.otp.mockResolvedValue({ otp: { purpose: 'TRIP_START', code: '482913', expiresAt: new Date().toISOString() } });
    render(<TripCodeCard ride={baseRide({ status: 'DRIVER_ASSIGNED' })} socket={fakeSocket()} />);
    expect(await screen.findByText('482913')).toBeInTheDocument();
    expect(screen.getByText('Your pickup code')).toBeInTheDocument();
  });

  test('shows the separate drop-off code during the trip and refreshes when a new code is ready', async () => {
    rideApi.otp.mockResolvedValueOnce({ otp: { purpose: 'TRIP_COMPLETE', code: '111222' } });
    const socket = fakeSocket();
    render(<TripCodeCard ride={baseRide({ status: 'IN_PROGRESS' })} socket={socket} />);
    expect(await screen.findByText('111222')).toBeInTheDocument();
    expect(screen.getByText('Your drop-off code')).toBeInTheDocument();
    rideApi.otp.mockResolvedValueOnce({ otp: { purpose: 'TRIP_COMPLETE', code: '333444' } });
    await act(async () => socket.serverSends('ride:otp-available', { rideId: 'r1', purpose: 'TRIP_COMPLETE' }));
    expect(await screen.findByText('333444')).toBeInTheDocument();
  });

  test('renders nothing when no code is needed (searching / finished)', () => {
    const { container } = render(<TripCodeCard ride={baseRide({ status: 'SEARCHING' })} socket={fakeSocket()} />);
    expect(container).toBeEmptyDOMElement();
    expect(rideApi.otp).not.toHaveBeenCalled();
  });
});

describe('Driver code entry', () => {
  test('accepts digits only and enables submit at 6 digits', async () => {
    const onSubmit = vi.fn();
    render(<OtpEntry label="Passenger's pickup code" actionLabel="Start trip" onSubmit={onSubmit} />);
    const input = screen.getByLabelText("Passenger's pickup code");
    const button = screen.getByRole('button', { name: 'Start trip' });
    await userEvent.type(input, '12ab34');
    expect(input).toHaveValue('1234');
    expect(button).toBeDisabled();
    await userEvent.type(input, '56');
    expect(button).toBeEnabled();
    await userEvent.click(button);
    expect(onSubmit).toHaveBeenCalledWith('123456');
  });

  test('shows the server error (e.g. wrong code) next to the box', () => {
    render(<OtpEntry label="Code" actionLabel="Start trip" onSubmit={() => {}} error="Incorrect code" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Incorrect code');
  });

  test('offers never show a destination, only pickup, riders and trip length', () => {
    const offer = {
      id: 'o1',
      expiresAt: new Date(Date.now() + 10000).toISOString(),
      distanceToPickupMeters: 900,
      ride: { pickup: { address: 'MG Road' }, destinationHidden: true, passengerCount: 3, estimate: { distanceMeters: 5200 }, estimatedFare: 15400, currency: 'INR' },
    };
    render(<OfferCard offer={offer} onAccept={() => {}} onReject={() => {}} />);
    expect(screen.getByText('MG Road')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText(/5\.2 km/)).toBeInTheDocument();
    expect(screen.getByText(/destination is shown after/i)).toBeInTheDocument();
    expect(screen.queryByText(/To:/)).not.toBeInTheDocument();
  });
});
