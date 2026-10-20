import { errorMessage } from '../services/api';
import { formatMoney, toLatLng } from '../utils/format';

describe('#89 toLatLng', () => {
  test.each([
    [{ lat: 12.9, lng: 77.6 }, [12.9, 77.6]],
    [{ lat: 0, lng: 0 }, [0, 0]],
    [null, null],
    [{ lat: '12.9', lng: 77.6 }, null],
    [{ lat: 91, lng: 77 }, null],
    [{ lat: 12, lng: 181 }, null],
    [{ lat: Infinity, lng: 1 }, null],
    [{ lat: 12 }, null],
  ])('%j -> %j', (input, expected) => expect(toLatLng(input)).toEqual(expected));
});

describe('#87 errorMessage', () => {
  test('uses the API error message and first validation detail', () => {
    expect(errorMessage({ response: { data: { error: { message: 'Request validation failed', details: [{ path: 'pickup.lat', message: 'Number must be less than or equal to 90' }] } } } })).toBe(
      'Request validation failed: pickup.lat Number must be less than or equal to 90'
    );
  });
  test('explains network failures and timeouts', () => {
    expect(errorMessage({ request: {}, message: 'Network Error' })).toMatch(/Cannot reach the server/);
    expect(errorMessage({ code: 'ECONNABORTED' })).toMatch(/took too long/);
  });
});

test('money is shown in rupees from integer paise', () => {
  expect(formatMoney(20600)).toMatch(/206/);
  expect(formatMoney(undefined)).toBe('—');
});
