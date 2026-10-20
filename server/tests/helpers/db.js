'use strict';

const mongoose = require('mongoose');
const config = require('../../src/config');
const { ensureIndexes } = require('../../src/models');

async function connect() {
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 5000 });
  }
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  if (!hello.setName) {
    throw new Error('Tests need a MongoDB replica set (transactions). Start it with: docker compose up -d mongo');
  }
  await ensureIndexes();
}

/** Remove all documents but keep collections and indexes. */
async function clear() {
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map((c) => (c.collectionName.startsWith('system.') ? null : c.deleteMany({}))));
}

async function disconnect() {
  await mongoose.disconnect();
}

/** Standard lifecycle for integration test files. */
function useDatabase() {
  beforeAll(connect);
  beforeEach(clear);
  afterAll(disconnect);
}

module.exports = { connect, clear, disconnect, useDatabase };
