// Seed data: policy defaults, buildings, amenities, purposes, rooms, bootstrap super admin.
import { config } from './config.js';
import { seedPolicyDefaults } from './policy.js';
import { hashPassword } from './auth.js';
import { DAY } from './time.js';
import { clock } from './clock.js';

export const BUILDINGS = [
  ['ENG', 'Engineering', 'North', 6.5185, 3.3980],
  ['LIB', 'Central Library', 'Central', 6.5160, 3.3995],
  ['SCI', 'Science Building', 'North', 6.5200, 3.3960],
  ['ART', 'Arts Building', 'South', 6.5120, 3.4010],
  ['BUS', 'Business School', 'East', 6.5170, 3.4050],
  ['LAW', 'Law Faculty', 'East', 6.5150, 3.4070],
  ['MED', 'Medical Sciences', 'West', 6.5210, 3.3900],
  ['STU', 'Student Centre', 'Central', 6.5165, 3.4000],
  ['ARC', 'Architecture', 'South', 6.5110, 3.4030],
  ['EDU', 'Education Block', 'West', 6.5190, 3.3920],
];
export const AMENITIES = ['Whiteboard', 'Projector', 'Power sockets', 'Step-free access', 'Quiet zone'];
export const PURPOSES = [
  ['Group project discussion', ['group', 'other'], 1],
  ['Study session', ['study', 'group', 'other'], 2],
  ['Quiet study', ['study'], 3],
  ['Seminar or presentation', ['seminar', 'group'], 4],
  ['Tutoring', ['study', 'group', 'other'], 5],
  ['Something else', [], 6],
];

// tiny deterministic generator so seeds are repeatable
function rng(seed) { let s = seed; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; }

export async function seedCatalog(c, { rooms = 300, withAdmin = true } = {}) {
  await seedPolicyDefaults(c);
  const bIds = {};
  for (const [code, name, zone, lat, lon] of BUILDINGS) {
    const { rows: [b] } = await c.query(
      'insert into building (name, zone, latitude, longitude) values ($1,$2,$3,$4) returning building_id', [name, zone, lat, lon]);
    bIds[code] = b.building_id;
  }
  const aIds = {};
  for (const n of AMENITIES) {
    const { rows: [a] } = await c.query('insert into amenity (name) values ($1) returning amenity_id', [n]);
    aIds[n] = a.amenity_id;
  }
  for (const [label, types, order] of PURPOSES) {
    await c.query('insert into purpose (label, suggested_room_types, sort_order, created_by) values ($1,$2,$3,$4)', [label, types, order, 'seed']);
  }

  const mk = async (code, bcode, type, capacity, amen, name) => {
    const { rows: [r] } = await c.query(
      `insert into room (code, building_id, name, type, capacity, opens_at, closes_at) values ($1,$2,$3,$4,$5,'08:00','22:00') returning room_id`,
      [code, bIds[bcode], name, type, capacity]);
    for (const a of amen) await c.query('insert into room_amenity (room_id, amenity_id) values ($1,$2)', [r.room_id, aIds[a]]);
  };
  // the rooms shown in the designs
  await mk('ENG-201', 'ENG', 'group', 8, ['Whiteboard', 'Projector'], 'Engineering 201');
  await mk('LIB-104', 'LIB', 'study', 4, ['Whiteboard', 'Quiet zone'], 'Library 104');
  await mk('SCI-302', 'SCI', 'seminar', 12, ['Projector', 'Step-free access'], 'Science 302');
  await mk('ART-106', 'ART', 'study', 6, ['Whiteboard', 'Step-free access'], 'Arts 106');
  const used = new Set(['ENG-201', 'LIB-104', 'SCI-302', 'ART-106']);
  const rand = rng(42);
  let made = 4;
  let i = 0;
  while (made < rooms) {
    // deterministic, collision-free codes: building cycles fastest, then room number, then floor
    const [bcode] = BUILDINGS[i % BUILDINGS.length];
    const idx = Math.floor(i / BUILDINGS.length);
    const floor = 1 + Math.floor(idx / 99) % 9;
    const num = 1 + (idx % 99);
    const code = `${bcode}-${floor}${String(num).padStart(2, '0')}`;
    i++;
    if (used.has(code)) continue;
    used.add(code);
    const t = rand();
    const type = t < 0.45 ? 'study' : t < 0.75 ? 'group' : t < 0.92 ? 'seminar' : 'other';
    const capacity = type === 'study' ? 2 + Math.floor(rand() * 5) : type === 'group' ? 4 + Math.floor(rand() * 9) : type === 'seminar' ? 12 + Math.floor(rand() * 29) : 3 + Math.floor(rand() * 8);
    const amen = AMENITIES.filter(() => rand() < 0.4);
    await mk(code, bcode, type, capacity, amen, `${BUILDINGS.find((b) => b[0] === bcode)[1]} ${floor}${String(num).padStart(2, '0')}`);
    made++;
  }

  if (withAdmin) {
    // bootstrap super admin: temporary password, must change at first login
    await c.query(
      `insert into operator (email, role, status, password_hash, must_change_password, temp_password_expires_at)
       values ($1,'super_admin','invited',$2,true,$3) on conflict (email) do nothing`,
      [config.bootstrapSuperAdmin.toLowerCase(), hashPassword(config.adminDefaultTempPassword), new Date(clock.now().getTime() + 7 * DAY)]);
  }
}
