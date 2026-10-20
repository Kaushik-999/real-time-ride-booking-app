# 10 · Fare calculation

> Previous: [09 Ride lifecycle](09-ride-lifecycle.md) · Next: [11 Real-time](11-realtime-communication-and-tracking.md)

## The basic idea

A taxi fare usually has three parts:

- a **base fare** (a fixed amount just for starting),
- a **distance charge** (per kilometre),
- a **time charge** (per minute, covering traffic and waiting).

We show an **estimated fare** before booking and calculate a **final fare** when the trip ends.

The **server** always computes the fare. If the browser decided the price, anyone could edit a request to pay ₹1. The booking schema doesn't even have a fare field; sending one is rejected with `400` (test #13).

## The formula in this project

`server/src/services/fareService.js`, `calculateFare`:

```text
fare = base + distance_km × perKm + duration_min × perMin
fare = max(fare, minimum)
fare = round to the nearest whole rupee
```

```js
const distancePaise = Math.round((distanceMeters * rates.perKmPaise) / 1000);
const timePaise = Math.round((durationSeconds * rates.perMinPaise) / 60);
const raw = basePaise + distancePaise + timePaise;
const totalPaise = Math.round(Math.max(raw, rates.minimumPaise) / 100) * 100;
```

### Configuration (defaults)

| Env variable | Default | Meaning |
| --- | --- | --- |
| `FARE_BASE_PAISE` | 5000 | ₹50 base |
| `FARE_PER_KM_PAISE` | 1200 | ₹12 per km |
| `FARE_PER_MIN_PAISE` | 150 | ₹1.50 per minute |
| `FARE_MINIMUM_PAISE` | 8000 | ₹80 minimum fare |
| `FARE_AVG_SPEED_KMH` | 25 | used to estimate duration from straight-line distance |
| `FARE_CURRENCY` | INR | |
| `ROUTING_PROVIDER` | `straight_line` | or `osrm` with `OSRM_URL` |

These `FARE_*` values are the **Car** fare table. Since the upgrade each vehicle type has its own table in the catalog (`server/src/config/vehicles.js`, overridable with `VEHICLE_CATALOG_JSON`): Bike ₹25 + ₹6/km + ₹1/min (min ₹30), Auto ₹35 + ₹9/km + ₹1.25/min (min ₹50), Car as above, Car XL ₹75 + ₹17/km + ₹2/min (min ₹120). See [18](18-vehicle-types-and-capacity.md).

## Currency representation and rounding

Money is stored as an **integer number of paise** (1 rupee = 100 paise). Computers store decimals in binary, so `0.1 + 0.2` is `0.30000000000000004`. Adding rupee amounts as decimals slowly produces wrong totals. Integers don't have that problem. Each component is rounded once to whole paise, and the total is rounded to the nearest whole rupee (a common, friendly display convention). The browser converts paise to "₹206" only for display (`formatMoney` in `client/src/utils/format.js`).

## Worked example (Indian rupees)

A 10 km trip taking 24 minutes:

| Part | Calculation | Paise |
| --- | --- | --- |
| Base | | 5,000 |
| Distance | 10,000 m × 1,200 / 1,000 | 12,000 |
| Time | 1,440 s × 150 / 60 | 3,600 |
| Raw total | | 20,600 |
| Minimum check | 20,600 ≥ 8,000 | 20,600 |
| Rounded to rupee | | **20,600 = ₹206** |

A 500 m, 1-minute hop: raw = 5000 + 600 + 150 = 5,750 paise → below minimum → **₹80** (`minimumApplied: true`).

Both examples are unit tests in `server/tests/unit/fare.test.js`.

## Estimated fare (at booking)

`fareService.estimateTrip(pickup, destination, vehicleType, passengerCount)` (rates from `ratesFor(vehicleType)`; the response also lists `options`, the price for every vehicle type that fits the group):

1. `routingService.getRoute` returns distance and duration.
   - Default `straight_line`: great-circle (haversine) distance; duration = distance ÷ `FARE_AVG_SPEED_KMH`. **This is an estimate**; real roads are longer. The API marks it `source: 'straight_line', isEstimate: true` and the UI says "Estimated from straight-line distance".
   - `osrm`: asks an OSRM routing server for the real driving route; falls back to straight-line on error or after `ROUTING_TIMEOUT_MS`. *Implemented but not tested against a live OSRM server.*
2. Rejects trips shorter than 100 m or longer than 200 km (`400`).
3. Computes the fare. The ride stores `estimatedFare` and `estimate.breakdown`.

Real example (MG Road → Koramangala, straight line): 5,185 m, 747 s → 5000 + 6222 + 1868 = 13,090 → **₹131**.

## Final fare (at completion)

`fareService.calculateFinalFare(ride, completedAt)` uses only **server-recorded** data:

- **Distance**: `ride.tripDistanceMeters`, the sum of distances between consecutive driver location updates the server accepted while the ride was `IN_PROGRESS` (`driverService.updateLocation`; jumps over 2 km between two updates are ignored as GPS glitches). If no updates arrived, the booking estimate distance is used.
- **Duration**: `completedAt − startedAt`, both server timestamps.

The result is stored as `finalFare` and `finalBreakdown` (test #71). The final fare can be lower or higher than the estimate.

## Straight-line vs route distance

Straight-line distance is the "as the crow flies" length. Route distance follows roads. **This implementation uses straight-line distance for estimates by default**, and **tracked GPS distance for final fares**. Tracked distance follows the actual roads driven, but it is only as trustworthy as the driver's device; a production system would cross-check it against a routing service.

## Cancellation and payment

- Cancelled and `NO_DRIVER_FOUND` rides have no final fare and no payment. No cancellation fee is implemented.
- **Completing a ride is not the same as being paid.** Completion creates a `Payment` with status `PENDING`:
  - `ONLINE`: passenger calls `POST /api/rides/:id/pay` → `PROCESSING`; the provider later calls `POST /api/payments/webhook` (HMAC-signed with `PAYMENT_WEBHOOK_SECRET`) → `SUCCEEDED` or `FAILED`. In development the **mock** provider settles automatically after `PAYMENT_MOCK_SETTLE_DELAY_MS`.
  - `CASH`: the assigned driver calls `POST /api/rides/:id/cash-collected` → `SUCCEEDED`.
- A repeated success callback doesn't double-record; a `FAILED` payment can't be flipped to `SUCCEEDED` by a late callback (tests #92, #93).

## What can go wrong

| Problem | Prevention |
| --- | --- |
| Client sends its own price | strict Zod schema rejects unknown fields |
| Rounding drift | integer paise |
| Router down/slow | fallback to straight-line, logged as a warning |
| Driver never sends locations during trip | final distance falls back to the estimate |

## Glossary

- **Paise**: 1/100 of a rupee.
- **Haversine**: formula for distance between two points on a sphere.
- **Routing service (OSRM)**: software that computes driving routes on a road map.
- **Webhook**: a request a third party (the payment provider) sends to our server to report a result.
- **HMAC signature**: a code proving a message came from someone who knows a shared secret.

## Upgrade: completion code and refunds

The trip can only be completed with the passenger's drop-off code ([16](16-otp-and-trip-verification.md)), and completion still creates a **PENDING** payment, so verified completion never implies payment. Admins can record a refund **request**; the mock provider moves no money ([25](25-admin-management-and-audit.md)).
