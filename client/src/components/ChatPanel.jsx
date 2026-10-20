import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage, rideApi } from '../services/api';
import { newRequestKey } from '../utils/format';

const CHAT_OPEN = ['DRIVER_ASSIGNED', 'DRIVER_ARRIVED', 'IN_PROGRESS'];
const MAX = 500;

/** Merge messages by id, keep time order (socket echoes + REST history never duplicate). */
export function mergeMessages(current, incoming) {
  const byId = new Map(current.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}

/**
 * Chat with the other person on this ride. History comes from the server
 * (the source of truth) on open and on every reconnect; new messages arrive
 * over Socket.IO. Sending uses the socket when connected, REST otherwise.
 */
export default function ChatPanel({ ride, socket, myRole }) {
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [error, setError] = useState(null);
  const [sending, setSending] = useState(false);
  const [unavailable, setUnavailable] = useState(null);
  const listRef = useRef(null);
  const canSend = ride && CHAT_OPEN.includes(ride.status);

  const loadHistory = useCallback(async () => {
    try {
      const data = await rideApi.messages(ride.id);
      setMessages((m) => mergeMessages(m, data.messages));
      setUnavailable(null);
    } catch (err) {
      setUnavailable(errorMessage(err));
    }
  }, [ride && ride.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    if (!socket) return undefined;
    const onMessage = (m) => m && m.rideId === ride.id && setMessages((cur) => mergeMessages(cur, [m]));
    socket.on('chat:message', onMessage);
    socket.on('connect', loadHistory);
    return () => {
      socket.off('chat:message', onMessage);
      socket.off('connect', loadHistory);
    };
  }, [socket, ride && ride.id, loadHistory]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages.length]);

  const send = async (e) => {
    e.preventDefault();
    const body = text.trim();
    if (!body || body.length > MAX || sending) return;
    setSending(true);
    setError(null);
    const clientMessageId = newRequestKey().replace(/[^A-Za-z0-9_-]/g, '');
    try {
      let result;
      if (socket && socket.connected) {
        result = await new Promise((resolve) => socket.timeout(8000).emit('chat:send', { rideId: ride.id, body, clientMessageId }, (err, ack) => resolve(err ? { ok: false, message: 'Message not confirmed. Check your connection.' } : ack)));
        if (!result.ok) throw new Error(result.message || 'Message not sent');
      } else {
        result = await rideApi.sendMessage(ride.id, { body, clientMessageId });
      }
      setMessages((m) => mergeMessages(m, [result.message]));
      setText('');
    } catch (err) {
      setError(err.response ? errorMessage(err) : err.message);
    } finally {
      setSending(false);
    }
  };

  if (unavailable && messages.length === 0) {
    return canSend ? <p className="mt-4 text-sm text-fog">{unavailable}</p> : null;
  }
  return (
    <section className="mt-5" aria-label="Chat">
      <h3 className="font-semibold">Messages</h3>
      <ol ref={listRef} className="mt-2 max-h-48 space-y-2 overflow-y-auto rounded-md border border-line bg-white p-2 text-sm" data-testid="chat-list">
        {messages.length === 0 && <li className="text-fog">No messages yet.</li>}
        {messages.map((m) => {
          const mine = m.senderRole === myRole;
          return (
            <li key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
              <span className={`max-w-[80%] rounded-md px-3 py-1.5 ${mine ? 'bg-asphalt text-chalk' : 'bg-chalk'}`}>{m.body}</span>
            </li>
          );
        })}
      </ol>
      {canSend ? (
        <form onSubmit={send} className="mt-2 flex gap-2">
          <label htmlFor="chat-input" className="sr-only">
            Message
          </label>
          <input id="chat-input" className="field" value={text} maxLength={MAX} onChange={(e) => setText(e.target.value)} placeholder="Write a message" />
          <button type="submit" className="btn-quiet shrink-0" disabled={sending || !text.trim()}>
            {sending ? 'Sending…' : 'Send'}
          </button>
        </form>
      ) : (
        <p className="mt-1 text-xs text-fog">Chat is closed. This conversation stays visible for 24 hours after the ride.</p>
      )}
      {error && (
        <p role="alert" className="mt-1 text-sm text-brake">
          {error}
        </p>
      )}
    </section>
  );
}
