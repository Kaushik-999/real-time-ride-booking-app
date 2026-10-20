'use strict';

const mongoose = require('mongoose');
const { DOCUMENT_TYPES, DOCUMENT_STATUS } = require('../utils/constants');

/**
 * Metadata for an uploaded driver document. The file itself lives in
 * private, encrypted storage (services/storage); `storageKey` is an opaque
 * random name, never a public URL. No document numbers (Aadhaar, PAN) are
 * extracted or stored.
 */
const driverDocumentSchema = new mongoose.Schema(
  {
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: DOCUMENT_TYPES, required: true },
    storageKey: { type: String, required: true, select: false },
    mimeType: { type: String, enum: ['image/jpeg', 'image/png', 'application/pdf'], required: true },
    sizeBytes: { type: Number, required: true, min: 1 },
    sha256: { type: String, required: true },
    status: { type: String, enum: Object.values(DOCUMENT_STATUS), required: true, default: DOCUMENT_STATUS.SUBMITTED },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: Date,
    rejectionReason: { type: String, maxlength: 300 },
    // Retention: rejected/superseded files are deleted after this date by the worker.
    deleteAfter: { type: Date, default: null },
    fileDeletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Only one current (non-superseded, non-rejected) document of each type per driver.
driverDocumentSchema.index(
  { driverId: 1, type: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['SUBMITTED', 'ACCEPTED'] } }, name: 'one_current_document_per_type' }
);
driverDocumentSchema.index({ driverId: 1, createdAt: -1 });
driverDocumentSchema.index({ deleteAfter: 1, fileDeletedAt: 1 });

driverDocumentSchema.set('toJSON', {
  transform(_doc, ret) {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    delete ret.storageKey;
    return ret;
  },
});

module.exports = mongoose.model('DriverDocument', driverDocumentSchema);
