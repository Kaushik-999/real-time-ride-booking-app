# Ride

An Uber-style ride-booking platform for Indian cities. It has passenger, driver and admin web apps, a matching engine that searches outward from the pickup in rings, live tracking, trip verification codes, chat, ratings, a safety button, driver document review, and an audited operations console.

**Stack:** React 18 + Vite + Tailwind CSS · Node.js + Express · MongoDB 7 (single-node replica set) + Mongoose · Socket.IO · Docker Compose.
No Redis, no Celery, no SQL database: background work and cross-process events also run through MongoDB.

---

## Contents

- [What it does](#what-it-does)
- [Quick start](#quick-start)
- [Everyday commands](#everyday-commands)
- [Running the tests](#running-the-tests)
- [Project structure](#project-structure)
- [Configuration](#configuration)
- [External services](#external-services)
- [Documentation](#documentation)
- [Known limitations](#known-limitations)

---

## What it does

**Passengers**
- Pick a pickup and destination on a map; choose Bike, Auto, Car or Car XL and the number of riders; see the fare for each option.
- Optionally ask for **women drivers only** (admin-verified drivers; never silently dropped if none is available).
- Follow the search live, then the driver on the map. Share a **pickup code** to start the trip and a **drop-off code** to end it.
- Chat with the driver, use the **Safety help** button, pay (cash or test online payment), rate the ride.
- Sign in with email + password, a **phone code**, or **Google**.

**Drivers**
- Register with identity details, upload documents (photo, licence, RC, masked Aadhaar…), and wait for approval.
- Go online, receive one offer at a time (the destination stays hidden until pickup), enter the passenger's codes, chat, rate passengers, and see earnings.

**Admins**
- Review drivers and documents (each document view is audited), verify women-driver eligibility, and manage users, rides, reviews, safety incidents, chat reports and payments.
- Every action needs its own permission and sensitive actions are written to an audit log.

**Under the hood**
- Matching searches **0–3, 3–6, 6–9, 9–12 km**, nearest driver first, one offer at a time.
- Atomic reservations, transactions and unique indexes stop double bookings, even under simultaneous requests.
- A MongoDB-backed **recovery worker** finishes work after crashes, including expired offers, stalled searches, emergency-alert retries and data retention.

---

## Quick start

> New to terminals? **[docs/26-running-on-your-computer.md](docs/26-running-on-your-computer.md)** explains every step: what to type, and where.

### Option A: Docker (recommended)

Requirements: **Docker Desktop** (open it and wait until it is running).

```bash
cd "/Users/kaushiksarmah999/uber clone"
docker compose up -d --build      # first time; later just: docker compose up -d
docker compose ps                 # wait for backend and mongo to show (healthy)
```

Open **http://localhost:5173**. API health: http://localhost:4000/api/health.

Optional, for a working demo:

```bash
docker compose exec -e ADMIN_EMAIL=admin@example.com -e ADMIN_PASSWORD='ChooseAStrongOne1' backend npm run seed:admin
docker compose exec backend npm run simulate:drivers    # demo drivers around central Bengaluru; Ctrl+C to stop
```

### Option B: run the app with npm (database still in Docker)

Requirements: Docker Desktop (for MongoDB) and **Node.js 20+**.

```bash
# Terminal 1: database only
cd "/Users/kaushiksarmah999/uber clone"
docker compose up -d mongo
docker compose stop backend worker frontend    # free ports 4000/5173 if they were running

# Terminal 2: backend (http://localhost:4000)
cd "/Users/kaushiksarmah999/uber clone/server"
npm install          # first time only
npm run dev

# Terminal 3: frontend (http://localhost:5173)
cd "/Users/kaushiksarmah999/uber clone/client"
npm install          # first time only
npm run dev
```

Running without Docker at all (Homebrew MongoDB as a replica set) is described in [docs/26](docs/26-running-on-your-computer.md#way-c-no-docker-at-all-not-tested-on-this-mac).

### A first ride

1. Start the app and `simulate:drivers`.
2. At http://localhost:5173, **create an account** → "I need rides".
3. Click the map near central Bengaluru (pickup) and elsewhere (destination) → **See fare** → **Request ride**.
4. Watch the search widen: one demo driver declines, one lets the offer time out (15 s), and a farther one accepts.
5. Your **pickup code** starts the trip and the **drop-off code** ends it. Then rate the ride.
6. Sign in as the admin to explore **Operations**.

---

## Everyday commands

| What | Docker (project folder) | npm (`server` or `client` folder) |
| --- | --- | --- |
| Start | `docker compose up -d` | `npm run dev` |
| Status | `docker compose ps` | — |
| Logs | `docker compose logs -f backend` | shown in the terminal |
| Restart one part | `docker compose restart backend` | `Ctrl + C`, then `npm run dev` |
| After dependency changes | `docker compose up -d --build` | `npm install` |
| Stop (keeps data) | `docker compose down` | `Ctrl + C` |
| Create admin | `docker compose exec -e ADMIN_EMAIL=… -e ADMIN_PASSWORD=… backend npm run seed:admin` | `ADMIN_EMAIL=… ADMIN_PASSWORD=… npm run seed:admin` |
| Demo drivers | `docker compose exec backend npm run simulate:drivers` | `npm run simulate:drivers` |
| Dev SMS codes | `docker compose exec backend npm run dev:outbox` | `npm run dev:outbox` |
| Production build (frontend) | — | `npm run build` (in `client`) |
| Production start (backend) | — | `npm start` (in `server`) |

> ⚠️ `docker compose down -v` **deletes all local data** (the `mongo-data` and `driver-documents` volumes). Nothing in this project runs it for you.

Existing databases are upgraded automatically: [data migrations](docs/02-database-design-and-relationships.md#migrations) run when the backend and worker start, touch only old-shaped documents, and never delete data.

---

## Running the tests

The backend tests use a real MongoDB replica set (start the database first); they use separate `uber_test_*` databases and never touch your data.

```bash
cd "/Users/kaushiksarmah999/uber clone/server" && npm test       # also: test:unit, test:integration, test:e2e
cd "/Users/kaushiksarmah999/uber clone/client" && npm test       # no database needed
cd "/Users/kaushiksarmah999/uber clone/client" && npm run build  # production build check
```

Inside Docker:

```bash
docker compose exec -e MONGO_URI_TEST="mongodb://mongo:27017/?replicaSet=rs0" backend npm test
docker compose exec frontend npm test
```

**Latest results:**

| Suite | Result |
| --- | --- |
| Backend | 314 passed, 0 failed (25 files); inside Docker 313 passed + 1 skipped repo-only check |
| Frontend | 64 passed, 0 failed (8 files) |
| Production build | succeeds |

The concurrency tests use genuinely simultaneous requests: double booking, competing accepts, cancel-vs-accept races, parallel code submissions and duplicate payments. See [docs/15](docs/15-testing-guide.md) and the per-feature [test log](docs/implementation-test-log.md).

---

## Project structure

```text
uber clone/
├── docker-compose.yml          mongo · backend · worker · frontend
├── .env.example                every setting, placeholders only
├── mongo/                      replica-set initialisation script
├── docs/                       beginner-friendly documentation (see below)
├── server/                     Node.js + Express API
│   ├── src/
│   │   ├── config/             validated settings, vehicle catalog, DB connection
│   │   ├── models/             Mongoose schemas (16 collections)
│   │   ├── migrations/         safe data upgrades, run at startup
│   │   ├── routes/             all URLs, with auth/permission/validation middleware
│   │   ├── controllers/        thin HTTP handlers
│   │   ├── services/           business logic: matching, offers, rides, OTPs, chat, safety, …
│   │   ├── middleware/         auth, validation, rate limits, uploads, errors
│   │   ├── sockets/            Socket.IO server and notifier
│   │   ├── workers/            recovery worker
│   │   └── utils/              transactions, geo, crypto, logger, schemas
│   ├── scripts/                seedAdmin, simulateDrivers, devOutbox
│   └── tests/                  unit · integration · e2e (Jest + Supertest)
└── client/                     React + Vite + Tailwind
    └── src/
        ├── pages/              passenger, driver, account, onboarding; admin/ console
        ├── components/         map, booking, trip code, chat, safety, rating, …
        ├── hooks/ context/ services/ utils/
        └── __tests__/          Vitest + React Testing Library
```

---

## Configuration

Copy the template and edit it if you want to change anything:

```bash
cp .env.example .env            # used by Docker
cp .env.example server/.env     # used when running the server with npm
```

Without a `.env`, development uses safe, clearly-named defaults (fake SMS outbox, development-only keys). **Production refuses to start** without real `JWT_SECRET`, `PAYMENT_WEBHOOK_SECRET`, `OTP_SECRET`, `TRIP_OTP_ENCRYPTION_KEY`, `DOCUMENT_ENCRYPTION_KEY` and a non-development `SMS_PROVIDER`. Generate a key with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Matching radii, offer timeout, fares per vehicle type (`VEHICLE_CATALOG_JSON`), code lifetimes, chat limits and more are all in [`.env.example`](.env.example).

---

## External services

These need real credentials or agreements, and none was tested against a live service. Each has an honest development mode that **never reports a fake success**.

| Service | Enable with | Without it |
| --- | --- | --- |
| SMS (phone sign-in, trip codes) | `SMS_PROVIDER=twilio` + `TWILIO_*` | codes go to a local dev outbox; nothing is sent |
| Google sign-in | `GOOGLE_CLIENT_ID` ([setup](docs/24-authentication-providers.md#setting-up-google-needs-your-own-google-cloud-project)) | Google button hidden |
| Emergency response | `EMERGENCY_PROVIDER=webhook` with an authorised partner | incident recorded, admins alerted, user told to call **112**; police are never reported as notified |
| Identity verification | (no government/KYC integration) | admins review uploaded documents manually |
| Payments / refunds | (mock provider only) | refunds are recorded as manual requests |
| Maps | none needed | OpenStreetMap tiles; Nominatim address search (light use) |

---

## Documentation

All documents are written for beginners and checked against the code.

| | Topic |
| --- | --- |
| **26** | **[Running the app on your computer](docs/26-running-on-your-computer.md)**: start here |
| 00 | [Project overview and implementation status](docs/00-project-overview.md) |
| 01 | [System architecture](docs/01-system-architecture.md) |
| 02 | [Database design, relationships and migrations](docs/02-database-design-and-relationships.md) |
| 03 | [Authentication and authorization](docs/03-authentication-and-authorization.md) |
| 04 | [Ride booking and API flow](docs/04-ride-booking-and-api-flow.md) |
| 05 | [Progressive-radius search](docs/05-progressive-radius-search.md) |
| 06 | [Driver matching algorithm](docs/06-driver-matching-algorithm.md) |
| 07 | [Concurrency, consistency and atomic operations](docs/07-concurrency-consistency-and-atomic-operations.md) |
| 08 | [Offer acceptance, rejection and timeouts](docs/08-offer-acceptance-rejection-and-timeouts.md) |
| 09 | [Ride lifecycle](docs/09-ride-lifecycle.md) |
| 10 | [Fare calculation](docs/10-fare-calculation.md) |
| 11 | [Real-time communication and tracking](docs/11-realtime-communication-and-tracking.md) |
| 12 | [Docker local development](docs/12-docker-local-development.md) |
| 13 | [Security](docs/13-security.md) |
| 14 | [Error handling and recovery](docs/14-error-handling-and-recovery.md) |
| 15 | [Testing guide](docs/15-testing-guide.md) |
| 16 | [OTP and trip verification](docs/16-otp-and-trip-verification.md) |
| 17 | [Reviews and ratings](docs/17-reviews-and-ratings.md) |
| 18 | [Vehicle types and capacity](docs/18-vehicle-types-and-capacity.md) |
| 19 | [Safety and emergency response](docs/19-safety-and-emergency-response.md) |
| 20 | [Women's safety and matching preferences](docs/20-women-safety-and-matching-preferences.md) |
| 22 | [Chat system](docs/22-chat-system.md) |
| 23 | [Driver document verification](docs/23-driver-document-verification.md) |
| 24 | [Authentication providers](docs/24-authentication-providers.md) |
| 25 | [Admin management and audit](docs/25-admin-management-and-audit.md) |
| — | [Implementation audit (state before the upgrade)](docs/implementation-audit.md) |
| — | [Implementation test log (per feature)](docs/implementation-test-log.md) |

---

## Known limitations

- **Distances:** fare estimates use straight-line distance by default; an OSRM road-routing option exists but is untested.
- **Infrastructure:** the single-node MongoDB replica set gives transactions but not high availability. MongoDB has no authentication in local Docker. Rate limits are kept in memory per server process.
- **Security gaps:** uploads aren't scanned for malware, and there is no automatic data deletion when a driver leaves. Security has **not** been professionally reviewed.
- **Missing features:** no refresh tokens or password reset; no driver-initiated cancellation; no surge pricing.

More detail: [implementation status](docs/00-project-overview.md#implementation-status).
