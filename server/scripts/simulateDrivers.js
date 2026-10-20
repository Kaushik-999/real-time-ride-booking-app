'use strict';

/**
 * Development-only driver simulator for manual end-to-end testing.
 *
 *   docker compose exec backend npm run simulate:drivers
 *
 * Creates (or reuses) four approved demo drivers around a centre point and
 * keeps them online with fresh locations through the REAL API. When an
 * offer arrives (over Socket.IO), each driver behaves differently so you can
 * watch progressive-radius matching work:
 *   Demo Driver 1.5km  -> declines the offer
 *   Demo Driver 4.5km  -> ignores it (offer times out after 15 s)
 *   Demo Driver 7.5km  -> accepts, then drives: arrive -> start -> complete
 *   Demo Driver 10.5km -> accepts if it ever gets an offer
 *
 * Env: SIM_API (default http://localhost:4000), SIM_LAT / SIM_LNG (default
 * central Bengaluru), SIM_PASSWORD (default DemoDriver1).
 * The script writes driver approval directly to MongoDB because it is a
 * local tool; never run it against production.
 *
 * Trip codes: a real driver gets the pickup/drop-off code from the passenger.
 * There is no passenger here, so the simulator reads the code the same way
 * the passenger's app does (rideOtpService.revealForPassenger), and logs that
 * it did so. This is a development shortcut only.
 */
const bcrypt = require('bcryptjs');
const { io } = require('socket.io-client');
const config = require('../src/config');
const { connectDb } = require('../src/config/db');
const mongoose = require('mongoose');
const { User, DriverProfile, ensureIndexes } = require('../src/models');
const { runMigrations } = require('../src/migrations');
const rideOtpService = require('../src/services/rideOtpService');
const { destinationPoint, haversineMeters } = require('../src/utils/geo');

if (config.isProduction) {
  console.error('Refusing to run the simulator in production.');
  process.exit(1);
}

const API = process.env.SIM_API || `http://localhost:${config.port}`;
const CENTER = { lat: Number(process.env.SIM_LAT || 12.9716), lng: Number(process.env.SIM_LNG || 77.5946) };
const PASSWORD = process.env.SIM_PASSWORD || 'DemoDriver1';
const DRIVERS = [
  { km: 1.5, bearing: 30, behaviour: 'decline', reg: 'KA01SIM0001' },
  { km: 4.5, bearing: 120, behaviour: 'ignore', reg: 'KA01SIM0002' },
  { km: 7.5, bearing: 210, behaviour: 'accept', reg: 'KA01SIM0003' },
  { km: 10.5, bearing: 300, behaviour: 'accept', reg: 'KA01SIM0004' },
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(token, method, path, body) {
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${json.error ? json.error.message : ''}`);
  return json.data;
}

async function ensureDriver(spec) {
  const name = `Demo Driver ${spec.km}km`;
  const email = `demo.driver.${spec.reg.toLowerCase()}@example.com`;
  let user = await User.findOne({ email });
  if (!user) {
    user = await User.create({ name, email, role: 'DRIVER', passwordHash: await bcrypt.hash(PASSWORD, 10) });
    await DriverProfile.create({
      userId: user._id,
      vehicle: { type: 'CAR', registrationNumber: spec.reg, model: 'Demo', color: 'Yellow' },
      identity: { legalName: name, dateOfBirth: new Date('1990-01-01'), licenseNumber: `DL${spec.reg}` },
    });
  }
  // Dev shortcut: mark the demo driver as reviewed and approved.
  await DriverProfile.updateOne({ userId: user._id }, { $set: { approvalStatus: 'APPROVED' } });
  const login = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  }).then((r) => r.json());
  if (!login.success) throw new Error(`login failed for ${email}`);
  return { ...spec, name, token: login.data.token, position: destinationPoint(CENTER, spec.km * 1000, spec.bearing), busy: false };
}

function log(d, msg) {
  console.log(`[${new Date().toLocaleTimeString()}] ${d.name}: ${msg}`);
}

async function driveTo(d, target, stepMeters = 400) {
  while (haversineMeters(d.position, target) > stepMeters) {
    const bearing = (Math.atan2(target.lng - d.position.lng, target.lat - d.position.lat) * 180) / Math.PI;
    d.position = destinationPoint(d.position, stepMeters, (bearing + 360) % 360);
    await call(d.token, 'PATCH', '/drivers/me/location', d.position).catch(() => {});
    await sleep(1500);
  }
  d.position = { ...target };
  await call(d.token, 'PATCH', '/drivers/me/location', d.position).catch(() => {});
}

async function runTrip(d, rideId) {
  d.busy = true;
  try {
    const { ride } = await call(d.token, 'GET', `/rides/${rideId}`);
    log(d, 'driving to pickup');
    await driveTo(d, ride.pickup, 800);
    await call(d.token, 'POST', `/rides/${rideId}/arrive`, {});
    log(d, 'arrived at pickup');
    await sleep(4000);
    const startCode = await rideOtpService.revealForPassenger(rideId, ride.passengerId);
    log(d, 'got the pickup code (simulated passenger)');
    const started = await call(d.token, 'POST', `/rides/${rideId}/start`, { otp: startCode.code });
    log(d, 'trip started; destination now visible');
    await driveTo(d, started.ride.destination, 400);
    const endCode = await rideOtpService.revealForPassenger(rideId, ride.passengerId);
    const done = await call(d.token, 'POST', `/rides/${rideId}/complete`, { otp: endCode.code });
    log(d, `trip completed, fare ₹${done.ride.finalFare / 100}`);
    if (done.ride.paymentMethod === 'CASH') await call(d.token, 'POST', `/rides/${rideId}/cash-collected`, {});
  } catch (err) {
    log(d, `trip stopped: ${err.message}`);
  } finally {
    d.busy = false;
  }
}

async function main() {
  await connectDb();
  await runMigrations(mongoose.connection.db);
  await ensureIndexes();
  const drivers = [];
  for (const spec of DRIVERS) drivers.push(await ensureDriver(spec));

  for (const d of drivers) {
    await call(d.token, 'PATCH', '/drivers/me/location', d.position);
    await call(d.token, 'PATCH', '/drivers/me/availability', { availability: 'AVAILABLE' }).catch((e) => log(d, e.message));
    const socket = io(API, { auth: { token: d.token }, transports: ['websocket'] });
    socket.on('connect', () => log(d, `online at ${d.km} km (${d.behaviour})`));
    socket.on('connect_error', (e) => log(d, `socket error ${e.message}`));
    socket.on('driver:offer', async (offer) => {
      log(d, `offer for ride ${offer.rideId}, pickup ${Math.round(offer.distanceToPickupMeters)} m away`);
      await sleep(2000);
      if (d.behaviour === 'decline') {
        await call(d.token, 'POST', `/offers/${offer.offerId}/reject`, {}).catch((e) => log(d, e.message));
        log(d, 'declined');
      } else if (d.behaviour === 'ignore') {
        log(d, 'ignoring (will time out)');
      } else {
        try {
          await call(d.token, 'POST', `/offers/${offer.offerId}/accept`, {});
          log(d, 'accepted');
          runTrip(d, offer.rideId);
        } catch (e) {
          log(d, `accept failed: ${e.message}`);
        }
      }
    });
    socket.on('driver:offer-expired', (p) => log(d, `offer ${p.offerId} closed${p.reason ? ` (${p.reason})` : ''}`));
  }

  // Heartbeat: keep idle drivers' locations fresh (< LOCATION_FRESHNESS_MS).
  setInterval(() => {
    for (const d of drivers) if (!d.busy) call(d.token, 'PATCH', '/drivers/me/location', d.position).catch(() => {});
  }, 5000);
  console.log(`Simulator running against ${API}. Book a ride near ${CENTER.lat}, ${CENTER.lng}. Ctrl+C to stop.`);
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
