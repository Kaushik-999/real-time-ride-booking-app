// Idempotent single-node replica-set initialisation.
// Executed by the MongoDB container's health check (see docker-compose.yml).
// - If the replica set already exists, rs.status() succeeds and nothing changes.
// - If it does not exist yet (fresh volume), rs.initiate() creates it.
// The health check only passes once this node is PRIMARY, so the backend
// never starts against a MongoDB that cannot run transactions.
try {
  const status = rs.status();
  if (status.myState !== 1) {
    print(`replica set exists, waiting for PRIMARY (state ${status.myState})`);
    quit(1);
  }
  quit(0);
} catch (err) {
  if (err.codeName === 'NotYetInitialized' || /no replset config/i.test(String(err.message))) {
    const host = process.env.MONGO_RS_HOST || 'mongo:27017';
    print(`initialising replica set rs0 with member ${host}`);
    rs.initiate({ _id: 'rs0', members: [{ _id: 0, host }] });
    quit(1); // not PRIMARY yet; the next health check run will pass
  }
  print(`replica set check failed: ${err.message}`);
  quit(1);
}
