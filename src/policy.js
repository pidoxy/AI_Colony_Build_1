// R20: every policy value lives in the `policy` table and is read by the service.
// DEFS only supplies the default used to seed the table and the validation rule.
import { readQuery } from './db.js';
import { bad } from './errors.js';

const int = (min, max) => ({
  type: 'int',
  check: (v) => Number.isInteger(v) && v >= min && v <= max,
  hint: `a whole number from ${min} to ${max}`,
});
const bool = { type: 'bool', check: (v) => typeof v === 'boolean', hint: 'true or false' };
const str = { type: 'string', check: (v) => typeof v === 'string' && v.length > 0, hint: 'text' };

export const DEFS = {
  time_grid_minutes:              { default: 30,  note: 'Start and end must sit on this grid', ...int(5, 60) },
  duration_min_minutes:           { default: 30,  note: 'Shortest booking', ...int(5, 600) },
  duration_max_minutes:           { default: 180, note: 'Longest booking', ...int(5, 1440) },
  horizon_days:                   { default: 14,  note: 'How far ahead a booking may start', ...int(1, 365) },
  weekly_limit:                   { default: 5,   note: 'Bookings per student per calendar week (Mon-Sun)', ...int(1, 100) },
  reminder_lead_minutes:          { default: 60,  note: 'Reminder before start (allowed 30 to 60)', ...int(30, 60) },
  checkin_open_before_minutes:    { default: 10,  note: 'Check-in opens this long before start', ...int(0, 120) },
  checkin_close_after_minutes:    { default: 15,  note: 'Check-in closes, and a no-show is recorded, this long after start', ...int(1, 120) },
  noshow_threshold:               { default: 3,   note: 'No-shows that trigger a suspension', ...int(1, 50) },
  noshow_window_days:             { default: 30,  note: 'Rolling window for counting no-shows', ...int(1, 365) },
  suspension_length_days:         { default: 7,   note: 'Booking blocked this long; search stays allowed', ...int(1, 365) },
  available_soon_window_minutes:  { default: 120, note: 'Available soon looks this far ahead (max 120)', ...int(15, 120) },
  just_released_window_minutes:   { default: 120, note: 'A released slot stays listed this long', ...int(5, 1440) },
  search_staleness_seconds:       { default: 5,   note: 'Search may be up to this old', ...int(0, 60) },
  active_user_days:               { default: 30,  note: 'Signed in within this many days = active user', ...int(1, 365) },
  university_email_domain:        { default: 'university.test', note: 'Attendee emails must end with @this', ...str },
  invitation_nudge_lead_hours:    { default: 24,  note: 'One nudge to pending invitees this long before start', ...int(1, 168) },
  email_enabled:                  { default: false, note: 'Email delivery (needs a provider, not integrated yet)', ...bool },
  push_enabled:                   { default: false, note: 'App push delivery (needs a provider)', ...bool },
  admin_temp_password_ttl_days:   { default: 7,   note: 'An unused temporary admin password expires after this', ...int(1, 90) },
  admin_max_failed_logins:        { default: 5,   note: 'Failed admin logins before lockout', ...int(1, 50) },
  admin_lockout_minutes:          { default: 15,  note: 'Admin lockout length', ...int(1, 1440) },
  retention_student_visible_days: { default: 90,  note: 'Bookings stay visible to the student this long', ...int(1, 3650) },
  retention_booking_months:       { default: 13,  note: 'Full booking rows are archived (anonymised) after this', ...int(1, 120) },
  retention_attendee_email_days:  { default: 90,  note: 'Attendee emails are deleted after this', ...int(1, 3650) },
  retention_notification_days:    { default: 90,  note: 'Sent notifications are deleted after this', ...int(1, 3650) },
  retention_penalty_months:       { default: 12,  note: 'Penalties are deleted after this', ...int(1, 120) },
  retention_inactive_student_months: { default: 13, note: 'Inactive students are deleted after this', ...int(1, 120) },
  retention_audit_months:         { default: 24,  note: 'Admin audit log kept this long', ...int(1, 240) },
};

let cache = null;
let cachedAt = 0;
const TTL = 1000;

export function invalidatePolicy() { cache = null; cachedAt = 0; }

/** All policy values as one object, merged over defaults. */
export async function getPolicy() {
  if (cache && Date.now() - cachedAt < TTL) return cache;
  const { rows } = await readQuery('select key, value from policy');
  const out = {};
  for (const k of Object.keys(DEFS)) out[k] = DEFS[k].default;
  for (const r of rows) if (r.key in DEFS) out[r.key] = r.value;
  cache = out;
  cachedAt = Date.now();
  return out;
}

export function validatePolicyValue(key, value) {
  const d = DEFS[key];
  if (!d) throw bad('UNKNOWN_POLICY_KEY', `Unknown policy key: ${key}`);
  if (!d.check(value)) throw bad('INVALID_POLICY_VALUE', `${key} must be ${d.hint}`, { key });
}

/** Cross-field rules, checked against the full proposed set. */
export function validatePolicySet(p) {
  if (p.duration_min_minutes > p.duration_max_minutes) throw bad('INVALID_POLICY_VALUE', 'Shortest booking cannot exceed the longest');
  if (p.duration_min_minutes % p.time_grid_minutes || p.duration_max_minutes % p.time_grid_minutes) {
    throw bad('INVALID_POLICY_VALUE', 'Durations must be multiples of the time grid');
  }
  if (60 % p.time_grid_minutes) throw bad('INVALID_POLICY_VALUE', 'The time grid must divide an hour evenly');
}

export async function seedPolicyDefaults(client) {
  for (const [k, d] of Object.entries(DEFS)) {
    await client.query(
      'insert into policy(key, value) values ($1, $2::jsonb) on conflict (key) do nothing',
      [k, JSON.stringify(d.default)],
    );
  }
}
