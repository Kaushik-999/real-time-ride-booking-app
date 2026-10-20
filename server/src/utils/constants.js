'use strict';

const ROLES = Object.freeze({ PASSENGER: 'PASSENGER', DRIVER: 'DRIVER', ADMIN: 'ADMIN' });

const RIDE_STATUS = Object.freeze({
  SEARCHING: 'SEARCHING',
  DRIVER_ASSIGNED: 'DRIVER_ASSIGNED',
  DRIVER_ARRIVED: 'DRIVER_ARRIVED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  NO_DRIVER_FOUND: 'NO_DRIVER_FOUND',
});

const DRIVER_AVAILABILITY = Object.freeze({
  OFFLINE: 'OFFLINE',
  AVAILABLE: 'AVAILABLE',
  RESERVED: 'RESERVED',
  ON_TRIP: 'ON_TRIP',
});

// Driver onboarding/review state.
//   DOCUMENTS_REQUIRED -> (driver submits) -> PENDING_REVIEW -> APPROVED | REJECTED
//   REJECTED -> (driver fixes documents, resubmits) -> PENDING_REVIEW
//   APPROVED -> SUSPENDED (admin) -> PENDING_REVIEW / APPROVED
const APPROVAL_STATUS = Object.freeze({
  DOCUMENTS_REQUIRED: 'DOCUMENTS_REQUIRED',
  PENDING_REVIEW: 'PENDING_REVIEW',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  SUSPENDED: 'SUSPENDED',
});

const OFFER_STATUS = Object.freeze({
  PENDING: 'PENDING',
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
});

const PAYMENT_STATUS = Object.freeze({
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  REFUNDED: 'REFUNDED',
});

const PAYMENT_METHOD = Object.freeze({ CASH: 'CASH', ONLINE: 'ONLINE' });

// Vehicle types come from the configurable catalog (config/vehicles.js).
const VEHICLE_TYPES = require('../config/vehicles').TYPES;

const DRIVER_PREFERENCE = Object.freeze({ ANY: 'ANY', FEMALE_ONLY: 'FEMALE_ONLY' });

const ACCOUNT_STATUS = Object.freeze({ ACTIVE: 'ACTIVE', SUSPENDED: 'SUSPENDED' });

// Women-driver programme: a driver asks to be eligible; an admin verifies
// using submitted documents. Nothing is inferred from names or photos.
const FEMALE_PROGRAM_STATUS = Object.freeze({
  NOT_REQUESTED: 'NOT_REQUESTED',
  PENDING: 'PENDING',
  VERIFIED: 'VERIFIED',
  REJECTED: 'REJECTED',
});

const DOCUMENT_TYPES = Object.freeze(['PHOTO', 'DRIVING_LICENSE', 'VEHICLE_RC', 'VEHICLE_INSURANCE', 'AADHAAR', 'PAN']);
const DOCUMENT_STATUS = Object.freeze({ SUBMITTED: 'SUBMITTED', ACCEPTED: 'ACCEPTED', REJECTED: 'REJECTED', SUPERSEDED: 'SUPERSEDED' });

const OTP_PURPOSE = Object.freeze({ TRIP_START: 'TRIP_START', TRIP_COMPLETE: 'TRIP_COMPLETE', LOGIN: 'LOGIN' });
const OTP_STATUS = Object.freeze({ ACTIVE: 'ACTIVE', VERIFIED: 'VERIFIED', LOCKED: 'LOCKED', SUPERSEDED: 'SUPERSEDED' });

const REVIEW_STATUS = Object.freeze({ PUBLISHED: 'PUBLISHED', HIDDEN: 'HIDDEN' });

const INCIDENT_STATUS = Object.freeze({ OPEN: 'OPEN', ACKNOWLEDGED: 'ACKNOWLEDGED', ESCALATED: 'ESCALATED', RESOLVED: 'RESOLVED' });
const DISPATCH_STATUS = Object.freeze({
  NOT_CONFIGURED: 'NOT_CONFIGURED', // no emergency integration: nothing was sent
  PENDING: 'PENDING', // queued / retrying
  ACCEPTED: 'ACCEPTED', // the external service confirmed it accepted the alert
  FAILED: 'FAILED', // gave up after retries
});

// Fine-grained admin powers. '*' grants all (bootstrap super admin).
const ADMIN_PERMISSIONS = Object.freeze([
  'users:read',
  'users:manage',
  'drivers:review',
  'documents:read',
  'rides:read',
  'rides:manage',
  'reviews:moderate',
  'safety:manage',
  'chat:read',
  'payments:read',
  'payments:refund',
  'audit:read',
]);

const RIDE_EVENT = Object.freeze({
  RIDE_REQUESTED: 'RIDE_REQUESTED',
  OFFER_SENT: 'OFFER_SENT',
  OFFER_REJECTED: 'OFFER_REJECTED',
  OFFER_EXPIRED: 'OFFER_EXPIRED',
  RADIUS_EXPANDED: 'RADIUS_EXPANDED',
  DRIVER_ASSIGNED: 'DRIVER_ASSIGNED',
  DRIVER_ARRIVED: 'DRIVER_ARRIVED',
  TRIP_STARTED: 'TRIP_STARTED',
  TRIP_COMPLETED: 'TRIP_COMPLETED',
  RIDE_CANCELLED: 'RIDE_CANCELLED',
  NO_DRIVER_FOUND: 'NO_DRIVER_FOUND',
  PAYMENT_UPDATED: 'PAYMENT_UPDATED',
  OTP_FAILED: 'OTP_FAILED',
  SAFETY_INCIDENT: 'SAFETY_INCIDENT',
});

module.exports = {
  ROLES,
  RIDE_STATUS,
  DRIVER_AVAILABILITY,
  APPROVAL_STATUS,
  OFFER_STATUS,
  PAYMENT_STATUS,
  PAYMENT_METHOD,
  VEHICLE_TYPES,
  RIDE_EVENT,
  DRIVER_PREFERENCE,
  ACCOUNT_STATUS,
  FEMALE_PROGRAM_STATUS,
  DOCUMENT_TYPES,
  DOCUMENT_STATUS,
  OTP_PURPOSE,
  OTP_STATUS,
  REVIEW_STATUS,
  INCIDENT_STATUS,
  DISPATCH_STATUS,
  ADMIN_PERMISSIONS,
};
