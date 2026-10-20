'use strict';

const User = require('./User');
const DriverProfile = require('./DriverProfile');
const DriverLocation = require('./DriverLocation');
const Ride = require('./Ride');
const RideOffer = require('./RideOffer');
const Payment = require('./Payment');
const RideEvent = require('./RideEvent');
const RideOtp = require('./RideOtp');
const AuthOtp = require('./AuthOtp');
const Review = require('./Review');
const ChatMessage = require('./ChatMessage');
const ChatReport = require('./ChatReport');
const SafetyIncident = require('./SafetyIncident');
const DriverDocument = require('./DriverDocument');
const AuditLog = require('./AuditLog');
const DevOutboxMessage = require('./DevOutboxMessage');

const models = {
  User,
  DriverProfile,
  DriverLocation,
  Ride,
  RideOffer,
  Payment,
  RideEvent,
  RideOtp,
  AuthOtp,
  Review,
  ChatMessage,
  ChatReport,
  SafetyIncident,
  DriverDocument,
  AuditLog,
  DevOutboxMessage,
};

/** Create collections and build every declared index (safe to call repeatedly). */
async function ensureIndexes() {
  for (const model of Object.values(models)) {
    await model.createCollection().catch((err) => {
      if (err.codeName !== 'NamespaceExists') throw err;
    });
    await model.syncIndexes();
  }
}

module.exports = { ...models, ensureIndexes };
