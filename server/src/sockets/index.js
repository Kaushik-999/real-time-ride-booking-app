'use strict';

const { Server } = require('socket.io');
const mongoose = require('mongoose');
const config = require('../config');
const logger = require('../utils/logger');
const notifier = require('./notifier');
const { verifyToken } = require('../services/authService');
const { User, Ride } = require('../models');
const { ROLES } = require('../utils/constants');

const ADAPTER_COLLECTION = 'socket_io_events';

/** Capped collection used by the Socket.IO MongoDB adapter/emitter. */
async function getAdapterCollection() {
  const db = mongoose.connection.db;
  try {
    await db.createCollection(ADAPTER_COLLECTION, { capped: true, size: 5 * 1024 * 1024 });
  } catch (err) {
    if (err.codeName !== 'NamespaceExists') throw err;
  }
  return db.collection(ADAPTER_COLLECTION);
}

/**
 * Attach Socket.IO to the HTTP server.
 * - Every connection must present a valid JWT (handshake `auth.token`).
 * - Each socket automatically joins only its own `user:<id>` room.
 * - Joining a `ride:<id>` room (live driver location) requires the server
 *   to confirm the user is that ride's passenger, its driver, or an admin.
 */
async function createSocketServer(httpServer, { adapter = config.socket.adapter } = {}) {
  const io = new Server(httpServer, {
    cors: { origin: config.corsOrigins },
    serveClient: false,
  });

  if (adapter === 'mongo') {
    const { createAdapter } = require('@socket.io/mongo-adapter');
    io.adapter(createAdapter(await getAdapterCollection(), { addCreatedAtField: true }));
  }

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth && socket.handshake.auth.token;
      if (!token) return next(new Error('UNAUTHORIZED'));
      const payload = verifyToken(token);
      const user = await User.findById(payload.sub).select('role name').lean();
      if (!user) return next(new Error('UNAUTHORIZED'));
      socket.data.user = { id: String(user._id), role: user.role };
      next();
    } catch {
      next(new Error('UNAUTHORIZED'));
    }
  });

  io.on('connection', (socket) => {
    const { user } = socket.data;
    socket.join(notifier.userRoom(user.id));
    if (user.role === ROLES.ADMIN) socket.join(notifier.ADMIN_ROOM);

    // Chat. Each call re-checks in MongoDB that this user is a participant of
    // the ride; joining rooms grants nothing by itself.
    const chatService = require('../services/chatService');
    const respond = (ack) => (typeof ack === 'function' ? ack : () => {});
    const chatError = (err) => ({ ok: false, error: err.code || 'SERVER_ERROR', message: err.status && err.status < 500 ? err.message : 'Something went wrong' });
    socket.on('chat:send', async (payload, ack) => {
      const reply = respond(ack);
      try {
        const p = payload || {};
        if (typeof p.rideId !== 'string' || !/^[a-f\d]{24}$/i.test(p.rideId)) return reply({ ok: false, error: 'INVALID_RIDE_ID' });
        const result = await chatService.sendMessage(user, p.rideId, { body: p.body, clientMessageId: p.clientMessageId });
        reply({ ok: true, ...result });
      } catch (err) {
        reply(chatError(err));
      }
    });
    socket.on('chat:history', async (payload, ack) => {
      const reply = respond(ack);
      try {
        const p = payload || {};
        if (typeof p.rideId !== 'string' || !/^[a-f\d]{24}$/i.test(p.rideId)) return reply({ ok: false, error: 'INVALID_RIDE_ID' });
        reply({ ok: true, ...(await chatService.history(user, p.rideId, { before: p.before })) });
      } catch (err) {
        reply(chatError(err));
      }
    });

    socket.on('ride:subscribe', async (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        const rideId = payload && payload.rideId;
        if (typeof rideId !== 'string' || !/^[a-f\d]{24}$/i.test(rideId)) return reply({ ok: false, error: 'INVALID_RIDE_ID' });
        const ride = await Ride.findById(rideId).select('passengerId driverId status').lean();
        const allowed =
          ride &&
          (String(ride.passengerId) === user.id ||
            (ride.driverId && String(ride.driverId) === user.id) ||
            user.role === ROLES.ADMIN);
        if (!allowed) return reply({ ok: false, error: 'FORBIDDEN' });
        socket.join(notifier.rideRoom(rideId));
        reply({ ok: true, status: ride.status });
      } catch (err) {
        logger.warn({ err: err.message }, 'ride:subscribe failed');
        reply({ ok: false, error: 'SERVER_ERROR' });
      }
    });

    socket.on('ride:unsubscribe', (payload) => {
      if (payload && typeof payload.rideId === 'string') socket.leave(notifier.rideRoom(payload.rideId));
    });
  });

  notifier.setTarget(io);
  return io;
}

/** For processes without a Socket.IO server (the recovery worker). */
async function createMongoEmitter() {
  const { Emitter } = require('@socket.io/mongo-emitter');
  return new Emitter(await getAdapterCollection());
}

module.exports = { createSocketServer, createMongoEmitter, ADAPTER_COLLECTION };
