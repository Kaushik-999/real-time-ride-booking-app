import { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import BookingForm, { emptyPlace } from '../components/BookingForm';
import { rideApi } from '../services/api';

vi.mock('../services/api', async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    rideApi: { ...actual.rideApi, create: vi.fn(), estimate: vi.fn() },
    // The catalog request must never reach the network in tests.
    vehiclesApi: { list: vi.fn().mockRejectedValue(new Error('offline')) },
  };
});
beforeEach(() => vi.clearAllMocks());

function Harness({ initialPickup = emptyPlace, initialDestination = emptyPlace, onBooked = () => {} }) {
  const [pickup, setPickup] = useState(initialPickup);
  const [destination, setDestination] = useState(initialDestination);
  const [picking, setPicking] = useState(null);
  return (
    <BookingForm
      pickup={pickup}
      destination={destination}
      onPickupChange={setPickup}
      onDestinationChange={setDestination}
      picking={picking}
      onPickingChange={setPicking}
      onBooked={onBooked}
    />
  );
}

const A = { address: 'MG Road', lat: 12.9716, lng: 77.5946 };
const B = { address: 'Koramangala', lat: 12.9352, lng: 77.6245 };

describe('#90 booking form', () => {
  test('prevents submission without valid places', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'Request ride' }));
    expect(screen.getByText('Enter a pickup address.')).toBeInTheDocument();
    expect(screen.getByText('Enter a destination address.')).toBeInTheDocument();
    expect(rideApi.create).not.toHaveBeenCalled();
  });

  test('an address without a map position is not accepted', async () => {
    render(<Harness initialPickup={{ address: 'somewhere', lat: null, lng: null }} initialDestination={B} />);
    await userEvent.click(screen.getByRole('button', { name: 'Request ride' }));
    expect(screen.getByText(/Place the pickup on the map/)).toBeInTheDocument();
    expect(rideApi.create).not.toHaveBeenCalled();
  });

  test('identical pickup and destination is rejected', async () => {
    render(<Harness initialPickup={A} initialDestination={{ ...A, address: 'same place' }} />);
    await userEvent.click(screen.getByRole('button', { name: 'Request ride' }));
    expect(screen.getByText('Destination must be different from pickup.')).toBeInTheDocument();
  });

  test('shows a loading state, blocks double submits, and sends no price', async () => {
    let resolve;
    rideApi.create.mockImplementation(() => new Promise((r) => (resolve = r)));
    const onBooked = vi.fn();
    render(<Harness initialPickup={A} initialDestination={B} onBooked={onBooked} />);
    await userEvent.click(screen.getByRole('button', { name: 'Request ride' }));
    const busy = screen.getByRole('button', { name: 'Requesting…' });
    expect(busy).toBeDisabled();
    await userEvent.click(busy);
    expect(rideApi.create).toHaveBeenCalledTimes(1);
    const body = rideApi.create.mock.calls[0][0];
    expect(body).not.toHaveProperty('estimatedFare');
    expect(body).not.toHaveProperty('fare');
    expect(body.requestKey).toEqual(expect.any(String));
    resolve({ ride: { id: 'r1' } });
    await waitFor(() => expect(onBooked).toHaveBeenCalledWith({ id: 'r1' }));
  });

  test('#87 a failed request shows the server message, and a retry reuses the same request key', async () => {
    rideApi.create.mockRejectedValueOnce({ response: { status: 409, data: { success: false, error: { code: 'ACTIVE_RIDE_EXISTS', message: 'You already have an active ride' } } } });
    rideApi.create.mockRejectedValueOnce({ request: {}, message: 'Network Error' });
    render(<Harness initialPickup={A} initialDestination={B} />);
    await userEvent.click(screen.getByRole('button', { name: 'Request ride' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You already have an active ride');
    await userEvent.click(screen.getByRole('button', { name: 'Request ride' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot reach the server');
    const [k1, k2] = rideApi.create.mock.calls.map((c) => c[0].requestKey);
    expect(k1).toBe(k2);
  });

  test('fare estimate comes from the server and is labelled as an estimate', async () => {
    rideApi.estimate.mockResolvedValue({ estimatedFare: 15400, currency: 'INR', distanceMeters: 5100, durationSeconds: 734, source: 'straight_line' });
    render(<Harness initialPickup={A} initialDestination={B} />);
    await userEvent.click(screen.getByRole('button', { name: 'See fare' }));
    const est = await screen.findByTestId('estimate');
    expect(est).toHaveTextContent('154');
    expect(est).toHaveTextContent(/straight-line/);
  });
});
