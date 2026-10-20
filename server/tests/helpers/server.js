'use strict';

const http = require('http');
const { io: ioClient } = require('socket.io-client');
const { createApp } = require('../../src/app');
const { createSocketServer } = require('../../src/sockets');

/** Start the real HTTP + Socket.IO server on a random port. */
async function startServer(opts = {}) {
  const app = createApp();
  const server = http.createServer(app);
  const io = await createSocketServer(server, opts);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const sockets = [];

  /** Connected client that records every event it receives. */
  async function connect(token) {
    const socket = ioClient(url, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
    sockets.push(socket);
    socket.received = [];
    socket.onAny((event, payload) => socket.received.push({ event, payload }));
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    return socket;
  }

  async function close() {
    sockets.forEach((s) => s.disconnect());
    await new Promise((r) => io.close(() => r()));
    await new Promise((r) => server.close(() => r()));
  }

  return { app, server, io, url, connect, close };
}

const waitForEvent = (socket, event, predicate = () => true, timeout = 5000) =>
  new Promise((resolve, reject) => {
    const existing = socket.received.find((e) => e.event === event && predicate(e.payload));
    if (existing) return resolve(existing.payload);
    const t = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timed out waiting for ${event}`));
    }, timeout);
    function handler(payload) {
      if (!predicate(payload)) return;
      clearTimeout(t);
      socket.off(event, handler);
      resolve(payload);
    }
    socket.on(event, handler);
  });

const emitWithAck = (socket, event, payload) => new Promise((resolve) => socket.emit(event, payload, resolve));

module.exports = { startServer, waitForEvent, emitWithAck };
