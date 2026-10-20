# 14 · Error handling and recovery

> Previous: [13 Security](13-security.md) · Next: [15 Testing](15-testing-guide.md)

## The basic idea

Things fail: users send bad input, networks drop, processes crash mid-operation. Good error handling means **failures are reported clearly, nothing is left half-done, and the system can carry on** afterwards.

## The error response format

Every error from the API looks like this:

```json
{ "success": false, "error": { "code": "INVALID_TRANSITION", "message": "Cannot start a ride that is DRIVER_ASSIGNED" } }
```

Services throw `AppError` objects (`server/src/utils/errors.js`: `badRequest`, `unauthorized`, `forbidden`, `notFound`, `conflict`). `asyncHandler` forwards them to `errorHandler` (`server/src/middleware/errorHandler.js`), which maps them to HTTP:

| Kind | HTTP | Example `code` |
| --- | --- | --- |
| Validation | 400 | `BAD_REQUEST` (with `details: [{ location, path, message }]`) |
| Malformed JSON | 400 | `BAD_REQUEST` "Malformed JSON body" |
| Invalid ObjectId / Mongoose cast | 400 | `BAD_REQUEST` |
| No/invalid token | 401 | `UNAUTHORIZED` |
| Wrong role / not yours (driver actions) | 403 | `FORBIDDEN` |
| Not found / not yours (rides) | 404 | `NOT_FOUND` |
| State conflict | 409 | `INVALID_TRANSITION`, `OFFER_NOT_PENDING`, `RIDE_NOT_SEARCHING`, `DRIVER_BUSY`, `ACTIVE_RIDE_EXISTS`, `IDEMPOTENCY_KEY_REUSED` |
| Unexpected duplicate key | 409 | `DUPLICATE` |
| Too many requests | 429 | `RATE_LIMITED` |
| Anything else | 500 | `INTERNAL_ERROR` (details only in logs) |

The frontend's `errorMessage(err)` (`client/src/services/api.js`) turns these into sentences, including network failures ("Cannot reach the server…") and timeouts (test #87).

## Specific failure types

### Database failures
If MongoDB is unreachable, requests fail with `500` and `/api/health` returns `503` (shown as unhealthy in `docker compose ps`). `restart: unless-stopped` restarts a container if its process crashes; it does not restart containers that are merely unhealthy. Mongoose reconnects automatically when MongoDB comes back (verified by restarting the `mongo` container: the API recovered with data intact).

### Duplicate-key errors
Expected ones are handled where they occur: booking retries (`rideService.createRide`), first location updates (`driverService.updateLocation`), registration (`authService.register` → `409 DUPLICATE`).

### Transaction failures
`withTransaction` retries transient errors (write conflicts) automatically. If the callback throws, **every write in the transaction is rolled back**. Tests #54 and #56 force failures halfway through accept and reserve/offer and confirm nothing partial remains.

### Driver unavailability
A driver who disappears between search and reservation simply makes `reserveDriver` return `null`; matching moves to the next candidate (#34).

### Offer expiry
Handled by an in-memory timer and, as a backstop, by the recovery worker ([08](08-offer-acceptance-rejection-and-timeouts.md)).

### Server restarts
In-memory timers are lost, but all state is in MongoDB. The recovery worker finds expired offers and stalled rides and continues them (#73, #77).

### Socket disconnections
Clients re-subscribe and re-fetch on reconnect ([11](11-realtime-communication-and-tracking.md)); polling covers silent drops.

### Recovery worker failures
Each sweep runs inside `safely()`; an exception is logged (`recovery task failed`, with the task name) and counted, and the other sweeps and later passes still run (#79). Re-running a pass is idempotent (#80).

## The recovery worker in detail

`RecoveryWorker.runOnce()` (`server/src/workers/recoveryWorker.js`):

| Sweep | Finds | Fixes | Safety |
| --- | --- | --- | --- |
| `expireOffers` | `PENDING` offers with `expiresAt ≤ now` | expire, release driver, `advanceMatching` | `expireOffer` conditional = atomic claim |
| `resumeStalledRides` | `SEARCHING` rides, lease free/expired, `lastProgressAt` older than `WORKER_STALE_SEARCH_MS`, no open offer | `advanceMatching` | per-ride lease |
| `reconcileDrivers` | `RESERVED` drivers older than `WORKER_RESERVATION_GRACE_MS` with no matching `PENDING` offer; `ON_TRIP` drivers whose ride is over or not theirs | set `AVAILABLE` | conditional on the same `activeRideId` |

`start()` schedules passes every `WORKER_INTERVAL_MS`; `stop()` waits for a running pass before returning (graceful shutdown).

## Logging and debugging

Logs are JSON lines (pino). Useful messages: `request` (method, path, status, ms), `ride requested`, `offer sent`, `offer expired`, `driver assigned`, `recovery pass`, `released abandoned reservation`, `unhandled request error` (with stack).

```bash
docker compose logs -f backend worker
docker compose logs backend | grep '"level":50'          # errors only
docker compose logs backend worker | grep <rideId>        # one ride's story
```

Set `LOG_LEVEL=debug` in `.env` to see more (for example "candidate no longer available").

## Graceful shutdown

On `SIGTERM`/`SIGINT` (`server.js`): stop accepting sockets and HTTP connections, let in-flight requests finish, stop the in-process worker, clear offer timers (the worker will expire those offers later), disconnect MongoDB, exit. A 15 s safety timer forces exit if something hangs. `workers/index.js` does the same for the worker.

## Troubleshooting guide

| Symptom | Diagnosis | Safe fix |
| --- | --- | --- |
| Ride stuck in `SEARCHING` for minutes | worker not running? `docker compose ps worker` | start it: `docker compose up -d worker`; it resumes the ride |
| Driver can't go online: "DRIVER_BUSY" | profile `RESERVED`/`ON_TRIP` | wait one worker pass; if the ride really ended, `reconcileDrivers` frees them |
| Passenger can't book: "ACTIVE_RIDE_EXISTS" | an earlier ride still active | open it (home redirects there) and cancel it |
| All offers expire instantly | server clock wrong or `OFFER_TIMEOUT_MS` tiny | check `.env` |
| Nobody ever gets offers | drivers' locations stale or not approved | admin Drivers tab: approval + "live" |

**Avoid editing documents by hand** in mongosh to "unstick" things, because it's easy to break invariants (for example setting a driver `AVAILABLE` while a ride still points at them). Prefer letting the worker reconcile, or cancel the ride through the API, which releases everything consistently.

## Glossary

- **Rollback**: undoing all writes of a failed transaction.
- **Graceful shutdown**: finishing current work before exiting.
- **Idempotent recovery**: running the same fix twice changes nothing the second time.
- **Backstop**: a second mechanism that catches what the first missed.

## Upgrade: new recovery tasks and error codes

The recovery worker's `runOnce()` now also runs, each inside `safely()`:

| Task | What it does |
| --- | --- |
| `retryEmergencyDispatches` | retries due emergency alerts under a lease; `FAILED` after `EMERGENCY_MAX_ATTEMPTS` ([19](19-safety-and-emergency-response.md)) |
| `purgeExpiredDocuments` | deletes files of rejected/superseded documents after retention ([23](23-driver-document-verification.md)) |
| `purgeOldChatMessages` | deletes old chat messages not held for a report/incident ([22](22-chat-system.md)) |

New error codes: `INVALID_OTP` (400), `OTP_EXPIRED` (410), `OTP_LOCKED` (423), `OTP_ALREADY_USED` / `OTP_NOT_ISSUED` (409), `OTP_COOLDOWN` / `OTP_LIMIT` / `OTP_REGENERATION_LIMIT` (429), `SMS_UNAVAILABLE` / `GOOGLE_NOT_CONFIGURED` (503), `ACCOUNT_LINK_REQUIRED` / `IDENTITY_IN_USE` (409), `ACCOUNT_SUSPENDED` (403), `NOT_ELIGIBLE` (409), `DOCUMENTS_INCOMPLETE` / `ONBOARDING_LOCKED` (409), `UNSUPPORTED_FILE` (415), `FILE_TOO_LARGE` (413), `DOCUMENT_DELETED` (410), `ALREADY_REVIEWED` / `REVIEW_NOT_ALLOWED` / `REVIEW_WINDOW_CLOSED` (409), `CHAT_CLOSED` (409), `CHAT_EXPIRED` (410), `CHAT_RATE_LIMITED` (429), `NOT_ACTIVE_RIDE` (409), `PREFERENCE_UNAVAILABLE` (409).

Migrations that fail are recorded as `failed` in the `migrations` collection and retried on the next start; the process refuses to start until they succeed.
