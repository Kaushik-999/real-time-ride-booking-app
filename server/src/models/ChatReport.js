'use strict';

const mongoose = require('mongoose');

/** A participant flagged a chat message as abusive / unsafe. */
const chatReportSchema = new mongoose.Schema(
  {
    rideId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ride', required: true },
    messageId: { type: mongoose.Schema.Types.ObjectId, ref: 'ChatMessage', required: true },
    reporterId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    reason: { type: String, trim: true, maxlength: 300, required: true },
    status: { type: String, enum: ['OPEN', 'REVIEWED'], default: 'OPEN' },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: Date,
  },
  { timestamps: true }
);

chatReportSchema.index({ messageId: 1, reporterId: 1 }, { unique: true });
chatReportSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('ChatReport', chatReportSchema);
