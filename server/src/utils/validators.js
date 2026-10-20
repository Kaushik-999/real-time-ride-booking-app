'use strict';

// Zod schemas for every request body / param / query the API accepts.
// Body schemas are `.strict()`: unknown keys (e.g. a client-supplied
// `fare`, `driverId`, `passengerId` or `status`) cause a 400 instead of
// being silently ignored.
const { z } = require('zod');
const { VEHICLE_TYPES, RIDE_STATUS, PAYMENT_METHOD, APPROVAL_STATUS, PAYMENT_STATUS } = require('./constants');
const { normalizePhone } = require('./phone');

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'must be a valid id');

const lat = z.number({ invalid_type_error: 'lat must be a number' }).finite().min(-90).max(90);
const lng = z.number({ invalid_type_error: 'lng must be a number' }).finite().min(-180).max(180);

const place = z
  .object({ address: z.string().trim().min(1).max(300), lat, lng })
  .strict();

const estimatePlace = z
  .object({ address: z.string().trim().max(300).optional(), lat, lng })
  .strict();

const password = z
  .string()
  .min(8, 'password must be at least 8 characters')
  .max(72, 'password must be at most 72 characters') // bcrypt only uses the first 72 bytes
  .regex(/[A-Za-z]/, 'password must contain a letter')
  .regex(/\d/, 'password must contain a digit');

const phone = z
  .string()
  .trim()
  .transform((v, ctx) => {
    const n = normalizePhone(v);
    if (!n) ctx.addIssue({ code: 'custom', message: 'phone must be 7-15 digits, optionally starting with +' });
    return n;
  });

const otpCode = z.string().trim().regex(/^\d{6}$/, 'code must be 6 digits');

const identity = z
  .object({
    legalName: z.string().trim().min(2).max(100),
    dateOfBirth: z.coerce
      .date()
      .refine((d) => d < new Date(Date.now() - 18 * 365.25 * 24 * 3600 * 1000), 'driver must be at least 18 years old')
      .refine((d) => d > new Date('1900-01-01'), 'date of birth is not valid'),
    licenseNumber: z
      .string()
      .trim()
      .transform((s) => s.toUpperCase().replace(/[\s-]/g, ''))
      .pipe(z.string().regex(/^[A-Z0-9]{6,20}$/, 'licence number must be 6-20 letters/digits')),
  })
  .strict();

const vehicle = z
  .object({
    type: z.enum(VEHICLE_TYPES),
    registrationNumber: z
      .string()
      .trim()
      .transform((s) => s.toUpperCase().replace(/[\s-]/g, ''))
      .pipe(z.string().regex(/^[A-Z0-9]{4,15}$/, 'registration number must be 4-15 letters/digits')),
    model: z.string().trim().max(60).optional(),
    color: z.string().trim().max(30).optional(),
    capacity: z.number().int().min(1).max(20).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const entry = require('../config/vehicles').getVehicle(v.type);
    if (entry && v.capacity !== undefined && v.capacity > entry.maxCapacity) {
      ctx.addIssue({ code: 'custom', path: ['capacity'], message: `a ${entry.label} can carry at most ${entry.maxCapacity} passengers` });
    }
  });

/** passengerCount must fit the vehicle type's configured maximum. */
function checkCapacity(b, ctx) {
  const entry = require('../config/vehicles').getVehicle(b.vehicleType);
  if (entry && b.passengerCount > entry.maxCapacity) {
    ctx.addIssue({ code: 'custom', path: ['passengerCount'], message: `A ${entry.label} can carry at most ${entry.maxCapacity} passenger(s)` });
  }
}

const schemas = {
  idParam: (name) => z.object({ [name]: objectId }).strict(),

  register: z
    .object({
      name: z.string().trim().min(1).max(100),
      email: z.string().trim().toLowerCase().email().max(254),
      password,
      phone: phone.optional(),
      // ADMIN accounts cannot be self-registered.
      role: z.enum(['PASSENGER', 'DRIVER']).default('PASSENGER'),
      vehicle: vehicle.optional(),
      identity: identity.optional(),
    })
    .strict()
    .refine((b) => b.role !== 'DRIVER' || b.vehicle, { message: 'vehicle is required for drivers', path: ['vehicle'] })
    .refine((b) => b.role !== 'DRIVER' || b.identity, { message: 'identity details are required for drivers', path: ['identity'] })
    .refine((b) => b.role === 'DRIVER' || (!b.vehicle && !b.identity), { message: 'only drivers have a vehicle or identity details', path: ['vehicle'] }),

  updateIdentity: z.object({ identity }).strict(),
  documentUpload: z.object({ type: z.enum(require('./constants').DOCUMENT_TYPES) }).strict(),
  femaleProgram: z
    .object({ action: z.enum(['REQUEST', 'WITHDRAW']), consent: z.literal(true).optional() })
    .strict()
    .refine((b) => b.action !== 'REQUEST' || b.consent === true, { message: 'consent is required to request eligibility', path: ['consent'] }),
  driverDecision: z
    .object({
      approvalStatus: z.enum(['APPROVED', 'REJECTED', 'SUSPENDED', 'PENDING_REVIEW', 'PENDING']),
      reason: z.string().trim().min(3).max(500).optional(),
      documentDecisions: z
        .array(z.object({ documentId: objectId, status: z.enum(['ACCEPTED', 'REJECTED']), reason: z.string().trim().max(300).optional() }).strict())
        .max(10)
        .optional(),
    })
    .strict(),
  adminVehicle: z.object({ capacity: z.number().int().min(1).max(20), reason: z.string().trim().max(300).optional() }).strict(),
  femaleVerification: z
    .object({ status: z.enum(['VERIFIED', 'REJECTED', 'NOT_REQUESTED']), note: z.string().trim().max(300).optional() })
    .strict(),
  tripOtp: z.object({ otp: otpCode }).strict(),
  safetyReport: z
    .object({ lat: lat.optional(), lng: lng.optional(), message: z.string().max(500).optional() })
    .strict()
    .refine((b) => (b.lat === undefined) === (b.lng === undefined), { message: 'send both lat and lng, or neither', path: ['lat'] }),
  safetyAction: z
    .object({ action: z.enum(['ACKNOWLEDGE', 'ESCALATE', 'RESOLVE', 'RETRY_DISPATCH']), note: z.string().trim().max(500).optional() })
    .strict(),
  adminSafetyQuery: z
    .object({
      page: z.coerce.number().int().min(1).max(10000).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(20),
      status: z.enum(['OPEN', 'ACKNOWLEDGED', 'ESCALATED', 'RESOLVED']).optional(),
      dispatchStatus: z.enum(['NOT_CONFIGURED', 'PENDING', 'ACCEPTED', 'FAILED']).optional(),
    })
    .strict(),
  chatSend: z.object({ body: z.string().max(2000), clientMessageId: z.string().min(8).max(64) }).strict(),
  chatHistoryQuery: z
    .object({ before: z.string().datetime().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) })
    .strict(),
  chatReport: z.object({ reason: z.string().trim().min(3).max(300) }).strict(),
  adminChatReportsQuery: z
    .object({
      page: z.coerce.number().int().min(1).max(10000).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(20),
      status: z.enum(['OPEN', 'REVIEWED']).optional(),
    })
    .strict(),
  review: z
    .object({
      rating: z.number().int().min(1).max(5),
      serviceRating: z.number().int().min(1).max(5).optional(),
      comment: z.string().max(500).optional(),
    })
    .strict(),
  reviewModeration: z.object({ status: z.enum(['HIDDEN', 'PUBLISHED']), reason: z.string().trim().max(300).optional() }).strict(),
  adminReviewsQuery: z
    .object({
      page: z.coerce.number().int().min(1).max(10000).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(20),
      status: z.enum(['PUBLISHED', 'HIDDEN']).optional(),
      maxRating: z.coerce.number().int().min(1).max(5).optional(),
    })
    .strict(),
  otpRequest: z.object({ phone }).strict(),
  otpVerify: z.object({ phone, code: otpCode }).strict(),
  googleToken: z.object({ idToken: z.string().min(20).max(4096) }).strict(),

  login: z
    .object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1).max(200) })
    .strict(),

  estimate: z
    .object({
      pickup: estimatePlace,
      destination: estimatePlace,
      vehicleType: z.enum(VEHICLE_TYPES).default('CAR'),
      passengerCount: z.number().int().min(1).max(20).default(1),
    })
    .strict()
    .superRefine(checkCapacity),

  createRide: z
    .object({
      pickup: place,
      destination: place,
      vehicleType: z.enum(VEHICLE_TYPES).default('CAR'),
      paymentMethod: z.nativeEnum(PAYMENT_METHOD).default(PAYMENT_METHOD.CASH),
      // Generated by the client once per booking attempt (e.g. a UUID) and
      // re-sent on retries so the server can de-duplicate.
      requestKey: z.string().trim().min(8).max(100).regex(/^[A-Za-z0-9_-]+$/, 'requestKey must be URL-safe'),
      // Number of riders (individual booking for a group; NOT a shared ride).
      passengerCount: z.number({ invalid_type_error: 'passengerCount must be a whole number' }).int().min(1).max(20).default(1),
      driverPreference: z.enum(['ANY', 'FEMALE_ONLY']).default('ANY'),
    })
    .strict()
    .superRefine(checkCapacity),

  cancel: z.object({ reason: z.string().trim().max(300).optional() }).strict(),

  emptyBody: z.object({}).strict(),

  availability: z.object({ availability: z.enum(['AVAILABLE', 'OFFLINE']) }).strict(),

  location: z
    .object({
      lat,
      lng,
      heading: z.number().min(0).max(360).optional(),
      // When the device captured the position. Optional; if supplied it must
      // be recent and not in the future.
      recordedAt: z.string().datetime().optional(),
    })
    .strict(),

  updateVehicle: z.object({ vehicle }).strict(),

  approval: z.object({ approvalStatus: z.nativeEnum(APPROVAL_STATUS) }).strict(),

  pagination: z
    .object({
      page: z.coerce.number().int().min(1).max(10000).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(20),
    })
    .strict(),

  adminRidesQuery: z
    .object({
      page: z.coerce.number().int().min(1).max(10000).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(20),
      status: z.nativeEnum(RIDE_STATUS).optional(),
      passengerId: objectId.optional(),
      driverId: objectId.optional(),
      vehicleType: z.enum(VEHICLE_TYPES).optional(),
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
    })
    .strict(),
  adminUsersQuery: z
    .object({
      page: z.coerce.number().int().min(1).max(10000).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(20),
      role: z.enum(['PASSENGER', 'DRIVER', 'ADMIN']).optional(),
      accountStatus: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
      q: z.string().trim().min(1).max(100).optional(),
    })
    .strict(),
  accountStatus: z.object({ accountStatus: z.enum(['ACTIVE', 'SUSPENDED']), reason: z.string().trim().min(3).max(300).optional() }).strict(),
  adminPermissions: z.object({ permissions: z.array(z.string().max(40)).max(20) }).strict(),
  adminCancel: z.object({ reason: z.string().trim().min(3).max(300) }).strict(),
  adminPaymentsQuery: z
    .object({
      page: z.coerce.number().int().min(1).max(10000).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(20),
      status: z.nativeEnum(PAYMENT_STATUS).optional(),
      method: z.nativeEnum(PAYMENT_METHOD).optional(),
      refund: z.enum(['requested']).optional(),
    })
    .strict(),
  refundRequest: z.object({ reason: z.string().trim().min(3).max(300) }).strict(),
  auditQuery: z
    .object({
      page: z.coerce.number().int().min(1).max(10000).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      action: z.string().max(80).optional(),
      actorId: objectId.optional(),
      targetType: z.string().max(40).optional(),
      targetId: objectId.optional(),
    })
    .strict(),

  adminDriversQuery: z
    .object({
      page: z.coerce.number().int().min(1).max(10000).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(20),
      approvalStatus: z.nativeEnum(APPROVAL_STATUS).optional(),
      femaleProgram: z.enum(['NOT_REQUESTED', 'PENDING', 'VERIFIED', 'REJECTED']).optional(),
    })
    .strict(),

  paymentWebhook: z
    .object({
      providerReference: z.string().min(8).max(100),
      status: z.enum([PAYMENT_STATUS.SUCCEEDED, PAYMENT_STATUS.FAILED]),
      failureReason: z.string().max(200).optional(),
    })
    .strict(),
};

module.exports = { schemas, objectId, otpCode, phone, identity, vehicle };
