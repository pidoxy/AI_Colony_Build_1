import { clock } from '../clock.js';
import { getPolicy } from '../policy.js';
import { readQuery, writeQuery } from '../db.js';
import { render } from '../templates.js';
import { notFound } from '../errors.js';

/**
 * Write one notification to the outbox, inside the caller's transaction so it is
 * never lost. In-app rows that are already due are delivered immediately (the row
 * is the delivery). Future rows (reminders, nudges) wait for the worker.
 * Email rows are not created while email is disabled; push rows only if enabled.
 */
export async function notify(client, n) {
  const { studentId, bookingId = null, announcementId = null, type, sendAt = null, dedupeKey, payload = {} } = n;
  if (!studentId) return; // person has never signed in; nothing to attach a row to
  const now = clock.now();
  const due = !sendAt || sendAt <= now;
  const policy = await getPolicy();
  await client.query(
    `insert into notification (student_id, booking_id, announcement_id, type, channel, payload, send_at, sent_at, dedupe_key)
     values ($1,$2,$3,$4,'in_app',$5::jsonb,$6,$7,$8) on conflict (dedupe_key) do nothing`,
    [studentId, bookingId, announcementId, type, JSON.stringify(payload), sendAt ?? now, due ? now : null, dedupeKey],
  );
  if (policy.push_enabled) {
    await client.query(
      `insert into notification (student_id, booking_id, announcement_id, type, channel, payload, send_at, dedupe_key)
       values ($1,$2,$3,$4,'push',$5::jsonb,$6,$7) on conflict (dedupe_key) do nothing`,
      [studentId, bookingId, announcementId, type, JSON.stringify(payload), sendAt ?? now, `${dedupeKey}:push`],
    );
  }
  // policy.email_enabled is false until a provider exists: no email rows are written.
}

export function bookingPayload(room, startDate, endDate, extra = {}) {
  return {
    room_code: room.code, room_name: room.name, building_name: room.building_name,
    start: startDate.toISOString(), end: endDate.toISOString(), ...extra,
  };
}

function toDto(r) {
  const { title, body } = render(r.type, r.payload);
  return {
    notification_id: r.notification_id, type: r.type, title, body,
    booking_id: r.booking_id, at: r.sent_at, read: !!r.read_at, payload: r.payload,
  };
}

export async function listNotifications(studentId, { limit = 50 } = {}) {
  const { rows } = await readQuery(
    `select * from notification where student_id = $1 and channel = 'in_app' and sent_at is not null and skipped_at is null
     order by sent_at desc limit $2`,
    [studentId, Math.min(Number(limit) || 50, 200)],
  );
  const unread = rows.filter((r) => !r.read_at).length;
  return { notifications: rows.map(toDto), unread };
}

export async function markRead(studentId, id) {
  const { rowCount } = await writeQuery(
    `update notification set read_at = coalesce(read_at, $3) where notification_id = $1 and student_id = $2`,
    [id, studentId, clock.now()],
  );
  if (!rowCount) throw notFound();
  return { ok: true };
}

export async function markAllRead(studentId) {
  await writeQuery(
    `update notification set read_at = $2 where student_id = $1 and read_at is null and channel = 'in_app'`,
    [studentId, clock.now()],
  );
  return { ok: true };
}
