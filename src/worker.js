// Scheduler worker. One copy is active at a time: a Postgres advisory lock keeps
// a standby copy idle until the active one stops. It keeps no memory between runs.
import pg from 'pg';
import { config } from './config.js';
import { runAll, retention, overlapCheck } from './jobs.js';

const LOCK_ID = 727001;
const TICK_MS = 30_000;   // spec: no-show release within 1 minute of start + 15 min
const DAILY_MS = 24 * 3600_000;

const lockClient = new pg.Client({ connectionString: config.databaseUrl });
lockClient.on('error', () => process.exit(1));
await lockClient.connect();

let active = false;
let lastDaily = 0;

async function tryLock() {
  const { rows } = await lockClient.query('select pg_try_advisory_lock($1) as ok', [LOCK_ID]);
  return rows[0].ok;
}

async function tick() {
  try {
    if (!active) {
      active = await tryLock();
      if (!active) return;
      console.log('[worker] active');
    }
    const r = await runAll();
    if (r.noShows.no_shows || r.completion.completed || r.outbox.sent || r.downtime.notified) console.log('[worker]', JSON.stringify(r));
    if (Date.now() - lastDaily > DAILY_MS) {
      lastDaily = Date.now();
      const bad = await overlapCheck();
      if (bad.length) console.error('[worker] OVERLAP CHECK FAILED', JSON.stringify(bad));
      else console.log('[worker] nightly overlap check clean');
      console.log('[worker] retention', JSON.stringify(await retention()));
    }
  } catch (e) {
    // worker down or database down: bookings still work; this run is simply late
    console.error('[worker] tick failed:', e.message);
  }
}

await tick();
setInterval(tick, TICK_MS);
process.on('SIGTERM', () => lockClient.end().finally(() => process.exit(0)));
