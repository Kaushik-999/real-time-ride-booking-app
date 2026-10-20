'use strict';

// Records sensitive administrative actions in the append-only `auditlogs`
// collection. Pass `session` to commit the audit entry atomically with the
// change it describes.
const { AuditLog } = require('../models');

async function record({ actorId, action, targetType, targetId, metadata = {}, ip }, { session } = {}) {
  const [entry] = await AuditLog.create([{ actorId, action, targetType, targetId, metadata, ip }], { session });
  return entry;
}

async function list({ page, limit, action, actorId, targetType, targetId }) {
  const filter = {};
  if (action) filter.action = action;
  if (actorId) filter.actorId = actorId;
  if (targetType) filter.targetType = targetType;
  if (targetId) filter.targetId = targetId;
  const [items, total] = await Promise.all([
    AuditLog.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).populate('actorId', 'name email').lean(),
    AuditLog.countDocuments(filter),
  ]);
  return {
    items: items.map((a) => ({
      id: String(a._id),
      action: a.action,
      targetType: a.targetType,
      targetId: String(a.targetId),
      metadata: a.metadata,
      actor: a.actorId ? { id: String(a.actorId._id), name: a.actorId.name, email: a.actorId.email } : null,
      createdAt: a.createdAt,
    })),
    total,
    page,
    limit,
  };
}

module.exports = { record, list };
