# Implementation audit (before the upgrade)

Audit date: 2026-10-20. This records what the repository actually contained **before** the upgrade described in the "Upgrade" master prompt, so later changes can be compared against a known baseline.

## How the audit was done

- Read every file under `server/src`, `server/tests`, `server/scripts`, `client/src`, `docker-compose.yml`, both Dockerfiles, `mongo/init-replica-set.js`, `.env.example`, `README.md` and documents 00–15 in `docs/`.
- Ran the full test suites and the production build (results below).
- Inspected the live development database (`uber`) for data that a schema change would affect.

## Baseline test results (executed before any change)

| Check | Command | Result |
| --- | --- | --- |
| Backend tests (Jest, real MongoDB replica set) | `cd server && npx jest` | 15 suites, **159 passed, 0 failed, 0 skipped** |
| Frontend tests (Vitest) | `cd client && npx vitest run` | 4 files, **36 passed, 0 failed** |
| Frontend production build | `cd client && npx vite build` | success |
| Backend syntax check | `node --check` on every `server/src` and `server/scripts` file | no errors |
| Linting | — | **no linter is configured** in the repository (no ESLint config); only syntax checks are possible |

There were **no pre-existing test failures**.

## Development data present at audit time

`users`: 7, `driverprofiles`: 4 (all `APPROVED`, created by the simulator), `rides`: 2 (both finished), no active rides. A schema migration must keep these documents usable. The Docker volume `mongo-data` must not be reset.

## Architecture as found

- `server/src/app.js` builds Express (Helmet, CORS, JSON body limit 50 KB, access log, `/api` router, error handler). `server/src/server.js` adds Socket.IO and optionally the recovery worker.
- All routes live in `server/src/routes/index.js`; controllers are thin; business logic is in `server/src/services/`.
- Models: `User`, `DriverProfile`, `DriverLocation`, `Ride`, `RideOffer`, `Payment`, `RideEvent` (`server/src/models/`). `ensureIndexes()` syncs indexes at startup.
- Transactions via `server/src/utils/transaction.js` (`withTransaction`, `withTransactionOrAbort`).
- Socket.IO (`server/src/sockets/index.js`): JWT handshake, `user:<id>` rooms, authorised `ride:<id>` rooms, MongoDB adapter for cross-process events.
- Recovery worker (`server/src/workers/recoveryWorker.js`): expires offers, resumes stalled rides, reconciles driver reservations.
- Frontend: React Router pages for passenger (`PassengerHome`, `RidePage`, `HistoryPage`), driver (`DriverHome`, `DriverTrips`), admin (`AdminPage`); `AuthContext` keeps the JWT in `sessionStorage`; `useRideTracking` treats REST as the source of truth.
- Docker Compose: `mongo` (single-node replica set `rs0`, volume `mongo-data`), `backend`, `worker`, `frontend`.

## Feature-by-feature status against the upgrade request

| Requested feature | Status before upgrade | Evidence |
| --- | --- | --- |
| 1. Trip-start / completion OTP | **Missing.** `POST /rides/:id/start` and `/complete` needed only an empty body. | `rideService.driverTransition`, `schemas.emptyBody` |
| Destination privacy for drivers | **Missing (privacy gap).** The `driver:offer` socket payload, `GET /drivers/me/offers` and the driver's ride view all included the full destination before pickup. | `matchingService.notifyOffer`, `offerService.listPendingOffers`, `rideView.buildRideView` |
| 2. Reviews and ratings | **Missing.** No model, API or UI. | — |
| 3. Car / bike / auto | **Partial.** `VEHICLE_TYPES = ['BIKE','AUTO','CAR']` hardcoded; booking UI could choose a type; matching filtered on exact type. **One fare table for all types**; no car subtypes; catalog not configurable. | `utils/constants.js`, `fareService.calculateFare`, `BookingForm.jsx` |
| 4. Passenger capacity | **Missing.** No capacity on vehicles, no passenger count on rides. | `DriverProfile.js`, `Ride.js` |
| 5. Women-driver preference | **Missing.** No preference field, no verified eligibility field. | — |
| 6. Safety button / incidents | **Missing.** | — |
| 7. Passenger–driver chat | **Missing.** | — |
| 8. Driver documents | **Missing.** Registration collected name, email, phone, password and vehicle only. Approval was a single admin flag (`PENDING`/`APPROVED`/`REJECTED`) with **no record of who reviewed, when, or why**. No file uploads. | `authService.register`, `adminService.setApproval` (removed in the upgrade) |
| 9. Auth providers | **Partial.** Email/password works (bcrypt + JWT). **No phone OTP login, no Google sign-in.** `User.passwordHash` was required, so passwordless accounts were impossible. Phone numbers were stored but never verified. | `User.js`, `authService.js` |
| 10. Admin management | **Partial.** Admin could list users/drivers/rides, approve drivers, view metrics and ride timelines. **No audit log, no permission scopes (every admin had every power), no passenger management, no review/safety/chat/payment screens, no user suspension.** | `adminService.js`, `AdminPage.jsx` |
| Progressive-radius matching | **Implemented and tested** (rings 0–3, 3–6, 6–9, 9–12 km; sequential offers; atomic reservation; lease; recovery). | `matchingService.js`, `tests/integration/matching.test.js` |
| Payments | **Implemented with a mock provider only.** No refunds. | `paymentService.js` |

## Existing API contracts that the upgrade affects

- `POST /api/rides/:rideId/start` and `/complete` accepted `{}`. They must now carry an OTP, which is a **breaking change** for any old client (only our own frontend and simulator exist).
- `PATCH /api/admin/drivers/:driverId/approval` accepted `PENDING|APPROVED|REJECTED`. New statuses must be introduced without breaking old values.
- `driver:offer` payload and `GET /api/drivers/me/offers` included `destination`; removing it is intentional (privacy).
- `POST /api/rides` and `/estimate` accepted `vehicleType ∈ {BIKE, AUTO, CAR}`; new fields must be optional with safe defaults so old clients keep working.

## Database compatibility concerns

- Existing `DriverProfile` documents have no capacity and no women-driver eligibility; if matching filtered on fields that are absent, **existing approved drivers would silently stop receiving rides**. A data migration is required.
- Existing `approvalStatus: 'PENDING'` values must map to the new review states.
- Existing `Ride` documents lack `passengerCount` / `driverPreference`.
- Existing rides that are `DRIVER_ASSIGNED`/`DRIVER_ARRIVED`/`IN_PROGRESS` at upgrade time would have no OTP; the OTP design must cope (none existed in the dev database at audit time).

## Other observations

- Rate limiting is in-memory per process (documented limitation, unchanged).
- MongoDB has no authentication in local Docker (documented, unchanged).
- No ESLint; style is consistent by convention.
