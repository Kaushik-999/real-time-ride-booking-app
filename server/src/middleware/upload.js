'use strict';

// Accept exactly one file (field "file") held in memory, capped at
// DOCUMENT_MAX_BYTES. The bytes are validated and encrypted by
// driverOnboardingService before anything touches the disk.
const multer = require('multer');
const config = require('../config');

const singleDocument = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.documents.maxBytes, files: 1, fields: 5, fieldSize: 1024 },
}).single('file');

module.exports = { singleDocument };
