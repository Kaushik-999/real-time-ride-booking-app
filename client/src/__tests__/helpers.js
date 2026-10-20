/** Minimal stand-in for a Socket.IO client socket. */
export function fakeSocket({ connected = true } = {}) {
  const handlers = new Map();
  return {
    connected,
    emitted: [],
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(fn);
    },
    off(event, fn) {
      handlers.get(event)?.delete(fn);
    },
    emit(event, payload, ack) {
      this.emitted.push({ event, payload });
      if (typeof ack === 'function') ack({ ok: true });
    },
    /** Simulate the server sending an event to this client. */
    serverSends(event, payload) {
      for (const fn of handlers.get(event) || []) fn(payload);
    },
  };
}

export const baseRide = (overrides = {}) => ({
  id: 'r1',
  status: 'SEARCHING',
  passengerId: 'p1',
  driverId: null,
  pickup: { address: 'MG Road', lat: 12.97, lng: 77.59 },
  destination: { address: 'Koramangala', lat: 12.93, lng: 77.62 },
  estimatedFare: 15400,
  finalFare: null,
  currency: 'INR',
  estimate: { distanceMeters: 5100, durationSeconds: 734, source: 'straight_line' },
  matchingRadiusKm: 3,
  driver: null,
  driverLocation: null,
  payment: null,
  ...overrides,
});

export const driver = { id: 'd1', name: 'Ravi Kumar', phone: null, vehicle: { type: 'CAR', registrationNumber: 'KA01AB1234', model: 'Swift', color: 'White' } };
