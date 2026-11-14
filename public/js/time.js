// Campus-time helpers for the browser (same algorithm as the server).
let TZ = 'Africa/Lagos';
export let TZ_LABEL = 'WAT';
export function setTz(tz, label) { TZ = tz; if (label) TZ_LABEL = label; }

const fmtCache = new Map();
function fmt() {
  if (!fmtCache.has(TZ)) {
    fmtCache.set(TZ, new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  }
  return fmtCache.get(TZ);
}
export function parts(d) {
  const o = {};
  for (const p of fmt().formatToParts(d)) o[p.type] = p.value;
  return { year: +o.year, month: +o.month, day: +o.day, hour: +o.hour, minute: +o.minute, weekday: o.weekday };
}
const offset = (d) => {
  const p = parts(d);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, new Date(d).getUTCSeconds()) - Math.floor(d.getTime() / 1000) * 1000;
};
export function toInstant(dateStr, timeStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let res = guess - offset(new Date(guess));
  const o2 = offset(new Date(res));
  if (o2 !== offset(new Date(guess))) res = guess - o2;
  return new Date(res);
}
export const pad = (n) => String(n).padStart(2, '0');
export const dateStr = (d) => { const p = parts(d); return `${p.year}-${pad(p.month)}-${pad(p.day)}`; };
export const timeStr = (d) => { const p = parts(d); return `${pad(p.hour)}:${pad(p.minute)}`; };
export function addDays(ds, n) {
  const [y, m, d] = ds.split('-').map(Number);
  const x = new Date(Date.UTC(y, m - 1, d + n));
  return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}`;
}
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' };
export const monthName = (d) => MONTHS[parts(d).month - 1];
export const monthShort = (d) => MONTHS[parts(d).month - 1].slice(0, 3);
export const weekdayName = (d) => DAYS[parts(d).weekday];
export function longDate(d) { const p = parts(d); return `${DAYS[p.weekday]}, ${p.day} ${MONTHS[p.month - 1]} ${p.year}`; }
export function shortDate(ds) {
  const d = toInstant(ds, '12:00'); const p = parts(d);
  return `${p.weekday}, ${p.day} ${MONTHS[p.month - 1].slice(0, 3)} ${p.year}`;
}
export function dayLabel(d, now = new Date()) {
  const a = dateStr(d); const b = dateStr(now);
  if (a === b) return 'Today';
  if (a === addDays(b, 1)) return 'Tomorrow';
  return `${DAYS[parts(d).weekday].slice(0, 3)}, ${parts(d).day} ${monthShort(d)}`;
}
export const range = (s, e) => `${timeStr(new Date(s))}–${timeStr(new Date(e))}`;
export function ago(iso, now = new Date()) {
  const s = Math.max(0, Math.round((now - new Date(iso)) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s} seconds ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}
export function minutes(n) { return n % 60 === 0 ? `${n / 60} hour${n === 60 ? '' : 's'}` : n < 60 ? `${n} min` : `${Math.floor(n / 60)} h ${n % 60} min`; }
/** 30-min-grid time options between open and close (HH:MM). */
export function gridTimes(from = '00:00', to = '24:00', step = 30) {
  const toM = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const out = [];
  for (let m = toM(from); m <= toM(to); m += step) out.push(m === 1440 ? '24:00' : `${pad(Math.floor(m / 60))}:${pad(m % 60)}`);
  return out;
}
