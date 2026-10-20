'use strict';

const { RIDE_STATUS: S } = require('../utils/constants');

// The only status changes a ride may ever make. Anything else is rejected.
const TRANSITIONS = Object.freeze({
  [S.SEARCHING]: Object.freeze([S.DRIVER_ASSIGNED, S.CANCELLED, S.NO_DRIVER_FOUND]),
  [S.DRIVER_ASSIGNED]: Object.freeze([S.DRIVER_ARRIVED, S.CANCELLED]),
  [S.DRIVER_ARRIVED]: Object.freeze([S.IN_PROGRESS, S.CANCELLED]),
  [S.IN_PROGRESS]: Object.freeze([S.COMPLETED]),
  [S.COMPLETED]: Object.freeze([]),
  [S.CANCELLED]: Object.freeze([]),
  [S.NO_DRIVER_FOUND]: Object.freeze([]),
});

const TERMINAL = Object.freeze([S.COMPLETED, S.CANCELLED, S.NO_DRIVER_FOUND]);
/** Statuses during which a driver is attached to the ride. */
const DRIVER_ATTACHED = Object.freeze([S.DRIVER_ASSIGNED, S.DRIVER_ARRIVED, S.IN_PROGRESS]);
/** Statuses from which the passenger may cancel. */
const PASSENGER_CANCELLABLE = Object.freeze([S.SEARCHING, S.DRIVER_ASSIGNED, S.DRIVER_ARRIVED]);

function canTransition(from, to) {
  return Boolean(TRANSITIONS[from]) && TRANSITIONS[from].includes(to);
}

/** Statuses from which `to` may be reached (used to build conditional updates). */
function sourcesOf(to) {
  return Object.keys(TRANSITIONS).filter((from) => TRANSITIONS[from].includes(to));
}

const isTerminal = (status) => TERMINAL.includes(status);

module.exports = { TRANSITIONS, TERMINAL, DRIVER_ATTACHED, PASSENGER_CANCELLABLE, canTransition, sourcesOf, isTerminal };
