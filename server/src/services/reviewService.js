'use strict';

/**
 * Two-way ratings after a completed ride.
 *   Passenger -> driver: rating (1-5), optional serviceRating for the
 *                        vehicle/service (1-5), optional comment.
 *   Driver -> passenger: rating (1-5), optional comment.
 *
 * Aggregates ("4.7 from 120 ratings") are running totals ($inc on sum and
 * count) updated in the SAME transaction as the review insert, so the
 * average can never drift from the reviews that exist. Hiding a review
 * (moderation) subtracts it again, in one transaction.
 */
const config = require('../config');
const { Review, Ride, User, DriverProfile } = require('../models');
const { RIDE_STATUS, ROLES, REVIEW_STATUS } = require('../utils/constants');
const { badRequest, notFound, conflict } = require('../utils/errors');
const { withTransactionOrAbort, AbortTransaction, isDuplicateKeyError } = require('../utils/transaction');
const audit = require('./auditService');

/** Remove control characters and collapse whitespace in free text. */
const cleanText = (s) => (s || '').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim();

const ownView = (r) => ({
  id: String(r._id),
  rideId: String(r.rideId),
  reviewerRole: r.reviewerRole,
  rating: r.rating,
  serviceRating: r.serviceRating,
  comment: r.comment,
  status: r.status,
  createdAt: r.createdAt,
});

async function applyStats(review, sign, session) {
  await User.updateOne({ _id: review.revieweeId }, { $inc: { 'ratingStats.sum': sign * review.rating, 'ratingStats.count': sign } }, { session });
  if (review.serviceRating) {
    await DriverProfile.updateOne(
      { userId: review.revieweeId },
      { $inc: { 'serviceRatingStats.sum': sign * review.serviceRating, 'serviceRatingStats.count': sign } },
      { session }
    );
  }
}

async function submitReview(user, rideId, { rating, serviceRating, comment }) {
  const ride = await Ride.findById(rideId).lean();
  const isPassenger = ride && String(ride.passengerId) === user.id && user.role === ROLES.PASSENGER;
  const isDriver = ride && ride.driverId && String(ride.driverId) === user.id && user.role === ROLES.DRIVER;
  // Same answer for "no such ride" and "not your ride".
  if (!isPassenger && !isDriver) throw notFound('Ride not found');
  if (ride.status !== RIDE_STATUS.COMPLETED) throw conflict('You can rate a ride only after it is completed', 'REVIEW_NOT_ALLOWED');
  const windowMs = config.reviews.windowDays * 24 * 3600 * 1000;
  if (!ride.completedAt || Date.now() - new Date(ride.completedAt).getTime() > windowMs) {
    throw conflict(`Ratings can be left up to ${config.reviews.windowDays} days after a ride`, 'REVIEW_WINDOW_CLOSED');
  }
  if (isDriver && serviceRating != null) throw badRequest('Only passengers rate the vehicle/service');

  const doc = {
    rideId,
    reviewerId: user.id,
    revieweeId: isPassenger ? ride.driverId : ride.passengerId,
    reviewerRole: isPassenger ? ROLES.PASSENGER : ROLES.DRIVER,
    rating,
    serviceRating: isPassenger && serviceRating != null ? serviceRating : null,
    comment: cleanText(comment),
  };
  try {
    return await withTransactionOrAbort(async (session) => {
      const [review] = await Review.create([doc], { session });
      await applyStats(review, +1, session);
      return ownView(review);
    });
  } catch (err) {
    if (isDuplicateKeyError(err)) throw conflict('You have already rated this ride', 'ALREADY_REVIEWED');
    throw err;
  }
}


async function myReviewForRide(user, rideId) {
  const ride = await Ride.findById(rideId).select('passengerId driverId').lean();
  if (!ride || (String(ride.passengerId) !== user.id && String(ride.driverId) !== user.id)) throw notFound('Ride not found');
  const review = await Review.findOne({ rideId, reviewerId: user.id }).lean();
  return review ? ownView(review) : null;
}

/**
 * Reviews ABOUT me. Published only, and without reviewer identity: drivers
 * see what passengers said, but not which passenger said it (and vice versa).
 */
async function receivedReviews(user, { page, limit }) {
  const filter = { revieweeId: user.id, status: REVIEW_STATUS.PUBLISHED };
  const [items, total, me] = await Promise.all([
    Review.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Review.countDocuments(filter),
    User.findById(user.id),
  ]);
  return {
    summary: me.toJSON().rating,
    items: items.map((r) => ({ rating: r.rating, serviceRating: r.serviceRating, comment: r.comment, reviewerRole: r.reviewerRole, createdAt: r.createdAt })),
    total,
    page,
    limit,
  };
}

async function givenReviews(user, { page, limit }) {
  const filter = { reviewerId: user.id };
  const [items, total] = await Promise.all([
    Review.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Review.countDocuments(filter),
  ]);
  return { items: items.map(ownView), total, page, limit };
}

// ---- Admin moderation ------------------------------------------------------

async function adminList({ page, limit, status, maxRating }) {
  const filter = {};
  if (status) filter.status = status;
  if (maxRating) filter.rating = { $lte: maxRating };
  const [items, total] = await Promise.all([
    Review.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('reviewerId', 'name role')
      .populate('revieweeId', 'name role')
      .lean(),
    Review.countDocuments(filter),
  ]);
  return {
    items: items.map((r) => ({
      ...ownView(r),
      reviewer: r.reviewerId ? { id: String(r.reviewerId._id), name: r.reviewerId.name } : null,
      reviewee: r.revieweeId ? { id: String(r.revieweeId._id), name: r.revieweeId.name, role: r.revieweeId.role } : null,
      moderation: r.moderation && r.moderation.at ? { at: r.moderation.at, reason: r.moderation.reason } : null,
    })),
    total,
    page,
    limit,
  };
}

/** Hide (or restore) a review. Aggregates are adjusted in the same transaction. */
async function moderate(admin, reviewId, { status, reason }, { ip } = {}) {
  if (status === REVIEW_STATUS.HIDDEN && !reason) throw badRequest('A reason is required to hide a review');
  const from = status === REVIEW_STATUS.HIDDEN ? REVIEW_STATUS.PUBLISHED : REVIEW_STATUS.HIDDEN;
  const result = await withTransactionOrAbort(async (session) => {
    const review = await Review.findOneAndUpdate(
      { _id: reviewId, status: from },
      { $set: { status, 'moderation.by': admin.id, 'moderation.at': new Date(), 'moderation.reason': reason || null } },
      { new: true, session }
    );
    if (!review) {
      const exists = await Review.exists({ _id: reviewId }).session(session);
      throw new AbortTransaction({ error: exists ? conflict(`Review is already ${status}`, 'NO_CHANGE') : notFound('Review not found') });
    }
    await applyStats(review, status === REVIEW_STATUS.HIDDEN ? -1 : +1, session);
    await audit.record(
      { actorId: admin.id, action: `REVIEW_${status}`, targetType: 'Review', targetId: review._id, metadata: { reason: reason || null, rating: review.rating }, ip },
      { session }
    );
    return { review };
  });
  if (result.error) throw result.error;
  return ownView(result.review);
}

module.exports = { submitReview, myReviewForRide, receivedReviews, givenReviews, adminList, moderate };
