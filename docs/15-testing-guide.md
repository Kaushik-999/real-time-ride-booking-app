# 15 · Testing guide

> Previous: [14 Errors and recovery](14-error-handling-and-recovery.md) · Back to [00 Overview](00-project-overview.md)

## The basic idea

An automated test is a small program that uses your code and checks the result. Tests let you change code confidently: if something breaks, a test fails.

| Kind | Checks | Here |
| --- | --- | --- |
| **Unit** | one function in isolation, no database | `server/tests/unit/` (fare maths, state machine, rings, geo) |
| **Integration** | several parts together with a **real MongoDB** | `server/tests/integration/` |
| **End-to-end (e2e)** | the whole flow: HTTP + sockets + matching + timers + worker | `server/tests/e2e/booking-flow.test.js` |
| **Concurrency** | correct results when operations run at the same time | `concurrency.test.js` and others using `Promise.all` |
| **Socket.IO** | real socket clients against a real server | `sockets.test.js`, e2e |
| **Frontend component** | React components/hooks in a simulated browser (jsdom) | `client/src/__tests__/` |

## Test databases, replica sets and isolation

- Server tests connect to a **real MongoDB replica set**, the same `mongo` container used for development, but to **separate databases** named `uber_test_<worker>` (`server/tests/helpers/env.js`). Your `uber` development data is never touched.
- Jest runs files in parallel; each Jest worker has its own database, so files don't interfere.
- `useDatabase()` (`tests/helpers/db.js`) connects, builds indexes, and **deletes all documents before each test**.
- The concurrency tests use **no mocks of the database**. A few tests use `jest.spyOn` only to *inject a failure* (e.g. make one insert throw) and check that rollback works.
- Test settings (`env.js`): matching auto-start and offer timers off (tests trigger steps explicitly for determinism), low bcrypt cost, high rate limits. The e2e file turns auto-start, real timers (1 s timeout) and the MongoDB socket adapter **on**.

## How to run

On your machine (MongoDB container must be running: `docker compose up -d mongo`):

```bash
cd server && npm install
npm test                    # everything (unit + integration + e2e)
npm run test:unit
npm run test:integration
npm run test:e2e
cd ../client && npm install
npm test                    # Vitest
npm run build               # production build of the web app
```

Inside Docker:

```bash
docker compose exec -e MONGO_URI_TEST="mongodb://mongo:27017/?replicaSet=rs0" backend npm test
docker compose exec frontend npm test
```

`MONGO_URI_TEST` overrides where tests connect (default `mongodb://localhost:27017/?directConnection=true`).

## Status of the tests

Terms: **implemented** = the test exists; **executed** = it was run; **passing / failing** = its result; **skipped** = deliberately not run in that environment.

Final runs after the upgrade (this machine, real MongoDB 7.0 replica set; the original first-version numbers are kept in [implementation-audit.md](implementation-audit.md)):

| Suite | Where | Implemented | Passed | Failed | Skipped |
| --- | --- | --- | --- | --- | --- |
| Backend (Jest, 25 files) | host | 314 | 314 | 0 | 0 |
| Backend (Jest) | inside `backend` container | 314 | 313 | 0 | 1 (`.gitignore` check: no git checkout in container) |
| Frontend (Vitest, 8 files) | host and inside `frontend` container | 64 | 64 | 0 | 0 |
| Frontend production build | host | — | succeeded | — | — |
| Backend syntax check (`node --check` on every file) | host | — | clean | — | — |

The backend suite ran four times in a row on the host with identical results. No linter is configured in this repository.

Per-file counts (backend): `e2e/booking-flow` 3, `admin` 12, `auth` 16, `authProviders` 22, `booking` 19, `chat` 13, `concurrency` 9, `driver` 12, `driverDocuments` 20, `health-and-indexes` 7, `lifecycle` 10, `matching` 17, `migrations` 4, `offers` 13, `payments` 6, `preferences` 7, `recovery` 10, `reviews` 17, `safety` 15, `security` 7, `sockets` 5, `tripOtp` 22, `vehicles` 20, `unit/fare` 6, `unit/stateMachineAndRings` 22. Frontend: `BookingForm` 6, `RideStatus` 12, `adminLists` 2, `bookingAndAuth` 9, `format` 11, `safetyChatReview` 11, `tripAndDriver` 6, `useRideTracking` 7.

## Required test cases → test files

| # | Topic | File(s) |
| --- | --- | --- |
| 1–6 | registration, duplicates, malformed input, login, bad password, JWT | `integration/auth.test.js` |
| 7, 8 | passenger / other driver cannot accept | `integration/offers.test.js` |
| 9 | another passenger's ride hidden | `integration/booking.test.js` |
| 10 | unapproved driver not offered / cannot accept | `matching.test.js`, `offers.test.js` |
| 11–19 | fare estimate, invalid coordinates, manipulated fares, booking, idempotency, history | `booking.test.js`, `unit/fare.test.js`, `driver.test.js`, `unit/stateMachineAndRings.test.js` |
| 20 | invalid transitions | `unit/stateMachineAndRings.test.js` (+ API-level in `lifecycle.test.js`) |
| 21–37 | progressive-radius matching | `integration/matching.test.js` |
| 38–48 | offer accept / reject / timeout | `integration/offers.test.js` |
| 49–51, 53, 54, 56–58 | concurrency | `integration/concurrency.test.js` |
| 52, 59 | busy driver availability, concurrent location updates | `integration/driver.test.js` |
| 55 | concurrent duplicate bookings | `integration/booking.test.js` |
| 60 | unique indexes | `integration/health-and-indexes.test.js` |
| 61–72 | ride lifecycle, events, final fare | `integration/lifecycle.test.js` (+ `unit/fare.test.js` for 71) |
| 73–80 | recovery worker | `integration/recovery.test.js` |
| 81–83, 86 | sockets | `integration/sockets.test.js` (+ `useRideTracking.test.jsx` for 86) |
| 84–90 | UI states, reconnect, duplicates, errors, no early driver, invalid location, form | `client/src/__tests__/*.test.jsx`, `format.test.js` |
| 91–94 | payments | `integration/payments.test.js` |
| 95–100 | rate limit, hidden hashes, CORS/Helmet, no stack traces, controlled errors, secrets | `integration/security.test.js` (+ `auth.test.js`, `booking.test.js`) |

Test names start with the case number (e.g. `'#49 two passengers request simultaneously...'`), so `npx jest -t "#49"` runs one case.

## Reproducing the most important scenarios by hand

Start everything, create an admin, start the simulator ([12](12-docker-local-development.md)):

```bash
docker compose up --build -d
docker compose exec -e ADMIN_EMAIL=admin@example.com -e ADMIN_PASSWORD='ChooseAStrongOne1' backend npm run seed:admin
docker compose exec backend npm run simulate:drivers
```

The simulator puts four approved drivers around central Bengaluru (1.5 km declines, 4.5 km ignores, 7.5 km and 10.5 km accept and then drive the trip).

1. **Progressive radius + reject + timeout.** At http://localhost:5173 register a passenger, tap the map near the centre (pickup) and somewhere else (destination), click **See fare**, then **Request ride**. Watch the yellow ring: the nearest driver declines, the next lets the offer expire (15 s), the search expands, and a farther driver accepts. The simulator's terminal prints each step.
2. **Live tracking.** The yellow ▲ marker moves; reload the page: the status and marker come back (state recovered over REST).
3. **Admin inspection.** Sign in as the admin → **Rides → Inspect**: offers with status, ring and distance, and the full event timeline.
4. **Driver approval.** Register a new driver in another browser profile; they see "waiting for approval" and can't go online until the admin approves them under **Drivers**.
5. **Cancellation.** Book, then click **Cancel ride** while searching or after assignment; the driver is freed.
6. **Crash recovery.** Book a ride, and while a driver's offer is pending run `docker compose restart backend`. Within a few seconds after the deadline, the worker expires the offer and matching continues.
7. **API idempotency.** With `curl`, send the same `POST /api/rides` body (same `requestKey`) twice: the second reply has `"created": false` and the same ride id.

## Writing a new test

Use the helpers in `server/tests/helpers/`: `factory.js` (`createPassenger`, `createDriver({ distanceKm, availability, approved, vehicleType, locationAgeMs })`, `createRide`, `auth(token)`), `matching.js` (`pendingOffer`, `rejectCurrent`, `timeOut`), `server.js` (`startServer`, `waitForEvent`). For anything concurrent, start the operations together with `Promise.all` and assert the final database state.

## Glossary

- **Assertion**: a check inside a test (`expect(x).toBe(y)`).
- **Mock / spy**: replacing or watching a function during a test.
- **Flaky test**: a test that sometimes passes and sometimes fails without code changes.
- **jsdom**: a simulated browser environment for running React tests in Node.
- **Fixture / factory**: helper that creates test data.

## Upgrade: required test areas → test files

| Area | Backend | Frontend |
| --- | --- | --- |
| OTP and destination privacy | `tripOtp.test.js` | `tripAndDriver.test.jsx` |
| Reviews | `reviews.test.js` | `safetyChatReview.test.jsx` |
| Vehicle types and capacity | `vehicles.test.js` | `bookingAndAuth.test.jsx` |
| Women's matching preference | `preferences.test.js` | `bookingAndAuth.test.jsx` |
| Safety | `safety.test.js` (with a local fake emergency service) | `safetyChatReview.test.jsx` |
| Chat | `chat.test.js` (real Socket.IO clients) | `safetyChatReview.test.jsx` |
| Driver verification | `driverDocuments.test.js` (synthetic files only) | — |
| Authentication | `authProviders.test.js`, `auth.test.js` | `bookingAndAuth.test.jsx` |
| Admin | `admin.test.js` (+ admin checks in the feature suites) | `adminLists.test.jsx`, `bookingAndAuth.test.jsx` |
| Migrations | `migrations.test.js` | — |
| Regression and concurrency | all original suites, updated for codes; see [07](07-concurrency-consistency-and-atomic-operations.md#upgrade-new-concurrency-sensitive-workflows-and-their-tests) | — |

**Checking that the tests can fail.** For several critical rules the protection was temporarily removed in a scratch copy and the tests re-run, then the code was restored. Removing upload content checks, the women-driver filter, trip-code verification, the "service must confirm acceptance" rule, and the stale-response guard made the matching tests fail every time. Details are in [implementation-test-log.md](implementation-test-log.md).

### Helpers added

`tests/helpers/matching.js` → `tripOtp(rideId)` (the passenger's current code) and `driveTrip(rideId, driverId)`; `tests/helpers/documents.js` → synthetic PNG/JPEG/PDF fixtures and `submittedDriver()`; `factory.createDriver({ capacity, femaleProgram })`, `factory.createRide({ passengerCount, driverPreference })`, `factory.createAdmin({ adminPermissions })`.

**Pitfall worth knowing:** Mongoose silently ignores `$set` on the `createdAt` timestamp. To backdate documents in a test, write through the raw collection (`Model.collection.updateMany`). An early test passed vacuously because of this until it was fixed.
