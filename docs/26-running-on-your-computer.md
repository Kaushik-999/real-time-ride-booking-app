# 26 · Running the app on your computer

> A step-by-step guide: what to type, and in which window. No prior experience needed.
> Related: [12 Docker local development](12-docker-local-development.md) · [15 Testing guide](15-testing-guide.md)

## Before you start: three words you need

- **Terminal**: the app where you type commands. On a Mac: press `⌘ + Space`, type `Terminal`, press Enter. (The terminal inside VS Code works too: menu **Terminal → New Terminal**.)
- **Command**: a line you type into the terminal, then press **Enter**. In this guide every command is in a grey box. Type (or paste) it exactly.
- **Project folder**: `/Users/kaushiksarmah999/uber clone`. The folder name contains a **space**, so always put the path in quotes:

```bash
cd "/Users/kaushiksarmah999/uber clone"
```

`cd` means "change directory", that is, go into this folder. Most commands below must be run from a specific folder; the guide always says which.

**To stop a running program in a terminal, press `Ctrl + C`** (hold Control, press C).

## What the app needs to run

| Part | What it is | Address in your browser |
| --- | --- | --- |
| MongoDB | the database (must run as a *replica set*, see [07](07-concurrency-consistency-and-atomic-operations.md#why-a-replica-set)) | not opened in the browser |
| Backend | the Node.js server (API + live updates + background worker) | http://localhost:4000/api/health |
| Frontend | the website you click on | **http://localhost:5173** |

There are three ways to run them. **Pick one.**

| Way | You need | Effort | Tested on this Mac |
| --- | --- | --- | --- |
| **A. Everything in Docker** (recommended) | Docker Desktop | easiest: 1 command | yes |
| **B. Database in Docker, app with npm** | Docker Desktop + Node.js | 3 terminal windows | yes |
| **C. No Docker at all** | Homebrew MongoDB + Node.js | most set-up | **no** (instructions only) |

---

## Way A: everything in Docker (recommended)

### Start

1. Open **Docker Desktop** (Applications folder, or `⌘ + Space` → "Docker"). Wait until the whale icon in the top menu bar stops animating (about 30 seconds).
2. Open a terminal and type:

```bash
cd "/Users/kaushiksarmah999/uber clone"
docker compose up -d
```

   - `up` starts all four parts (database, backend, background worker, website).
   - `-d` ("detached") runs them in the background, so you get your terminal back.
   - The **first time**, or after the code's dependencies changed, use `docker compose up -d --build` instead (it rebuilds; takes a few minutes).

3. Check that everything is running:

```bash
docker compose ps
```

   Wait until `backend` and `mongo` say **(healthy)**. That can take up to a minute.

4. Open **http://localhost:5173** in your browser. Done.

### Useful extras (same terminal, same folder)

```bash
# Create an admin account (only once; choose your own password)
docker compose exec -e ADMIN_EMAIL=admin@example.com -e ADMIN_PASSWORD='ChooseAStrongOne1' backend npm run seed:admin

# Fake drivers driving around Bengaluru, so you can book a ride (Ctrl+C to stop)
docker compose exec backend npm run simulate:drivers

# Phone sign-in codes (in development no SMS is really sent; they appear here)
docker compose exec backend npm run dev:outbox

# Watch what the server is doing (Ctrl+C stops watching, not the app)
docker compose logs -f backend
```

### Stop

```bash
cd "/Users/kaushiksarmah999/uber clone"
docker compose down
```

Your data (accounts, rides, uploaded documents) is **kept**. Then you can quit Docker Desktop.

> ⚠️ Never add `-v` (`docker compose down -v`) unless you really want to **delete all your local data**.

### Next time

Open Docker Desktop, wait for the whale, then `docker compose up -d` in the project folder.

---

## Way B: database in Docker, app with npm

Use this when you want to see the server's output directly, or change code and see it restart instantly.

### One-time set-up

Install the app's libraries. Each command runs once, in its own folder:

```bash
cd "/Users/kaushiksarmah999/uber clone/server"
npm install
```

```bash
cd "/Users/kaushiksarmah999/uber clone/client"
npm install
```

(`npm install` downloads everything listed in `package.json` into a `node_modules` folder. Run it again only when someone adds a library.)

### Every time: three terminal windows

**Terminal 1: database only.** Open Docker Desktop first, then:

```bash
cd "/Users/kaushiksarmah999/uber clone"
docker compose up -d mongo
```

If the other Docker parts are running (from Way A), stop them so they don't occupy ports 4000 and 5173:

```bash
docker compose stop backend worker frontend
```

**Terminal 2: backend.**

```bash
cd "/Users/kaushiksarmah999/uber clone/server"
npm run dev
```

You should see `"msg":"connected to MongoDB"` and `"msg":"API listening"`. Leave this window open: the server runs as long as it stays open. `npm run dev` restarts the server automatically when you save a file. The background worker runs inside this same process, so you don't need a separate one.

**Terminal 3: frontend.** Open a new window or tab (`⌘ + T`):

```bash
cd "/Users/kaushiksarmah999/uber clone/client"
npm run dev
```

You should see `Local: http://localhost:5173/`. Open it in your browser.

### Extras in Way B (a fourth terminal, in the `server` folder)

```bash
cd "/Users/kaushiksarmah999/uber clone/server"
ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD='ChooseAStrongOne1' npm run seed:admin
npm run simulate:drivers
npm run dev:outbox
```

### Settings (optional)

Outside Docker, the server reads settings from **`server/.env`**, not the `.env` in the main folder. To customise anything:

```bash
cd "/Users/kaushiksarmah999/uber clone"
cp .env.example server/.env
```

Then edit `server/.env`. Without it, safe development defaults are used. `.env` files are never committed to git.

### Stop

Press `Ctrl + C` in Terminal 2 and Terminal 3. Then, to stop the database:

```bash
cd "/Users/kaushiksarmah999/uber clone"
docker compose stop mongo
```

---

## Way C: no Docker at all (not tested on this Mac)

The app needs MongoDB **as a replica set** (transactions don't work on a plain MongoDB). These are the standard steps with Homebrew; they were **not** run on this machine.

### One-time set-up

```bash
brew tap mongodb/brew
brew install mongodb-community@7.0
mkdir -p ~/mongo-rs-data
```

### Every time

**Terminal 1: start MongoDB as a single-node replica set** (leave it open):

```bash
mongod --replSet rs0 --dbpath ~/mongo-rs-data --port 27017 --bind_ip 127.0.0.1
```

**Only the very first time**, in another terminal, turn on the replica set:

```bash
mongosh --eval 'rs.initiate({_id: "rs0", members: [{_id: 0, host: "127.0.0.1:27017"}]})'
```

It should print `{ ok: 1 }`. Then continue exactly like **Way B**, from "Terminal 2: backend". This database is separate from the Docker one, so you start with no accounts.

---

## Building the production version

`npm run dev` is for development: it is fast and restarts automatically. For a production-like run:

**Frontend: build the website into plain files** (folder `client`):

```bash
cd "/Users/kaushiksarmah999/uber clone/client"
npm run build
```

This creates `client/dist/` (optimised HTML/CSS/JavaScript). To preview that build locally:

```bash
npm run preview
```

It prints an address (usually http://localhost:4173). Like `npm run dev`, the preview forwards `/api` and live updates to the backend on port 4000, so start the backend first. Use `npm run dev` for normal work, because it reloads when you edit code.

**Backend: run without auto-restart** (folder `server`):

```bash
cd "/Users/kaushiksarmah999/uber clone/server"
npm start
```

For a real deployment you must set real secrets: production refuses to start without `JWT_SECRET`, `PAYMENT_WEBHOOK_SECRET`, `OTP_SECRET`, `TRIP_OTP_ENCRYPTION_KEY`, `DOCUMENT_ENCRYPTION_KEY` and a non-development `SMS_PROVIDER` ([13](13-security.md)). Docker production images are described in [12](12-docker-local-development.md#production-images).

## Running the tests

The backend tests need the database running (Way A, B or C).

```bash
cd "/Users/kaushiksarmah999/uber clone/server"
npm test                    # all backend tests (about a minute)
npm run test:unit           # only the quick unit tests (no database needed)
```

```bash
cd "/Users/kaushiksarmah999/uber clone/client"
npm test                    # frontend tests (no database needed)
```

Tests use their own databases (`uber_test_1`, `uber_test_2`, …) and never touch your app data. Expected result: **314 backend and 64 frontend tests passing** ([15](15-testing-guide.md)).

## Try it: a 3-minute walkthrough

1. Start the app (Way A or B) and the driver simulator.
2. Open http://localhost:5173 → **Create an account** → "I need rides".
3. Click the map near central Bengaluru (pickup), then somewhere else (destination). Choose riders, click **See fare**, then **Request ride**.
4. Watch the search: one simulated driver declines, one ignores the offer (15 seconds), then one accepts.
5. Your **pickup code** appears. The simulated driver uses it to start the trip, then the **drop-off code** to finish.
6. Rate the ride. Sign in as the admin (seed command above) to see everything under **Operations**.

## When something goes wrong

| What you see | What it means | What to do |
| --- | --- | --- |
| `Cannot connect to the Docker daemon` / `failed to connect to the docker API` | Docker Desktop isn't running | open Docker Desktop, wait for the whale, try again |
| `ECONNREFUSED 127.0.0.1:27017` or health says `"status":"degraded"` | the database isn't running | start it (`docker compose up -d mongo`, or `mongod …` in Way C) |
| `Transaction numbers are only allowed on a replica set member` | MongoDB is running, but not as a replica set | use the Docker `mongo` service, or start `mongod` with `--replSet rs0` and run `rs.initiate` once |
| `EADDRINUSE: address already in use :::4000` (or 5173) | something is already using that port, often the Docker backend/frontend | `docker compose stop backend worker frontend`, or find it with `lsof -i :4000` and stop it |
| `cd: no such file or directory: /Users/kaushiksarmah999/uber` | the path wasn't in quotes (the folder name has a space) | `cd "/Users/kaushiksarmah999/uber clone"` |
| `Cannot find module …` | libraries not installed | run `npm install` in that folder (`server` or `client`) |
| `npm ERR! Missing script: "dev"` | you are in the wrong folder | `cd` into `server` or `client` first |
| The website loads but says "Cannot reach the server" | the backend isn't running | start Terminal 2 (Way B) or check `docker compose ps` (Way A) |
| No ride offers arrive | no fresh, approved drivers nearby | run `npm run simulate:drivers` and book near central Bengaluru |
| Phone sign-in: "where is my code?" | development mode doesn't send SMS | `npm run dev:outbox` (Way B) / `docker compose exec backend npm run dev:outbox` (Way A) |

Node.js 20 or newer is required (check with `node -v`; this Mac has v26).
