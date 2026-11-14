// Admin console: operator auth, catalogue (buildings, rooms, hours, closures, amenities,
// purposes), announcements, policy, admin users, audit log. Every write is audited in
// the same transaction. Deactivating a room or adding a closure cancels affected
// bookings with reason ROOM_UNAVAILABLE / CLOSED_DAY and notifies the people involved.
import { config } from '../config.js';
import { clock } from '../clock.js';
import { tx, readQuery } from '../db.js';
import { hashPassword, verifyPassword, signAdminToken } from '../auth.js';
import { bad, conflict, notFound, forbidden, unprocessable, ApiError } from '../errors.js';
import { DEFS, getPolicy, invalidatePolicy, validatePolicyValue, validatePolicySet } from '../policy.js';
import { systemCancel } from './bookings.js';
import { downtimeFanOut } from '../jobs.js';
import { DAY, HOUR } from '../time.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const ROOM_TYPES = ['study', 'seminar', 'group', 'other'];
const DUMMY_HASH = hashPassword('not-a-real-password');

export async function audit(c, op, entity, entityId, action, before, after) {
  await c.query(
    `insert into admin_audit_log (operator_id, entity, entity_id, action, before, after, at) values ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)`,
    [op?.operator_id ?? null, entity, entityId == null ? null : String(entityId), action,
      before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after), clock.now()]);
}

/* ------------------------------- authentication ------------------------------- */

export async function login(email, password) {
  const now = clock.now();
  const policy = await getPolicy();
  if (typeof email !== 'string' || typeof password !== 'string') throw bad('INVALID_CREDENTIALS', 'Email and password are required');
  return tx(async (c) => {
    const { rows: [op] } = await c.query('select * from operator where lower(email) = lower($1) for update', [email.trim()]);
    if (!op || op.status === 'revoked') {
      verifyPassword(password, DUMMY_HASH); // keep timing similar
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is wrong');
    }
    if (op.locked_until && op.locked_until > now) {
      throw new ApiError(423, 'ACCOUNT_LOCKED', 'Too many failed attempts. Try again later.', { locked_until: op.locked_until.toISOString() });
    }
    if (!verifyPassword(password, op.password_hash)) {
      const n = op.failed_attempts + 1;
      if (n >= policy.admin_max_failed_logins) {
        await c.query('update operator set failed_attempts = 0, locked_until = $2 where operator_id = $1',
          [op.operator_id, new Date(now.getTime() + policy.admin_lockout_minutes * 60000)]);
      } else {
        await c.query('update operator set failed_attempts = $2 where operator_id = $1', [op.operator_id, n]);
      }
      // commit the counter, then refuse
      return { __refuse: true };
    }
    if (op.must_change_password && op.temp_password_expires_at && op.temp_password_expires_at < now) {
      return { __expired: true };
    }
    await c.query('update operator set failed_attempts = 0, locked_until = null, last_login_at = $2 where operator_id = $1', [op.operator_id, now]);
    const scope = op.must_change_password ? 'change_password' : 'full';
    return {
      token: await signAdminToken(op, scope), must_change_password: op.must_change_password,
      operator: { operator_id: op.operator_id, email: op.email, role: op.role },
    };
  }).then((r) => {
    if (r.__refuse) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is wrong');
    if (r.__expired) throw new ApiError(401, 'TEMP_PASSWORD_EXPIRED', 'The temporary password expired. Ask a super admin to reset your account.');
    return r;
  });
}

export async function changePassword(op, current, next) {
  if (typeof current !== 'string' || typeof next !== 'string') throw bad('INVALID_PASSWORD', 'current_password and new_password are required');
  if (!verifyPassword(current, op.password_hash)) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Current password is wrong');
  if (next.length < 10) throw unprocessable('WEAK_PASSWORD', 'Use at least 10 characters');
  if (next.toLowerCase() === config.adminDefaultTempPassword.toLowerCase() || next.toLowerCase() === op.email.toLowerCase()) {
    throw unprocessable('WEAK_PASSWORD', 'Choose a password that is not the default or your email');
  }
  if (next === current) throw unprocessable('WEAK_PASSWORD', 'Choose a different password');
  return tx(async (c) => {
    const { rows: [u] } = await c.query(
      `update operator set password_hash = $2, must_change_password = false, temp_password_expires_at = null,
              status = 'active', token_version = token_version + 1, failed_attempts = 0, locked_until = null
       where operator_id = $1 returning *`, [op.operator_id, hashPassword(next)]);
    await audit(c, op, 'operator', op.operator_id, 'password_changed', null, null);
    return { token: await signAdminToken(u, 'full'), operator: { operator_id: u.operator_id, email: u.email, role: u.role } };
  });
}

/* ------------------------------- admin users ------------------------------- */

const opDto = (o) => ({ operator_id: o.operator_id, email: o.email, role: o.role, status: o.status,
  must_change_password: o.must_change_password, last_login_at: o.last_login_at, created_at: o.created_at, revoked_at: o.revoked_at });

export async function listAdmins() {
  const { rows } = await readQuery('select * from operator order by created_at');
  return { admins: rows.map(opDto) };
}

export async function inviteAdmin(op, body) {
  const email = String(body?.email || '').trim().toLowerCase();
  const role = body?.role || 'admin';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('INVALID_EMAIL', 'Enter a valid email');
  if (!['admin', 'super_admin'].includes(role)) throw bad('INVALID_ROLE', 'role must be admin or super_admin');
  const policy = await getPolicy();
  const expires = new Date(clock.now().getTime() + policy.admin_temp_password_ttl_days * DAY);
  return tx(async (c) => {
    const { rows: [ex] } = await c.query('select * from operator where lower(email) = $1', [email]);
    if (ex && ex.status !== 'revoked') throw conflict('EMAIL_EXISTS', 'That email already has admin access');
    let row;
    if (ex) {
      ({ rows: [row] } = await c.query(
        `update operator set role = $2, status = 'invited', password_hash = $3, must_change_password = true,
                temp_password_expires_at = $4, failed_attempts = 0, locked_until = null, revoked_at = null,
                token_version = token_version + 1, invited_by = $5 where operator_id = $1 returning *`,
        [ex.operator_id, role, hashPassword(config.adminDefaultTempPassword), expires, op.operator_id]));
    } else {
      ({ rows: [row] } = await c.query(
        `insert into operator (email, role, status, password_hash, must_change_password, temp_password_expires_at, invited_by)
         values ($1,$2,'invited',$3,true,$4,$5) returning *`,
        [email, role, hashPassword(config.adminDefaultTempPassword), expires, op.operator_id]));
    }
    await audit(c, op, 'operator', row.operator_id, 'invited', null, { email, role });
    return { admin: opDto(row), temporary_password_expires_at: expires.toISOString() };
  });
}

async function otherSuperAdmins(c, exceptId) {
  const { rows: [{ n }] } = await c.query(
    `select count(*)::int as n from operator where role = 'super_admin' and status <> 'revoked' and operator_id <> $1`, [exceptId]);
  return n;
}

export async function setAdminRole(op, id, role) {
  if (!UUID.test(id)) throw notFound();
  if (!['admin', 'super_admin'].includes(role)) throw bad('INVALID_ROLE', 'role must be admin or super_admin');
  return tx(async (c) => {
    const { rows: [t] } = await c.query('select * from operator where operator_id = $1 for update', [id]);
    if (!t) throw notFound();
    if (t.role === 'super_admin' && role !== 'super_admin' && (await otherSuperAdmins(c, id)) === 0) {
      throw conflict('LAST_SUPER_ADMIN', 'There must be at least one super admin');
    }
    const { rows: [u] } = await c.query('update operator set role = $2, token_version = token_version + 1 where operator_id = $1 returning *', [id, role]);
    await audit(c, op, 'operator', id, 'role_changed', { role: t.role }, { role });
    return { admin: opDto(u) };
  });
}

export async function revokeAdmin(op, id) {
  if (!UUID.test(id)) throw notFound();
  return tx(async (c) => {
    const { rows: [t] } = await c.query('select * from operator where operator_id = $1 for update', [id]);
    if (!t) throw notFound();
    if (t.operator_id === op.operator_id) throw conflict('CANNOT_REVOKE_SELF', 'You cannot revoke your own access');
    if (t.role === 'super_admin' && (await otherSuperAdmins(c, id)) === 0) throw conflict('LAST_SUPER_ADMIN', 'There must be at least one super admin');
    const { rows: [u] } = await c.query(
      `update operator set status = 'revoked', revoked_at = $2, token_version = token_version + 1 where operator_id = $1 returning *`,
      [id, clock.now()]);
    await audit(c, op, 'operator', id, 'revoked', { status: t.status }, { status: 'revoked' });
    return { admin: opDto(u) };
  });
}

/** Forgot password without email: reset to the temporary password and force a change. */
export async function resetAdmin(op, id) {
  if (!UUID.test(id)) throw notFound();
  const policy = await getPolicy();
  const expires = new Date(clock.now().getTime() + policy.admin_temp_password_ttl_days * DAY);
  return tx(async (c) => {
    const { rows: [t] } = await c.query('select * from operator where operator_id = $1 for update', [id]);
    if (!t) throw notFound();
    if (t.status === 'revoked') throw conflict('REVOKED', 'This admin was revoked. Invite them again instead.');
    const { rows: [u] } = await c.query(
      `update operator set password_hash = $2, must_change_password = true, temp_password_expires_at = $3,
              failed_attempts = 0, locked_until = null, token_version = token_version + 1 where operator_id = $1 returning *`,
      [id, hashPassword(config.adminDefaultTempPassword), expires]);
    await audit(c, op, 'operator', id, 'password_reset', null, null);
    return { admin: opDto(u), temporary_password_expires_at: expires.toISOString() };
  });
}

export async function auditLog({ entity, operator_id, limit = 100, offset = 0 } = {}) {
  const { rows } = await readQuery(
    `select l.*, o.email as operator_email from admin_audit_log l left join operator o on o.operator_id = l.operator_id
     where ($1::text is null or l.entity = $1) and ($2::uuid is null or l.operator_id = $2)
     order by l.at desc limit $3 offset $4`,
    [entity || null, operator_id && UUID.test(operator_id) ? operator_id : null, Math.min(Number(limit) || 100, 500), Number(offset) || 0]);
  return { entries: rows };
}

/* ------------------------------- buildings ------------------------------- */

function buildingFields(b, partial = false) {
  const out = {};
  if (!partial || b.name !== undefined) { if (typeof b.name !== 'string' || !b.name.trim()) throw bad('INVALID_BUILDING', 'name is required'); out.name = b.name.trim(); }
  if (b.zone !== undefined) out.zone = String(b.zone).trim();
  for (const k of ['latitude', 'longitude']) {
    if (!partial || b[k] !== undefined) {
      const n = Number(b[k]);
      const max = k === 'latitude' ? 90 : 180;
      if (!Number.isFinite(n) || Math.abs(n) > max) throw bad('INVALID_BUILDING', `${k} is not valid`);
      out[k] = n;
    }
  }
  return out;
}

export async function listBuildings() {
  const { rows } = await readQuery(
    `select b.*, (select count(*)::int from room r where r.building_id = b.building_id) as rooms from building b order by b.name`);
  return { buildings: rows };
}
export async function createBuilding(op, body) {
  const f = buildingFields(body);
  return tx(async (c) => {
    const { rows: [b] } = await c.query(
      'insert into building (name, zone, latitude, longitude) values ($1,$2,$3,$4) returning *', [f.name, f.zone ?? '', f.latitude, f.longitude]);
    await audit(c, op, 'building', b.building_id, 'created', null, b);
    return { building: b };
  });
}
export async function updateBuilding(op, id, body) {
  const f = buildingFields(body, true);
  const keys = Object.keys(f);
  if (!keys.length) throw bad('NOTHING_TO_UPDATE', 'No fields to update');
  return tx(async (c) => {
    const { rows: [before] } = await c.query('select * from building where building_id = $1 for update', [Number(id)]);
    if (!before) throw notFound();
    const { rows: [b] } = await c.query(
      `update building set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} where building_id = $1 returning *`, [before.building_id, ...keys.map((k) => f[k])]);
    await audit(c, op, 'building', b.building_id, 'updated', before, b);
    return { building: b };
  });
}

/* ------------------------------- amenities ------------------------------- */

export async function listAmenities() {
  const { rows } = await readQuery(
    `select a.*, (select count(*)::int from room_amenity ra where ra.amenity_id = a.amenity_id) as rooms from amenity a order by a.name`);
  return { amenities: rows };
}
export async function createAmenity(op, name) {
  if (typeof name !== 'string' || !name.trim()) throw bad('INVALID_AMENITY', 'name is required');
  return tx(async (c) => {
    try {
      const { rows: [a] } = await c.query('insert into amenity (name) values ($1) returning *', [name.trim()]);
      await audit(c, op, 'amenity', a.amenity_id, 'created', null, a);
      return { amenity: a };
    } catch (e) { if (e.code === '23505') throw conflict('AMENITY_EXISTS', 'That amenity already exists'); throw e; }
  });
}
export async function renameAmenity(op, id, name) {
  if (typeof name !== 'string' || !name.trim()) throw bad('INVALID_AMENITY', 'name is required');
  return tx(async (c) => {
    const { rows: [before] } = await c.query('select * from amenity where amenity_id = $1 for update', [Number(id)]);
    if (!before) throw notFound();
    try {
      const { rows: [a] } = await c.query('update amenity set name = $2 where amenity_id = $1 returning *', [before.amenity_id, name.trim()]);
      await audit(c, op, 'amenity', a.amenity_id, 'updated', before, a);
      return { amenity: a };
    } catch (e) { if (e.code === '23505') throw conflict('AMENITY_EXISTS', 'That amenity already exists'); throw e; }
  });
}
export async function deleteAmenity(op, id) {
  return tx(async (c) => {
    const { rows: [before] } = await c.query('delete from amenity where amenity_id = $1 returning *', [Number(id)]);
    if (!before) throw notFound();
    await audit(c, op, 'amenity', before.amenity_id, 'deleted', before, null);
    return { ok: true };
  });
}

/* ------------------------------- purposes ------------------------------- */

function purposeFields(b, partial) {
  const out = {};
  if (!partial || b.label !== undefined) { if (typeof b.label !== 'string' || !b.label.trim()) throw bad('INVALID_PURPOSE', 'label is required'); out.label = b.label.trim(); }
  if (b.suggested_room_types !== undefined) {
    if (!Array.isArray(b.suggested_room_types) || b.suggested_room_types.some((t) => !ROOM_TYPES.includes(t))) throw bad('INVALID_PURPOSE', 'suggested_room_types has an unknown room type');
    out.suggested_room_types = b.suggested_room_types;
  }
  if (b.sort_order !== undefined) { if (!Number.isInteger(b.sort_order)) throw bad('INVALID_PURPOSE', 'sort_order must be a whole number'); out.sort_order = b.sort_order; }
  if (b.is_active !== undefined) { if (typeof b.is_active !== 'boolean') throw bad('INVALID_PURPOSE', 'is_active must be true or false'); out.is_active = b.is_active; }
  return out;
}
export async function listPurposes({ all = false } = {}) {
  const { rows } = await readQuery(
    `select p.*, (select count(*)::int from booking b where b.purpose_id = p.purpose_id) as bookings from purpose p
     ${all ? '' : 'where p.is_active'} order by p.sort_order, p.label`);
  return { purposes: rows };
}
export async function createPurpose(op, body) {
  const f = purposeFields(body, false);
  return tx(async (c) => {
    try {
      const { rows: [p] } = await c.query(
        `insert into purpose (label, suggested_room_types, sort_order, is_active, created_by) values ($1,$2,$3,$4,$5) returning *`,
        [f.label, f.suggested_room_types ?? [], f.sort_order ?? 0, f.is_active ?? true, op.email]);
      await audit(c, op, 'purpose', p.purpose_id, 'created', null, p);
      return { purpose: p };
    } catch (e) { if (e.code === '23505') throw conflict('PURPOSE_EXISTS', 'That purpose already exists'); throw e; }
  });
}
export async function updatePurpose(op, id, body) {
  const f = purposeFields(body, true);
  const keys = Object.keys(f);
  if (!keys.length) throw bad('NOTHING_TO_UPDATE', 'No fields to update');
  return tx(async (c) => {
    const { rows: [before] } = await c.query('select * from purpose where purpose_id = $1 for update', [Number(id)]);
    if (!before) throw notFound();
    try {
      const { rows: [p] } = await c.query(
        `update purpose set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} where purpose_id = $1 returning *`, [before.purpose_id, ...keys.map((k) => f[k])]);
      await audit(c, op, 'purpose', p.purpose_id, 'updated', before, p);
      return { purpose: p };
    } catch (e) { if (e.code === '23505') throw conflict('PURPOSE_EXISTS', 'That purpose already exists'); throw e; }
  });
}
export async function deletePurpose(op, id) {
  return tx(async (c) => {
    const { rows: [used] } = await c.query('select 1 from booking where purpose_id = $1 limit 1', [Number(id)]);
    if (used) throw conflict('PURPOSE_IN_USE', 'Bookings use this purpose. Retire it instead of deleting.');
    const { rows: [before] } = await c.query('delete from purpose where purpose_id = $1 returning *', [Number(id)]);
    if (!before) throw notFound();
    await audit(c, op, 'purpose', before.purpose_id, 'deleted', before, null);
    return { ok: true };
  });
}

/* ------------------------------- rooms ------------------------------- */

const ROOM_SELECT = `
  select r.*, bl.name as building_name,
    (select coalesce(json_agg(json_build_object('amenity_id', a.amenity_id, 'name', a.name) order by a.name), '[]'::json)
       from room_amenity ra join amenity a using (amenity_id) where ra.room_id = r.room_id) as amenities,
    (select coalesce(json_agg(json_build_object('weekday', e.weekday, 'opens_at', to_char(e.opens_at, 'HH24:MI'), 'closes_at', to_char(e.closes_at, 'HH24:MI')) order by e.weekday), '[]'::json)
       from room_hours_exception e where e.room_id = r.room_id) as hours_exceptions
  from room r join building bl on bl.building_id = r.building_id`;

const fmtRoom = (r) => ({ ...r, opens_at: String(r.opens_at).slice(0, 5), closes_at: String(r.closes_at).slice(0, 5) });

export async function listRooms(q = {}) {
  const limit = Math.min(Math.max(Number(q.limit) || 25, 1), 200);
  const offset = Math.max(Number(q.offset) || 0, 0);
  const params = [];
  const where = [];
  if (q.q) { params.push(`%${String(q.q).replace(/[\\%_]/g, '\\$&')}%`); where.push(`(r.name ilike $${params.length} or r.code ilike $${params.length})`); }
  if (q.building_id) { params.push(Number(q.building_id)); where.push(`r.building_id = $${params.length}`); }
  if (q.type && ROOM_TYPES.includes(q.type)) { params.push(q.type); where.push(`r.type = $${params.length}`); }
  if (q.active === 'true' || q.active === 'false') { params.push(q.active === 'true'); where.push(`r.is_active = $${params.length}`); }
  params.push(limit, offset);
  const { rows } = await readQuery(
    `${ROOM_SELECT} ${where.length ? 'where ' + where.join(' and ') : ''} order by r.code limit $${params.length - 1} offset $${params.length}`, params);
  const { rows: [{ n }] } = await readQuery(
    `select count(*)::int as n from room r ${where.length ? 'where ' + where.join(' and ') : ''}`, params.slice(0, params.length - 2));
  return { rooms: rows.map(fmtRoom), total: n, limit, offset };
}

export async function getRoom(id) {
  if (!UUID.test(id)) throw notFound();
  const { rows } = await readQuery(`${ROOM_SELECT} where r.room_id = $1`, [id]);
  if (!rows[0]) throw notFound();
  return { room: fmtRoom(rows[0]) };
}

function roomFields(b, partial) {
  const out = {};
  const need = (k) => !partial || b[k] !== undefined;
  if (need('code')) { if (typeof b.code !== 'string' || !/^[A-Za-z0-9-]{2,20}$/.test(b.code.trim())) throw bad('INVALID_ROOM', 'code like ENG-201 is required'); out.code = b.code.trim().toUpperCase(); }
  if (need('name')) { if (typeof b.name !== 'string' || !b.name.trim()) throw bad('INVALID_ROOM', 'name is required'); out.name = b.name.trim(); }
  if (need('type')) { if (!ROOM_TYPES.includes(b.type)) throw bad('INVALID_ROOM', `type must be one of ${ROOM_TYPES.join(', ')}`); out.type = b.type; }
  if (need('capacity')) { if (!Number.isInteger(b.capacity) || b.capacity <= 0 || b.capacity > 2000) throw bad('INVALID_ROOM', 'capacity must be a whole number above 0'); out.capacity = b.capacity; }
  if (need('building_id')) { if (!Number.isInteger(b.building_id)) throw bad('INVALID_ROOM', 'building_id is required'); out.building_id = b.building_id; }
  for (const k of ['opens_at', 'closes_at']) {
    if (need(k)) {
      if (!(typeof b[k] === 'string' && (HHMM.test(b[k]) || (k === 'closes_at' && b[k] === '24:00')))) throw bad('INVALID_ROOM', `${k} must be HH:MM`);
      out[k] = b[k];
    }
  }
  if (b.is_active !== undefined) { if (typeof b.is_active !== 'boolean') throw bad('INVALID_ROOM', 'is_active must be true or false'); out.is_active = b.is_active; }
  if (out.opens_at && out.closes_at && out.opens_at >= out.closes_at) throw bad('INVALID_ROOM', 'opens_at must be before closes_at');
  return out;
}

function checkHoursList(list) {
  if (!Array.isArray(list)) throw bad('INVALID_HOURS', 'hours_exceptions must be a list');
  const seen = new Set();
  for (const e of list) {
    if (!Number.isInteger(e.weekday) || e.weekday < 1 || e.weekday > 7 || seen.has(e.weekday)) throw bad('INVALID_HOURS', 'weekday must be 1 (Mon) to 7 (Sun), once each');
    seen.add(e.weekday);
    if (!HHMM.test(e.opens_at) || !(HHMM.test(e.closes_at) || e.closes_at === '24:00') || e.opens_at >= e.closes_at) throw bad('INVALID_HOURS', 'opens_at must be before closes_at (HH:MM)');
  }
}

async function writeAmenities(c, roomId, ids) {
  await c.query('delete from room_amenity where room_id = $1', [roomId]);
  if (ids.length) {
    const { rows } = await c.query('select amenity_id from amenity where amenity_id = any($1::int[])', [ids]);
    if (rows.length !== new Set(ids).size) throw bad('UNKNOWN_AMENITY', 'An amenity id does not exist');
    await c.query('insert into room_amenity (room_id, amenity_id) select $1, unnest($2::int[]) on conflict do nothing', [roomId, ids]);
  }
}
async function writeHours(c, roomId, list) {
  await c.query('delete from room_hours_exception where room_id = $1', [roomId]);
  for (const e of list) {
    await c.query('insert into room_hours_exception (room_id, weekday, opens_at, closes_at) values ($1,$2,$3,$4)', [roomId, e.weekday, e.opens_at, e.closes_at]);
  }
}

/** Cancel the active future bookings of a room, or of a closure's scope and dates. */
async function affectedBookings(c, { roomId = null, closure = null, lock = true }) {
  const params = [clock.now(), config.tz];
  let cond = 'and $2::text is not null';
  if (roomId) { params.push(roomId); cond += ` and b.room_id = $${params.length}`; }
  if (closure) {
    params.push(closure.during);
    cond += ` and $${params.length}::daterange @> timezone($2, lower(b.during))::date`;
    if (closure.scope === 'building') { params.push(closure.building_id); cond += ` and r.building_id = $${params.length}`; }
    if (closure.scope === 'room') { params.push(closure.room_id); cond += ` and r.room_id = $${params.length}`; }
  }
  const { rows } = await c.query(
    `select b.booking_id, b.student_id, lower(b.during) as start_at, upper(b.during) as end_at,
            r.code as room_code, r.name as room_name, bl.name as building_name
     from booking b join room r on r.room_id = b.room_id join building bl on bl.building_id = r.building_id
     where b.status = 'CONFIRMED' and lower(b.during) > $1 ${cond} ${lock ? 'for update of b' : ''}`, params);
  return rows;
}

export async function createRoom(op, body) {
  const f = roomFields(body, false);
  const amenityIds = Array.isArray(body.amenity_ids) ? body.amenity_ids.map(Number) : [];
  const hours = body.hours_exceptions ?? [];
  checkHoursList(hours);
  return tx(async (c) => {
    const { rows: [bl] } = await c.query('select 1 from building where building_id = $1', [f.building_id]);
    if (!bl) throw bad('INVALID_ROOM', 'Unknown building');
    let room;
    try {
      ({ rows: [room] } = await c.query(
        `insert into room (code, building_id, name, type, capacity, opens_at, closes_at, is_active) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
        [f.code, f.building_id, f.name, f.type, f.capacity, f.opens_at, f.closes_at, f.is_active ?? true]));
    } catch (e) { if (e.code === '23505') throw conflict('CODE_EXISTS', 'A room with that code already exists'); throw e; }
    await writeAmenities(c, room.room_id, amenityIds);
    await writeHours(c, room.room_id, hours);
    await audit(c, op, 'room', room.room_id, 'created', null, { ...f, amenity_ids: amenityIds, hours_exceptions: hours });
    return { room_id: room.room_id };
  }).then(async (r) => getRoom(r.room_id));
}

export async function updateRoom(op, id, body) {
  if (!UUID.test(id)) throw notFound();
  const f = roomFields(body, true);
  const hasAmenities = Array.isArray(body.amenity_ids);
  const hasHours = body.hours_exceptions !== undefined;
  if (hasHours) checkHoursList(body.hours_exceptions);
  if (!Object.keys(f).length && !hasAmenities && !hasHours) throw bad('NOTHING_TO_UPDATE', 'No fields to update');
  let cancelled = 0;
  await tx(async (c) => {
    const { rows: [before] } = await c.query('select * from room where room_id = $1 for update', [id]);
    if (!before) throw notFound();
    const merged = { ...before, ...f };
    if (merged.opens_at >= merged.closes_at) throw bad('INVALID_ROOM', 'opens_at must be before closes_at');
    const keys = Object.keys(f);
    if (keys.length) {
      try {
        await c.query(`update room set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} where room_id = $1`, [id, ...keys.map((k) => f[k])]);
      } catch (e) { if (e.code === '23505') throw conflict('CODE_EXISTS', 'A room with that code already exists'); if (e.code === '23503') throw bad('INVALID_ROOM', 'Unknown building'); throw e; }
    }
    if (hasAmenities) await writeAmenities(c, id, body.amenity_ids.map(Number));
    if (hasHours) await writeHours(c, id, body.hours_exceptions);
    if (before.is_active && f.is_active === false) {
      cancelled = await systemCancel(c, await affectedBookings(c, { roomId: id }), 'ROOM_UNAVAILABLE', 'room unavailable', clock.now());
    }
    await audit(c, op, 'room', id, f.is_active === false && before.is_active ? 'deactivated' : 'updated', before, { ...f, bookings_cancelled: cancelled });
  });
  return { ...(await getRoom(id)), bookings_cancelled: cancelled };
}

/** Preview before deactivating: "N active bookings will be cancelled". */
export async function roomDeactivationPreview(id) {
  if (!UUID.test(id)) throw notFound();
  return tx(async (c) => {
    const rows = await affectedBookings(c, { roomId: id, lock: false });
    return { bookings_affected: rows.length, students_affected: new Set(rows.map((r) => r.student_id)).size };
  });
}

/** Bulk import: upsert rooms by code. Per-row errors do not stop the rest. */
export async function importRooms(op, list) {
  if (!Array.isArray(list) || !list.length) throw bad('INVALID_IMPORT', 'Send a non-empty list of rooms');
  if (list.length > 5000) throw bad('INVALID_IMPORT', 'Import at most 5,000 rows at a time');
  const res = { created: 0, updated: 0, bookings_cancelled: 0, errors: [] };
  await tx(async (c) => {
    const { rows: blds } = await c.query('select building_id, lower(name) as n from building');
    const bmap = new Map(blds.map((b) => [b.n, b.building_id]));
    const { rows: ams } = await c.query('select amenity_id, lower(name) as n from amenity');
    const amap = new Map(ams.map((a) => [a.n, a.amenity_id]));
    for (let i = 0; i < list.length; i++) {
      const row = list[i];
      await c.query('savepoint s');
      try {
        const bid = Number.isInteger(row.building_id) ? row.building_id : bmap.get(String(row.building || '').trim().toLowerCase());
        if (!bid) throw bad('INVALID_ROOM', 'Unknown building');
        const f = roomFields({ ...row, building_id: bid, capacity: Number(row.capacity) }, false);
        const names = Array.isArray(row.amenities) ? row.amenities : [];
        const ids = [];
        for (const nm of names) {
          const key = String(nm).trim().toLowerCase();
          if (!key) continue;
          let id = amap.get(key);
          if (!id) {
            const { rows: [a] } = await c.query('insert into amenity (name) values ($1) returning amenity_id', [String(nm).trim()]);
            id = a.amenity_id; amap.set(key, id);
          }
          ids.push(id);
        }
        const { rows: [ex] } = await c.query('select * from room where code = $1 for update', [f.code]);
        let roomId;
        if (ex) {
          const keys = Object.keys(f);
          await c.query(`update room set ${keys.map((k, j) => `${k} = $${j + 2}`).join(', ')} where room_id = $1`, [ex.room_id, ...keys.map((k) => f[k])]);
          roomId = ex.room_id; res.updated++;
          if (ex.is_active && f.is_active === false) {
            res.bookings_cancelled += await systemCancel(c, await affectedBookings(c, { roomId }), 'ROOM_UNAVAILABLE', 'room unavailable', clock.now());
          }
        } else {
          const { rows: [r] } = await c.query(
            `insert into room (code, building_id, name, type, capacity, opens_at, closes_at, is_active) values ($1,$2,$3,$4,$5,$6,$7,$8) returning room_id`,
            [f.code, f.building_id, f.name, f.type, f.capacity, f.opens_at, f.closes_at, f.is_active ?? true]);
          roomId = r.room_id; res.created++;
        }
        if (Array.isArray(row.amenities)) await writeAmenities(c, roomId, ids);
        await c.query('release savepoint s');
      } catch (e) {
        await c.query('rollback to savepoint s');
        res.errors.push({ row: i + 1, code: row?.code ?? null, message: e instanceof ApiError ? e.message : (e.code === '23505' ? 'Duplicate' : 'Could not import this row') });
      }
    }
    await audit(c, op, 'room', null, 'imported', null, { created: res.created, updated: res.updated, errors: res.errors.length });
  });
  return res;
}

/* ------------------------------- closures ------------------------------- */

function closureInput(b) {
  const scope = b?.scope;
  if (!['campus', 'building', 'room'].includes(scope)) throw bad('INVALID_CLOSURE', 'scope must be campus, building or room');
  const d = (s) => (/^\d{4}-\d\d-\d\d$/.test(s || '') && !Number.isNaN(Date.parse(s)) ? s : null);
  const first = d(b.first_date); const last = d(b.last_date || b.first_date);
  if (!first || !last || last < first) throw bad('INVALID_CLOSURE', 'Give first_date and last_date (YYYY-MM-DD), last not before first');
  const lastExcl = new Date(Date.parse(last) + DAY).toISOString().slice(0, 10);
  const out = { scope, building_id: null, room_id: null, during: `[${first},${lastExcl})`, first, last, reason: String(b.reason || '').trim() };
  if (scope === 'building') { if (!Number.isInteger(b.building_id)) throw bad('INVALID_CLOSURE', 'building_id is required'); out.building_id = b.building_id; }
  if (scope === 'room') { if (!UUID.test(String(b.room_id || ''))) throw bad('INVALID_CLOSURE', 'room_id is required'); out.room_id = b.room_id; }
  return out;
}

export async function listClosures() {
  const { rows } = await readQuery(
    `select c.closure_id, c.scope, c.building_id, c.room_id, c.reason, c.created_by, c.created_at,
            lower(c.during)::text as first_date, (upper(c.during) - 1)::text as last_date,
            bl.name as building_name, r.code as room_code
     from closure c left join building bl on bl.building_id = c.building_id left join room r on r.room_id = c.room_id
     order by lower(c.during) desc, c.created_at desc`);
  return { closures: rows };
}

export async function closurePreview(b) {
  const cl = closureInput(b);
  return tx(async (c) => {
    const rows = await affectedBookings(c, { closure: cl, lock: false });
    return { bookings_affected: rows.length, students_affected: new Set(rows.map((r) => r.student_id)).size };
  });
}

export async function createClosure(op, b) {
  const cl = closureInput(b);
  return tx(async (c) => {
    if (cl.building_id) { const { rows } = await c.query('select 1 from building where building_id = $1', [cl.building_id]); if (!rows[0]) throw bad('INVALID_CLOSURE', 'Unknown building'); }
    if (cl.room_id) { const { rows } = await c.query('select 1 from room where room_id = $1', [cl.room_id]); if (!rows[0]) throw bad('INVALID_CLOSURE', 'Unknown room'); }
    const { rows: [row] } = await c.query(
      `insert into closure (scope, building_id, room_id, during, reason, created_by) values ($1,$2,$3,$4::daterange,$5,$6) returning closure_id`,
      [cl.scope, cl.building_id, cl.room_id, cl.during, cl.reason, op.email]);
    const cancelled = await systemCancel(c, await affectedBookings(c, { closure: cl }), 'CLOSED_DAY', cl.reason || 'closed day', clock.now());
    await audit(c, op, 'closure', row.closure_id, 'created', null, { ...cl, bookings_cancelled: cancelled });
    return { closure_id: row.closure_id, bookings_cancelled: cancelled };
  });
}

export async function deleteClosure(op, id) {
  if (!UUID.test(id)) throw notFound();
  return tx(async (c) => {
    const { rows: [b] } = await c.query('delete from closure where closure_id = $1 returning *', [id]);
    if (!b) throw notFound();
    await audit(c, op, 'closure', id, 'deleted', { scope: b.scope, during: b.during }, null);
    return { ok: true };
  });
}

/* ------------------------------- announcements ------------------------------- */

export async function listAnnouncementsAdmin() {
  const { rows } = await readQuery('select * from announcement order by starts_at desc limit 200');
  return { announcements: rows };
}

export async function createAnnouncement(op, b) {
  const starts = new Date(b?.starts_at); const ends = new Date(b?.ends_at);
  if (Number.isNaN(starts.getTime()) || Number.isNaN(ends.getTime()) || ends <= starts) throw bad('INVALID_ANNOUNCEMENT', 'Give starts_at and a later ends_at');
  if (typeof b.message !== 'string' || !b.message.trim()) throw bad('INVALID_ANNOUNCEMENT', 'message is required');
  const now = clock.now();
  // quality target: planned downtime is announced at least 24 hours ahead
  if (starts.getTime() - now.getTime() < 24 * HOUR) throw unprocessable('TOO_LATE', 'Planned downtime must be announced at least 24 hours ahead');
  const notifyAt = b.notify_at ? new Date(b.notify_at) : now;
  if (Number.isNaN(notifyAt.getTime()) || notifyAt >= starts) throw bad('INVALID_ANNOUNCEMENT', 'notify_at must be before starts_at');
  const row = await tx(async (c) => {
    const { rows: [a] } = await c.query(
      `insert into announcement (starts_at, ends_at, message, notify_at, created_by) values ($1,$2,$3,$4,$5) returning *`,
      [starts, ends, b.message.trim(), notifyAt, op.email]);
    await audit(c, op, 'announcement', a.announcement_id, 'created', null, a);
    return a;
  });
  if (notifyAt <= now) await downtimeFanOut(now, row.announcement_id);
  return { announcement: row };
}

export async function deleteAnnouncement(op, id) {
  if (!UUID.test(id)) throw notFound();
  return tx(async (c) => {
    const { rows: [a] } = await c.query('delete from announcement where announcement_id = $1 returning *', [id]);
    if (!a) throw notFound();
    await audit(c, op, 'announcement', id, 'deleted', a, null);
    return { ok: true };
  });
}

/* ------------------------------- policy ------------------------------- */

export async function listPolicy() {
  const values = await getPolicy();
  return {
    policy: Object.entries(DEFS).map(([key, d]) => ({ key, value: values[key], default: d.default, note: d.note, type: d.type })),
  };
}

export async function updatePolicy(op, body) {
  const values = body?.values;
  if (!values || typeof values !== 'object' || !Object.keys(values).length) throw bad('INVALID_POLICY_VALUE', 'Send { values: { key: value } }');
  for (const [k, v] of Object.entries(values)) validatePolicyValue(k, v);
  const current = await getPolicy();
  validatePolicySet({ ...current, ...values });
  await tx(async (c) => {
    for (const [k, v] of Object.entries(values)) {
      await c.query(
        `insert into policy (key, value, updated_at) values ($1,$2::jsonb,$3) on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`,
        [k, JSON.stringify(v), clock.now()]);
    }
    await audit(c, op, 'policy', null, 'updated', Object.fromEntries(Object.keys(values).map((k) => [k, current[k]])), values);
  });
  invalidatePolicy();
  return listPolicy();
}

export { forbidden };
