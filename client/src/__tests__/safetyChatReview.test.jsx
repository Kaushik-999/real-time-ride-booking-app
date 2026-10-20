import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import SafetyButton from '../components/SafetyButton';
import ChatPanel, { mergeMessages } from '../components/ChatPanel';
import ReviewForm from '../components/ReviewForm';
import { rideApi } from '../services/api';
import { baseRide, fakeSocket } from './helpers';

vi.mock('../services/api', async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    rideApi: { ...actual.rideApi, reportSafety: vi.fn(), messages: vi.fn(), sendMessage: vi.fn(), myReview: vi.fn(), review: vi.fn() },
  };
});
beforeEach(() => vi.clearAllMocks());

const active = baseRide({ status: 'IN_PROGRESS', driverId: 'd1' });

describe('Safety button', () => {
  test('asks for confirmation, then shows exactly what the server reported (no false police claim)', async () => {
    rideApi.reportSafety.mockResolvedValue({
      incident: { emergency: { status: 'NOT_CONFIGURED', policeNotified: false, emergencyNumber: '112', message: 'Automated police dispatch is not available in this app. Our safety team has been alerted. If you are in danger, call 112 now.' } },
    });
    render(<SafetyButton ride={active} />);
    await userEvent.click(screen.getByRole('button', { name: 'Safety help' }));
    expect(rideApi.reportSafety).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Send safety alert' }));
    const result = await screen.findByTestId('safety-result');
    expect(result).toHaveTextContent(/not available/);
    expect(result).not.toHaveTextContent(/police (have been|were) notified/i);
    expect(screen.getByRole('link', { name: 'Call 112' })).toHaveAttribute('href', 'tel:112');
  });

  test('a failed request is shown as NOT recorded, with the emergency number', async () => {
    rideApi.reportSafety.mockRejectedValue({ request: {}, message: 'Network Error' });
    render(<SafetyButton ride={active} emergencyNumber="112" />);
    await userEvent.click(screen.getByRole('button', { name: 'Safety help' }));
    await userEvent.click(screen.getByRole('button', { name: 'Send safety alert' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/NOT recorded/);
    expect(screen.queryByTestId('safety-result')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Call 112' })).toBeInTheDocument();
  });

  test('is hidden outside an active ride', () => {
    const { container } = render(<SafetyButton ride={baseRide({ status: 'COMPLETED' })} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('Chat', () => {
  const msg = (id, body, senderRole = 'DRIVER', t = 0) => ({ id, rideId: 'r1', body, senderRole, createdAt: new Date(1700000000000 + t).toISOString() });

  test('mergeMessages de-duplicates by id and keeps time order', () => {
    const out = mergeMessages([msg('a', 'one', 'DRIVER', 1)], [msg('b', 'two', 'PASSENGER', 2), msg('a', 'one', 'DRIVER', 1)]);
    expect(out.map((m) => m.id)).toEqual(['a', 'b']);
  });

  test('loads history, sends over the socket, and an echoed copy does not duplicate', async () => {
    rideApi.messages.mockResolvedValue({ messages: [msg('a', 'I am outside')] });
    const socket = fakeSocket();
    socket.timeout = () => ({ emit: (event, payload, cb) => cb(null, { ok: true, message: msg('b', payload.body, 'PASSENGER', 5) }) });
    render(<ChatPanel ride={active} socket={socket} myRole="PASSENGER" />);
    expect(await screen.findByText('I am outside')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Message'), 'Coming');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Coming')).toBeInTheDocument();
    await act(async () => socket.serverSends('chat:message', msg('b', 'Coming', 'PASSENGER', 5)));
    expect(screen.getAllByText('Coming')).toHaveLength(1);
  });

  test('re-fetches history after a reconnect', async () => {
    rideApi.messages.mockResolvedValueOnce({ messages: [] });
    const socket = fakeSocket();
    render(<ChatPanel ride={active} socket={socket} myRole="PASSENGER" />);
    await waitFor(() => expect(rideApi.messages).toHaveBeenCalledTimes(1));
    rideApi.messages.mockResolvedValueOnce({ messages: [msg('z', 'sent while offline')] });
    await act(async () => socket.serverSends('connect'));
    expect(await screen.findByText('sent while offline')).toBeInTheDocument();
  });

  test('shows the rate-limit error from the server', async () => {
    rideApi.messages.mockResolvedValue({ messages: [] });
    const socket = fakeSocket();
    socket.timeout = () => ({ emit: (e, p, cb) => cb(null, { ok: false, error: 'CHAT_RATE_LIMITED', message: 'You are sending messages too quickly' }) });
    render(<ChatPanel ride={active} socket={socket} myRole="PASSENGER" />);
    await userEvent.type(await screen.findByLabelText('Message'), 'hi');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('too quickly');
  });

  test('after the ride ends the history is read-only', async () => {
    rideApi.messages.mockResolvedValue({ messages: [msg('a', 'thanks')] });
    render(<ChatPanel ride={baseRide({ status: 'COMPLETED', driverId: 'd1' })} socket={fakeSocket()} myRole="PASSENGER" />);
    expect(await screen.findByText('thanks')).toBeInTheDocument();
    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument();
    expect(screen.getByText(/Chat is closed/)).toBeInTheDocument();
  });
});

describe('Rating form', () => {
  const done = baseRide({ status: 'COMPLETED', driverId: 'd1' });

  test('requires a rating, submits it, then shows thanks', async () => {
    rideApi.myReview.mockResolvedValue({ review: null });
    rideApi.review.mockResolvedValue({ review: { rating: 4 } });
    render(<ReviewForm ride={done} myRole="PASSENGER" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Submit rating' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/Choose a rating/);
    expect(rideApi.review).not.toHaveBeenCalled();
    await userEvent.click(screen.getAllByRole('radio', { name: '4 stars' })[0]);
    await userEvent.click(screen.getByRole('button', { name: 'Submit rating' }));
    expect(rideApi.review).toHaveBeenCalledWith('r1', { rating: 4 });
    expect(await screen.findByTestId('review-done')).toHaveTextContent('4 out of 5');
  });

  test('drivers do not get the vehicle/service question', async () => {
    rideApi.myReview.mockResolvedValue({ review: null });
    render(<ReviewForm ride={done} myRole="DRIVER" />);
    await screen.findByRole('button', { name: 'Submit rating' });
    expect(screen.queryByText(/vehicle and service/)).not.toBeInTheDocument();
  });

  test('a duplicate submission shows the server message', async () => {
    rideApi.myReview.mockResolvedValue({ review: null });
    rideApi.review.mockRejectedValue({ response: { data: { error: { code: 'ALREADY_REVIEWED', message: 'You have already rated this ride' } } } });
    render(<ReviewForm ride={done} myRole="PASSENGER" />);
    await userEvent.click((await screen.findAllByRole('radio', { name: '5 stars' }))[0]);
    await userEvent.click(screen.getByRole('button', { name: 'Submit rating' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already rated');
  });
});
