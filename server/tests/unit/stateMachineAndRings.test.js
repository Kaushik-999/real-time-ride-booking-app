'use strict';

const { canTransition, sourcesOf, isTerminal } = require('../../src/services/rideStateMachine');
const { buildRings } = require('../../src/services/matchingService');
const { haversineMeters, destinationPoint, toPoint, fromPoint, isValidLatLng } = require('../../src/utils/geo');

describe('ride state machine', () => {
  const valid = [
    ['SEARCHING', 'DRIVER_ASSIGNED'],
    ['SEARCHING', 'CANCELLED'],
    ['SEARCHING', 'NO_DRIVER_FOUND'],
    ['DRIVER_ASSIGNED', 'DRIVER_ARRIVED'],
    ['DRIVER_ASSIGNED', 'CANCELLED'],
    ['DRIVER_ARRIVED', 'IN_PROGRESS'],
    ['DRIVER_ARRIVED', 'CANCELLED'],
    ['IN_PROGRESS', 'COMPLETED'],
  ];
  test.each(valid)('allows %s -> %s', (a, b) => expect(canTransition(a, b)).toBe(true));

  const invalid = [
    ['SEARCHING', 'IN_PROGRESS'],
    ['SEARCHING', 'COMPLETED'],
    ['DRIVER_ASSIGNED', 'IN_PROGRESS'],
    ['IN_PROGRESS', 'CANCELLED'],
    ['COMPLETED', 'IN_PROGRESS'],
    ['CANCELLED', 'SEARCHING'],
    ['NO_DRIVER_FOUND', 'DRIVER_ASSIGNED'],
    ['BOGUS', 'SEARCHING'],
  ];
  test.each(invalid)('#20 rejects %s -> %s', (a, b) => expect(canTransition(a, b)).toBe(false));

  test('terminal states and sources', () => {
    expect(isTerminal('COMPLETED')).toBe(true);
    expect(isTerminal('IN_PROGRESS')).toBe(false);
    expect(sourcesOf('CANCELLED').sort()).toEqual(['DRIVER_ARRIVED', 'DRIVER_ASSIGNED', 'SEARCHING']);
  });
});

describe('progressive rings', () => {
  test('default 3/3/12 km gives four non-overlapping rings in metres', () => {
    expect(buildRings({ initialRadiusKm: 3, radiusStepKm: 3, maxRadiusKm: 12 })).toEqual([
      { index: 0, minMeters: 0, maxMeters: 3000 },
      { index: 1, minMeters: 3000, maxMeters: 6000 },
      { index: 2, minMeters: 6000, maxMeters: 9000 },
      { index: 3, minMeters: 9000, maxMeters: 12000 },
    ]);
  });
  test('max radius that is not a multiple of the step caps the last ring', () => {
    expect(buildRings({ initialRadiusKm: 2, radiusStepKm: 4, maxRadiusKm: 8 }).map((r) => r.maxMeters)).toEqual([2000, 6000, 8000]);
  });
});

describe('geo helpers', () => {
  test('GeoJSON uses [lng, lat]', () => {
    expect(toPoint({ lat: 12.9, lng: 77.6 })).toEqual({ type: 'Point', coordinates: [77.6, 12.9] });
    expect(fromPoint({ type: 'Point', coordinates: [77.6, 12.9] })).toEqual({ lat: 12.9, lng: 77.6 });
  });
  test('destinationPoint and haversine agree', () => {
    const o = { lat: 12.9716, lng: 77.5946 };
    for (const km of [1, 3, 7.5, 12]) {
      expect(Math.abs(haversineMeters(o, destinationPoint(o, km * 1000, 45)) - km * 1000)).toBeLessThan(1);
    }
  });
  test('#12 coordinate validation', () => {
    expect(isValidLatLng(12, 77)).toBe(true);
    expect(isValidLatLng(91, 77)).toBe(false);
    expect(isValidLatLng(12, 181)).toBe(false);
    expect(isValidLatLng(NaN, 0)).toBe(false);
    expect(isValidLatLng('12', 77)).toBe(false);
  });
});
