import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, stopServer, roomId, purposeId } from './helpers.js';
import { primary } from '../src/db.js';

after(stopServer);
beforeEach(async () => {
  await resetDb();
  for (const n of [1, 2]) await primary.query(`insert into student values ($1,$2,$3)`, [`s${n}`, `s${n}@university.test`, `S${n}`]);
});

async function ins(student, key, start, end, status = 'CONFIRMED', room = 'LIB-104') {
  return primary.query(
    `insert into booking (room_id, student_id, during, purpose_id, status, idempotency_key, request_hash)
     values ($1,$2,tstzrange($3,$4,'[)'),$5,$6,$7,'h')`,
    [await roomId(room), student, start, end, await purposeId(), status, key]);
}

test('T-R6 at the database: overlapping active bookings are rejected', async () => {
  await ins('s1', 'a', '2026-10-27T09:00Z', '2026-10-27T10:00Z');
  await assert.rejects(ins('s2', 'b', '2026-10-27T09:30Z', '2026-10-27T10:30Z'), (e) => e.code === '23P01');
});
test('T-E5 at the database: back to back is allowed', async () => {
  await ins('s1', 'a', '2026-10-27T09:00Z', '2026-10-27T10:00Z');
  await ins('s2', 'b', '2026-10-27T10:00Z', '2026-10-27T11:00Z');
});
test('a cancelled booking does not block the slot', async () => {
  await ins('s1', 'a', '2026-10-27T09:00Z', '2026-10-27T10:00Z', 'CANCELLED');
  await ins('s2', 'b', '2026-10-27T09:00Z', '2026-10-27T10:00Z');
});
test('rule 2: one active booking per student per room', async () => {
  await ins('s1', 'a', '2026-10-27T09:00Z', '2026-10-27T10:00Z');
  await assert.rejects(ins('s1', 'b', '2026-10-28T09:00Z', '2026-10-28T10:00Z'), (e) => e.constraint === 'booking_one_active_per_room');
});
test('rule 3: one booking per (student, idempotency key)', async () => {
  await ins('s1', 'a', '2026-10-27T09:00Z', '2026-10-27T10:00Z', 'CANCELLED');
  await assert.rejects(ins('s1', 'a', '2026-10-28T09:00Z', '2026-10-28T10:00Z'), (e) => e.constraint === 'booking_idem');
});
test('rule 4: end after start, and status one of the values', async () => {
  await assert.rejects(ins('s1', 'a', '2026-10-27T10:00Z', '2026-10-27T10:00Z'), (e) => e.code === '22000' || e.code === '23514');
  await assert.rejects(ins('s1', 'b', '2026-10-27T09:00Z', '2026-10-27T10:00Z', 'PENDING'), (e) => e.code === '23514');
});
