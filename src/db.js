import pg from 'pg';
import { config } from './config.js';
import { unavailable, isConnectionError } from './errors.js';

// Return timestamptz as Date (default) and int8 as number (counts are small).
pg.types.setTypeParser(20, (v) => Number(v));

export let primary = new pg.Pool({ connectionString: config.databaseUrl, max: config.poolMax, connectionTimeoutMillis: 5000 });
export let replica = config.replicaUrl
  ? new pg.Pool({ connectionString: config.replicaUrl, max: 20, connectionTimeoutMillis: 3000 })
  : primary;
primary.on('error', () => {});
replica.on('error', () => {});

/** For tests: point both pools at another database. */
export async function useDatabase(url) {
  await primary.end().catch(() => {});
  if (replica !== primary) await replica.end().catch(() => {});
  primary = new pg.Pool({ connectionString: url, max: config.poolMax, connectionTimeoutMillis: 5000 });
  primary.on('error', () => {});
  replica = primary;
}

/** Run fn inside one transaction on the primary. Writes always go here. */
export async function tx(fn) {
  let client;
  try {
    client = await primary.connect();
  } catch (e) {
    if (isConnectionError(e)) throw unavailable();
    throw e;
  }
  try {
    await client.query('begin');
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (e) {
    try { await client.query('rollback'); } catch { /* connection may be gone */ }
    if (isConnectionError(e)) throw unavailable();
    throw e;
  } finally {
    client.release();
  }
}

/** Read on the replica; fall back to the primary if the replica is unreachable. */
export async function readQuery(text, params) {
  if (replica === primary) return query(primary, text, params);
  try {
    return await replica.query(text, params);
  } catch (e) {
    if (!isConnectionError(e)) throw e;
    return query(primary, text, params);
  }
}

async function query(pool, text, params) {
  try {
    return await pool.query(text, params);
  } catch (e) {
    if (isConnectionError(e)) throw unavailable();
    throw e;
  }
}
export const writeQuery = (text, params) => query(primary, text, params);

let pingAt = 0;
let pingOk = true;
/** Is the primary reachable? Cached for 2 s so reads stay cheap. */
export async function primaryUp() {
  const now = Date.now();
  if (now - pingAt < 2000) return pingOk;
  pingAt = now;
  try {
    await primary.query('select 1');
    pingOk = true;
  } catch {
    pingOk = false;
  }
  return pingOk;
}
export function resetPing() { pingAt = 0; pingOk = true; }
