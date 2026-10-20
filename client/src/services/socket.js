import { io } from 'socket.io-client';

// One authenticated Socket.IO connection per signed-in user. Events are only
// hints that something changed; screens re-fetch the ride over REST to learn
// the authoritative state (see hooks/useRideTracking.js).
let socket = null;

export function connectSocket(token) {
  disconnectSocket();
  socket = io({ path: '/socket.io', auth: { token }, transports: ['websocket', 'polling'] });
  return socket;
}

export function getSocket() {
  return socket;
}

export function disconnectSocket() {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }
}
