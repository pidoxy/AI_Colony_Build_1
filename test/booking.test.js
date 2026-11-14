import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, startServer, stopServer, api, token, book, at, roomId, purposeId, key, NOW } from './helpers.js';
import { primary } from '../src/db.js';
import { clock } from '../src/clock.js';
import { getPolicy, invalidatePolicy } from '../src/policy.js';

let t1; let t2;
before(async () => { await startServer(); });
after(stopServer);
beforeEach(async () => { await resetDb(); t1 = await token(1); t2 = await token(2); });

test('T-R5: valid booking is confirmed at once (R7), status CONFIRMED', async () => {
  const r = await book(t1, 'LIB-104', at('10:00'), at('13:00'));
  assert.equal(r.status, 201);
  assert.equal(r.body.status, 'CONFIRMED');
  assert.match(r.body.reference, /^CR-1027-\d{3}$/);
});

test('T-R5b: 3.5 hours is refused DURATION_NOT_ALLOWED', async () => {
  const r = await book(t1, 'LIB-104', at('10:00'), at('13:30'));
  assert.equal(r.status, 422); assert.equal(r.error.code, 'DURATION_NOT_ALLOWED');
});

test('T-E15: off-grid 10:10 refused OFF_GRID', async () => {
  const r = await book(t1, 'LIB-104', at('10:10'), at('11:10'));
  assert.equal(r.status, 422); assert.equal(r.error.code, 'OFF_GRID');
});

test('closing time: past 22:00 refused OUTSIDE_OPENING_HOURS', async () => {
  const r = await book(t1, 'LIB-104', at('21:30'), at('22:30'));
  assert.equal(r.error.code, 'OUTSIDE_OPENING_HOURS');
});

test('E16: past and beyond 14 days refused', async () => {
  assert.equal((await book(t1, 'LIB-104', at('08:00', 26), at('09:00', 26))).error.code, 'IN_PAST');
  assert.equal((await book(t1, 'LIB-104', at('10:00', 20), at('11:00', 20))).error.code, 'IN_PAST');
  const far = new Date(NOW.getTime() + 15 * 86400000);
  const s = new Date(Date.UTC(far.getUTCFullYear(), far.getUTCMonth(), far.getUTCDate(), 9)).toISOString();
  const e = new Date(Date.UTC(far.getUTCFullYear(), far.getUTCMonth(), far.getUTCDate(), 10)).toISOString();
  assert.equal((await book(t1, 'LIB-104', s, e)).error.code, 'OUT_OF_HORIZON');
});

test('T-R6/E4: partial overlap gets SLOT_TAKEN with alternatives; nothing new stored', async () => {
  assert.equal((await book(t1, 'LIB-104', at('10:00'), at('11:00'))).status, 201);
  const r = await book(t2, 'LIB-104', at('10:30'), at('11:30'));
  assert.equal(r.status, 409); assert.equal(r.error.code, 'SLOT_TAKEN');
  assert.ok(r.error.alternatives.same_time.length > 0);
  assert.ok(r.error.alternatives.same_room_later);
  const { rows } = await primary.query(`select count(*)::int n from booking`);
  assert.equal(rows[0].n, 1);
});

test('T-E5: back to back is allowed (half-open ranges)', async () => {
  assert.equal((await book(t1, 'LIB-104', at('10:00'), at('11:00'))).status, 201);
  assert.equal((await book(t2, 'LIB-104', at('11:00'), at('12:00'))).status, 201);
});

test('T-R8/E9: second active booking for the same room refused', async () => {
  assert.equal((await book(t1, 'LIB-104', at('10:00'), at('11:00'))).status, 201);
  const r = await book(t1, 'LIB-104', at('10:00', 28), at('11:00', 28));
  assert.equal(r.status, 409); assert.equal(r.error.code, 'ALREADY_BOOKED_THIS_ROOM');
  assert.ok(r.error.booking_id);
});

test('T-R9/E7: sixth booking in the week refused with count and reset date; E8 cancelled do not count', async () => {
  const codes = ['LIB-104', 'ART-106', 'SCI-302', 'ENG-201'];
  const ids = [];
  for (let i = 0; i < 4; i++) { const r = await book(t1, codes[i], at('10:00'), at('11:00')); assert.equal(r.status, 201); ids.push(r.body.booking_id); }
  const { rows } = await primary.query(`select code from room where code <> all($1) order by code limit 2`, [codes]);
  assert.equal((await book(t1, rows[0].code, at('10:00'), at('11:00'))).status, 201);
  const sixth = await book(t1, rows[1].code, at('10:00'), at('11:00'));
  assert.equal(sixth.status, 422); assert.equal(sixth.error.code, 'WEEKLY_LIMIT_REACHED');
  assert.equal(sixth.error.used, 5); assert.equal(sixth.error.limit, 5);
  assert.equal(sixth.error.resets_at, '2026-11-01T23:00:00.000Z'); // Monday 2 Nov 00:00 WAT
  // E8: cancel two, then book again
  await api('POST', `/bookings/${ids[0]}/cancel`, { tok: t1 });
  await api('POST', `/bookings/${ids[1]}/cancel`, { tok: t1 });
  assert.equal((await book(t1, rows[1].code, at('10:00'), at('11:00'))).status, 201);
});

test('T-R10/E2: same idempotency key twice gives one booking, same id', async () => {
  const idem = key();
  const [a, b] = await Promise.all([book(t1, 'LIB-104', at('10:00'), at('11:00'), { idem }), book(t1, 'LIB-104', at('10:00'), at('11:00'), { idem })]);
  assert.deepEqual([a.status, b.status].sort(), [200, 201]);
  assert.equal(a.body.booking_id, b.body.booking_id);
  const { rows } = await primary.query('select count(*)::int n from booking');
  assert.equal(rows[0].n, 1);
});

test('T-E3: retry after a lost response returns the original (200)', async () => {
  const idem = key();
  const first = await book(t1, 'LIB-104', at('10:00'), at('11:00'), { idem });
  const retry = await book(t1, 'LIB-104', at('10:00'), at('11:00'), { idem });
  assert.equal(first.status, 201); assert.equal(retry.status, 200);
  assert.equal(retry.body.booking_id, first.body.booking_id);
});

test('T-E21: same key for a different room refused IDEMPOTENCY_KEY_REUSED', async () => {
  const idem = key();
  await book(t1, 'LIB-104', at('10:00'), at('11:00'), { idem });
  const r = await book(t1, 'ART-106', at('10:00'), at('11:00'), { idem });
  assert.equal(r.status, 422); assert.equal(r.error.code, 'IDEMPOTENCY_KEY_REUSED');
});

test('T-E1: 50 students book the same room and time at once: exactly one wins', async () => {
  const room = await roomId('LIB-104'); const purpose = await purposeId();
  const toks = await Promise.all(Array.from({ length: 50 }, (_, i) => token(100 + i)));
  const res = await Promise.all(toks.map((tk) => api('POST', '/bookings', { tok: tk, idem: key(), body: { room_id: room, start: at('10:00'), end: at('11:00'), purpose_id: purpose } })));
  assert.equal(res.filter((r) => r.status === 201).length, 1);
  assert.equal(res.filter((r) => r.error?.code === 'SLOT_TAKEN').length, 49);
  const { rows } = await primary.query(`select count(*)::int n from booking where status in ('CONFIRMED','CHECKED_IN')`);
  assert.equal(rows[0].n, 1);
});

test('one student, parallel bookings cannot slip under the weekly limit', async () => {
  const { rows } = await primary.query(`select code from room order by code limit 8`);
  const res = await Promise.all(rows.map((r) => book(t1, r.code, at('10:00'), at('11:00'))));
  assert.equal(res.filter((r) => r.status === 201).length, 5);
  assert.equal(res.filter((r) => r.error?.code === 'WEEKLY_LIMIT_REACHED').length, 3);
});

test('T-R20: changing the weekly limit needs no deploy', async () => {
  for (const c of ['LIB-104', 'ART-106', 'SCI-302']) await book(t1, c, at('10:00'), at('11:00'));
  await primary.query(`update policy set value = '3' where key = 'weekly_limit'`);
  invalidatePolicy();
  const r = await book(t1, 'ENG-201', at('10:00'), at('11:00'));
  assert.equal(r.status, 422); assert.equal(r.error.code, 'WEEKLY_LIMIT_REACHED'); assert.equal(r.error.limit, 3);
});

test('A1: a student id in the body is ignored; the token decides', async () => {
  const r = await api('POST', '/bookings', { tok: t1, idem: key(), body: { student_id: 's999', room_id: await roomId('LIB-104'), start: at('10:00'), end: at('11:00'), purpose_id: await purposeId() } });
  assert.equal(r.status, 201);
  const { rows } = await primary.query('select student_id from booking');
  assert.equal(rows[0].student_id, 's1');
});

test('401 without a token; 404 ROOM_NOT_FOUND for unknown room', async () => {
  assert.equal((await api('GET', '/me/bookings')).status, 401);
  const r = await api('POST', '/bookings', { tok: t1, idem: key(), body: { room_id: '11111111-1111-4111-8111-111111111111', start: at('10:00'), end: at('11:00'), purpose_id: await purposeId() } });
  assert.equal(r.status, 404); assert.equal(r.error.code, 'ROOM_NOT_FOUND');
});

test('T-R11: cancel frees the slot at once (search returns the room again); repeat cancel returns 200', async () => {
  const b = await book(t1, 'LIB-104', at('10:00'), at('11:00'));
  const q = `/rooms/search?start=${encodeURIComponent(at('10:00'))}&end=${encodeURIComponent(at('11:00'))}&name=LIB-104`;
  assert.equal((await api('GET', q, { tok: t2 })).body.rooms.length, 0);
  const c1 = await api('POST', `/bookings/${b.body.booking_id}/cancel`, { tok: t1 });
  assert.equal(c1.status, 200); assert.equal(c1.body.status, 'CANCELLED');
  assert.equal((await api('POST', `/bookings/${b.body.booking_id}/cancel`, { tok: t1 })).status, 200);
  assert.equal((await api('GET', q, { tok: t2 })).body.rooms.length, 1);
});

test('cancel: someone else\'s booking looks like NOT_FOUND', async () => {
  const b = await book(t1, 'LIB-104', at('10:00'), at('11:00'));
  const r = await api('POST', `/bookings/${b.body.booking_id}/cancel`, { tok: t2 });
  assert.equal(r.status, 404); assert.equal(r.error.code, 'NOT_FOUND');
});

test('T-E11: cancel after start refused ALREADY_STARTED', async () => {
  const b = await book(t1, 'LIB-104', at('10:00'), at('11:00'));
  clock.set(new Date(at('10:05')));
  const r = await api('POST', `/bookings/${b.body.booking_id}/cancel`, { tok: t1 });
  assert.equal(r.status, 409); assert.equal(r.error.code, 'ALREADY_STARTED');
});

test('T-R12: check in 8 min before start works and repeat is 200; T-R12b: 15 min early is TOO_EARLY', async () => {
  const b = await book(t1, 'LIB-104', at('10:00'), at('11:00'));
  clock.set(new Date(at('09:45')));
  const early = await api('POST', `/bookings/${b.body.booking_id}/check-in`, { tok: t1 });
  assert.equal(early.status, 409); assert.equal(early.error.code, 'TOO_EARLY');
  clock.set(new Date(at('09:52')));
  const ok = await api('POST', `/bookings/${b.body.booking_id}/check-in`, { tok: t1 });
  assert.equal(ok.status, 200); assert.equal(ok.body.status, 'CHECKED_IN');
  assert.equal((await api('POST', `/bookings/${b.body.booking_id}/check-in`, { tok: t1 })).status, 200);
  const { rows } = await primary.query(`select count(*)::int n from booking_event where to_status = 'CHECKED_IN'`);
  assert.equal(rows[0].n, 1); // T-E22
});

test('T-R4: my bookings soonest first, and my standing', async () => {
  await book(t1, 'ART-106', at('14:00'), at('15:00'));
  await book(t1, 'LIB-104', at('10:00'), at('11:00'));
  const l = await api('GET', '/me/bookings?status=upcoming', { tok: t1 });
  assert.deepEqual(l.body.bookings.map((b) => b.room.code), ['LIB-104', 'ART-106']);
  const s = await api('GET', '/me/standing', { tok: t1 });
  assert.equal(s.body.used_this_week, 2); assert.equal(s.body.weekly_limit, 5);
  assert.equal(s.body.suspended_until, null); assert.deepEqual(s.body.no_shows, []);
});

test('R16/E18: confirmation and cancellation notices; cancelled booking sends no reminder', async () => {
  const b = await book(t1, 'LIB-104', at('15:00'), at('16:00'));
  await api('POST', `/bookings/${b.body.booking_id}/cancel`, { tok: t1 });
  const n = await api('GET', '/me/notifications', { tok: t1 });
  assert.deepEqual(n.body.notifications.map((x) => x.type).sort(), ['booking_cancelled', 'booking_confirmed']);
  clock.set(new Date(at('14:00')));
  const { runAll } = await import('../src/jobs.js');
  await runAll();
  const { rows } = await primary.query(`select count(*)::int n from notification where type = 'reminder' and sent_at is not null`);
  assert.equal(rows[0].n, 0);
  const { rows: sk } = await primary.query(`select count(*)::int n from notification where type = 'reminder' and skipped_at is not null`);
  assert.equal(sk[0].n, 1);
});

test('T-R17: reminder sent once, 60 min before start', async () => {
  await book(t1, 'LIB-104', at('15:00'), at('16:00'));
  const { runAll } = await import('../src/jobs.js');
  clock.set(new Date(at('13:50'))); await runAll();
  assert.equal((await primary.query(`select count(*)::int n from notification where type = 'reminder' and sent_at is not null`)).rows[0].n, 0);
  clock.set(new Date(at('14:00'))); await runAll(); await runAll();
  assert.equal((await primary.query(`select count(*)::int n from notification where type = 'reminder' and sent_at is not null`)).rows[0].n, 1);
});

test('T-D1: email disabled means no email rows; booking unaffected', async () => {
  const r = await book(t1, 'LIB-104', at('10:00'), at('11:00'));
  assert.equal(r.status, 201);
  assert.equal((await primary.query(`select count(*)::int n from notification where channel = 'email'`)).rows[0].n, 0);
  assert.equal((await getPolicy()).email_enabled, false);
});
