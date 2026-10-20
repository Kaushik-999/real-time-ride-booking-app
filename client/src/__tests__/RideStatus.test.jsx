import { render, screen } from '@testing-library/react';
import RideStatus from '../components/RideStatus';
import { baseRide, driver } from './helpers';

describe('#84 passenger ride status display', () => {
  const cases = [
    ['SEARCHING', 'Finding you a driver'],
    ['DRIVER_ASSIGNED', 'Driver on the way'],
    ['DRIVER_ARRIVED', 'Driver is at pickup'],
    ['IN_PROGRESS', 'On the way'],
    ['COMPLETED', 'Ride complete'],
    ['CANCELLED', 'Ride cancelled'],
    ['NO_DRIVER_FOUND', 'No driver nearby'],
  ];
  test.each(cases)('%s shows "%s"', (status, text) => {
    const attached = ['DRIVER_ASSIGNED', 'DRIVER_ARRIVED', 'IN_PROGRESS', 'COMPLETED'].includes(status);
    render(<RideStatus ride={baseRide({ status, driver: attached ? driver : null, finalFare: status === 'COMPLETED' ? 20600 : null })} />);
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(text);
    expect(screen.getByTestId('ride-status')).toHaveAttribute('data-status', status);
  });

  test('searching explains the current radius', () => {
    render(<RideStatus ride={baseRide({ matchingRadiusKm: 6 })} />);
    expect(screen.getByText(/within 6 km/)).toBeInTheDocument();
  });

  test('completed ride shows the final fare, not the estimate, and payment status separately', () => {
    render(<RideStatus ride={baseRide({ status: 'COMPLETED', finalFare: 20600, driver, payment: { status: 'PENDING', method: 'ONLINE', amount: 20600 } })} />);
    expect(screen.getByTestId('final-fare')).toHaveTextContent('206');
    expect(screen.getByTestId('payment-status')).toHaveTextContent('not paid yet');
  });

  test('driver details appear once assigned', () => {
    render(<RideStatus ride={baseRide({ status: 'DRIVER_ASSIGNED', driverId: 'd1', driver })} />);
    expect(screen.getByTestId('driver-card')).toHaveTextContent('Ravi Kumar');
    expect(screen.getByTestId('driver-card')).toHaveTextContent('KA01AB1234');
  });
});

describe('#88 no confirmed driver before the backend assigns one', () => {
  test('a SEARCHING ride never shows a driver, even if driver data is present', () => {
    render(<RideStatus ride={baseRide({ status: 'SEARCHING', driver })} />);
    expect(screen.queryByTestId('driver-card')).not.toBeInTheDocument();
    expect(screen.queryByText('Ravi Kumar')).not.toBeInTheDocument();
  });
  test('a NO_DRIVER_FOUND ride shows no driver', () => {
    render(<RideStatus ride={baseRide({ status: 'NO_DRIVER_FOUND', driver })} />);
    expect(screen.queryByTestId('driver-card')).not.toBeInTheDocument();
  });
});
