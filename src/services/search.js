// Read side: search, Available soon, Just released. Served from the read replica
// (results may be up to `search_staleness_seconds` old). Availability is derived:
// free = open hours, minus closures, minus active bookings. Nothing is stored.
import { config } from '../config.js';
import { clock } from '../clock.js';
import { getPolicy } from '../policy.js';
import { bad } from '../errors.js';
import { readQuery, replica, primary, primaryUp } from '../db.js';
import { localParts, localDateStr, minutesOfDay, parseIso, localToInstant, MIN, pad } from '../time.js';
import { localEndTimeStr } from './rules.js';

const ACTIVE = `('CONFIRMED','CHECKED_IN')`;
const ROOM_TYPES = ['study', 'seminar', 'group', 'other'];

export function floorToGrid(d, grid) {
  const m = minutesOfDay(d) % grid;
  return new Date(Math.floor(d.getTime() / MIN) * MIN - m * MIN);
}

async function asOf() {
  const now = clock.now();
  if (replica === primary) return now;
  try {
    const { rows } = await readQuery('select pg_last_xact_replay_timestamp() as ts');
    const ts = rows[0]?.ts;
    return ts ? new Date(Math.min(now.getTime(), ts.getTime())) : now;
  } catch { return now; }
}

function ids(v) {
  if (v == null || v === '') return [];
  const arr = Array.isArray(v) ? v : String(v).split(',');
  return arr.map((x) => String(x).trim()).filter(Boolean);
}
function posInt(v, name) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw bad('UNKNOWN_FILTER', `${name} is not valid`);
  return n;
}

/** Shared filter parsing (type, capacity, name, amenities, purpose, near_building). */
async function parseFilters(q) {
  const f = { types: null, minCapacity: null, name: null, amenityIds: [], purposeTypes: null, near: null };
  if (q.min_capacity != null && q.min_capacity !== '') f.minCapacity = posInt(q.min_capacity, 'min_capacity');
  const types = ids(q.type);
  if (types.length) {
    if (types.some((t) => !ROOM_TYPES.includes(t))) throw bad('UNKNOWN_FILTER', 'Unknown room type');
    f.types = types;
  }
  if (q.name && String(q.name).trim()) f.name = String(q.name).trim().slice(0, 80);
  const am = ids(q.amenities);
  if (am.length) {
    f.amenityIds = am.map((a) => posInt(a, 'amenities'));
    const { rows } = await readQuery('select count(*)::int as n from amenity where amenity_id = any($1::int[])', [f.amenityIds]);
    if (rows[0].n !== new Set(f.amenityIds).size) throw bad('UNKNOWN_FILTER', 'Amenity not found');
  }
  if (q.purpose != null && q.purpose !== '') {
    const pid = posInt(q.purpose, 'purpose');
    const { rows } = await readQuery('select suggested_room_types from purpose where purpose_id = $1', [pid]);
    if (!rows[0]) throw bad('UNKNOWN_FILTER', 'Purpose not found');
    if (rows[0].suggested_room_types.length) f.purposeTypes = rows[0].suggested_room_types;
  }
  if (q.near_building != null && q.near_building !== '') {
    const bid = posInt(q.near_building, 'near_building');
    const { rows } = await readQuery('select building_id, latitude, longitude from building where building_id = $1', [bid]);
    if (!rows[0]) throw bad('UNKNOWN_FILTER', 'Building not found');
    f.near = rows[0];
  }
  return f;
}

/** Appends WHERE fragments for the shared filters; returns { where, dist }. */
function filterSql(f, params, alias = 'r', bAlias = 'b') {
  const p = (v) => { params.push(v); return `$${params.length}`; };
  const where = [];
  if (f.types) where.push(`${alias}.type = any(${p(f.types)}::text[])`);
  if (f.purposeTypes) where.push(`${alias}.type = any(${p(f.purposeTypes)}::text[])`);
  if (f.minCapacity) where.push(`${alias}.capacity >= ${p(f.minCapacity)}`);
  if (f.name) {
    const like = `%${f.name.replace(/[\\%_]/g, '\\$&')}%`;
    const l = p(like);
    where.push(`(${alias}.name ilike ${l} or ${alias}.code ilike ${l})`);
  }
  for (const a of f.amenityIds) {
    where.push(`exists (select 1 from room_amenity ra where ra.room_id = ${alias}.room_id and ra.amenity_id = ${p(a)})`);
  }
  let dist = 'null::float8';
  if (f.near) {
    const la = p(f.near.latitude); const lo = p(f.near.longitude);
    dist = `(6371 * 2 * asin(sqrt(power(sin(radians(${bAlias}.latitude - ${la}) / 2), 2) + cos(radians(${la})) * cos(radians(${bAlias}.latitude)) * power(sin(radians(${bAlias}.longitude - ${lo}) / 2), 2))))`;
  }
  return { where, dist };
}

function pageOf(q) {
  const limit = Math.min(Math.max(Number(q.limit) || 20, 1), 100);
  const offset = Math.max(Number(q.offset) || 0, 0);
  return { limit, offset };
}

const AMENITIES_SQL = `(select coalesce(json_agg(json_build_object('amenity_id', a.amenity_id, 'name', a.name) order by a.name), '[]'::json)
  from room_amenity ra join amenity a using (amenity_id) where ra.room_id = r.room_id)`;

function roomDto(r) {
  return {
    room_id: r.room_id, code: r.code, name: r.name, type: r.type, capacity: r.capacity,
    building: { building_id: r.building_id, name: r.building_name, zone: r.zone },
    distance_km: r.distance_km == null ? null : Math.round(r.distance_km * 100) / 100,
    amenities: r.amenities,
  };
}

/** GET /rooms/search */
export async function searchRooms(q) {
  const policy = await getPolicy();
  const now = clock.now();
  let start; let end;
  if (q.date && /^\d\d:\d\d$/.test(q.start || '')) {
    start = localToInstant(q.date, q.start);
    end = q.end ? localToInstant(q.date, q.end) : null;
  } else {
    start = parseIso(q.start);
    end = q.end ? parseIso(q.end) : null;
  }
  const duration = q.duration != null && q.duration !== '' ? Number(q.duration) : null;
  if (duration != null && (!Number.isInteger(duration) || duration <= 0)) throw bad('INVALID_RANGE', 'duration is not valid');
  if (!end && start && duration) end = new Date(start.getTime() + duration * MIN);
  if (!start || !end) throw bad('INVALID_RANGE', 'Give a date, start and end');
  if (end <= start) throw bad('INVALID_RANGE', 'End must be after start');
  if (duration && (end - start) / MIN !== duration) throw bad('INVALID_RANGE', 'duration does not match start and end');
  const g = policy.time_grid_minutes;
  if (minutesOfDay(start) % g || minutesOfDay(end) % g) throw bad('INVALID_RANGE', `Times must fall on the ${g}-minute grid`);
  if (start < now || end.getTime() > now.getTime() + policy.horizon_days * 86400000) {
    throw bad('OUT_OF_HORIZON', `Search covers now to ${policy.horizon_days} days ahead`);
  }
  const f = await parseFilters(q);
  const { limit, offset } = pageOf(q);
  const asof = await asOf();
  const booking_paused = !(await primaryUp());

  const endT = localEndTimeStr(start, end);
  if (!endT) return { rooms: [], total: 0, limit, offset, as_of: asof.toISOString(), booking_paused };

  const params = [localParts(start).isoWeekday, `${pad(localParts(start).hour)}:${pad(localParts(start).minute)}`, endT,
    localDateStr(start), `[${start.toISOString()},${end.toISOString()})`];
  const { where, dist } = filterSql(f, params);
  params.push(limit, offset);
  const sql = `
    select r.room_id, r.code, r.name, r.type, r.capacity, r.building_id, b.name as building_name, b.zone,
           ${AMENITIES_SQL} as amenities, ${dist} as distance_km, count(*) over () as total
    from room r
    join building b on b.building_id = r.building_id
    left join room_hours_exception he on he.room_id = r.room_id and he.weekday = $1
    where r.is_active
      and coalesce(he.opens_at, r.opens_at) <= $2::time
      and coalesce(he.closes_at, r.closes_at) >= $3::time
      and not exists (select 1 from closure c where c.during @> $4::date
            and (c.scope = 'campus' or (c.scope = 'building' and c.building_id = r.building_id) or (c.scope = 'room' and c.room_id = r.room_id)))
      and not exists (select 1 from booking bk where bk.room_id = r.room_id and bk.status in ${ACTIVE} and bk.during && $5::tstzrange)
      ${where.map((w) => `and ${w}`).join('\n      ')}
    order by ${f.near ? 'distance_km asc,' : ''} r.code asc
    limit $${params.length - 1} offset $${params.length}`;
  const { rows } = await readQuery(sql, params);
  return {
    rooms: rows.map((r) => ({ ...roomDto(r), available: { start: start.toISOString(), end: end.toISOString() } })),
    total: rows[0]?.total ?? 0, limit, offset,
    as_of: asof.toISOString(), booking_paused,
  };
}

/** GET /rooms/available-soon: rooms free now or within the window, soonest first. */
export async function availableSoon(q) {
  const policy = await getPolicy();
  const now = clock.now();
  let within = policy.available_soon_window_minutes;
  if (q.within != null && q.within !== '') {
    within = Number(q.within);
    if (!Number.isInteger(within) || within <= 0 || within > 120) throw bad('INVALID_WINDOW', 'within must be 1 to 120 minutes');
  }
  const f = await parseFilters(q);
  const { limit, offset } = pageOf(q);
  const g = policy.time_grid_minutes;
  const firstSlot = floorToGrid(now, g);
  const lastSlot = new Date(now.getTime() + within * MIN);
  const params = [firstSlot.toISOString(), lastSlot.toISOString(), `${g} minutes`, now.toISOString(), config.tz];
  const { where, dist } = filterSql(f, params);
  params.push(limit, offset);
  const sql = `
    select r.room_id, r.code, r.name, r.type, r.capacity, r.building_id, b.name as building_name, b.zone,
           ${AMENITIES_SQL} as amenities, ${dist} as distance_km,
           min(greatest(sl.s, $4::timestamptz)) as free_from, count(*) over () as total
    from room r
    join building b on b.building_id = r.building_id
    cross join generate_series($1::timestamptz, $2::timestamptz, $3::interval) as sl(s)
    left join room_hours_exception he on he.room_id = r.room_id
         and he.weekday = extract(isodow from timezone($5, sl.s))::int
    where r.is_active
      and sl.s + $3::interval > $4::timestamptz
      and timezone($5, greatest(sl.s, $4::timestamptz))::time >= coalesce(he.opens_at, r.opens_at)
      and ((timezone($5, sl.s + $3::interval)::time <= coalesce(he.closes_at, r.closes_at)
            and timezone($5, sl.s + $3::interval)::date = timezone($5, sl.s)::date)
           or (timezone($5, sl.s + $3::interval)::time = '00:00' and coalesce(he.closes_at, r.closes_at) = '24:00'))
      and not exists (select 1 from closure c where c.during @> timezone($5, sl.s)::date
            and (c.scope = 'campus' or (c.scope = 'building' and c.building_id = r.building_id) or (c.scope = 'room' and c.room_id = r.room_id)))
      and not exists (select 1 from booking bk where bk.room_id = r.room_id and bk.status in ${ACTIVE}
            and bk.during && tstzrange(greatest(sl.s, $4::timestamptz), sl.s + $3::interval))
      ${where.map((w) => `and ${w}`).join('\n      ')}
    group by r.room_id, b.building_id
    order by free_from asc, ${f.near ? 'distance_km asc,' : ''} r.code asc
    limit $${params.length - 1} offset $${params.length}`;
  const { rows } = await readQuery(sql, params);

  // How long each room stays free: until its next booking or closing time.
  const roomIds = rows.map((r) => r.room_id);
  const nextBk = new Map();
  const closes = new Map();
  if (roomIds.length) {
    const nb = await readQuery(
      `select r.room_id, (select min(lower(bk.during)) from booking bk
          where bk.room_id = r.room_id and bk.status in ${ACTIVE} and lower(bk.during) > now_at.t) as nxt
       from room r cross join (select $2::timestamptz as t) now_at where r.room_id = any($1::uuid[])`,
      [roomIds, now.toISOString()]);
    for (const r of nb.rows) nextBk.set(r.room_id, r.nxt);
  }
  const out = rows.map((r) => {
    const ff = new Date(r.free_from);
    const nxt = nextBk.get(r.room_id);
    const cap = nxt ? new Date(nxt) : null;
    return { ...roomDto(r), free_from: ff.toISOString(), free_now: ff.getTime() <= now.getTime() + 1000,
      free_until: cap ? cap.toISOString() : null,
      available_minutes: cap ? Math.round((cap - ff) / MIN) : null };
  });
  void closes;
  const asof = await asOf();
  return { rooms: out, total: rows[0]?.total ?? 0, limit, offset, within_minutes: within,
    as_of: asof.toISOString(), booking_paused: !(await primaryUp()) };
}

/** GET /rooms/released: slots freed by cancel or no-show, newest first. */
export async function justReleased(q) {
  const policy = await getPolicy();
  const now = clock.now();
  const f = await parseFilters(q);
  const { limit, offset } = pageOf(q);
  const gs = policy.time_grid_minutes * 60;
  const params = [now.toISOString(), `${policy.just_released_window_minutes} minutes`, gs, config.tz];
  const { where, dist } = filterSql(f, params);
  params.push(limit, offset);
  const ceilGrid = (x) => `to_timestamp(ceil(extract(epoch from ${x}) / $3) * $3)`;
  const sql = `
    select * from (
      select r.room_id, r.code, r.name, r.type, r.capacity, r.building_id, b.name as building_name, b.zone,
             ${AMENITIES_SQL} as amenities, ${dist} as distance_km, x.status, x.released_at, x.free_start, x.free_end,
             count(*) over () as total
      from (
        select bk.booking_id, bk.room_id, bk.status,
               case when bk.status = 'CANCELLED' then bk.cancelled_at else ev.at end as released_at,
               case when bk.status = 'CANCELLED' then lower(bk.during)
                    else greatest(${ceilGrid('ev.at')}, ${ceilGrid('$1::timestamptz')}) end as free_start,
               upper(bk.during) as free_end
        from booking bk
        left join lateral (select at from booking_event where booking_id = bk.booking_id and to_status = 'NO_SHOW'
                           order by at desc limit 1) ev on bk.status = 'NO_SHOW'
        where bk.status in ('CANCELLED','NO_SHOW')
      ) x
      join room r on r.room_id = x.room_id
      join building b on b.building_id = r.building_id
      where r.is_active
        and x.released_at is not null
        and x.released_at > $1::timestamptz - $2::interval and x.released_at <= $1::timestamptz
        and (x.status = 'NO_SHOW' or x.free_start > $1::timestamptz)
        and x.free_end > x.free_start
        and not exists (select 1 from booking o where o.room_id = x.room_id and o.status in ${ACTIVE}
              and o.during && tstzrange(x.free_start, x.free_end))
        and not exists (select 1 from closure c where c.during @> timezone($4, x.free_start)::date
              and (c.scope = 'campus' or (c.scope = 'building' and c.building_id = r.building_id) or (c.scope = 'room' and c.room_id = r.room_id)))
        ${where.map((w) => `and ${w}`).join('\n        ')}
    ) y
    order by released_at desc, ${f.near ? 'distance_km asc,' : ''} code asc
    limit $${params.length - 1} offset $${params.length}`;
  const { rows } = await readQuery(sql, params);
  const asof = await asOf();
  return {
    slots: rows.map((r) => ({
      ...roomDto(r), reason: r.status === 'CANCELLED' ? 'cancelled' : 'no_show',
      released_at: new Date(r.released_at).toISOString(),
      start: new Date(r.free_start).toISOString(), end: new Date(r.free_end).toISOString(),
    })),
    total: rows[0]?.total ?? 0, limit, offset, window_minutes: policy.just_released_window_minutes,
    as_of: asof.toISOString(), booking_paused: !(await primaryUp()),
  };
}

/** Exact (primary) check used to suggest alternatives after SLOT_TAKEN (E1). */
export async function alternativesFor(client, room, start, end, policy) {
  const params = [localParts(start).isoWeekday, `${pad(localParts(start).hour)}:${pad(localParts(start).minute)}`,
    localEndTimeStr(start, end), localDateStr(start), `[${start.toISOString()},${end.toISOString()})`, room.room_id, room.building_id, room.type];
  if (!params[2]) return { same_time: [], same_room_later: null };
  const { rows } = await client.query(
    `select r.room_id, r.code, r.name, r.type, r.capacity, r.building_id, b.name as building_name, b.zone, ${AMENITIES_SQL} as amenities,
            null::float8 as distance_km
     from room r join building b on b.building_id = r.building_id
     left join room_hours_exception he on he.room_id = r.room_id and he.weekday = $1
     where r.is_active and r.room_id <> $6
       and coalesce(he.opens_at, r.opens_at) <= $2::time and coalesce(he.closes_at, r.closes_at) >= $3::time
       and not exists (select 1 from closure c where c.during @> $4::date
            and (c.scope = 'campus' or (c.scope = 'building' and c.building_id = r.building_id) or (c.scope = 'room' and c.room_id = r.room_id)))
       and not exists (select 1 from booking bk where bk.room_id = r.room_id and bk.status in ${ACTIVE} and bk.during && $5::tstzrange)
     order by (r.building_id = $7) desc, (r.type = $8) desc, r.code limit 3`, params);
  // same room, later: the next free window of the same length on that day
  const len = end - start;
  let later = null;
  for (let i = 1; i <= 8 && !later; i++) {
    const s = new Date(end.getTime() + (i - 1) * policy.time_grid_minutes * MIN);
    const e = new Date(s.getTime() + len);
    const endTl = localEndTimeStr(s, e);
    if (!endTl) break;
    const { rows: ok } = await client.query(
      `select 1 from room r left join room_hours_exception he on he.room_id = r.room_id and he.weekday = $2
       where r.room_id = $1 and coalesce(he.opens_at, r.opens_at) <= $3::time and coalesce(he.closes_at, r.closes_at) >= $4::time
         and not exists (select 1 from booking bk where bk.room_id = r.room_id and bk.status in ${ACTIVE} and bk.during && $5::tstzrange)
         and not exists (select 1 from closure c where c.during @> $6::date
            and (c.scope = 'campus' or (c.scope = 'building' and c.building_id = r.building_id) or (c.scope = 'room' and c.room_id = r.room_id)))`,
      [room.room_id, localParts(s).isoWeekday, `${pad(localParts(s).hour)}:${pad(localParts(s).minute)}`, endTl,
        `[${s.toISOString()},${e.toISOString()})`, localDateStr(s)]);
    if (ok.length) later = { start: s.toISOString(), end: e.toISOString() };
  }
  return { same_time: rows.map((r) => ({ ...roomDto(r), available: { start: start.toISOString(), end: end.toISOString() } })), same_room_later: later };
}
