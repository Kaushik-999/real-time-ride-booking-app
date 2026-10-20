# 18 · Vehicle types and passenger capacity

> Related: [05 Progressive radius](05-progressive-radius-search.md) · [06 Matching](06-driver-matching-algorithm.md) · [10 Fare](10-fare-calculation.md)

## 1. What this feature means

Passengers choose a **vehicle type** (Bike, Auto, Car, Car XL) and say **how many people** are riding. Only drivers with that vehicle type and enough seats are offered the ride. Each type has its own price list.

This is an **individual booking for a group** (for example, 3 friends in one auto), **not** carpooling with strangers.

## 2. Why it is needed

A bike can't carry three people, and an SUV costs more to run than a hatchback. Without type and capacity rules, drivers would receive rides they can't legally or physically do, and prices would be unfair.

## 3. How it works, step by step

1. The booking screen loads the catalog from `GET /api/vehicles` (`BookingForm.jsx`). It shows every type with its maximum passengers, disables types that are too small for the chosen group, and switches automatically to the first type that fits.
2. **See fare** calls `POST /api/rides/estimate` with `vehicleType` and `passengerCount`. The response includes `options`: the same route priced for every type that fits the group.
3. **Request ride** sends `vehicleType` and `passengerCount` (no price). The server checks the count **twice**:
   - in the request schema (`checkCapacity` in `utils/validators.js`), and
   - again in `rideService.createRide` (defence in depth: never trust only the validation layer).
4. The ride stores `vehicleType` and `passengerCount`. The fare is computed with that type's fare table (`fareService.ratesFor`).
5. **Matching** uses one shared rule, `rideEligibilityFilter(ride)` in `server/src/services/driverEligibility.js`:

```js
{
  'vehicle.type': ride.vehicleType,                        // same type
  'vehicle.capacity': { $gte: ride.passengerCount || 1 },  // enough seats
  // + women-driver verification for FEMALE_ONLY rides (see doc 20)
}
```

   The same filter is applied in three places, so they can never disagree:
   1. the geospatial candidate search (`matchingService.findCandidates`),
   2. the **atomic reservation** (`driverReservation.reserveDriver`), and
   3. the **atomic acceptance** (`offerService.acceptOffer`).

   Even a forged offer to an incompatible driver can't be accepted (`409 NOT_ELIGIBLE`).
6. The passenger sees the assigned vehicle's type, label, registration and capacity (`RideStatus.jsx`).

## 4. The configurable catalog

`server/src/config/vehicles.js` defines the default catalog:

| Type | Label | Category | Default seats | Max seats | Base | Per km | Per min | Minimum |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `BIKE` | Bike | BIKE | 1 | 1 | ₹25 | ₹6 | ₹1.00 | ₹30 |
| `AUTO` | Auto | AUTO | 3 | 3 | ₹35 | ₹9 | ₹1.25 | ₹50 |
| `CAR` | Car | CAR | 4 | 4 | `FARE_BASE_PAISE` (₹50) | `FARE_PER_KM_PAISE` (₹12) | `FARE_PER_MIN_PAISE` (₹1.50) | `FARE_MINIMUM_PAISE` (₹80) |
| `CAR_XL` | Car XL | CAR | 6 | 7 | ₹75 | ₹17 | ₹2.00 | ₹120 |

Nothing is hard-coded elsewhere: `VEHICLE_TYPES` in `utils/constants.js` is derived from the catalog, and the database enums use it. To change prices or add a type (say an e-rickshaw), set `VEHICLE_CATALOG_JSON` (validated with Zod at startup; invalid JSON stops the server with a clear error). `category` groups subtypes such as `CAR` and `CAR_XL`.

**Matching rule:** the requested type must equal the driver's type exactly. A Car XL driver does not automatically receive Car requests. This is a deliberate, simple choice; "upgrade" rules could be added later.

## 5. MongoDB collections and fields

- `driverprofiles.vehicle.type`, `vehicle.capacity` (validated: integer, ≥ 1, ≤ the type's `maxCapacity`; defaults to the type's `defaultCapacity`).
- `rides.vehicleType`, `rides.passengerCount`.
- Migration `2026-10-20-001-driver-profiles-v2` set `vehicle.capacity` for drivers created before this feature (see [implementation-audit.md](implementation-audit.md)), so existing approved drivers kept receiving rides.

## 6. API endpoints

| Endpoint | Notes |
| --- | --- |
| `GET /api/vehicles` | public catalog: `{ type, label, category, maxPassengers, defaultCapacity }` |
| `POST /api/rides/estimate` | accepts `vehicleType`, `passengerCount`; returns `options` |
| `POST /api/rides` | accepts `vehicleType`, `passengerCount` |
| `POST /api/auth/register` (driver) | `vehicle.capacity` optional, ≤ type maximum |
| `PATCH /api/admin/drivers/:driverId/vehicle` | admin (`drivers:review`) corrects capacity, audited |

Socket `driver:offer` includes `vehicleType` and `passengerCount`.

## 7. What can go wrong, and 8. how it is handled

| Problem | Handling |
| --- | --- |
| Client sends 5 riders for a car, or `"3"`, `2.5`, `0` | `400` from the schema, and again from the service |
| Bike driver receives a car ride | impossible: filter in search, reservation and acceptance |
| A driver's capacity is wrong | admin corrects it (audited); can't exceed the type maximum |
| Bad `VEHICLE_CATALOG_JSON` | server refuses to start, with the reason |
| Driver changes vehicle | goes back to `DOCUMENTS_REQUIRED`, offline; RC and insurance must be re-uploaded ([23](23-driver-document-verification.md)) |

## 9. How to test

`server/tests/integration/vehicles.test.js` (20 tests: catalog, per-type fares, over-capacity per type, manipulated counts, all four types bookable, matching excludes other types and small vehicles, ring expansion still works for Car XL, forged incompatible offer rejected, assigned vehicle displayed, final fare per type, catalog override validation, admin capacity edit). Frontend: `bookingAndAuth.test.jsx`.

## 10. Not implemented

No vehicle-upgrade matching (e.g. Car XL serving Car requests), no luggage or child-seat options, no per-city catalogs.
