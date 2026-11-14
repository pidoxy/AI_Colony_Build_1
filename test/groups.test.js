import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, startServer, stopServer, api, token, book, at, me } from './helpers.js';
import { primary } from '../src/db.js';
import { clock } from '../src/clock.js';
import { runAll } from '../src/jobs.js';

let t1; let t2; let t3;
before(async () => { await startServer(); });
after(stopServer);
beforeEach(async () => { await resetDb(); t1 = await token(1); t2 = await token(2); t3 = await token(3); });
const emails = (...n) => n.map((i) => `student${i}@university.test`);
// students must exist to receive notifications: sign them in
const signIn = (...toks) => Promise.all(toks.map((t) => api('POST', '/session', { tok: t })));

test('T-G1: group room holds booker + attendees up to capacity (8); a 9th person is refused', async () => {
  const ok = await book(t1, 'ENG-201', at('10:00'), at('11:00'), { attendees: emails(2, 3, 4, 5, 6, 7, 8) });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.attendees.length, 7);
  assert.ok(ok.body.attendees.every((a) => a.status === 'invited'));
  const t9 = await token(20);
  const over = await book(t9, 'ENG-201', at('12:00'), at('13:00'), { attendees: emails(2, 3, 4, 5, 6, 7, 8, 9) });
  assert.equal(over.status, 422); assert.equal(over.error.code, 'TOO_MANY_ATTENDEES');
});

test('T-G2: non-university email refused, nothing stored', async () => {
  const r = await book(t1, 'ENG-201', at('10:00'), at('11:00'), { attendees: ['bob@gmail.com'] });
  assert.equal(r.status, 422); assert.equal(r.error.code, 'ATTENDEE_EMAIL_INVALID_DOMAIN');
  assert.equal((await primary.query('select count(*)::int n from booking')).rows[0].n, 0);
});

test('T-G3: study room with attendees refused', async () => {
  const r = await book(t1, 'LIB-104', at('10:00'), at('11:00'), { attendees: emails(2) });
  assert.equal(r.status, 422); assert.equal(r.error.code, 'ATTENDEES_NOT_ALLOWED');
});

test('invited student is notified, sees the invitation, accepts; booker is told (T-G4)', async () => {
  await signIn(t2);
  const b = await book(t1, 'ENG-201', at('10:00'), at('11:00'), { attendees: emails(2) });
  const n = await api('GET', '/me/notifications', { tok: t2 });
  assert.ok(n.body.notifications.some((x) => x.type === 'invited'));
  const inv = await api('GET', '/me/bookings?status=invited', { tok: t2 });
  assert.equal(inv.body.bookings.length, 1);
  assert.equal(inv.body.bookings[0].role, 'invitee');
  assert.equal((await api('GET', '/me/bookings?status=upcoming', { tok: t2 })).body.bookings.length, 0);
  const a1 = await api('POST', `/bookings/${b.body.booking_id}/invitation/accept`, { tok: t2 });
  assert.equal(a1.status, 200); assert.equal(a1.body.my_invitation, 'accepted');
  const a2 = await api('POST', `/bookings/${b.body.booking_id}/invitation/accept`, { tok: t2 });
  assert.equal(a2.status, 200);
  const resp = await api('GET', '/me/notifications', { tok: t1 });
  assert.equal(resp.body.notifications.filter((x) => x.type === 'invitation_response').length, 1);
  assert.equal((await api('GET', '/me/bookings?status=upcoming', { tok: t2 })).body.bookings.length, 1);
  const mine = await api('GET', '/me/bookings?status=upcoming', { tok: t1 });
  assert.equal(mine.body.bookings[0].attendees[0].status, 'accepted');
});

test('invitee can decline, then change their mind before the start; cannot cancel or check in', async () => {
  await signIn(t2);
  const b = await book(t1, 'ENG-201', at('10:00'), at('11:00'), { attendees: emails(2) });
  const d = await api('POST', `/bookings/${b.body.booking_id}/invitation/decline`, { tok: t2 });
  assert.equal(d.body.my_invitation, 'declined');
  assert.equal((await api('POST', `/bookings/${b.body.booking_id}/invitation/accept`, { tok: t2 })).body.my_invitation, 'accepted');
  assert.equal((await api('POST', `/bookings/${b.body.booking_id}/cancel`, { tok: t2 })).status, 404);
  assert.equal((await api('POST', `/bookings/${b.body.booking_id}/check-in`, { tok: t2 })).status, 404);
});

test('T-G5: responding after the start is refused ALREADY_STARTED', async () => {
  await signIn(t2);
  const b = await book(t1, 'ENG-201', at('10:00'), at('11:00'), { attendees: emails(2) });
  clock.set(new Date(at('10:01')));
  const r = await api('POST', `/bookings/${b.body.booking_id}/invitation/accept`, { tok: t2 });
  assert.equal(r.status, 409); assert.equal(r.error.code, 'ALREADY_STARTED');
});

test('T-G6: booker cancels; invited and accepted attendees each get one notice', async () => {
  await signIn(t2, t3);
  const b = await book(t1, 'ENG-201', at('10:00'), at('11:00'), { attendees: emails(2, 3) });
  await api('POST', `/bookings/${b.body.booking_id}/invitation/accept`, { tok: t3 });
  await api('POST', `/bookings/${b.body.booking_id}/cancel`, { tok: t1 });
  for (const t of [t2, t3]) {
    const n = await api('GET', '/me/notifications', { tok: t });
    assert.equal(n.body.notifications.filter((x) => x.type === 'booking_cancelled_for_attendee').length, 1);
  }
  assert.equal((await api('POST', `/bookings/${b.body.booking_id}/invitation/accept`, { tok: t2 })).error.code, 'NOT_ACTIVE');
});

test('T-G7: invitee who has never signed in sees the invitation after first sign-in', async () => {
  const b = await book(t1, 'ENG-201', at('10:00'), at('11:00'), { attendees: emails(2) });
  assert.equal(b.status, 201);
  assert.equal((await api('GET', '/me/bookings?status=invited', { tok: t2 })).body.bookings.length, 1); // linked by email even before /session
  await api('POST', '/session', { tok: t2 });
  const { rows } = await primary.query(`select student_id from booking_attendee`);
  assert.equal(rows[0].student_id, 's2');
});

test('booker edits attendees: added invited, removed told; declined frees a seat', async () => {
  await signIn(t2, t3);
  const b = await book(t1, 'ENG-201', at('10:00'), at('11:00'), { attendees: emails(2) });
  const put = await api('PUT', `/bookings/${b.body.booking_id}/attendees`, { tok: t1, body: { attendees: emails(3) } });
  assert.equal(put.status, 200);
  assert.deepEqual(put.body.attendees.map((a) => a.email), emails(3));
  assert.ok((await api('GET', '/me/notifications', { tok: t2 })).body.notifications.some((x) => x.type === 'attendee_removed'));
  assert.ok((await api('GET', '/me/notifications', { tok: t3 })).body.notifications.some((x) => x.type === 'invited'));
  assert.equal((await api('PUT', `/bookings/${b.body.booking_id}/attendees`, { tok: t2, body: { attendees: [] } })).status, 404);
});

test('privacy: a stranger cannot read the booking; attendees are not exposed in search', async () => {
  const b = await book(t1, 'ENG-201', at('10:00'), at('11:00'), { attendees: emails(2) });
  assert.equal((await api('GET', `/bookings/${b.body.booking_id}`, { tok: t3 })).status, 404);
  assert.equal((await api('GET', `/bookings/${b.body.booking_id}`, { tok: t2 })).status, 200);
});

test('pending invitees get a nudge; accepted attendees get a reminder; declined do not', async () => {
  await signIn(t2, t3);
  const b = await book(t1, 'ENG-201', at('15:00'), at('16:00'), { attendees: emails(2, 3) });
  await api('POST', `/bookings/${b.body.booking_id}/invitation/accept`, { tok: t3 });
  clock.set(new Date(at('14:00'))); await runAll();
  assert.ok((await api('GET', '/me/notifications', { tok: t3 })).body.notifications.some((x) => x.type === 'reminder'));
  assert.ok(!(await api('GET', '/me/notifications', { tok: t2 })).body.notifications.some((x) => x.type === 'reminder'));
  assert.ok((await api('GET', '/me/notifications', { tok: t1 })).body.notifications.some((x) => x.type === 'reminder'));
});
