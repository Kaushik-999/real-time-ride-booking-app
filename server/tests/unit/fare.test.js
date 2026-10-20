'use strict';

const { calculateFare, calculateFinalFare } = require('../../src/services/fareService');
const { straightLine } = require('../../src/services/routingService');

const rates = { currency: 'INR', basePaise: 5000, perKmPaise: 1200, perMinPaise: 150, minimumPaise: 8000 };

describe('#11 fare calculation', () => {
  test('base + distance x perKm + duration x perMin, rounded to the rupee', () => {
    // 10 km, 24 min: 5000 + 12000 + 3600 = 20600 paise = ₹206
    const fare = calculateFare({ distanceMeters: 10000, durationSeconds: 24 * 60 }, rates);
    expect(fare.totalPaise).toBe(20600);
    expect(fare.breakdown).toMatchObject({ basePaise: 5000, distancePaise: 12000, timePaise: 3600, minimumApplied: false });
  });

  test('minimum fare applies to very short trips', () => {
    const fare = calculateFare({ distanceMeters: 500, durationSeconds: 60 }, rates);
    expect(fare.totalPaise).toBe(8000);
    expect(fare.breakdown.minimumApplied).toBe(true);
  });

  test('results are always whole paise (no floating-point leftovers)', () => {
    for (const d of [1, 333, 1234.567, 98765]) {
      const fare = calculateFare({ distanceMeters: d, durationSeconds: d / 7 }, rates);
      expect(Number.isInteger(fare.totalPaise)).toBe(true);
      expect(fare.totalPaise % 100).toBe(0);
    }
  });

  test('#13 rejects negative or malformed inputs', () => {
    expect(() => calculateFare({ distanceMeters: -1, durationSeconds: 10 }, rates)).toThrow(/distance/);
    expect(() => calculateFare({ distanceMeters: 10, durationSeconds: NaN }, rates)).toThrow(/duration/);
    expect(() => calculateFare({ distanceMeters: 'abc', durationSeconds: 10 }, rates)).toThrow();
  });

  test('straight-line estimate is labelled as such', () => {
    const r = straightLine({ lat: 12.9716, lng: 77.5946 }, { lat: 12.9352, lng: 77.6245 });
    expect(r.source).toBe('straight_line');
    expect(r.distanceMeters).toBeGreaterThan(5000);
    expect(r.distanceMeters).toBeLessThan(6000);
  });

  test('#71 final fare uses server-recorded trip distance and duration', () => {
    const startedAt = new Date('2026-01-01T10:00:00Z');
    const completedAt = new Date('2026-01-01T10:30:00Z');
    const ride = { tripDistanceMeters: 12000, startedAt, estimate: { distanceMeters: 5000 } };
    const fare = calculateFinalFare(ride, completedAt);
    expect(fare.breakdown.distanceMeters).toBe(12000);
    expect(fare.breakdown.durationSeconds).toBe(1800);
    // falls back to the estimate when no in-trip location updates arrived
    const fallback = calculateFinalFare({ ...ride, tripDistanceMeters: 0 }, completedAt);
    expect(fallback.breakdown.distanceMeters).toBe(5000);
  });
});
