# Implementation test log (upgrade)

Every entry was written immediately after the tests it reports were **actually executed** against the real MongoDB 7.0 single-node replica set (Docker service `mongo`). Counts are exactly as Jest/Vitest printed them.

Frontend screens for each feature were built in step 13 (one consistent pass over the UI); backend APIs were tested feature by feature as they were written.

## Step 1 · Baseline (before any change)

| Check | Result |
| --- | --- |
| Backend Jest | 15 suites, **159 passed**, 0 failed, 0 skipped |
| Frontend Vitest | 4 files, **36 passed**, 0 failed |
| Frontend build | success |
| `node --check` on all server files | clean (no ESLint configured in repo) |

Pre-existing failures: **none**. See [implementation-audit.md](implementation-audit.md).

## Step 2 · Schema changes and safe migrations

- **Files:** `server/src/config/vehicles.js` (new), `utils/constants.js`, `models/User.js`, `models/DriverProfile.js`, `models/Ride.js`, `models/Payment.js`, new models `RideOtp`, `AuthOtp`, `Review`, `ChatMessage`, `ChatReport`, `SafetyIncident`, `DriverDocument`, `AuditLog`, `DevOutboxMessage`, `models/index.js`, `migrations/index.js` (new), `server.js`, `workers/index.js`, `scripts/seedAdmin.js`, `tests/helpers/factory.js`, `tests/integration/auth.test.js`, `tests/integration/migrations.test.js` (new).
- **Order change:** the vehicle catalog (part of feature 5) was created here because the capacity migration needs per-type defaults.
- **Tests run:** full backend suite.
- **Result:** 16 suites, **163 passed**, 0 failed, 0 skipped.
- **Bugs found:** none.
- **Notes:** migrations run before `ensureIndexes()` so new unique indexes are never built over old-shaped data. Legacy `PENDING` drivers become `DOCUMENTS_REQUIRED`; legacy `APPROVED` drivers stay approved and keep receiving rides (tested).

## Step 3 · Authentication providers (phone OTP, Google, linking)

- **Files:** `services/authService.js`, `services/smsService.js` (new), `services/googleIdentity.js` (new), `utils/otpCrypto.js` (new), `utils/phone.js` (new), `utils/validators.js`, `middleware/auth.js` (suspension + `requirePermission`), `controllers/authController.js`, `routes/index.js`, `config/index.js`, `migrations/index.js` (phone normalisation), `scripts/devOutbox.js` (new), `tests/integration/authProviders.test.js` (new), `tests/helpers/env.js`.
- **Tests run:** `authProviders.test.js` + `auth.test.js` (3 consecutive runs), then the full backend suite.
- **Results:** targeted 38/38 passed ×3; full suite 17 suites, **188 passed**, 0 failed, 0 skipped.
- **Bug found and fixed:** concurrent first Google sign-ins for the same Google account could return `409 ACCOUNT_LINK_REQUIRED` to the losers (one request created the user between another request's subject lookup and email check). Fix: when the email is already taken, check whether that account is linked to the same Google subject before refusing. Test "concurrent first sign-ins … create one user" now passes reliably.
- **Limitations:** Twilio delivery is implemented but not exercised against a live Twilio account. Google verification is tested with locally generated RS256 keys through the real `jose` verification path; it was not tested against live Google tokens (needs a real `GOOGLE_CLIENT_ID`).

## Step 4 · Driver registration, documents and admin review

- **Files:** `services/driverOnboardingService.js` (new), `services/documentStorage.js` (new), `services/auditService.js` (new), `controllers/onboardingController.js` (new), `middleware/upload.js` (new), `middleware/errorHandler.js` (multer errors), `middleware/rateLimiters.js` (upload limiter), `routes/index.js` (onboarding routes, admin routes now permission-scoped), `services/adminService.js` (old one-step approval removed), `services/driverService.js` (vehicle change → re-review), `workers/recoveryWorker.js` (document retention purge), `utils/validators.js`, `docker-compose.yml` (`driver-documents` volume), `server/Dockerfile`, `tests/helpers/documents.js` (synthetic fixtures), `tests/integration/driverDocuments.test.js` (new).
- **Tests run:** `driverDocuments.test.js`, then the full backend suite.
- **Results:** targeted 20/20; full suite 18 suites, **208 passed**, 0 failed, 0 skipped.
- **Test-quality check:** I deliberately disabled the magic-byte content check in a scratch copy; the three content-validation tests failed as expected, and the original code was restored. (A first attempt at this check silently didn't apply because of shell quoting; it was redone properly.)
- **Bugs found:** an incorrect abort path in `uploadDocument` (spotted in review before testing) was fixed.
- **Limitations:** no government/KYC database is consulted; approval means an admin reviewed the uploaded files. Storage is local disk (encrypted); a cloud object store would need a new adapter with the same `put/get/remove` interface.

## Step 5 · Vehicle types, capacity and booking preferences (features 3, 4, 5)

- **Files:** `config/vehicles.js` (catalog with per-type fares/capacity, `VEHICLE_CATALOG_JSON` override), `services/fareService.js` (`ratesFor`, per-type estimate + `options`), `services/driverEligibility.js` (new, single eligibility filter), `services/driverReservation.js` (eligibility re-checked atomically), `services/matchingService.js` (filter + `noDriverReason`), `services/offerService.js` (eligibility re-checked on accept; `passengerCount` in offers), `services/rideService.js` (capacity/preference checks), `services/rideView.js` (viewer-aware: preference hidden from drivers; public vehicle details only), `services/adminService.js` (`setVehicleCapacity`, audited), controllers/routes (`GET /api/vehicles`, `PATCH /api/admin/drivers/:id/vehicle`), `utils/validators.js`, `tests/helpers/factory.js`, `tests/integration/vehicles.test.js`, `tests/integration/preferences.test.js` (new).
- **Tests run:** targeted suites, a mutation check, full suite.
- **Results:** targeted 27/27; full suite 20 suites, **235 passed**, 0 failed, 0 skipped.
- **Test-quality check:** with the women-driver condition removed from `rideEligibilityFilter`, 5 of 7 preference tests failed (the remaining 2 check data exposure and input validation, which don't depend on it). Restored afterwards.
- **Bug found:** one test assertion I first wrote relied on Mongoose *update* validators, which do not run document-context validators; replaced with a meaningful create-time check.

## Step 6 · Progressive-radius matching regression

- **Change to matching:** candidate filtering now also requires matching vehicle type, enough capacity, and (for `FEMALE_ONLY`) admin-verified eligibility. The same filter is re-applied inside the atomic reservation and the accept transaction. Ring order (0–3, 3–6, 6–9, 9–12 km), sequential offers, leases and recovery are unchanged.
- **Tests run:** full backend suite (above), which includes all original matching (#21–#37), offer (#38–#48), concurrency (#49–#59) and recovery (#73–#80) tests, plus new ones proving expansion still works with the new filters (e.g. a FEMALE_ONLY ride skips ring 0, is offered in ring 1, then ring 2).
- **Result:** all passed (235/235).

## Steps 7–8 · Trip-start OTP, destination privacy, trip-completion OTP (feature 1)

- **Files:** `services/rideOtpService.js` (new), `models/RideOtp.js`, `services/offerService.js` (start code issued in the accept transaction; offers hide destination), `services/matchingService.js` (offer payload hides destination), `services/rideService.js` (start/complete verify + consume code inside the transition transaction; completion code issued on start; cancel invalidates codes), `services/rideView.js` (destination hidden from drivers until the trip starts), `controllers/rideController.js` (`GET /rides/:id/otp`), `routes/index.js`, `middleware/rateLimiters.js` (otp limiter), `utils/validators.js` (`tripOtp`), `utils/logger.js` (redacts `otp`), `tests/helpers/matching.js` (`tripOtp`, `driveTrip`), `tests/integration/lifecycle.test.js`, `payments.test.js`, `e2e/booking-flow.test.js` (updated for codes), `tests/integration/tripOtp.test.js` (new).
- **API contract change:** `POST /rides/:id/start` and `/complete` now require `{ "otp": "123456" }`.
- **Tests run:** `tripOtp.test.js`, mutation check, full suite.
- **Results:** targeted 22/22; full suite 21 suites, **257 passed**, 0 failed, 0 skipped.
- **Test-quality check:** with code verification removed from `driverTransition`, 7 OTP tests failed; restored afterwards.
- **Bugs found:** (1) redacting the key `code` in logs would also have hidden error codes such as `ECONNREFUSED`; now only `otp` is redacted (codes are never passed to the logger at all). (2) A meaningless assertion added to the e2e test (always true) was removed.
- **Design notes:** codes are stored as an HMAC (for checking) plus AES-GCM ciphertext (so only the passenger can view them again after reloading); a repeated `complete` after success returns `alreadyDone: true` with no new effects (network-retry safety), while a repeated `start` is a 409.

## Step 9 · Reviews and ratings (feature 2)

- **Files:** `services/reviewService.js` (new), `models/Review.js`, `controllers/reviewController.js` (new), `routes/index.js`, `utils/validators.js`, `services/rideView.js` (ratings on ride views), `models/User.js` / `models/DriverProfile.js` (rating counters), `tests/integration/reviews.test.js` (new).
- **Tests run:** `reviews.test.js`, full suite.
- **Results:** targeted 17/17; full suite 22 suites, **274 passed**, 0 failed, 0 skipped.
- **Bugs found and fixed:**
  1. `submitReview` returned the raw Mongoose document (`_id` instead of `id`). An admin-moderation test's "reason required → 400" assertion was passing **for the wrong reason** (the id was missing, not the reason). Fixed the response shape, and the assertion now also checks the error message.
  2. Test-helper bug: repeated `completedRide()` calls let an earlier, nearer driver receive the new offer. The helper now takes its driver offline after the trip.

## Step 10 · Passenger–driver chat (feature 7)

- **Files:** `services/chatService.js` (new), `models/ChatMessage.js`, `models/ChatReport.js`, `controllers/chatController.js` (new), `sockets/index.js` (`chat:send`, `chat:history`; admins join `role:ADMIN`), `sockets/notifier.js` (`toAdmins`), `routes/index.js`, `utils/validators.js`, `workers/recoveryWorker.js` (message retention purge), `tests/integration/chat.test.js` (new).
- **Tests run:** `chat.test.js` (twice), `authProviders.test.js`, full suite.
- **Results:** targeted 13/13 (×2); full suite 23 suites, **287 passed**, 0 failed, 0 skipped.
- **Bugs found and fixed (in tests):**
  1. The retention test could not backdate messages: Mongoose silently ignores `$set` on the immutable `createdAt` timestamp. It now writes through the raw collection.
  2. **The same trap had made an earlier test pass vacuously:** `authProviders.test.js` › "requesting a new code invalidates the previous one" never actually issued a second code. It now uses the raw collection and asserts that a second code was issued and the first was superseded.
  3. A stray extra driver in the retention test received the offer meant for the helper's driver.
- **Limitations:** the chat rate limit is in-memory per API process (like the HTTP rate limits).

## Step 11 · Safety incidents and emergency integration (feature 6)

- **Files:** `services/safetyService.js` (new), `services/emergencyService.js` (new adapter: `none` | `webhook`), `models/SafetyIncident.js`, `controllers/safetyController.js` (new), `routes/index.js`, `utils/validators.js`, `workers/recoveryWorker.js` (dispatch retries), `tests/integration/safety.test.js` (new, with a local fake emergency service).
- **Tests run:** `safety.test.js`, mutation check, full suite.
- **Results:** targeted 15/15; full suite 24 suites, **302 passed**, 0 failed, 0 skipped.
- **Test-quality check:** when the "service must answer `accepted: true`" rule was removed, the two tests for a 2xx-without-confirmation response failed (i.e. the tests would catch a false "police notified"). Restored afterwards.
- **Bugs found:** none in this step.
- **External dependency:** no real emergency-response service is configured or verified. The default `EMERGENCY_PROVIDER=none` records the incident, alerts in-app safety admins, shows the emergency number (112) and states that automated dispatch is unavailable. The `webhook` adapter was tested only against a local fake service.

## Step 12 · Expanded admin management and audit logs (feature 10)

- **Files:** `services/adminService.js` (user search/detail, suspension, permission management, ride search, admin cancellation, payments, refund requests, extended metrics; unused `listUsers`/`listRides` removed), `controllers/adminController.js`, `routes/index.js` (every admin route permission-scoped; passengers' cancel route no longer accepts admins — they use the audited `POST /api/admin/rides/:id/cancel`), `services/chatService.js` (suspended accounts cannot send over an already-open socket), `utils/validators.js`, `tests/integration/admin.test.js` (new).
- **Tests run:** `admin.test.js`, full suite (before and after removing dead code).
- **Results:** targeted 12/12; full suite 25 suites, **314 passed**, 0 failed, 0 skipped.
- **Coverage note:** one test calls all 22 admin endpoints as unauthenticated, passenger, driver, and as an admin lacking the specific permission, expecting 401/403/403/403 every time.
- **Bugs found:** none in this step.
- **Limitations:** refunds are only recorded as manual requests (`REQUESTED_MANUAL`); the mock payment provider cannot move money and nothing claims a refund was paid.

## Step 13 · Frontend integration (all features)

- **Files (client):** `services/api.js` (all new endpoints), new components `TripCodeCard`, `OtpEntry`, `ChatPanel`, `SafetyButton`, `ReviewForm`, `ConfirmAction`, `Pagination`, `GoogleSignIn`; updated `BookingForm` (catalog, riders, preference, per-vehicle prices), `RideStatus`, `OfferCard`, `AppShell`, `AuthContext` (sign out on suspension); pages `RidePage`, `DriverHome`, `AuthPages` (phone code + Google + driver identity), new `DriverOnboarding`, `AccountPage`, admin split into `pages/admin/*` (Overview, Drivers, Users, Rides, Safety, Reviews, Chat reports, Payments, Audit log); tests `tripAndDriver.test.jsx`, `safetyChatReview.test.jsx`, `bookingAndAuth.test.jsx`, `adminLists.test.jsx`; `BookingForm.test.jsx` (mocks the catalog).
- **Files (server):** `scripts/simulateDrivers.js` (runs migrations; reads trip codes as the simulated passenger, clearly logged as a dev shortcut).
- **Tests run:** Vitest (all files), production build, live browser check through Docker with the driver simulator.
- **Results:** Vitest 8 files, **64 passed**, 0 failed; `vite build` succeeded.
- **Live check (Docker, real backend):** registered a passenger; booked a 2-rider car (Bike correctly disabled; per-vehicle prices shown). Matching: nearest driver declined, next timed out, a 7.5 km driver accepted. The passenger saw the pickup code, chat worked, the drop-off code appeared during the trip, the trip completed with a server fare, and a rating was submitted. Registered a driver and landed on onboarding: a synthetic PNG upload was accepted and a disguised text file was rejected (415). The admin console showed the new driver, identity, missing documents and the review.
- **Bugs found and fixed:**
  1. **Stale-response race in admin lists (found in the live check):** changing a filter quickly let the older, slower response overwrite the newer one ("No drivers in this list" while the API returned one). `usePaged` now ignores responses that aren't from the latest request. Regression test added; it fails without the fix.
  2. The old booking test made real network requests for the vehicle catalog (jsdom error noise); the catalog is now mocked.
- **Limitations:** the Google button cannot be exercised without a real `GOOGLE_CLIENT_ID` (it is hidden when not configured, which is tested).

## Step 14 · Documentation

- **New:** `16-otp-and-trip-verification.md`, `17-reviews-and-ratings.md`, `18-vehicle-types-and-capacity.md`, `19-safety-and-emergency-response.md`, `20-women-safety-and-matching-preferences.md`, `22-chat-system.md`, `23-driver-document-verification.md`, `24-authentication-providers.md`, `25-admin-management-and-audit.md`, plus this log and `implementation-audit.md`.
- **Updated:** 00–15 (stale statements corrected, e.g. "all vehicle types use the same rates", offers containing the destination, the old approval states, admin cancellation via the passenger route, old test counts; an "Upgrade" section added to each relevant document), `README.md`, `.env.example` (placeholders only).
- **Verification:** a script checked every file path, function, identifier, endpoint, socket event and relative link in all 27 documents against the code. The only remaining flags were audit action names built from templates (`SAFETY_${action}` and similar; the templates were confirmed to exist) and an example Node error code. All 23 Mermaid diagrams parse with Mermaid 11. Per-file test counts quoted in the docs were checked against Jest's JSON output; one wrong count (vehicles: 16 → 20) was corrected.

## Step 15 · Final verification

| Check | Result |
| --- | --- |
| Backend Jest (host), 25 files | **314 passed, 0 failed, 0 skipped**, identical on 4 consecutive runs |
| Backend Jest (inside `backend` container) | 313 passed, 0 failed, 1 skipped (repo-only `.gitignore` check) |
| Frontend Vitest (host and `frontend` container), 8 files | **64 passed, 0 failed** |
| Frontend production build | success |
| `node --check` on all server source and scripts | clean (no ESLint configured) |
| Docker Compose services | mongo, backend, frontend healthy; worker running; `/api/health` reports replica set `rs0` primary |
| Basic booking flow | verified live in step 13 (book → match with decline/timeout → codes → complete → rate) |
| Existing data | dev database migrated in place (7 users, 2 rides, 4 drivers preserved); no volume was reset |
| Diff vs pre-upgrade snapshot | no files deleted; non-source changes limited to `.env.example`, `.gitignore`, `README.md`, `docker-compose.yml`, `server/Dockerfile`, `server/package*.json`, `server/scripts/*`; no secrets found; generated files git-ignored |
