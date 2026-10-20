'use strict';

// One place that sends Socket.IO events. The "target" is either:
// - the Socket.IO server (API process), or
// - a @socket.io/mongo-emitter (recovery-worker process), which writes the
//   event to a MongoDB collection that every API process's Mongo adapter
//   reads and forwards to connected clients.
//
// Notifications are fire-and-forget hints. The database is the source of
// truth; clients re-fetch state over REST after reconnecting.
const logger = require('../utils/logger');

let target = null;

function setTarget(t) {
  target = t;
}

function emit(room, event, payload) {
  if (!target) return;
  try {
    target.to(room).emit(event, payload);
  } catch (err) {
    logger.warn({ err: err.message, event }, 'socket emit failed');
  }
}

const userRoom = (userId) => `user:${userId}`;
const rideRoom = (rideId) => `ride:${rideId}`;

const toUser = (userId, event, payload) => emit(userRoom(String(userId)), event, payload);
const toRide = (rideId, event, payload) => emit(rideRoom(String(rideId)), event, payload);
// Every connected administrator (sockets of ADMIN users join this room on connect).
const ADMIN_ROOM = 'role:ADMIN';
const toAdmins = (event, payload) => emit(ADMIN_ROOM, event, payload);

/** Status changes go to the passenger and (if any) the driver's personal rooms. */
function rideStatus(ride, event, extra = {}) {
  const payload = { rideId: String(ride._id), status: ride.status, ...extra };
  toUser(ride.passengerId, event, payload);
  if (ride.driverId) toUser(ride.driverId, event, payload);
}

module.exports = { setTarget, toUser, toRide, toAdmins, rideStatus, userRoom, rideRoom, ADMIN_ROOM };
