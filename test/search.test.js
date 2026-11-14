import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, startServer, stopServer, api, token, book, at, key, roomId, purposeId, NOW } from './helpers.js';
import { primary } from '../src/db.js';
import { clock } from '../src/clock.js';
import { runAll, noShowSweep } from '../src/jobs.js';

let t1; let t2;
before(async () => { await startServer(); });
after(stopServer);
beforeEach(async () => { await resetDb(); t1 = await token(1); t2 = await token(2); });
const qs = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
const range = { start: at('14:00'), end: at('16:00') };

test('T-R1: capacity + amenity filters return only matching rooms', async () => {
  const { rows } = await primary.query(`select amenity_id from amenity where name = 'Projector'`);
  const r = await api('GET', `/rooms/search?${qs({ ...range, min_capacity: 8, amenities: rows[0].amenity_id })}`, { tok: t1 });
  assert.equal(r.status, 200);
  const codes = r.body.rooms.map((x) => x.code);
  assert.ok(codes.includes('ENG-201') && codes.includes('SCI-302'));
  assert.ok(!codes.includes('LIB-104') && !codes.includes('ART-106'));
  assert.ok(r.body.rooms.every((x) => x.capacity >= 8 && x.amenities.some((a) => a.name === 'Projector')));
});

test('R1: type, name, purpose and proximity filters; date + HH:MM form', async () => {
  const t = await api('GET', `/rooms/search?${qs({ ...range, type: 'seminar' })}`, { tok: t1 });
  assert.ok(t.body.rooms.length && t.body.rooms.every((x) => x.type === 'seminar'));
  const n = await api('GET', `/rooms/search?${qs({ ...range, name: 'lib-104' })}`, { tok: t1 });
  assert.deepEqual(n.body.rooms.map((x) => x.code), ['LIB-104']);
  const { rows: [pq] } = await primary.query(`select purpose_id from purpose where label = 'Quiet study'`);
  const p = await api('GET', `/rooms/search?${qs({ ...range, purpose: pq.purpose_id })}`, { tok: t1 });
  assert.ok(p.body.rooms.length && p.body.rooms.every((x) => x.type === 'study'));
  const { rows: [b] } = await primary.query(`select building_id from building where name = 'Engineering'`);
  const near = await api('GET', `/rooms/search?${qs({ ...range, near_building: b.building_id })}`, { tok: t1 });
  const d = near.body.rooms.map((x) => x.distance_km);
  assert.deepEqual(d, [...d].sort((x, y) => x - y));
  assert.equal(near.body.rooms[0].building.name, 'Engineering');
  const dt = await api('GET', `/rooms/search?${qs({ date: '2026-10-27', start: '14:00', end: '16:00' })}`, { tok: t1 });
  assert.equal(dt.status, 200); assert.equal(dt.body.total, 12);
  const dur = await api('GET', `/rooms/search?${qs({ start: range.start, duration: 60 })}`, { tok: t1 });
  assert.equal(dur.status, 200);
});

test('R1: pagination', async () => {
  const r = await api('GET', `/rooms/search?${qs({ ...range, limit: 5, offset: 10 })}`, { tok: t1 });
  assert.equal(r.body.rooms.length, 2); assert.equal(r.body.total, 12);
});

test('search errors: INVALID_RANGE, OUT_OF_HORIZON, UNKNOWN_FILTER', async () => {
  const bad = await api('GET', `/rooms/search?${qs({ start: at('15:00'), end: at('14:00') })}`, { tok: t1 });
  assert.equal(bad.status, 400); assert.equal(bad.error.code, 'INVALID_RANGE');
  assert.equal((await api('GET', `/rooms/search?${qs({ start: at('14:10'), end: at('15:10') })}`, { tok: t1 })).error.code, 'INVALID_RANGE');
  assert.equal((await api('GET', `/rooms/search?${qs({ start: at('14:00', 20), end: at('15:00', 20) })}`, { tok: t1 })).error.code, 'OUT_OF_HORIZON');
  assert.equal((await api('GET', `/rooms/search?${qs({ ...range, amenities: 9999 })}`, { tok: t1 })).error.code, 'UNKNOWN_FILTER');
  assert.equal((await api('GET', `/rooms/search?${qs({ ...range, near_building: 9999 })}`, { tok: t1 })).error.code, 'UNKNOWN_FILTER');
});

test('T-R2: booked room is not returned; response carries as_of within 5 s', async () => {
  await book(t1, 'LIB-104', at('14:00'), at('15:00'));
  const r = await api('GET', `/rooms/search?${qs({ start: at('14:30'), end: at('15:30') })}`, { tok: t2 });
  assert.ok(!r.body.rooms.some((x) => x.code === 'LIB-104'));
  assert.ok(Math.abs(new Date(r.body.as_of) - clock.now()) <= 5000);
  assert.equal(r.body.booking_paused, false);
});

test('opening hours and weekday exceptions apply to search and booking', async () => {
  const rid = await roomId('LIB-104');
  await primary.query(`insert into room_hours_exception (room_id, weekday, opens_at, closes_at) values ($1, 2, '10:00', '12:00')`, [rid]); // Tuesday
  const r = await api('GET', `/rooms/search?${qs({ start: at('14:00'), end: at('15:00'), name: 'LIB-104' })}`, { tok: t1 });
  assert.equal(r.body.rooms.length, 0);
  assert.equal((await book(t1, 'LIB-104', at('14:00'), at('15:00'))).error.code, 'OUTSIDE_OPENING_HOURS');
  assert.equal((await book(t1, 'LIB-104', at('10:00'), at('11:00'))).status, 201);
});

test('closures hide rooms and refuse booking (T-C1)', async () => {
  await primary.query(`insert into closure (scope, during) values ('campus', '[2026-10-27,2026-10-28)')`);
  const r = await api('GET', `/rooms/search?${qs(range)}`, { tok: t1 });
  assert.equal(r.body.total, 0);
  assert.equal((await book(t1, 'LIB-104', at('14:00'), at('15:00'))).error.code, 'ROOM_CLOSED');
  assert.equal((await book(t1, 'LIB-104', at('14:00', 28), at('15:00', 28))).status, 201);
});

test('T-R3: Available soon lists rooms free now or within 2 h, soonest first', async () => {
  const now = clock.now();
  const tk = await Promise.all([10, 11, 12, 13, 14, 15, 16, 17, 18, 19].map((i) => token(i)));
  const codes = (await primary.query(`select code from room order by code`)).rows.map((r) => r.code);
  const a = 'LIB-104'; const b = 'ART-106'; const c = 'SCI-302';
  await book(tk[0], a, now.toISOString(), at('09:30', 26)); // free from 09:30
  await book(tk[1], b, now.toISOString(), at('10:30', 26)); // free from 10:30
  await book(tk[2], c, now.toISOString(), at('11:30', 26)); // free from 11:30: outside the window
  const r = await api('GET', '/rooms/available-soon', { tok: t1 });
  assert.equal(r.status, 200);
  const list = r.body.rooms.map((x) => x.code);
  assert.ok(list.indexOf(a) >= 0 && list.indexOf(a) < list.indexOf(b));
  assert.ok(!list.includes(c));
  assert.equal(r.body.rooms.find((x) => x.code === a).free_now, false);
  assert.equal((await api('GET', '/rooms/available-soon?within=500', { tok: t1 })).error.code, 'INVALID_WINDOW');
  void codes;
});

test('T-R13/R14/T-J2: no-show releases the rest; listed in Just released and searchable from 10:30', async () => {
  await book(t1, 'LIB-104', at('10:00'), at('12:00'));
  clock.set(new Date(at('10:16')));
  const sweep = await noShowSweep();
  assert.equal(sweep.no_shows, 1);
  const { rows: [b] } = await primary.query('select status from booking'); assert.equal(b.status, 'NO_SHOW');
  assert.equal((await primary.query('select count(*)::int n from penalty')).rows[0].n, 1);
  const s = await api('GET', `/rooms/search?${qs({ start: at('10:30'), end: at('12:00'), name: 'LIB-104' })}`, { tok: t2 });
  assert.equal(s.body.rooms.length, 1);
  const rel = await api('GET', '/rooms/released', { tok: t2 });
  const slot = rel.body.slots.find((x) => x.code === 'LIB-104');
  assert.equal(slot.reason, 'no_show'); assert.equal(slot.start, at('10:30')); assert.equal(slot.end, at('12:00'));
  // the same slot can then be taken
  assert.equal((await book(t2, 'LIB-104', at('10:30'), at('12:00'))).status, 201);
  assert.ok(!(await api('GET', '/rooms/released', { tok: t2 })).body.slots.some((x) => x.code === 'LIB-104'));
});

test('R14/T-E10: cancelled slot appears in Just released until it starts; T-J1: gone after 2 h', async () => {
  const b = await book(t1, 'LIB-104', at('15:00'), at('16:00'));
  clock.set(new Date(at('14:59')));
  await api('POST', `/bookings/${b.body.booking_id}/cancel`, { tok: t1 });
  assert.ok((await api('GET', '/rooms/released', { tok: t2 })).body.slots.some((x) => x.code === 'LIB-104' && x.reason === 'cancelled'));
  clock.set(new Date(at('15:00')));
  assert.ok(!(await api('GET', '/rooms/released', { tok: t2 })).body.slots.some((x) => x.code === 'LIB-104'));
  // T-J1: cancelled long before start, checked 2 h 5 min later
  const b2 = await book(t1, 'ART-106', at('20:00'), at('21:00'));
  clock.set(new Date(at('10:00')));
  await api('POST', `/bookings/${b2.body.booking_id}/cancel`, { tok: t1 });
  clock.set(new Date(at('12:05')));
  assert.ok(!(await api('GET', '/rooms/released', { tok: t2 })).body.slots.some((x) => x.code === 'ART-106'));
});

test('T-R15/E13/E14: third no-show suspends; booking 403, search still works; standing lists dated no-shows', async () => {
  const s1 = await token(1);
  // two earlier no-shows inside 30 days
  for (const d of [3, 9]) {
    clock.set(new Date(Date.UTC(2026, 9, d, 7)));
    await book(s1, 'ART-106', at('10:00', d + 1), at('11:00', d + 1)).catch(() => {});
  }
  await primary.query('delete from booking'); // keep it simple: seed penalties by direct rows below
  clock.set(NOW);
  const { rows: stu } = await primary.query(`select student_id from student where student_id = 's1'`);
  assert.equal(stu.length, 1);
  async function noShow(day, room, start, end) {
    await primary.query(
      `insert into booking (room_id, student_id, during, purpose_id, status, idempotency_key, request_hash)
       values ($1,'s1',tstzrange($2,$3,'[)'),$4,'NO_SHOW',gen_random_uuid()::text,'h') returning booking_id`,
      [await roomId(room), start, end, await purposeId()]);
    const { rows: [b] } = await primary.query(`select booking_id from booking where status = 'NO_SHOW' order by created_at desc limit 1`);
    await primary.query(`insert into penalty (student_id, booking_id, at) values ('s1', $1, $2)`, [b.booking_id, new Date(Date.UTC(2026, 9, day, 12))]);
  }
  await noShow(5, 'ART-106', '2026-10-05T09:00Z', '2026-10-05T10:00Z');
  await noShow(12, 'SCI-302', '2026-10-12T09:00Z', '2026-10-12T10:00Z');
  await book(s1, 'LIB-104', at('10:00'), at('11:00'));
  clock.set(new Date(at('10:16')));
  const sw = await noShowSweep();
  assert.equal(sw.suspensions, 1);
  const st = await api('GET', '/me/standing', { tok: s1 });
  assert.equal(st.body.no_shows_30d, 3);
  assert.equal(st.body.no_shows.length, 3);
  assert.ok(st.body.no_shows.every((x) => x.room_code && x.at));
  assert.equal(new Date(st.body.suspended_until).getTime(), new Date(at('10:16')).getTime() + 7 * 86400000);
  const blocked = await book(s1, 'ART-106', at('10:00', 28), at('11:00', 28));
  assert.equal(blocked.status, 403); assert.equal(blocked.error.code, 'SUSPENDED');
  assert.equal((await api('GET', `/rooms/search?${qs({ start: at('14:00', 28), end: at('15:00', 28) })}`, { tok: s1 })).status, 200);
  const n = await api('GET', '/me/notifications', { tok: s1 });
  assert.ok(n.body.notifications.some((x) => x.type === 'suspension_started'));
  assert.ok(n.body.notifications.some((x) => x.type === 'booking_released_no_show'));
});

test('completion: CHECKED_IN becomes COMPLETED at end time', async () => {
  const b = await book(t1, 'LIB-104', at('10:00'), at('11:00'));
  clock.set(new Date(at('10:00')));
  await api('POST', `/bookings/${b.body.booking_id}/check-in`, { tok: t1 });
  clock.set(new Date(at('11:00')));
  await runAll();
  assert.equal((await primary.query('select status from booking')).rows[0].status, 'COMPLETED');
});

test('no-show booking cannot be checked in: RELEASED', async () => {
  const b = await book(t1, 'LIB-104', at('10:00'), at('11:00'));
  clock.set(new Date(at('10:20'))); await noShowSweep();
  const r = await api('POST', `/bookings/${b.body.booking_id}/check-in`, { tok: t1 });
  assert.equal(r.status, 409); assert.equal(r.error.code, 'RELEASED');
  assert.equal((await api('POST', `/bookings/${b.body.booking_id}/cancel`, { tok: t1 })).error.code, 'NOT_CANCELLABLE');
});
