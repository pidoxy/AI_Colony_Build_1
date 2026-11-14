// Time-driven work owned by the worker: no-show release, completion, penalties and
// suspension, outbox sending, downtime notices, retention, and the overlap check.
// Each job takes `now` so tests can drive the clock; each runs in its own transaction.
import { clock } from './clock.js';
import { config } from './config.js';
import { getPolicy } from './policy.js';
import { tx, writeQuery } from './db.js';
import { bookingPayload, notify } from './services/notifications.js';
import { sendPush, sendEmail } from './providers.js';
import { MIN, DAY } from './time.js';

const ACTIVE = `('CONFIRMED','CHECKED_IN')`;

/** CONFIRMED with no check-in by start + window becomes NO_SHOW; the rest of the time is released. */
export async function noShowSweep(now = clock.now()) {
  const policy = await getPolicy();
  const cutoff = new Date(now.getTime() - policy.checkin_close_after_minutes * MIN);
  return tx(async (c) => {
    const { rows } = await c.query(
      `select b.booking_id, b.student_id, lower(b.during) as start_at, upper(b.during) as end_at,
              r.code as room_code, r.name as room_name, bl.name as building_name
       from booking b join room r on r.room_id = b.room_id join building bl on bl.building_id = r.building_id
       where b.status = 'CONFIRMED' and lower(b.during) <= $1
       order by lower(b.during) for update of b skip locked`, [cutoff]);
    let suspended = 0;
    for (const b of rows) {
      await c.query(`update booking set status = 'NO_SHOW' where booking_id = $1`, [b.booking_id]);
      await c.query(
        `insert into booking_event (booking_id, from_status, to_status, actor, at) values ($1,'CONFIRMED','NO_SHOW','worker',$2)`,
        [b.booking_id, now]);
      const { rows: [pen] } = await c.query(
        `insert into penalty (student_id, booking_id, kind, at) values ($1,$2,'no_show',$3) returning penalty_id`,
        [b.student_id, b.booking_id, now]);
      const payload = bookingPayload({ code: b.room_code, name: b.room_name, building_name: b.building_name }, b.start_at, b.end_at);
      await notify(c, { studentId: b.student_id, bookingId: b.booking_id, type: 'booking_released_no_show', dedupeKey: `noshow:${b.booking_id}`, payload });
      await c.query(
        `update notification set skipped_at = $2 where booking_id = $1 and sent_at is null and skipped_at is null
           and type in ('reminder','invitation_nudge')`, [b.booking_id, now]);

      const since = new Date(now.getTime() - policy.noshow_window_days * DAY);
      const { rows: [{ n }] } = await c.query('select count(*)::int as n from penalty where student_id = $1 and at > $2', [b.student_id, since]);
      if (n >= policy.noshow_threshold) {
        const until = new Date(now.getTime() + policy.suspension_length_days * DAY);
        const { rowCount } = await c.query(
          `update student set suspended_until = $2 where student_id = $1 and (suspended_until is null or suspended_until <= $3)`,
          [b.student_id, until, now]);
        if (rowCount) {
          suspended++;
          await notify(c, { studentId: b.student_id, type: 'suspension_started', dedupeKey: `suspension:${pen.penalty_id}`,
            payload: { count: n, window_days: policy.noshow_window_days, until: until.toISOString() } });
        }
      }
    }
    return { no_shows: rows.length, suspensions: suspended };
  });
}

/** CHECKED_IN bookings become COMPLETED at their end time. */
export async function completionSweep(now = clock.now()) {
  return tx(async (c) => {
    const { rows } = await c.query(
      `select booking_id from booking where status = 'CHECKED_IN' and upper(during) <= $1 for update skip locked`, [now]);
    for (const b of rows) {
      await c.query(`update booking set status = 'COMPLETED' where booking_id = $1`, [b.booking_id]);
      await c.query(
        `insert into booking_event (booking_id, from_status, to_status, actor, at) values ($1,'CHECKED_IN','COMPLETED','worker',$2)`,
        [b.booking_id, now]);
    }
    return { completed: rows.length };
  });
}

/** Send due outbox rows. In-app rows are delivered by becoming visible; push/email go to a provider. */
export async function sendDue(now = clock.now()) {
  const policy = await getPolicy();
  return tx(async (c) => {
    const { rows } = await c.query(
      `select n.*, b.status as bstatus, a.status as astatus
       from notification n
       left join booking b on b.booking_id = n.booking_id
       left join booking_attendee a on n.type = 'invitation_nudge' and a.attendee_id::text = substring(n.dedupe_key from 7)
       where n.sent_at is null and n.skipped_at is null and n.send_at <= $1
       order by n.send_at limit 500 for update of n skip locked`, [now]);
    let sent = 0; let skipped = 0; let failed = 0;
    for (const n of rows) {
      const needsActive = n.type === 'reminder' || n.type === 'invitation_nudge';
      if (needsActive && !['CONFIRMED', 'CHECKED_IN'].includes(n.bstatus)) {
        await c.query('update notification set skipped_at = $2 where notification_id = $1', [n.notification_id, now]);
        skipped++; continue;
      }
      if (n.type === 'invitation_nudge' && n.astatus !== 'invited') {
        await c.query('update notification set skipped_at = $2 where notification_id = $1', [n.notification_id, now]);
        skipped++; continue;
      }
      try {
        if (n.channel === 'push') { if (!policy.push_enabled) throw new Error('push disabled'); await sendPush(n); }
        else if (n.channel === 'email') { if (!policy.email_enabled) throw new Error('email disabled'); await sendEmail(n); }
        await c.query('update notification set sent_at = $2, attempts = attempts + 1 where notification_id = $1', [n.notification_id, now]);
        sent++;
      } catch (e) {
        // a provider outage never blocks bookings; retry with backoff
        const backoffMin = Math.min(60, 2 ** Math.min(n.attempts + 1, 6));
        await c.query(
          `update notification set attempts = attempts + 1, last_error = $2, send_at = $3 where notification_id = $1`,
          [n.notification_id, String(e.message).slice(0, 200), new Date(now.getTime() + backoffMin * MIN)]);
        failed++;
      }
    }
    return { sent, skipped, failed };
  });
}

/** Fan out downtime notices: students with bookings in the window, and all active users. */
export async function downtimeFanOut(now = clock.now(), onlyId = null) {
  const policy = await getPolicy();
  return tx(async (c) => {
    const { rows: anns } = await c.query(
      `select * from announcement where notified_at is null and notify_at <= $1 and ends_at > $1
         and ($2::uuid is null or announcement_id = $2) for update skip locked`, [now, onlyId]);
    let total = 0;
    for (const a of anns) {
      const activeSince = new Date(now.getTime() - policy.active_user_days * DAY);
      const { rowCount } = await c.query(
        `insert into notification (student_id, announcement_id, type, channel, payload, send_at, sent_at, dedupe_key)
         select s.student_id, $1::uuid, 'downtime', 'in_app',
                jsonb_build_object('message', $2::text, 'starts_at', $3::timestamptz, 'ends_at', $4::timestamptz, 'has_booking', hb.student_id is not null),
                $5, $5, 'downtime:' || $1::uuid::text || ':' || s.student_id
         from student s
         left join (
           select student_id from booking where status in ${ACTIVE} and during && tstzrange($3, $4)
           union
           select a.student_id from booking_attendee a join booking b on b.booking_id = a.booking_id
             where a.status = 'accepted' and a.student_id is not null and b.status in ${ACTIVE} and b.during && tstzrange($3, $4)
         ) hb on hb.student_id = s.student_id
         where s.last_login_at >= $6 or hb.student_id is not null
         on conflict (dedupe_key) do nothing`,
        [a.announcement_id, a.message, a.starts_at, a.ends_at, now, activeSince]);
      total += rowCount;
      await c.query('update announcement set notified_at = $2 where announcement_id = $1', [a.announcement_id, now]);
    }
    return { announcements: anns.length, notified: total };
  });
}

/** Tiered retention: delete early, anonymise after the booking retention period. */
export async function retention(now = clock.now()) {
  const p = await getPolicy();
  const months = (m) => { const d = new Date(now); d.setMonth(d.getMonth() - m); return d; };
  const days = (n) => new Date(now.getTime() - n * DAY);
  return tx(async (c) => {
    const out = {};
    out.attendees = (await c.query(
      `delete from booking_attendee a using booking b where b.booking_id = a.booking_id and upper(b.during) < $1`,
      [days(p.retention_attendee_email_days)])).rowCount;
    out.notifications = (await c.query(
      `delete from notification where coalesce(sent_at, skipped_at) < $1`, [days(p.retention_notification_days)])).rowCount;
    out.penalties = (await c.query('delete from penalty where at < $1', [months(p.retention_penalty_months)])).rowCount;
    // archive: replace the student with a salted hash, drop purpose and attendees, then delete the live row
    await c.query(
      `insert into booking_archive (booking_id, room_id, during, status, student_hash, created_at)
       select booking_id, room_id, during, status, encode(sha256(convert_to(student_id || $2, 'UTF8')), 'hex'), created_at
       from booking where upper(during) < $1 and status not in ('CONFIRMED','CHECKED_IN')
       on conflict (booking_id) do nothing`, [months(p.retention_booking_months), config.retentionSalt]);
    out.bookings_archived = (await c.query(
      `delete from booking where upper(during) < $1 and status not in ('CONFIRMED','CHECKED_IN')`,
      [months(p.retention_booking_months)])).rowCount;
    out.students = (await c.query(
      `delete from student s where coalesce(s.last_login_at, s.created_at) < $1
         and not exists (select 1 from booking b where b.student_id = s.student_id)
         and not exists (select 1 from penalty x where x.student_id = s.student_id)`,
      [months(p.retention_inactive_student_months)])).rowCount;
    out.audit = (await c.query('delete from admin_audit_log where at < $1', [months(p.retention_audit_months)])).rowCount;
    return out;
  });
}

/** The nightly query that must return no rows: overlapping active bookings. */
export async function overlapCheck() {
  const { rows } = await writeQuery(
    `select a.booking_id as a, b.booking_id as b, a.room_id from booking a
     join booking b on a.room_id = b.room_id and a.booking_id < b.booking_id and a.during && b.during
     where a.status in ${ACTIVE} and b.status in ${ACTIVE}`);
  return rows;
}

export async function runAll(now = clock.now()) {
  return {
    noShows: await noShowSweep(now),
    completion: await completionSweep(now),
    downtime: await downtimeFanOut(now),
    outbox: await sendDue(now),
  };
}

let lastSweep = 0;
/**
 * Serverless has no always-on worker. During normal requests, run the time-driven jobs
 * at most once per interval. Safe under concurrency (rows are claimed with SKIP LOCKED).
 */
export async function maybeSweep(intervalMs = 20000) {
  const nowMs = Date.now();
  if (nowMs - lastSweep < intervalMs) return;
  lastSweep = nowMs;
  try { await runAll(); } catch { /* the database is down: bookings fail loudly on their own */ }
}
