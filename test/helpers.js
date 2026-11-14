import './env.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { primary, tx } from '../src/db.js';
import { clock } from '../src/clock.js';
import { invalidatePolicy } from '../src/policy.js';
import { seedCatalog } from '../src/seed.js';
import { signDevStudentToken } from '../src/auth.js';
import { createApp } from '../src/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.join(here, '..', 'db', 'schema.sql'), 'utf8');

/** Monday 26 Oct 2026, 09:00 campus time (WAT, UTC+1). */
export const NOW = new Date('2026-10-26T08:00:00Z');

export async function resetDb({ rooms = 12 } = {}) {
  await primary.query('drop schema public cascade; create schema public;');
  await primary.query(schema);
  clock.set(NOW);
  await tx((c) => seedCatalog(c, { rooms }));
  invalidatePolicy();
}

let server; let base;
export async function startServer() {
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  return base;
}
export async function stopServer() {
  if (server) await new Promise((r) => server.close(r));
  await primary.end();
}

export async function token(n, extra = {}) {
  return signDevStudentToken({ studentId: `s${n}`, email: `student${n}@university.test`, name: `Student ${n}`, ...extra });
}
export const me = (n) => ({ studentId: `s${n}`, email: `student${n}@university.test`, name: `Student ${n}` });

let keyN = 0;
export const key = () => `00000000-0000-4000-8000-${String(++keyN).padStart(12, '0')}`;

export async function api(method, url, { tok, body, idem, headers = {} } = {}) {
  const h = { 'content-type': 'application/json', ...headers };
  if (tok) h.authorization = `Bearer ${tok}`;
  if (idem) h['idempotency-key'] = idem;
  const res = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json, error: json?.error };
}

export async function roomId(code) {
  const { rows } = await primary.query('select room_id from room where code = $1', [code]);
  return rows[0].room_id;
}
export async function purposeId(label = 'Study session') {
  const { rows } = await primary.query('select purpose_id from purpose where label = $1', [label]);
  return rows[0].purpose_id;
}

/** UTC instant for "tomorrow" (27 Oct) at local HH:MM (WAT = UTC+1). */
export const at = (hhmm, day = 27) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, day, h - 1, m)).toISOString();
};

export async function book(tokn, code, start, end, extra = {}) {
  return api('POST', '/bookings', {
    tok: tokn, idem: extra.idem || key(),
    body: { room_id: await roomId(code), start, end, purpose_id: extra.purpose_id ?? await purposeId(), attendees: extra.attendees },
  });
}
