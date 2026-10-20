'use strict';

/**
 * Vehicle catalog: every bookable vehicle type, its passenger capacity and
 * its fare table. Configuration-driven so new types (or different prices
 * per city) need no code change:
 *
 *   VEHICLE_CATALOG_JSON='{"BIKE":{"label":"Bike","category":"BIKE","defaultCapacity":1,"maxCapacity":1,
 *                          "fare":{"basePaise":2500,"perKmPaise":600,"perMinPaise":100,"minimumPaise":3000}}, ...}'
 *
 * Keys are the values stored in DriverProfile.vehicle.type and Ride.vehicleType.
 * `category` groups subtypes (CAR and CAR_XL are both cars).
 * The CAR entry defaults to the FARE_* environment variables so existing
 * deployments keep their prices.
 */
const { z } = require('zod');
const config = require('./index');

const fareSchema = z
  .object({
    basePaise: z.number().int().min(0),
    perKmPaise: z.number().int().min(0),
    perMinPaise: z.number().int().min(0),
    minimumPaise: z.number().int().min(0),
  })
  .strict();

const entrySchema = z
  .object({
    label: z.string().min(1).max(40),
    category: z.enum(['BIKE', 'AUTO', 'CAR']),
    defaultCapacity: z.number().int().min(1).max(20),
    maxCapacity: z.number().int().min(1).max(20),
    fare: fareSchema,
  })
  .strict()
  .refine((e) => e.defaultCapacity <= e.maxCapacity, { message: 'defaultCapacity must be <= maxCapacity' });

const catalogSchema = z
  .record(z.string().regex(/^[A-Z][A-Z0-9_]{1,19}$/, 'vehicle type keys are UPPER_SNAKE_CASE'), entrySchema)
  .refine((c) => Object.keys(c).length > 0, { message: 'catalog must not be empty' });

const carFare = {
  basePaise: config.fare.basePaise,
  perKmPaise: config.fare.perKmPaise,
  perMinPaise: config.fare.perMinPaise,
  minimumPaise: config.fare.minimumPaise,
};

const DEFAULT_CATALOG = {
  BIKE: {
    label: 'Bike',
    category: 'BIKE',
    defaultCapacity: 1,
    maxCapacity: 1,
    fare: { basePaise: 2500, perKmPaise: 600, perMinPaise: 100, minimumPaise: 3000 },
  },
  AUTO: {
    label: 'Auto',
    category: 'AUTO',
    defaultCapacity: 3,
    maxCapacity: 3,
    fare: { basePaise: 3500, perKmPaise: 900, perMinPaise: 125, minimumPaise: 5000 },
  },
  CAR: { label: 'Car', category: 'CAR', defaultCapacity: 4, maxCapacity: 4, fare: carFare },
  CAR_XL: {
    label: 'Car XL',
    category: 'CAR',
    defaultCapacity: 6,
    maxCapacity: 7,
    fare: { basePaise: 7500, perKmPaise: 1700, perMinPaise: 200, minimumPaise: 12000 },
  },
};

function loadCatalog(raw = process.env.VEHICLE_CATALOG_JSON) {
  if (!raw) return DEFAULT_CATALOG;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Invalid configuration: VEHICLE_CATALOG_JSON is not valid JSON');
  }
  const result = catalogSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: VEHICLE_CATALOG_JSON ${issues}`);
  }
  return result.data;
}

const CATALOG = Object.freeze(loadCatalog());
const TYPES = Object.freeze(Object.keys(CATALOG));

function getVehicle(type) {
  return CATALOG[type] || null;
}

/** Public, client-safe view of the catalog (used by GET /api/vehicles). */
function publicCatalog() {
  return TYPES.map((type) => {
    const v = CATALOG[type];
    return { type, label: v.label, category: v.category, maxPassengers: v.maxCapacity, defaultCapacity: v.defaultCapacity };
  });
}

module.exports = { CATALOG, TYPES, getVehicle, publicCatalog, loadCatalog, DEFAULT_CATALOG };
