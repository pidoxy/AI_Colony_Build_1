// T-R19 load test: seed rooms and 14 days of realistic bookings, then drive searches at a
// fixed rate with a few booking writes per second, and report p50/p95/p99.
// Usage: npm run loadtest -- --rooms=300 --seconds=30 --rate=50 --writes=5
// Uses the test database (TEST_DATABASE_URL or campus_rooms_test). Wipes it first.
import '../test/env.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { primary, tx } from '../src/db.js';
import { seedCatalog } from '../src/seed.js';
import { invalidatePolicy } from '../src/policy.js';
import { signDevStudentToken } from '../src/auth.js';
import { createApp } from '../src/app.js';
import { DAY } from '../src/time.js';
import crypto from 'node:crypto';

const arg = (k, d) => Number(process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d);
const ROOMS = arg('rooms', 300); const SECONDS = arg('seconds', 30); const RATE = arg('rate', 50); const WRITES = arg('writes', 5);
const here = path.dirname(fileURLToPath(import.meta.url));

console.log(`Seeding ${ROOMS} rooms and 14 days of bookings…`);
await primary.query('drop schema public cascade; create schema public;');
await primary.query(fs.readFileSync(path.join(here, '..', 'db', 'schema.sql'), 'utf8'));
await tx((c) => seedCatalog(c, { rooms: ROOMS }));
invalidatePolicy();
await primary.query(`
  create temp table seed_b as
  select row_number() over () as rn, r.room_id, (dd.day + (8 + k * 3) * interval '1 hour') as start_at
  from room r
  cross join generate_series(0, 13) as g(day_n)
  cross join lateral (select (date_trunc('day', now() at time zone 'Africa/Lagos') + g.day_n * interval '1 day') at time zone 'Africa/Lagos' as day) dd
  cross join generate_series(0, 3) as k
  where random() < 0.6 and (dd.day + (8 + k * 3) * interval '1 hour') > now() + interval '1 hour'`);
const { rows: [{ n }] } = await primary.query('select count(*)::int as n from seed_b');
await primary.query(`insert into student (student_id, email, display_name) select 'lt' || rn, 'lt' || rn || '@university.test', 'Load ' || rn from seed_b`);
await primary.query(`
  insert into booking (room_id, student_id, during, purpose_id, status, idempotency_key, request_hash)
  select room_id, 'lt' || rn, tstzrange(start_at, start_at + interval '90 minutes', '[)'), (select min(purpose_id) from purpose), 'CONFIRMED', gen_random_uuid()::text, 'h' from seed_b`);
await primary.query('analyze');
console.log(`  ${n} bookings seeded. Running ${RATE} searches/s and ${WRITES} booking writes/s for ${SECONDS}s…`);

const app = createApp();
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const tok = await signDevStudentToken({ studentId: 'lt-user', email: 'lt-user@university.test', name: 'Load User' });
const toks = await Promise.all(Array.from({ length: 50 }, (_, i) => signDevStudentToken({ studentId: `w${i}`, email: `w${i}@university.test`, name: `W${i}` })));
const { rows: purposes } = await primary.query('select purpose_id from purpose order by 1 limit 1');
const { rows: roomIds } = await primary.query('select room_id from room order by random() limit 500');

const day0 = new Date(); day0.setUTCHours(0, 0, 0, 0);
const lat = { search: [], write: [] }; let errors = 0; const codes = {};
const pick = (a) => a[Math.floor(Math.random() * a.length)];
function randomRange() {
  const dayN = 1 + Math.floor(Math.random() * 12); const startH = 8 + Math.floor(Math.random() * 12);
  const len = pick([1, 1, 2, 3]);
  const s = new Date(day0.getTime() + dayN * DAY + (startH - 1) * 3600000);
  return [s.toISOString(), new Date(s.getTime() + len * 3600000).toISOString()];
}
async function search() {
  const [s, e] = randomRange(); const t0 = performance.now();
  const q = new URLSearchParams({ start: s, end: e, limit: '20' });
  if (Math.random() < 0.4) q.set('min_capacity', String(pick([4, 6, 8])));
  if (Math.random() < 0.3) q.set('type', pick(['study', 'group', 'seminar']));
  try {
    const r = await fetch(`${base}/rooms/search?${q}`, { headers: { authorization: `Bearer ${tok}` } });
    await r.json(); lat.search.push(performance.now() - t0); codes[r.status] = (codes[r.status] || 0) + 1; if (!r.ok) errors++;
  } catch { errors++; }
}
async function write(i) {
  const [s, e] = randomRange(); const t0 = performance.now();
  try {
    const r = await fetch(`${base}/bookings`, { method: 'POST', headers: { authorization: `Bearer ${pick(toks)}`, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ room_id: pick(roomIds).room_id, start: s, end: e, purpose_id: purposes[0].purpose_id }) });
    await r.json(); lat.write.push(performance.now() - t0); codes[`w${r.status}`] = (codes[`w${r.status}`] || 0) + 1;
  } catch { errors++; }
  void i;
}
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : NaN; };

const start = Date.now(); let sent = 0; let sentW = 0;
const pending = new Set();
while ((Date.now() - start) / 1000 < SECONDS) {
  const el = (Date.now() - start) / 1000;
  while (sent < el * RATE) { sent++; const p = search().finally(() => pending.delete(p)); pending.add(p); }
  while (sentW < el * WRITES) { sentW++; const p = write(sentW).finally(() => pending.delete(p)); pending.add(p); }
  await new Promise((r) => setTimeout(r, 5));
}
await Promise.all(pending);

const row = (name, a) => `${name.padEnd(8)} n=${String(a.length).padEnd(5)} p50=${pct(a, 0.5).toFixed(0)}ms  p95=${pct(a, 0.95).toFixed(0)}ms  p99=${pct(a, 0.99).toFixed(0)}ms  max=${Math.max(...a).toFixed(0)}ms`;
console.log('\n' + row('search', lat.search)); console.log(row('booking', lat.write));
console.log('statuses', JSON.stringify(codes), 'errors', errors);
const sp95 = pct(lat.search, 0.95); const wp95 = pct(lat.write, 0.95);
console.log(`\nsearch p95 ${sp95 < 1000 ? 'PASS' : 'FAIL'} (< 1000 ms), booking p95 ${wp95 < 1000 ? 'PASS' : 'FAIL'} (< 1000 ms)`);
const { rows: ov } = await primary.query(`select count(*)::int n from booking a join booking b on a.room_id = b.room_id and a.booking_id < b.booking_id and a.during && b.during where a.status in ('CONFIRMED','CHECKED_IN') and b.status in ('CONFIRMED','CHECKED_IN')`);
console.log(`overlap check: ${ov[0].n === 0 ? 'clean (0 rows)' : 'FAILED ' + ov[0].n}`);
server.close(); await primary.end();
process.exit(sp95 < 1000 && wp95 < 1000 && ov[0].n === 0 ? 0 : 1);
