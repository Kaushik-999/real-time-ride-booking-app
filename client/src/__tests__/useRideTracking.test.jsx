import { act, renderHook, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import { useRideTracking } from '../hooks/useRideTracking';
import { rideApi } from '../services/api';
import { baseRide, driver, fakeSocket } from './helpers';

vi.mock('../services/api', async (orig) => {
  const actual = await orig();
  return { ...actual, rideApi: { ...actual.rideApi, get: vi.fn(), create: vi.fn() } };
});

beforeEach(() => vi.clearAllMocks());

describe('useRideTracking', () => {
  test('loads the ride over REST and subscribes to its room', async () => {
    rideApi.get.mockResolvedValue({ ride: baseRide() });
    const socket = fakeSocket();
    const { result } = renderHook(() => useRideTracking('r1', socket));
    await waitFor(() => expect(result.current.ride).not.toBeNull());
    expect(result.current.ride.status).toBe('SEARCHING');
    expect(socket.emitted).toContainEqual({ event: 'ride:subscribe', payload: { rideId: 'r1' } });
  });

  test('#85 after reconnecting, it re-subscribes and fetches the current state', async () => {
    rideApi.get.mockResolvedValueOnce({ ride: baseRide() });
    const socket = fakeSocket();
    const { result } = renderHook(() => useRideTracking('r1', socket));
    await waitFor(() => expect(result.current.ride?.status).toBe('SEARCHING'));

    // While disconnected the ride was assigned; no event reached us.
    rideApi.get.mockResolvedValueOnce({ ride: baseRide({ status: 'DRIVER_ASSIGNED', driverId: 'd1', driver }) });
    socket.emitted = [];
    await act(async () => socket.serverSends('connect'));
    await waitFor(() => expect(result.current.ride.status).toBe('DRIVER_ASSIGNED'));
    expect(socket.emitted.some((e) => e.event === 'ride:subscribe')).toBe(true);
  });

  test('#86 a burst of duplicate socket events collapses into few fetches and never creates rides', async () => {
    let resolveFirst;
    rideApi.get.mockResolvedValueOnce({ ride: baseRide() });
    const socket = fakeSocket();
    const { result } = renderHook(() => useRideTracking('r1', socket));
    await waitFor(() => expect(result.current.ride).not.toBeNull());
    rideApi.get.mockClear();

    rideApi.get.mockImplementation(
      () =>
        new Promise((r) => {
          resolveFirst = r;
        })
    );
    act(() => {
      for (let i = 0; i < 10; i += 1) socket.serverSends('ride:driver-assigned', { rideId: 'r1', status: 'DRIVER_ASSIGNED' });
    });
    expect(rideApi.get).toHaveBeenCalledTimes(1); // one in flight, the rest coalesced
    rideApi.get.mockResolvedValue({ ride: baseRide({ status: 'DRIVER_ASSIGNED', driver }) });
    await act(async () => resolveFirst({ ride: baseRide({ status: 'DRIVER_ASSIGNED', driver }) }));
    await waitFor(() => expect(result.current.ride.status).toBe('DRIVER_ASSIGNED'));
    expect(rideApi.get.mock.calls.length).toBeLessThanOrEqual(2);
    expect(rideApi.create).not.toHaveBeenCalled();
  });

  test('#88 a status event alone does not change the UI; the REST answer does', async () => {
    rideApi.get.mockResolvedValue({ ride: baseRide() });
    const socket = fakeSocket();
    const { result } = renderHook(() => useRideTracking('r1', socket));
    await waitFor(() => expect(result.current.ride).not.toBeNull());
    // Server still says SEARCHING (e.g. stale or forged event).
    await act(async () => socket.serverSends('ride:driver-assigned', { rideId: 'r1', status: 'DRIVER_ASSIGNED', driverId: 'x' }));
    await waitFor(() => expect(rideApi.get).toHaveBeenCalledTimes(2));
    expect(result.current.ride.status).toBe('SEARCHING');
    expect(result.current.ride.driver).toBeNull();
  });

  test('events for other rides are ignored', async () => {
    rideApi.get.mockResolvedValue({ ride: baseRide() });
    const socket = fakeSocket();
    renderHook(() => useRideTracking('r1', socket));
    await waitFor(() => expect(rideApi.get).toHaveBeenCalledTimes(1));
    act(() => socket.serverSends('ride:cancelled', { rideId: 'someone-else' }));
    expect(rideApi.get).toHaveBeenCalledTimes(1);
  });

  test('#89 invalid driver locations are not rendered as valid positions', async () => {
    rideApi.get.mockResolvedValue({ ride: baseRide({ status: 'DRIVER_ASSIGNED', driver }) });
    const socket = fakeSocket();
    const { result } = renderHook(() => useRideTracking('r1', socket));
    await waitFor(() => expect(result.current.ride).not.toBeNull());
    for (const bad of [{ lat: 'x', lng: 77 }, { lat: 120, lng: 77 }, { lat: 12, lng: null }, { lat: NaN, lng: 77 }]) {
      act(() => socket.serverSends('driver:location-updated', { rideId: 'r1', ...bad }));
      expect(result.current.ride.driverLocation).toBeNull();
    }
    act(() => socket.serverSends('driver:location-updated', { rideId: 'r1', lat: 12.95, lng: 77.6 }));
    expect(result.current.ride.driverLocation).toMatchObject({ lat: 12.95, lng: 77.6 });
  });

  test('#87 a failed fetch surfaces a useful message', async () => {
    rideApi.get.mockRejectedValue({ response: { status: 404, data: { success: false, error: { code: 'NOT_FOUND', message: 'Ride not found' } } } });
    const { result } = renderHook(() => useRideTracking('r1', fakeSocket()));
    await waitFor(() => expect(result.current.error).toBe('Ride not found'));
  });
});
