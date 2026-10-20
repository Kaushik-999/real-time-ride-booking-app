'use strict';

// DEVELOPMENT ONLY: print messages the dev SMS outbox captured instead of
// sending them (login codes, trip codes). Nothing in this list reached a phone.
//   docker compose exec backend npm run dev:outbox
//   docker compose exec backend npm run dev:outbox -- +919876543210
const config = require('../src/config');
const { connectDb, disconnectDb } = require('../src/config/db');
const { DevOutboxMessage } = require('../src/models');

async function main() {
  if (config.isProduction) throw new Error('The dev outbox is not available in production.');
  if (config.sms.provider !== 'dev_outbox') console.log(`Note: SMS_PROVIDER is "${config.sms.provider}", new messages are not captured here.`);
  await connectDb();
  const filter = process.argv[2] ? { to: process.argv[2] } : {};
  const rows = await DevOutboxMessage.find(filter).sort({ createdAt: -1 }).limit(10).lean();
  console.log('DEV OUTBOX (not delivered to any phone). Newest first; entries expire after 1 hour.');
  if (!rows.length) console.log('(empty)');
  for (const r of rows) console.log(`${r.createdAt.toISOString()}  to ${r.to}  [${r.purpose || '-'}]  ${r.body}`);
  await disconnectDb();
}

main().catch(async (err) => {
  console.error(err.message);
  await disconnectDb().catch(() => {});
  process.exit(1);
});
