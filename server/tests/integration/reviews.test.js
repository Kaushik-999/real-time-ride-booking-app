'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { useDatabase } = require('../helpers/db');
const f = require('../helpers/factory');
const m = require('../helpers/matching');
const matching = require('../../src/services/matchingService');
const offerService = require('../../src/services/offerService');
const { Review, User, DriverProfile, Ride, AuditLog } = require('../../src/models');

useDatabase();
const app = createApp();
const api = () => request(app);

async function completedRide({ complete = true } = {}) {
  const passenger = await f.createPassenger();
  const driver = await f.createDriver({ distanceKm: 1 });
  const ride = await f.createRide(passenger);
  await matching.advanceMatching(ride._id);
  await offerService.acceptOffer((await m.pendingOffer(ride._id))._id, driver.id);
  if (complete) await m.driveTrip(ride._id, driver.id);
  // Free this driver so later calls in the same test don't match them first.
  await DriverProfile.updateOne({ userId: driver.id }, { $set: { availability: 'OFFLINE' } });
  return { passenger, driver, ride };
}
const review = (rideId, token, body) => api().post(`/api/rides/${rideId}/reviews`).set(f.auth(token)).send(body);
const statsOf = async (userId) => (await User.findById(userId).lean()).ratingStats;

describe('Reviews and ratings', () => {
  test('the passenger rates the driver and the vehicle/service; the driver rates the passenger', async () => {
    const { passenger, driver, ride } = await completedRide();
    const p = await review(ride._id, passenger.token, { rating: 5, serviceRating: 4, comment: '  Smooth ride,\n clean car ' });
    expect(p.status).toBe(201);
    expect(p.body.data.review).toMatchObject({ rating: 5, serviceRating: 4, comment: 'Smooth ride, clean car', reviewerRole: 'PASSENGER' });
    const d = await review(ride._id, driver.token, { rating: 4, comment: 'On time' });
    expect(d.status).toBe(201);
    expect(await statsOf(driver.id)).toEqual({ sum: 5, count: 1 });
    expect(await statsOf(passenger.id)).toEqual({ sum: 4, count: 1 });
    expect((await DriverProfile.findOne({ userId: driver.id }).lean()).serviceRatingStats).toEqual({ sum: 4, count: 1 });
  });

  test('reviews are allowed only for completed rides', async () => {
    const { passenger, ride } = await completedRide({ complete: false });
    const res = await review(ride._id, passenger.token, { rating: 5 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('REVIEW_NOT_ALLOWED');
    const cancelled = await f.createRide(await f.createPassenger());
    await Ride.updateOne({ _id: cancelled._id }, { $set: { status: 'CANCELLED', active: false } });
    expect(await Review.countDocuments()).toBe(0);
  });

  test('the review window closes', async () => {
    const { passenger, ride } = await completedRide();
    await Ride.updateOne({ _id: ride._id }, { $set: { completedAt: new Date(Date.now() - 30 * 24 * 3600 * 1000) } });
    expect((await review(ride._id, passenger.token, { rating: 5 })).body.error.code).toBe('REVIEW_WINDOW_CLOSED');
  });

  test('only the ride passenger and its assigned driver may review it', async () => {
    const { ride } = await completedRide();
    const strangerP = await f.createPassenger();
    const strangerD = await f.createDriver();
    const admin = await f.createAdmin();
    expect((await review(ride._id, strangerP.token, { rating: 1 })).status).toBe(404);
    expect((await review(ride._id, strangerD.token, { rating: 1 })).status).toBe(404);
    expect((await review(ride._id, admin.token, { rating: 1 })).status).toBe(403);
    expect(await Review.countDocuments()).toBe(0);
  });

  test('drivers cannot submit a service rating', async () => {
    const { driver, ride } = await completedRide();
    expect((await review(ride._id, driver.token, { rating: 5, serviceRating: 5 })).status).toBe(400);
  });

  test('duplicate reviews are rejected, including concurrent ones, and stats count once', async () => {
    const { passenger, driver, ride } = await completedRide();
    const results = await Promise.all(Array.from({ length: 5 }, () => review(ride._id, passenger.token, { rating: 4 })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409).every((r) => r.body.error.code === 'ALREADY_REVIEWED')).toBe(true);
    expect(await Review.countDocuments()).toBe(1);
    expect(await statsOf(driver.id)).toEqual({ sum: 4, count: 1 });
  });

  test.each([[0], [6], [3.5], ['5'], [null]])('invalid rating %p is rejected', async (rating) => {
    const { passenger, ride } = await completedRide();
    expect((await review(ride._id, passenger.token, { rating })).status).toBe(400);
  });

  test('comments over 500 characters and unknown fields are rejected', async () => {
    const { passenger, ride } = await completedRide();
    expect((await review(ride._id, passenger.token, { rating: 5, comment: 'x'.repeat(501) })).status).toBe(400);
    expect((await review(ride._id, passenger.token, { rating: 5, revieweeId: '507f1f77bcf86cd799439011' })).status).toBe(400);
  });

  test('aggregates average accurately over many rides; the driver sees received reviews without reviewer identity', async () => {
    const driver = await f.createDriver({ distanceKm: 1 });
    const ratings = [5, 4, 3, 5];
    for (const r of ratings) {
      const p = await f.createPassenger();
      const ride = await f.createRide(p);
      await matching.advanceMatching(ride._id);
      await offerService.acceptOffer((await m.pendingOffer(ride._id))._id, driver.id);
      await m.driveTrip(ride._id, driver.id);
      await review(ride._id, p.token, { rating: r, comment: `rated ${r}` }).expect(201);
    }
    const res = await api().get('/api/reviews/received').set(f.auth(driver.token));
    expect(res.body.data.summary).toEqual({ average: 4.3, count: 4 }); // 17/4 = 4.25 -> 4.3
    expect(res.body.data.items).toHaveLength(4);
    expect(JSON.stringify(res.body.data.items)).not.toMatch(/reviewerId|"name"|email/);
    const me = await api().get('/api/auth/me').set(f.auth(driver.token));
    expect(me.body.data.user.rating).toEqual({ average: 4.3, count: 4 });
  });

  test('review history: my given reviews and my review for a ride', async () => {
    const { passenger, ride } = await completedRide();
    await review(ride._id, passenger.token, { rating: 5 }).expect(201);
    const given = await api().get('/api/reviews/given').set(f.auth(passenger.token));
    expect(given.body.data.items).toHaveLength(1);
    const mine = await api().get(`/api/rides/${ride._id}/reviews/mine`).set(f.auth(passenger.token));
    expect(mine.body.data.review.rating).toBe(5);
  });

  test('admin moderation hides a review, removes it from aggregates, requires a reason, and is audited', async () => {
    const { passenger, driver, ride } = await completedRide();
    const r = (await review(ride._id, passenger.token, { rating: 1, serviceRating: 1, comment: 'abusive words here' })).body.data.review;
    const admin = await f.createAdmin({ adminPermissions: ['reviews:moderate'] });
    const url = `/api/admin/reviews/${r.id}/moderation`;
    expect(r.id).toMatch(/^[a-f0-9]{24}$/);
    const noReason = await api().patch(url).set(f.auth(admin.token)).send({ status: 'HIDDEN' });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.message).toMatch(/reason is required/);
    const hid = await api().patch(url).set(f.auth(admin.token)).send({ status: 'HIDDEN', reason: 'Abusive language' });
    expect(hid.status).toBe(200);
    expect((await Review.findById(r.id)).status).toBe('HIDDEN');
    expect(await statsOf(driver.id)).toEqual({ sum: 0, count: 0 });
    expect((await DriverProfile.findOne({ userId: driver.id }).lean()).serviceRatingStats).toEqual({ sum: 0, count: 0 });
    expect((await api().get('/api/reviews/received').set(f.auth(driver.token))).body.data.items).toHaveLength(0);
    expect(await AuditLog.countDocuments({ action: 'REVIEW_HIDDEN', targetId: r.id })).toBe(1);
    // repeated hide is a no-op conflict; restoring brings the stats back
    expect((await api().patch(url).set(f.auth(admin.token)).send({ status: 'HIDDEN', reason: 'again' })).status).toBe(409);
    await api().patch(url).set(f.auth(admin.token)).send({ status: 'PUBLISHED' }).expect(200);
    expect(await statsOf(driver.id)).toEqual({ sum: 1, count: 1 });
  });

  test('non-moderators cannot list or moderate reviews', async () => {
    const { passenger, ride } = await completedRide();
    const r = (await review(ride._id, passenger.token, { rating: 2 })).body.data.review;
    const other = await f.createAdmin({ adminPermissions: ['rides:read'] });
    expect((await api().get('/api/admin/reviews').set(f.auth(other.token))).status).toBe(403);
    expect((await api().patch(`/api/admin/reviews/${r.id}/moderation`).set(f.auth(passenger.token)).send({ status: 'HIDDEN', reason: 'x' })).status).toBe(403);
  });

  test('admin list supports filters and pagination', async () => {
    for (const rating of [1, 2, 5]) {
      const { passenger, ride } = await completedRide();
      await review(ride._id, passenger.token, { rating }).expect(201);
    }
    const admin = await f.createAdmin();
    const low = await api().get('/api/admin/reviews?maxRating=2&limit=1&page=2').set(f.auth(admin.token));
    expect(low.body.data).toMatchObject({ total: 2, page: 2, limit: 1 });
    expect(low.body.data.items).toHaveLength(1);
    expect(low.body.data.items[0].rating).toBeLessThanOrEqual(2);
  });
});
