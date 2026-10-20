'use strict';

const { RideOffer, Ride, RideEvent, DriverProfile } = require('../../src/models');
const matching = require('../../src/services/matchingService');
const offerService = require('../../src/services/offerService');

const pendingOffer = (rideId) => RideOffer.findOne({ rideId, status: 'PENDING' }).lean();

/** Force the ride's current pending offer to be past its deadline, then time it out. */
async function timeOut(rideId) {
  const offer = await pendingOffer(rideId);
  await RideOffer.updateOne({ _id: offer._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  return matching.handleOfferTimeout(offer._id);
}

/** Reject the current pending offer as its driver, then run the next matching step. */
async function rejectCurrent(rideId) {
  const offer = await pendingOffer(rideId);
  await offerService.rejectOffer(offer._id, offer.driverId);
  return matching.advanceMatching(rideId);
}

/** Who has been offered this ride, in order. */
async function offeredDriverIds(rideId) {
  const offers = await RideOffer.find({ rideId }).sort({ offeredAt: 1, _id: 1 }).lean();
  return offers.map((o) => String(o.driverId));
}

const rideOf = (rideId) => Ride.findById(rideId).lean();
const profileOf = (driver) => DriverProfile.findById(driver.profile._id).lean();
const eventsOf = (rideId, type) => RideEvent.find({ rideId, ...(type ? { eventType: type } : {}) }).sort({ createdAt: 1, _id: 1 }).lean();

/** The passenger's current trip code (what their app would display). */
async function tripOtp(rideId) {
  const ride = await Ride.findById(rideId).lean();
  return (await require('../../src/services/rideOtpService').revealForPassenger(rideId, ride.passengerId)).code;
}

/** Drive a ride through arrive -> start -> complete with valid codes. */
async function driveTrip(rideId, driverId, steps = ['arrive', 'start', 'complete']) {
  const rideService = require('../../src/services/rideService');
  let last;
  for (const s of steps) {
    const otp = s === 'arrive' ? undefined : await tripOtp(rideId);
    last = await rideService.driverTransition(rideId, driverId, s, { otp });
  }
  return last;
}

module.exports = {
  tripOtp,
  driveTrip, pendingOffer, timeOut, rejectCurrent, offeredDriverIds, rideOf, profileOf, eventsOf };
