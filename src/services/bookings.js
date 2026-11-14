// Write side: book, cancel, check in, attendees. Every booking is one transaction
// on the primary. The exclusion constraint decides who wins a race; the policy
// rules are checked inside the same transaction as the insert.
import crypto from 'node:crypto';
import { clock } from '../clock.js';
import { getPolicy } from '../policy.js';
import { tx, readQuery } from '../db.js';
import { bad, unprocessable, conflict, notFound, forbidden, ApiError } from '../errors.js';
import { weekBounds, localDateStr, localParts, parseIso, MIN, HOUR, pad } from '../time.js';
import { checkGridAndDuration, checkHorizon, checkOpeningHours, localDatesOf } from './rules.js';
import { notify, bookingPayload } from './notifications.js';
import { alternativesFor } from './search.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ACTIVE = ['CONFIRMED', 'CHECKED_IN'];

/** Short display code derived from the booking id (no stored reference): CR-MMDD-NNN. */
export function bookingRef(id, start) {
  const p = localParts(new Date(start));
  const n = parseInt(id.replace(/-/g, '').slice(-6), 16) % 1000;
  return `CR-${pad(p.month)}${pad(p.day)}-${String(n).padStart(3, '0')}`;
}

const BOOKING_SELECT = `
  select b.booking_id, b.student_id, b.status, lower(b.during) as start, upper(b.during) as "end",
         b.checked_in_at, b.cancelled_at, b.created_at,
         p.purpose_id, p.label as purpose,
         r.room_id, r.code as room_code, r.name as room_name, r.type as room_type, r.capacity,
         bl.building_id, bl.name as building_name,
         st.display_name as booker_name, st.email as booker_email
  from booking b
  join room r on r.room_id = b.room_id
  join building bl on bl.building_id = r.building_id
  join purpose p on p.purpose_id = b.purpose_id
  join student st on st.student_id = b.student_id`;

function dto(row, policy, me, attendees) {
  const start = new Date(row.start);
  const isBooker = row.student_id === me.studentId;
  const mine = attendees.find((a) => a.student_id === me.studentId || a.email === me.email);
  return {
    booking_id: row.booking_id,
    reference: bookingRef(row.booking_id, start),
    status: row.status,
    role: isBooker ? 'booker' : 'invitee',
    start: start.toISOString(), end: new Date(row.end).toISOString(),
    purpose: { purpose_id: row.purpose_id, label: row.purpose },
    room: {
      room_id: row.room_id, code: row.room_code, name: row.room_name, type: row.room_type, capacity: row.capacity,
      building: { building_id: row.building_id, name: row.building_name },
    },
    booker: { name: row.booker_name, email: isBooker ? undefined : row.booker_email },
    checked_in_at: row.checked_in_at, cancelled_at: row.cancelled_at, created_at: row.created_at,
    check_in_opens_at: new Date(start.getTime() - policy.checkin_open_before_minutes * MIN).toISOString(),
    check_in_closes_at: new Date(start.getTime() + policy.checkin_close_after_minutes * MIN).toISOString(),
    attendees: attendees.map((a) => ({ email: a.email, name: a.display_name || null, status: a.status })),
    my_invitation: mine && !isBooker ? mine.status : null,
  };
}

async function attendeesFor(client, ids) {
  if (!ids.length) return new Map();
  const { rows } = await client.query(
    `select a.booking_id, a.attendee_id, a.email, a.student_id, a.status, s.display_name
     from booking_attendee a left join student s on s.student_id = a.student_id
     where a.booking_id = any($1::uuid[]) order by a.invited_at, a.email`, [ids]);
  const m = new Map();
  for (const r of rows) { if (!m.has(r.booking_id)) m.set(r.booking_id, []); m.get(r.booking_id).push(r); }
  return m;
}

export async function loadBookings(client, rows, policy, me) {
  const att = await attendeesFor(client, rows.map((r) => r.booking_id));
  return rows.map((r) => dto(r, policy, me, att.get(r.booking_id) || []));
}

async function ensureStudent(client, me) {
  await client.query(
    `insert into student (student_id, email, display_name) values ($1,$2,$3)
     on conflict (student_id) do update set email = excluded.email, display_name = excluded.display_name`,
    [me.studentId, me.email, me.name]);
  await client.query(
    `update booking_attendee set student_id = $1 where lower(email) = lower($2) and student_id is null`,
    [me.studentId, me.email]);
}

/** POST /session: record sign-in, link pending invitations to this student. */
export async function recordSignIn(me) {
  await tx(async (c) => {
    await ensureStudent(c, me);
    await c.query('update student set last_login_at = $2 where student_id = $1', [me.studentId, clock.now()]);
  });
  return { student_id: me.studentId, email: me.email, name: me.name };
}

function requestHash(roomId, start, end, purposeId, attendees) {
  return crypto.createHash('sha256')
    .update(JSON.stringify([roomId, start.getTime(), end.getTime(), purposeId, [...attendees].sort()])).digest('hex');
}

function parseEmails(list, domain, selfEmail) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw bad('INVALID_ATTENDEES', 'attendees must be a list of emails');
  const out = [];
  for (const raw of list) {
    const e = String(raw).trim().toLowerCase();
    if (!e) continue;
    if (!/^[^@\s]+@[^@\s]+$/.test(e) || !e.endsWith(`@${domain.toLowerCase()}`)) {
      throw unprocessable('ATTENDEE_EMAIL_INVALID_DOMAIN', `Attendees need a @${domain} email`, { email: e, domain });
    }
    if (e === selfEmail) continue;
    if (!out.includes(e)) out.push(e);
  }
  return out;
}

async function closureFor(client, room, start, end) {
  const dates = localDatesOf(start, end);
  const { rows } = await client.query(
    `select 1 from closure c where c.during @> any($1::date[])
       and (c.scope = 'campus' or (c.scope = 'building' and c.building_id = $2) or (c.scope = 'room' and c.room_id = $3)) limit 1`,
    [dates, room.building_id, room.room_id]);
  return rows.length > 0;
}

async function addAttendees(c, booking, room, emails, me, now, policy, startDate, endDate) {
  if (!emails.length) return;
  const { rows: known } = await c.query('select student_id, email from student where lower(email) = any($1::text[])', [emails]);
  const byEmail = new Map(known.map((k) => [k.email.toLowerCase(), k.student_id]));
  for (const email of emails) {
    const sid = byEmail.get(email) || null;
    const { rows: [a] } = await c.query(
      `insert into booking_attendee (booking_id, email, student_id) values ($1,$2,$3) returning attendee_id`,
      [booking.booking_id, email, sid]);
    const payload = bookingPayload(room, startDate, endDate, { booker_name: me.name });
    await notify(c, { studentId: sid, bookingId: booking.booking_id, type: 'invited', dedupeKey: `invited:${a.attendee_id}`, payload });
    const nudgeAt = new Date(startDate.getTime() - policy.invitation_nudge_lead_hours * HOUR);
    if (nudgeAt > now) {
      await notify(c, { studentId: sid, bookingId: booking.booking_id, type: 'invitation_nudge', sendAt: nudgeAt, dedupeKey: `nudge:${a.attendee_id}`, payload });
    }
  }
}

/** POST /bookings */
export async function createBooking(me, idemKey, body) {
  if (!idemKey) throw bad('MISSING_IDEMPOTENCY_KEY', 'Send an Idempotency-Key header (a UUID)');
  if (!UUID.test(idemKey)) throw bad('INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be a UUID');
  body = body || {};
  if (!UUID.test(String(body.room_id || ''))) throw new ApiError(404, 'ROOM_NOT_FOUND', 'Unknown or inactive room');
  const start = parseIso(body.start);
  const end = parseIso(body.end);
  if (!start || !end || end <= start) throw bad('INVALID_RANGE', 'Give a start and end (ISO 8601 with offset), end after start');
  const purposeId = Number(body.purpose_id);
  if (!Number.isInteger(purposeId)) throw unprocessable('UNKNOWN_PURPOSE', 'Choose what the room is for');

  const policy = await getPolicy();
  const now = clock.now();
  const attendees = parseEmails(body.attendees, policy.university_email_domain, me.email);
  let ctx = null;

  try {
    return await tx(async (c) => {
      await ensureStudent(c, me);
      const { rows: [st] } = await c.query('select * from student where student_id = $1 for update', [me.studentId]);

      const hash = requestHash(body.room_id, start, end, purposeId, attendees);
      const { rows: [dup] } = await c.query(
        'select booking_id, request_hash from booking where student_id = $1 and idempotency_key = $2', [me.studentId, idemKey]);
      if (dup) {
        if (dup.request_hash !== hash) throw unprocessable('IDEMPOTENCY_KEY_REUSED', 'That key was already used for a different booking');
        const { rows } = await c.query(`${BOOKING_SELECT} where b.booking_id = $1`, [dup.booking_id]);
        return { status: 200, booking: (await loadBookings(c, rows, policy, me))[0] };
      }

      if (st.suspended_until && st.suspended_until > now) {
        throw forbidden('SUSPENDED', 'Booking is paused after repeated no-shows', { suspended_until: st.suspended_until.toISOString() });
      }

      const { rows: [room] } = await c.query(
        `select r.*, bl.name as building_name from room r join building bl on bl.building_id = r.building_id
         where r.room_id = $1 and r.is_active`, [body.room_id]);
      if (!room) throw new ApiError(404, 'ROOM_NOT_FOUND', 'Unknown or inactive room');
      ctx = { room, start, end, policy };

      checkGridAndDuration(start, end, policy);
      checkHorizon(start, end, now, policy);
      const { rows: ex } = await c.query('select weekday, opens_at, closes_at from room_hours_exception where room_id = $1', [room.room_id]);
      checkOpeningHours(room, ex, start, end);
      if (await closureFor(c, room, start, end)) throw unprocessable('ROOM_CLOSED', 'The campus is closed for this room on that day');

      const { rows: [pu] } = await c.query('select purpose_id from purpose where purpose_id = $1 and is_active', [purposeId]);
      if (!pu) throw unprocessable('UNKNOWN_PURPOSE', 'Choose what the room is for');

      if (attendees.length) {
        if (room.type !== 'group') throw unprocessable('ATTENDEES_NOT_ALLOWED', 'Only group rooms take attendees');
        if (attendees.length + 1 > room.capacity) {
          throw unprocessable('TOO_MANY_ATTENDEES', `This room holds ${room.capacity} people including you`, { capacity: room.capacity });
        }
      }

      const { rows: [held] } = await c.query(
        `select booking_id, lower(during) as start, upper(during) as "end" from booking
         where student_id = $1 and room_id = $2 and status = any($3::text[])`, [me.studentId, room.room_id, ACTIVE]);
      if (held) {
        throw conflict('ALREADY_BOOKED_THIS_ROOM', 'You already have this room booked',
          { booking_id: held.booking_id, start: held.start.toISOString(), end: held.end.toISOString() });
      }

      const wk = weekBounds(start);
      const { rows: [{ n }] } = await c.query(
        `select count(*)::int as n from booking where student_id = $1 and status <> 'CANCELLED'
           and lower(during) >= $2 and lower(during) < $3`, [me.studentId, wk.start, wk.end]);
      if (n >= policy.weekly_limit) {
        throw unprocessable('WEEKLY_LIMIT_REACHED', 'You have used all your bookings for this week',
          { used: n, limit: policy.weekly_limit, resets_at: wk.end.toISOString() });
      }

      let booking;
      try {
        const { rows } = await c.query(
          `insert into booking (room_id, student_id, during, purpose_id, status, idempotency_key, request_hash)
           values ($1,$2,tstzrange($3,$4,'[)'),$5,'CONFIRMED',$6,$7) returning booking_id`,
          [room.room_id, me.studentId, start, end, purposeId, idemKey, hash]);
        booking = rows[0];
      } catch (e) {
        if (e.code === '23P01') throw conflict('SLOT_TAKEN', 'Someone booked that room first');
        if (e.code === '23505' && e.constraint === 'booking_one_active_per_room') {
          throw conflict('ALREADY_BOOKED_THIS_ROOM', 'You already have this room booked');
        }
        throw e;
      }

      await c.query(
        `insert into booking_event (booking_id, from_status, to_status, actor) values ($1, null, 'CONFIRMED', 'student')`,
        [booking.booking_id]);
      const payload = bookingPayload(room, start, end);
      await notify(c, { studentId: me.studentId, bookingId: booking.booking_id, type: 'booking_confirmed', dedupeKey: `confirmed:${booking.booking_id}`, payload });
      const remindAt = new Date(start.getTime() - policy.reminder_lead_minutes * MIN);
      if (remindAt > now) {
        await notify(c, { studentId: me.studentId, bookingId: booking.booking_id, type: 'reminder', sendAt: remindAt,
          dedupeKey: `reminder:${booking.booking_id}:${me.studentId}`,
          payload: { ...payload, checkin_open_before: policy.checkin_open_before_minutes } });
      }
      await addAttendees(c, booking, room, attendees, me, now, policy, start, end);

      const { rows } = await c.query(`${BOOKING_SELECT} where b.booking_id = $1`, [booking.booking_id]);
      return { status: 201, booking: (await loadBookings(c, rows, policy, me))[0] };
    });
  } catch (e) {
    if (e instanceof ApiError && e.code === 'SLOT_TAKEN' && ctx) {
      // Offer nearby free rooms and the same room later (E1). Exact read on the primary.
      const alts = await tx((c) => alternativesFor(c, ctx.room, ctx.start, ctx.end, ctx.policy)).catch(() => null);
      if (alts) e.extra = { alternatives: alts };
    }
    throw e;
  }
}

async function bookingForUpdate(c, id, me) {
  if (!UUID.test(id)) throw notFound();
  const { rows: [b] } = await c.query(
    `select b.*, lower(b.during) as start_at, upper(b.during) as end_at, r.code as room_code, r.name as room_name,
            bl.name as building_name
     from booking b join room r on r.room_id = b.room_id join building bl on bl.building_id = r.building_id
     where b.booking_id = $1 and b.student_id = $2 for update of b`, [id, me.studentId]);
  if (!b) throw notFound(); // not found and not yours look the same
  return b;
}

const payloadOf = (b) => bookingPayload({ code: b.room_code, name: b.room_name, building_name: b.building_name }, b.start_at, b.end_at);

async function skipPending(c, bookingId, now) {
  await c.query(
    `update notification set skipped_at = $2 where booking_id = $1 and sent_at is null and skipped_at is null
       and type in ('reminder','invitation_nudge')`, [bookingId, now]);
}

async function notifyAttendeesCancelled(c, b, payload) {
  const { rows } = await c.query(
    `select attendee_id, student_id from booking_attendee where booking_id = $1 and status <> 'declined'`, [b.booking_id]);
  for (const a of rows) {
    await notify(c, { studentId: a.student_id, bookingId: b.booking_id, type: 'booking_cancelled_for_attendee',
      dedupeKey: `cancelled:${b.booking_id}:${a.attendee_id}`, payload });
  }
}

/** POST /bookings/{id}/cancel */
export async function cancelBooking(me, id) {
  const policy = await getPolicy();
  const now = clock.now();
  return tx(async (c) => {
    const b = await bookingForUpdate(c, id, me);
    if (b.status === 'CANCELLED') return { status: 200, booking: await one(c, id, policy, me) };
    if (b.status !== 'CONFIRMED') {
      if (b.status === 'CHECKED_IN' && now < b.start_at) throw conflict('NOT_CANCELLABLE', 'This booking can no longer be cancelled');
      throw conflict('NOT_CANCELLABLE', 'This booking can no longer be cancelled');
    }
    if (now >= b.start_at) throw conflict('ALREADY_STARTED', 'This booking has started. Check in instead.');
    await c.query(`update booking set status = 'CANCELLED', cancelled_at = $2 where booking_id = $1`, [id, now]);
    await c.query(`insert into booking_event (booking_id, from_status, to_status, actor) values ($1,'CONFIRMED','CANCELLED','student')`, [id]);
    const payload = payloadOf(b);
    await notify(c, { studentId: me.studentId, bookingId: id, type: 'booking_cancelled', dedupeKey: `cancelled:${id}`, payload });
    await notifyAttendeesCancelled(c, b, payload);
    await skipPending(c, id, now);
    return { status: 200, booking: await one(c, id, policy, me) };
  });
}

/** POST /bookings/{id}/check-in */
export async function checkIn(me, id) {
  const policy = await getPolicy();
  const now = clock.now();
  return tx(async (c) => {
    const b = await bookingForUpdate(c, id, me);
    if (b.status === 'CHECKED_IN') return { status: 200, booking: await one(c, id, policy, me) };
    if (b.status === 'NO_SHOW') throw conflict('RELEASED', 'This booking was released as a no-show');
    if (b.status !== 'CONFIRMED') throw conflict('NOT_ACTIVE', 'This booking is not active');
    const opens = new Date(b.start_at.getTime() - policy.checkin_open_before_minutes * MIN);
    const closes = new Date(b.start_at.getTime() + policy.checkin_close_after_minutes * MIN);
    if (now < opens) throw conflict('TOO_EARLY', `Check-in opens ${policy.checkin_open_before_minutes} minutes before start`, { opens_at: opens.toISOString() });
    if (now > closes) throw conflict('RELEASED', 'The check-in window has closed');
    await c.query(`update booking set status = 'CHECKED_IN', checked_in_at = $2 where booking_id = $1`, [id, now]);
    await c.query(`insert into booking_event (booking_id, from_status, to_status, actor) values ($1,'CONFIRMED','CHECKED_IN','student')`, [id]);
    await skipPending(c, id, now);
    return { status: 200, booking: await one(c, id, policy, me) };
  });
}

async function one(c, id, policy, me) {
  const { rows } = await c.query(`${BOOKING_SELECT} where b.booking_id = $1`, [id]);
  return (await loadBookings(c, rows, policy, me))[0];
}

/** GET /bookings/{id}: visible to the booker and to invitees only. */
export async function getBooking(me, id) {
  if (!UUID.test(id)) throw notFound();
  const policy = await getPolicy();
  const { rows } = await readQuery(
    `${BOOKING_SELECT} where b.booking_id = $1 and (b.student_id = $2 or exists
       (select 1 from booking_attendee a where a.booking_id = b.booking_id and (a.student_id = $2 or lower(a.email) = $3)))`,
    [id, me.studentId, me.email]);
  if (!rows[0]) throw notFound();
  const att = await attendeesFor({ query: (t, p) => readQuery(t, p) }, [id]);
  return dto(rows[0], policy, me, att.get(id) || []);
}

/** GET /me/bookings?status=upcoming|past|invited */
export async function myBookings(me, status = 'upcoming') {
  const policy = await getPolicy();
  const now = clock.now();
  const q = { query: (t, p) => readQuery(t, p) };
  let rows;
  if (status === 'upcoming') {
    ({ rows } = await readQuery(
      `${BOOKING_SELECT} where b.status = any($3::text[]) and upper(b.during) > $2
         and (b.student_id = $1 or exists (select 1 from booking_attendee a where a.booking_id = b.booking_id
              and a.status = 'accepted' and (a.student_id = $1 or lower(a.email) = $4)))
       order by lower(b.during) asc`, [me.studentId, now, ACTIVE, me.email]));
  } else if (status === 'past') {
    const since = new Date(now.getTime() - policy.retention_student_visible_days * 86400000);
    ({ rows } = await readQuery(
      `${BOOKING_SELECT} where b.student_id = $1 and lower(b.during) > $3
         and not (b.status = any($4::text[]) and upper(b.during) > $2)
       order by lower(b.during) desc limit 200`, [me.studentId, now, since, ACTIVE]));
  } else if (status === 'invited') {
    ({ rows } = await readQuery(
      `${BOOKING_SELECT} where b.status = 'CONFIRMED' and lower(b.during) > $2 and b.student_id <> $1
         and exists (select 1 from booking_attendee a where a.booking_id = b.booking_id and a.status = 'invited'
              and (a.student_id = $1 or lower(a.email) = $3))
       order by lower(b.during) asc`, [me.studentId, now, me.email]));
  } else {
    throw bad('INVALID_STATUS', 'status must be upcoming, past or invited');
  }
  return { bookings: await loadBookings(q, rows, policy, me) };
}

/** GET /me/standing */
export async function standing(me) {
  const policy = await getPolicy();
  const now = clock.now();
  const wk = weekBounds(now);
  const { rows: [u] } = await readQuery(
    `select count(*)::int as n from booking where student_id = $1 and status <> 'CANCELLED'
       and lower(during) >= $2 and lower(during) < $3`, [me.studentId, wk.start, wk.end]);
  const since = new Date(now.getTime() - policy.noshow_window_days * 86400000);
  const { rows: ns } = await readQuery(
    `select p.at, lower(b.during) as start, upper(b.during) as "end", r.code, r.name
     from penalty p join booking b on b.booking_id = p.booking_id join room r on r.room_id = b.room_id
     where p.student_id = $1 and p.at > $2 order by p.at desc`, [me.studentId, since]);
  const { rows: [s] } = await readQuery('select suspended_until from student where student_id = $1', [me.studentId]);
  const until = s?.suspended_until && s.suspended_until > now ? s.suspended_until.toISOString() : null;
  return {
    used_this_week: u.n, weekly_limit: policy.weekly_limit, resets_at: wk.end.toISOString(),
    no_shows_30d: ns.length, no_show_window_days: policy.noshow_window_days, noshow_threshold: policy.noshow_threshold,
    no_shows: ns.map((x) => ({ at: x.at.toISOString(), start: x.start.toISOString(), end: x.end.toISOString(), room_code: x.code, room_name: x.name })),
    suspended_until: until,
  };
}

/** PUT /bookings/{id}/attendees: booker replaces the attendee list before the start. */
export async function setAttendees(me, id, list) {
  const policy = await getPolicy();
  const now = clock.now();
  const emails = parseEmails(list, policy.university_email_domain, me.email);
  return tx(async (c) => {
    const b = await bookingForUpdate(c, id, me);
    if (!ACTIVE.includes(b.status)) throw conflict('NOT_ACTIVE', 'This booking is not active');
    if (now >= b.start_at) throw conflict('ALREADY_STARTED', 'This booking has started');
    const { rows: [room] } = await c.query(
      `select r.*, bl.name as building_name from room r join building bl on bl.building_id = r.building_id where room_id = $1`, [b.room_id]);
    if (emails.length && room.type !== 'group') throw unprocessable('ATTENDEES_NOT_ALLOWED', 'Only group rooms take attendees');
    if (emails.length + 1 > room.capacity) throw unprocessable('TOO_MANY_ATTENDEES', `This room holds ${room.capacity} people including you`, { capacity: room.capacity });
    const { rows: cur } = await c.query('select attendee_id, email, student_id from booking_attendee where booking_id = $1', [id]);
    const have = new Set(cur.map((a) => a.email));
    const toAdd = emails.filter((e) => !have.has(e));
    const toRemove = cur.filter((a) => !emails.includes(a.email));
    const payload = bookingPayload(room, b.start_at, b.end_at, { booker_name: me.name });
    for (const a of toRemove) {
      await c.query('delete from booking_attendee where attendee_id = $1', [a.attendee_id]);
      await c.query(`update notification set skipped_at = $2 where sent_at is null and skipped_at is null and dedupe_key = any($1::text[])`,
        [[`nudge:${a.attendee_id}`], now]);
      await notify(c, { studentId: a.student_id, bookingId: id, type: 'attendee_removed', dedupeKey: `removed:${a.attendee_id}`, payload });
    }
    await addAttendees(c, { booking_id: id }, room, toAdd, me, now, policy, b.start_at, b.end_at);
    return { status: 200, booking: await one(c, id, policy, me) };
  });
}

/** POST /bookings/{id}/invitation/accept|decline */
export async function respondInvitation(me, id, response) {
  if (!UUID.test(id)) throw notFound();
  const policy = await getPolicy();
  const now = clock.now();
  const next = response === 'accept' ? 'accepted' : 'declined';
  return tx(async (c) => {
    await ensureStudent(c, me);
    const { rows: [a] } = await c.query(
      `select a.*, lower(b.during) as start_at, upper(b.during) as end_at, b.status as bstatus, b.student_id as booker_id,
              r.code as room_code, r.name as room_name, bl.name as building_name
       from booking_attendee a join booking b on b.booking_id = a.booking_id
       join room r on r.room_id = b.room_id join building bl on bl.building_id = r.building_id
       where a.booking_id = $1 and (a.student_id = $2 or lower(a.email) = $3) for update of a`, [id, me.studentId, me.email]);
    if (!a) throw notFound();
    if (!ACTIVE.includes(a.bstatus)) throw conflict('NOT_ACTIVE', 'This booking is not active');
    if (now >= a.start_at) throw conflict('ALREADY_STARTED', 'This booking has started');
    if (a.status !== next) {
      await c.query('update booking_attendee set status = $2, responded_at = $3, student_id = $4 where attendee_id = $1',
        [a.attendee_id, next, now, me.studentId]);
      const payload = bookingPayload({ code: a.room_code, name: a.room_name, building_name: a.building_name }, a.start_at, a.end_at,
        { response: next, attendee_name: me.name, attendee_email: me.email });
      await notify(c, { studentId: a.booker_id, bookingId: id, type: 'invitation_response',
        dedupeKey: `response:${a.attendee_id}:${next}:${now.getTime()}`, payload });
      // skip the nudge once they have replied; accepted people get a reminder
      await c.query(`update notification set skipped_at = $2 where dedupe_key = $1 and sent_at is null`, [`nudge:${a.attendee_id}`, now]);
      if (next === 'accepted') {
        const remindAt = new Date(a.start_at.getTime() - policy.reminder_lead_minutes * MIN);
        if (remindAt > now) {
          await notify(c, { studentId: me.studentId, bookingId: id, type: 'reminder', sendAt: remindAt,
            dedupeKey: `reminder:${id}:${me.studentId}`,
            payload: { ...bookingPayload({ code: a.room_code, name: a.room_name, building_name: a.building_name }, a.start_at, a.end_at),
              checkin_open_before: policy.checkin_open_before_minutes } });
        }
      } else {
        await c.query(`update notification set skipped_at = $3 where booking_id = $1 and student_id = $2 and type = 'reminder' and sent_at is null`,
          [id, me.studentId, now]);
      }
    }
    return { status: 200, booking: await one(c, id, policy, me) };
  });
}

/**
 * Cancel active future bookings on behalf of the system (room deactivated, closed day).
 * Used by the admin service; runs in the caller's transaction.
 */
export async function systemCancel(c, bookingRows, reasonCode, reasonText, now) {
  let n = 0;
  for (const b of bookingRows) {
    await c.query(`update booking set status = 'CANCELLED', cancelled_at = $2 where booking_id = $1 and status = 'CONFIRMED'`, [b.booking_id, now]);
    await c.query(
      `insert into booking_event (booking_id, from_status, to_status, actor, reason) values ($1,'CONFIRMED','CANCELLED','system',$2)`,
      [b.booking_id, reasonCode]);
    const payload = bookingPayload({ code: b.room_code, name: b.room_name, building_name: b.building_name }, b.start_at, b.end_at,
      { reason: reasonCode, reason_text: reasonText });
    await notify(c, { studentId: b.student_id, bookingId: b.booking_id, type: 'system_cancelled', dedupeKey: `syscancel:${b.booking_id}`, payload });
    await notifyAttendeesCancelled(c, b, payload);
    await skipPending(c, b.booking_id, now);
    n++;
  }
  return n;
}

export { localDateStr };
