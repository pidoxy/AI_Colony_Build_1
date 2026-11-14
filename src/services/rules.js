// Booking-range rules that need policy values and campus time. Used by booking
// (inside its transaction) and by search (as the same rules in SQL form).
import { config } from '../config.js';
import { unprocessable } from '../errors.js';
import { localParts, localDateStr, minutesOfDay, MIN, DAY, pad } from '../time.js';

const hhmm = (mins) => `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;

/** "HH:MM" local end time; a booking ending exactly at local midnight is 24:00. */
export function localEndTimeStr(start, end) {
  const sd = localDateStr(start);
  const m = minutesOfDay(end);
  if (localDateStr(end) === sd) return hhmm(m);
  // ends exactly at the next local midnight: the last instant is still on the start day
  if (m === 0 && localDateStr(new Date(end.getTime() - 1)) === sd) return '24:00';
  return null;
}

export function checkGridAndDuration(start, end, policy) {
  const grid = policy.time_grid_minutes;
  const onGrid = (d) => d.getTime() % 60000 === 0 && minutesOfDay(d) % grid === 0;
  if (!onGrid(start) || !onGrid(end)) {
    throw unprocessable('OFF_GRID', `Start and end must fall on the ${grid}-minute grid`, { allowed_minutes_multiple: grid });
  }
  const mins = (end - start) / MIN;
  if (mins < policy.duration_min_minutes || mins > policy.duration_max_minutes) {
    throw unprocessable('DURATION_NOT_ALLOWED', `Bookings must be ${policy.duration_min_minutes} to ${policy.duration_max_minutes} minutes`, {
      min_minutes: policy.duration_min_minutes, max_minutes: policy.duration_max_minutes,
    });
  }
}

export function checkHorizon(start, end, now, policy, errCode = 'OUT_OF_HORIZON') {
  if (start < now) throw unprocessable(errCode === 'OUT_OF_HORIZON' ? 'IN_PAST' : errCode, 'That time has already started');
  if (end.getTime() > now.getTime() + policy.horizon_days * DAY) {
    throw unprocessable('OUT_OF_HORIZON', `Bookings open up to ${policy.horizon_days} days ahead`, { horizon_days: policy.horizon_days });
  }
}

/** Opening window for the room on the local weekday of `start`, applying the weekday exception. */
export function hoursFor(room, exceptions, start) {
  const wd = localParts(start).isoWeekday;
  const ex = exceptions.find((e) => e.weekday === wd);
  return { opens: ex ? ex.opens_at : room.opens_at, closes: ex ? ex.closes_at : room.closes_at };
}

export function checkOpeningHours(room, exceptions, start, end) {
  const { opens, closes } = hoursFor(room, exceptions, start);
  const startT = `${pad(localParts(start).hour)}:${pad(localParts(start).minute)}`;
  const endT = localEndTimeStr(start, end);
  const within = endT && startT >= opens.slice(0, 5) && endT <= closes.slice(0, 5);
  if (!within) {
    throw unprocessable('OUTSIDE_OPENING_HOURS', `This room is open ${opens.slice(0, 5)} to ${closes.slice(0, 5)}`, {
      opens_at: opens.slice(0, 5), closes_at: closes.slice(0, 5),
    });
  }
}

/** Local dates (YYYY-MM-DD) the range touches. */
export function localDatesOf(start, end) {
  const out = new Set([localDateStr(start)]);
  out.add(localDateStr(new Date(end.getTime() - 1)));
  return [...out];
}

export const tzName = () => config.tz;
