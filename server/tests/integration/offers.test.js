'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { useDatabase } = require('../helpers/db');
const f = require('../helpers/factory');
const m = require('../helpers/matching');
const matching = require('../../src/services/matchingService');
const { RideOffer, Ride, DriverProfile } = require('../../src/models');

useDatabase();
const app = createApp();

async function offeredRide(driverSpecs = [{ distanceKm: 1 }, { distanceKm: 2 }]) {
  const passenger = await f.createPassenger();
  const drivers = [];
  for (const s of driverSpecs) drivers.push(await f.createDriver(s));
  const ride = await f.createRide(passenger);
  await matching.advanceMatching(ride._id);
  const offer = await m.pendingOffer(ride._id);
  return { passenger, drivers, ride, offer };
}

const accept = (offerId, token) => request(app).post(`/api/offers/${offerId}/accept`).set(f.auth(token)).send({});
const reject = (offerId, token) => request(app).post(`/api/offers/${offerId}/reject`).set(f.auth(token)).send({});

describe('D. Offer acceptance, rejection and timeout', () => {
  test('driver sees their pending offer with ride details', async () => {
    const { drivers, offer } = await offeredRide();
    const res = await request(app).get('/api/drivers/me/offers').set(f.auth(drivers[0].token));
    expect(res.status).toBe(200);
    expect(res.body.data.offers).toHaveLength(1);
    expect(res.body.data.offers[0]).toMatchObject({ id: String(offer._id), status: 'PENDING' });
    const other = await request(app).get('/api/drivers/me/offers').set(f.auth(drivers[1].token));
    expect(other.body.data.offers).toHaveLength(0);
  });

  test('#38 #47 eligible driver accepts: ride DRIVER_ASSIGNED with that driver, driver ON_TRIP', async () => {
    const { drivers, ride, offer } = await offeredRide();
    const res = await accept(offer._id, drivers[0].token);
    expect(res.status).toBe(200);
    expect(res.body.data.ride).toMatchObject({ status: 'DRIVER_ASSIGNED', driverId: drivers[0].id });
    expect(res.body.data.ride.driver.vehicle.type).toBe('CAR');
    const r = await m.rideOf(ride._id);
    expect(r.status).toBe('DRIVER_ASSIGNED');
    expect(String(r.driverId)).toBe(drivers[0].id);
    expect(r.assignedAt).toBeTruthy();
    expect(await m.profileOf(drivers[0])).toMatchObject({ availability: 'ON_TRIP' });
    expect(String((await m.profileOf(drivers[0])).activeRideId)).toBe(String(ride._id));
    expect((await RideOffer.findById(offer._id)).status).toBe('ACCEPTED');
    expect(await m.eventsOf(ride._id, 'DRIVER_ASSIGNED')).toHaveLength(1);
  });

  test('#39 #40 driver rejects; the next eligible driver is offered', async () => {
    const { drivers, ride, offer } = await offeredRide();
    const res = await reject(offer._id, drivers[0].token);
    expect(res.status).toBe(200);
    expect(res.body.data.offer.status).toBe('REJECTED');
    expect(await m.profileOf(drivers[0])).toMatchObject({ availability: 'AVAILABLE', activeRideId: null });
    await matching.advanceMatching(ride._id);
    expect(String((await m.pendingOffer(ride._id)).driverId)).toBe(drivers[1].id);
  });

  test('#41 #43 an expired offer cannot be accepted, and a late accept cannot revive it', async () => {
    const { drivers, ride, offer } = await offeredRide();
    await RideOffer.updateOne({ _id: offer._id }, { $set: { expiresAt: new Date(Date.now() - 1) } });
    const early = await accept(offer._id, drivers[0].token);
    expect(early.status).toBe(409);
    expect((await m.rideOf(ride._id)).status).toBe('SEARCHING');
    await matching.handleOfferTimeout(offer._id);
    const late = await accept(offer._id, drivers[0].token);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('OFFER_NOT_PENDING');
    expect((await RideOffer.findById(offer._id)).status).toBe('EXPIRED');
    expect((await m.rideOf(ride._id)).driverId).toBeNull();
  });

  test('#42 a timed-out offer becomes EXPIRED and matching moves on', async () => {
    const { drivers, ride } = await offeredRide();
    await m.timeOut(ride._id);
    expect(await RideOffer.countDocuments({ rideId: ride._id, status: 'EXPIRED' })).toBe(1);
    expect(String((await m.pendingOffer(ride._id)).driverId)).toBe(drivers[1].id);
    expect(await m.eventsOf(ride._id, 'OFFER_EXPIRED')).toHaveLength(1);
  });

  test('#44 repeated acceptance does not create duplicate effects', async () => {
    const { drivers, ride, offer } = await offeredRide();
    const first = await accept(offer._id, drivers[0].token);
    const second = await accept(offer._id, drivers[0].token);
    expect(first.body.data.alreadyAccepted).toBe(false);
    expect(second.status).toBe(200);
    expect(second.body.data.alreadyAccepted).toBe(true);
    expect(await m.eventsOf(ride._id, 'DRIVER_ASSIGNED')).toHaveLength(1);
    expect(String((await m.rideOf(ride._id)).driverId)).toBe(drivers[0].id);
  });

  test('#45 repeated rejection is handled safely', async () => {
    const { drivers, ride, offer } = await offeredRide();
    await reject(offer._id, drivers[0].token).expect(200);
    const again = await reject(offer._id, drivers[0].token);
    expect(again.status).toBe(200);
    expect(again.body.data.alreadyRejected).toBe(true);
    expect(await m.eventsOf(ride._id, 'OFFER_REJECTED')).toHaveLength(1);
  });

  test('#46 rejecting/expiring releases the reservation only if it is still for the same ride', async () => {
    const { drivers, ride, offer, passenger } = await offeredRide();
    // Simulate the driver's reservation having moved to another ride.
    await Ride.updateOne({ _id: ride._id }, { $set: { active: false } });
    const otherRide = await f.createRide(passenger);
    await DriverProfile.updateOne({ userId: drivers[0].id }, { $set: { activeRideId: otherRide._id } });
    await reject(offer._id, drivers[0].token).expect(200);
    const p = await m.profileOf(drivers[0]);
    expect(p.availability).toBe('RESERVED');
    expect(String(p.activeRideId)).toBe(String(otherRide._id));
  });

  test('#48 an offer cannot be accepted after the ride is cancelled', async () => {
    const { drivers, ride, offer, passenger } = await offeredRide();
    await request(app).post(`/api/rides/${ride._id}/cancel`).set(f.auth(passenger.token)).send({}).expect(200);
    expect((await RideOffer.findById(offer._id)).status).toBe('CANCELLED');
    expect(await m.profileOf(drivers[0])).toMatchObject({ availability: 'AVAILABLE', activeRideId: null });
    const res = await accept(offer._id, drivers[0].token);
    expect(res.status).toBe(409);
    expect((await m.rideOf(ride._id)).status).toBe('CANCELLED');
  });

  test('#7 a passenger cannot accept a driver offer', async () => {
    const { passenger, offer } = await offeredRide();
    expect((await accept(offer._id, passenger.token)).status).toBe(403);
  });

  test("#8 a driver cannot accept or reject another driver's offer", async () => {
    const { drivers, offer, ride } = await offeredRide();
    expect((await accept(offer._id, drivers[1].token)).status).toBe(403);
    expect((await reject(offer._id, drivers[1].token)).status).toBe(403);
    expect((await m.rideOf(ride._id)).status).toBe('SEARCHING');
    expect((await RideOffer.findById(offer._id)).status).toBe('PENDING');
  });

  test('#10 an unapproved driver cannot accept an offer', async () => {
    const { drivers, offer, ride } = await offeredRide();
    await DriverProfile.updateOne({ userId: drivers[0].id }, { $set: { approvalStatus: 'REJECTED' } });
    expect((await accept(offer._id, drivers[0].token)).status).toBe(403);
    expect((await m.rideOf(ride._id)).status).toBe('SEARCHING');
  });

  test('unknown offer id gives 404, malformed id gives 400', async () => {
    const d = await f.createDriver();
    expect((await accept('507f1f77bcf86cd799439011', d.token)).status).toBe(404);
    expect((await accept('xyz', d.token)).status).toBe(400);
  });
});
