// Campus-local time helpers. Everything stored is UTC; grid, week boundaries,
// opening hours and closures are computed in the single campus time zone.
import { config } from './config.js';

const cache = new Map();
function fmt(tz) {
  let f = cache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    cache.set(tz, f);
  }
  return f;
}
const WD = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function localParts(d, tz = config.tz) {
  const o = {};
  for (const p of fmt(tz).formatToParts(d)) o[p.type] = p.value;
  return {
    year: +o.year, month: +o.month, day: +o.day,
    hour: +o.hour, minute: +o.minute, second: +o.second,
    isoWeekday: WD[o.weekday],
  };
}

function offsetMs(d, tz) {
  const p = localParts(d, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(d.getTime() / 1000) * 1000;
}

/** Local wall-clock fields in `tz` to a UTC instant. */
export function zonedToUtc({ year, month, day, hour = 0, minute = 0 }, tz = config.tz) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const off = offsetMs(new Date(guess), tz);
  let res = guess - off;
  const off2 = offsetMs(new Date(res), tz);
  if (off2 !== off) res = guess - off2;
  return new Date(res);
}

export const pad = (n) => String(n).padStart(2, '0');
export function localDateStr(d, tz = config.tz) {
  const p = localParts(d, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}
export function localTimeStr(d, tz = config.tz) {
  const p = localParts(d, tz);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}
export function minutesOfDay(d, tz = config.tz) {
  const p = localParts(d, tz);
  return p.hour * 60 + p.minute;
}

/** Monday 00:00 (campus time) to next Monday 00:00 around d. */
export function weekBounds(d, tz = config.tz) {
  const p = localParts(d, tz);
  const monday = new Date(Date.UTC(p.year, p.month - 1, p.day - (p.isoWeekday - 1)));
  const next = new Date(monday.getTime() + 7 * 86400000);
  const f = (x) => zonedToUtc({ year: x.getUTCFullYear(), month: x.getUTCMonth() + 1, day: x.getUTCDate() }, tz);
  return { start: f(monday), end: f(next) };
}

/** Parse an ISO 8601 instant that carries an explicit offset. Returns null if invalid. */
export function parseIso(s) {
  if (typeof s !== 'string' || !/(Z|[+-]\d\d:\d\d)$/.test(s)) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Local date "YYYY-MM-DD" + "HH:MM" to a UTC instant. */
export function localToInstant(dateStr, timeStr, tz = config.tz) {
  const dm = /^(\d{4})-(\d\d)-(\d\d)$/.exec(dateStr || '');
  const tm = /^(\d\d):(\d\d)$/.exec(timeStr || '');
  if (!dm || !tm) return null;
  return zonedToUtc({ year: +dm[1], month: +dm[2], day: +dm[3], hour: +tm[1], minute: +tm[2] }, tz);
}

export const MIN = 60000;
export const HOUR = 3600000;
export const DAY = 86400000;
