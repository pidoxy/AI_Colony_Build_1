import { admin, pub, tokens, ApiError } from './api.js';
import * as T from './time.js';
import { html, out, icons, logo, modal, initials } from './ui.js';

const $app = document.getElementById('app');
const S = { cfg: null, me: null, flash: null, amenities: [], buildings: [] };
const WD = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const TYPES = [['study', 'Study'], ['group', 'Group'], ['seminar', 'Seminar'], ['other', 'Other']];
const SECTIONS = [
  ['rooms', 'Rooms', 'Catalogue'], ['buildings', 'Buildings', ''], ['amenities', 'Amenities', ''], ['purposes', 'Purposes', ''],
  ['closures', 'Closed days', 'Calendar'], ['announcements', 'Announcements', ''],
  ['policy', 'Policy', 'System'], ['users', 'Admin users', ''], ['audit', 'Audit log', ''],
];

const hash = () => location.hash.replace(/^#\/?/, '') || 'rooms';
const go = (h) => { location.hash = h; };
const friendly = (e) => (e?.status === 0 ? 'No connection.' : e?.status === 503 ? 'Service unavailable. Try again in a few minutes.' : e?.message || 'Something went wrong.');
const fmtDt = (iso) => (iso ? `${T.dateStr(new Date(iso))} ${T.timeStr(new Date(iso))}` : '');
const flash = (kind, text) => { S.flash = { kind, text }; };

/* ------------------------------ shell ------------------------------ */
function layout(active, inner, title, sub, tools = '') {
  const isSuper = S.me.role === 'super_admin';
  const side = []; let lastGrp = null;
  for (const [id, label, grp] of SECTIONS) {
    if (id === 'users' && !isSuper) continue;
    if (grp && grp !== lastGrp) { side.push(html`<div class="grp">${grp}</div>`); lastGrp = grp; }
    side.push(html`<a href="#/${id}" class="${id === active ? 'active' : ''}">${label}</a>`);
  }
  const f = S.flash; S.flash = null;
  $app.innerHTML = out(html`<header class="nav"><div class="wrap" style="max-width:none;padding:0 32px">
      ${logo('/admin.html')}<span class="pill">Admin</span>
      <div class="nav-right"><span class="loc">${S.me.email} · ${S.me.role === 'super_admin' ? 'Super admin' : 'Admin'}</span><button class="btn btn-outline btn-sm" data-act="signout">Sign out</button></div></div></header>
    <div class="adm"><nav class="adm-side" aria-label="Admin sections">${side}</nav>
    <main class="adm-main" id="page">
      ${f ? html`<div class="banner ${f.kind === 'ok' ? '' : 'warn'}" style="margin:0 0 20px" role="status">${icons.check}<div class="grow">${f.text}</div></div>` : ''}
      <div class="adm-head"><div><h1>${title}</h1><p class="muted" style="margin:0">${sub}</p></div><div>${tools}</div></div>${inner}</main></div>`);
}
const loading = (active, title) => layout(active, html`<div class="skeleton"></div><div class="skeleton"></div>`, title, 'Loading…');

function table(cols, rows, empty = 'Nothing here yet.') {
  if (!rows.length) return html`<div class="empty" style="padding:48px 0"><p class="muted">${empty}</p></div>`;
  return html`<div class="tbl-wrap"><table class="tbl"><thead><tr>${cols.map((c) => html`<th class="${c.cls || ''}">${c.h}</th>`)}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

/* ------------------------------ auth ------------------------------ */
function pageLogin(err = '') {
  $app.innerHTML = out(html`<header class="nav"><div class="wrap">${logo('/admin.html')}<span class="pill" style="margin-left:-20px">Admin</span></div></header>
    <main><div class="wrap"><div class="card"><div class="eyebrow">Campus Rooms admin</div><h1 class="h2">Sign in.</h1>
      <p class="muted">Use the email your super admin gave access to. First time? Your temporary password is the default one, and you’ll set your own next.</p>
      <form id="lf" novalidate><div class="field"><label for="em">Email</label><input id="em" class="inp" type="email" autocomplete="username" required></div>
      <div class="field"><label for="pw">Password</label><input id="pw" class="inp" type="password" autocomplete="current-password" required></div>
      <div class="errtxt" id="err" role="alert">${err}</div><button class="btn btn-primary btn-block" style="margin-top:16px" type="submit">Sign in ${icons.arrow}</button></form></div></div></main>`);
  document.getElementById('lf').addEventListener('submit', async (ev) => {
    ev.preventDefault(); const e = document.getElementById('err'); e.textContent = '';
    try {
      const r = await admin.post('/admin/login', { email: document.getElementById('em').value, password: document.getElementById('pw').value });
      tokens.set('admin', r.token, false);
      S.tempPw = document.getElementById('pw').value;
      if (r.must_change_password) return pageChangePassword(r.operator.email);
      await boot();
    } catch (x) { e.textContent = x.code === 'ACCOUNT_LOCKED' ? `Too many failed attempts. Try again at ${fmtDt(x.data.locked_until)}.` : friendly(x); }
  });
}

function pageChangePassword(email, err = '') {
  $app.innerHTML = out(html`<header class="nav"><div class="wrap">${logo('/admin.html')}<span class="pill" style="margin-left:-20px">Admin</span></div></header>
    <main><div class="wrap"><div class="card"><div class="eyebrow amber">First sign-in</div><h1 class="h2">Set your own password.</h1>
      <p class="muted">${email}, the temporary password only lets you do this. Use at least 10 characters, and not the default password or your email.</p>
      <form id="cf" novalidate><div class="field"><label for="cur">Temporary password</label><input id="cur" class="inp" type="password" autocomplete="current-password" value="${S.tempPw || ''}"></div>
      <div class="field"><label for="n1">New password</label><input id="n1" class="inp" type="password" autocomplete="new-password" minlength="10"></div>
      <div class="field"><label for="n2">Repeat new password</label><input id="n2" class="inp" type="password" autocomplete="new-password"></div>
      <div class="errtxt" id="err" role="alert">${err}</div><button class="btn btn-primary btn-block" style="margin-top:16px" type="submit">Save password ${icons.arrow}</button></form></div></div></main>`);
  document.getElementById('cf').addEventListener('submit', async (ev) => {
    ev.preventDefault(); const e = document.getElementById('err'); e.textContent = '';
    const n1 = document.getElementById('n1').value;
    if (n1 !== document.getElementById('n2').value) { e.textContent = 'The two passwords don’t match.'; return; }
    try {
      const r = await admin.post('/admin/password/change', { current_password: document.getElementById('cur').value, new_password: n1 });
      tokens.set('admin', r.token, false); S.tempPw = null;
      flash('ok', 'Password saved. You’re signed in.');
      await boot();
    } catch (x) { e.textContent = x.code === 'UNAUTHENTICATED' ? 'Your session expired. Sign in again.' : friendly(x); }
  });
}
function signOut() { tokens.clear('admin'); S.me = null; pageLogin(); }

/* ------------------------------ data ------------------------------ */
async function loadRef() {
  const [a, b] = await Promise.all([admin.get('/admin/amenities'), admin.get('/admin/buildings')]);
  S.amenities = a.amenities; S.buildings = b.buildings;
}

/* ------------------------------ rooms ------------------------------ */
const R = { q: '', building: '', type: '', active: '', offset: 0, limit: 25 };
async function pageRooms() {
  loading('rooms', 'Rooms'); await loadRef();
  const d = await admin.get('/admin/rooms', { q: R.q, building_id: R.building, type: R.type, active: R.active, limit: R.limit, offset: R.offset });
  const rows = d.rooms.map((r) => html`<tr><td><b>${r.code}</b></td><td>${r.name}</td><td>${r.building_name}</td><td>${r.type}</td><td class="num">${r.capacity}</td>
    <td>${r.opens_at}–${r.closes_at}${r.hours_exceptions.length ? html` <span class="pill warn">${r.hours_exceptions.length} exception${r.hours_exceptions.length > 1 ? 's' : ''}</span>` : ''}</td>
    <td>${r.amenities.map((a) => a.name).join(', ') || html`<span class="muted">none</span>`}</td>
    <td><span class="pill ${r.is_active ? 'ok' : 'off'}">${r.is_active ? 'Active' : 'Inactive'}</span></td><td class="act"><button class="btn btn-outline btn-sm" data-act="room-edit" data-id="${r.room_id}">Edit</button></td></tr>`);
  const tools = html`<button class="btn btn-outline" data-act="room-import">Import CSV</button> <button class="btn btn-primary" data-act="room-new">Add room ${icons.arrow}</button>`;
  layout('rooms', html`<div class="adm-tools"><input class="inp" id="rq" placeholder="Search name or code" value="${R.q}">
      <select class="sel" id="rb"><option value="">All buildings</option>${S.buildings.map((b) => html`<option value="${b.building_id}" ${String(R.building) === String(b.building_id) ? 'selected' : ''}>${b.name}</option>`)}</select>
      <select class="sel" id="rt"><option value="">Any type</option>${TYPES.map(([v, l]) => html`<option value="${v}" ${R.type === v ? 'selected' : ''}>${l}</option>`)}</select>
      <select class="sel" id="ra"><option value="">Active and inactive</option><option value="true" ${R.active === 'true' ? 'selected' : ''}>Active</option><option value="false" ${R.active === 'false' ? 'selected' : ''}>Inactive</option></select></div>
    ${table([{ h: 'Code' }, { h: 'Name' }, { h: 'Building' }, { h: 'Type' }, { h: 'Seats', cls: 'num' }, { h: 'Hours' }, { h: 'Amenities' }, { h: 'Status' }, { h: '', cls: 'act' }], rows, 'No rooms match.')}
    <div class="more-row"><span>Showing ${R.offset + 1}–${Math.min(R.offset + R.limit, d.total)} of ${d.total}</span><span>${R.offset > 0 ? html`<button class="link" data-act="rooms-prev">← Previous</button>` : ''} ${R.offset + R.limit < d.total ? html`<button class="link" data-act="rooms-next" style="margin-left:16px">Next →</button>` : ''}</span></div>`,
  'Rooms', `${d.total} rooms. Edit hours, equipment and availability. Changes apply to search at once.`, tools);
  const qEl = document.getElementById('rq');
  qEl.addEventListener('change', () => { R.q = qEl.value.trim(); R.offset = 0; pageRooms(); });
  for (const [id, k] of [['rb', 'building'], ['rt', 'type'], ['ra', 'active']]) document.getElementById(id).addEventListener('change', (e) => { R[k] = e.target.value; R.offset = 0; pageRooms(); });
}

async function roomForm(existing) {
  await loadRef();
  const r = existing || { code: '', name: '', building_id: S.buildings[0]?.building_id, type: 'study', capacity: 4, opens_at: '08:00', closes_at: '22:00', is_active: true, amenities: [], hours_exceptions: [] };
  const have = new Set(r.amenities.map((a) => a.amenity_id));
  const ex = new Map(r.hours_exceptions.map((e) => [e.weekday, e]));
  const m = modal(html`<h2>${existing ? `Edit ${r.code}` : 'Add a room'}</h2>
    <form id="rf" novalidate><div class="form-grid">
      <div class="field"><label for="f-code">Code</label><input id="f-code" class="inp" value="${r.code}" placeholder="ENG-201" ${existing ? '' : ''}></div>
      <div class="field"><label for="f-name">Name</label><input id="f-name" class="inp" value="${r.name}"></div>
      <div class="field"><label for="f-b">Building</label><select id="f-b" class="sel">${S.buildings.map((b) => html`<option value="${b.building_id}" ${b.building_id === r.building_id ? 'selected' : ''}>${b.name}</option>`)}</select></div>
      <div class="field"><label for="f-t">Type</label><select id="f-t" class="sel">${TYPES.map(([v, l]) => html`<option value="${v}" ${r.type === v ? 'selected' : ''}>${l}</option>`)}</select></div>
      <div class="field"><label for="f-c">Capacity</label><input id="f-c" class="inp" type="number" min="1" value="${r.capacity}"></div>
      <div class="field"><label for="f-a">Status</label><select id="f-a" class="sel"><option value="true" ${r.is_active ? 'selected' : ''}>Active</option><option value="false" ${!r.is_active ? 'selected' : ''}>Inactive</option></select></div>
      <div class="field"><label for="f-o">Opens</label><input id="f-o" class="inp" type="time" value="${r.opens_at}"></div>
      <div class="field"><label for="f-cl">Closes</label><input id="f-cl" class="inp" type="time" value="${r.closes_at === '24:00' ? '23:59' : r.closes_at}"></div>
      <div class="field full"><label>Amenities</label><div style="display:flex;gap:6px 18px;flex-wrap:wrap">${S.amenities.map((a) => html`<label class="check"><input type="checkbox" name="am" value="${a.amenity_id}" ${have.has(a.amenity_id) ? 'checked' : ''}> ${a.name}</label>`)}</div></div>
      <div class="field full"><label>Different hours on some days <span class="muted" style="font-weight:400">(tick a day to override the default)</span></label>
        <div class="hours-grid">${WD.map((d, i) => { const e = ex.get(i + 1); return html`<span>${d}</span><input type="checkbox" name="hx" value="${i + 1}" ${e ? 'checked' : ''} aria-label="Override ${d}"><input class="inp" type="time" name="ho${i + 1}" value="${e?.opens_at || r.opens_at}"><input class="inp" type="time" name="hc${i + 1}" value="${e?.closes_at || r.closes_at}">`; })}</div></div></div>
      <div id="dv"></div><div class="errtxt" id="m-err" role="alert"></div>
      <div class="row" style="margin-top:20px"><button class="btn btn-outline" type="button" data-m="close">Cancel</button><button class="btn btn-primary" type="submit">${existing ? 'Save changes' : 'Add room'}</button></div></form>`, {});
  m.el.parentElement.querySelector('.modal').classList.add('wide');
  const f = m.el;
  const err = f.querySelector('#m-err');
  f.addEventListener('click', (e) => { if (e.target.dataset.m === 'close') m.close(); });
  let confirmed = false;
  f.querySelector('#rf').addEventListener('submit', async (ev) => {
    ev.preventDefault(); err.textContent = '';
    const v = (id) => f.querySelector(id).value;
    const hx = [...f.querySelectorAll('[name=hx]:checked')].map((c) => ({ weekday: Number(c.value), opens_at: v(`[name=ho${c.value}]`), closes_at: v(`[name=hc${c.value}]`) }));
    const body = { code: v('#f-code'), name: v('#f-name'), building_id: Number(v('#f-b')), type: v('#f-t'), capacity: Number(v('#f-c')), opens_at: v('#f-o'), closes_at: v('#f-cl'), is_active: v('#f-a') === 'true',
      amenity_ids: [...f.querySelectorAll('[name=am]:checked')].map((c) => Number(c.value)), hours_exceptions: hx };
    try {
      if (existing && r.is_active && !body.is_active && !confirmed) {
        const pv = await admin.get(`/admin/rooms/${r.room_id}/deactivation-preview`);
        f.querySelector('#dv').innerHTML = out(html`<div class="callout"><b>${pv.bookings_affected} active booking${pv.bookings_affected === 1 ? '' : 's'} will be cancelled and ${pv.students_affected} student${pv.students_affected === 1 ? '' : 's'} notified.</b><br>Cancelled by the system with the reason “room unavailable”. Press Save again to confirm.</div>`);
        confirmed = true; return;
      }
      const res = existing ? await admin.patch(`/admin/rooms/${r.room_id}`, body) : await admin.post('/admin/rooms', body);
      m.close();
      flash('ok', existing ? `Saved ${body.code}.${res.bookings_cancelled ? ` ${res.bookings_cancelled} booking${res.bookings_cancelled === 1 ? '' : 's'} cancelled and students notified.` : ''}` : `Added ${body.code}.`);
      pageRooms();
    } catch (x) { err.textContent = x.message; }
  });
}

function csvRows(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}
function importModal() {
  const m = modal(html`<h2>Import rooms</h2><p class="muted">CSV with a header row. Rooms are matched by code: existing ones are updated, new ones are added.</p>
    <div class="box"><div class="small kvs">Columns: <code class="k">code</code> <code class="k">name</code> <code class="k">building</code> <code class="k">type</code> <code class="k">capacity</code> <code class="k">opens_at</code> <code class="k">closes_at</code> <code class="k">amenities</code> (separate with ;) <code class="k">is_active</code> (true/false, optional)</div></div>
    <div class="field"><input type="file" id="csv" accept=".csv,text/csv"></div><div id="ir"></div><div class="errtxt" id="m-err" role="alert"></div>
    <div class="row"><button class="btn btn-outline" data-m="close">Close</button><button class="btn btn-primary" data-m="go" disabled>Import</button></div>`);
  let rooms = null; const go_ = m.el.querySelector('[data-m=go]'); const err = m.el.querySelector('#m-err');
  m.el.querySelector('#csv').addEventListener('change', async (e) => {
    err.textContent = ''; const file = e.target.files[0]; if (!file) return;
    const rs = csvRows(await file.text()); const head = rs.shift()?.map((h) => h.trim().toLowerCase()) || [];
    if (!['code', 'name', 'building', 'type', 'capacity', 'opens_at', 'closes_at'].every((c) => head.includes(c))) { err.textContent = 'The header row needs code, name, building, type, capacity, opens_at and closes_at.'; return; }
    rooms = rs.map((r) => { const o = Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()])); o.capacity = Number(o.capacity); o.amenities = o.amenities ? o.amenities.split(';').map((x) => x.trim()).filter(Boolean) : []; if (o.is_active !== undefined && o.is_active !== '') o.is_active = o.is_active !== 'false'; else delete o.is_active; return o; });
    m.el.querySelector('#ir').innerHTML = `<div class="callout ok">${rooms.length} row${rooms.length === 1 ? '' : 's'} ready.</div>`; go_.disabled = false;
  });
  m.el.addEventListener('click', async (e) => {
    if (e.target.dataset.m === 'close') return m.close();
    if (e.target.dataset.m !== 'go' || !rooms) return;
    go_.disabled = true;
    try {
      const r = await admin.post('/admin/rooms/import', { rooms });
      m.el.querySelector('#ir').innerHTML = out(html`<div class="callout ${r.errors.length ? '' : 'ok'}"><b>${r.created} added, ${r.updated} updated${r.bookings_cancelled ? `, ${r.bookings_cancelled} bookings cancelled` : ''}.</b>${r.errors.length ? html`<br>${r.errors.length} row${r.errors.length === 1 ? '' : 's'} skipped:<ul style="margin:6px 0 0;padding-left:18px">${r.errors.slice(0, 20).map((x) => html`<li>Row ${x.row}${x.code ? ` (${x.code})` : ''}: ${x.message}</li>`)}</ul>` : ''}</div>`);
      e.target.textContent = 'Done'; e.target.dataset.m = 'close'; e.target.disabled = false; pageRooms();
    } catch (x) { err.textContent = x.message; go_.disabled = false; }
  });
}

/* ------------------------------ buildings ------------------------------ */
async function pageBuildings() {
  loading('buildings', 'Buildings');
  const { buildings } = await admin.get('/admin/buildings');
  S.buildings = buildings;
  const rows = buildings.map((b) => html`<tr><td><b>${b.name}</b></td><td>${b.zone}</td><td class="num">${b.latitude}</td><td class="num">${b.longitude}</td><td class="num">${b.rooms}</td><td class="act"><button class="btn btn-outline btn-sm" data-act="b-edit" data-id="${b.building_id}">Edit</button></td></tr>`);
  layout('buildings', table([{ h: 'Name' }, { h: 'Zone' }, { h: 'Latitude', cls: 'num' }, { h: 'Longitude', cls: 'num' }, { h: 'Rooms', cls: 'num' }, { h: '', cls: 'act' }], rows),
    'Buildings', 'Coordinates drive the “nearest first” search. They are a fixed table, not live GPS.', html`<button class="btn btn-primary" data-act="b-new">Add building ${icons.arrow}</button>`);
}
function buildingForm(b) {
  const x = b || { name: '', zone: '', latitude: '', longitude: '' };
  const m = modal(html`<h2>${b ? `Edit ${x.name}` : 'Add a building'}</h2><form id="bf" novalidate><div class="form-grid">
    <div class="field"><label for="bn">Name</label><input id="bn" class="inp" value="${x.name}"></div><div class="field"><label for="bz">Zone</label><input id="bz" class="inp" value="${x.zone}" placeholder="North"></div>
    <div class="field"><label for="bla">Latitude</label><input id="bla" class="inp" type="number" step="any" value="${x.latitude}"></div><div class="field"><label for="blo">Longitude</label><input id="blo" class="inp" type="number" step="any" value="${x.longitude}"></div></div>
    <div class="errtxt" id="m-err" role="alert"></div><div class="row" style="margin-top:20px"><button class="btn btn-outline" type="button" data-m="close">Cancel</button><button class="btn btn-primary" type="submit">Save</button></div></form>`);
  m.el.addEventListener('click', (e) => { if (e.target.dataset.m === 'close') m.close(); });
  m.el.querySelector('#bf').addEventListener('submit', async (ev) => {
    ev.preventDefault(); const q = (s) => m.el.querySelector(s).value;
    const body = { name: q('#bn'), zone: q('#bz'), latitude: q('#bla'), longitude: q('#blo') };
    try { b ? await admin.patch(`/admin/buildings/${b.building_id}`, body) : await admin.post('/admin/buildings', body); m.close(); flash('ok', `Saved ${body.name}.`); pageBuildings(); }
    catch (e) { m.el.querySelector('#m-err').textContent = e.message; }
  });
}

/* ------------------------------ amenities ------------------------------ */
async function pageAmenities() {
  loading('amenities', 'Amenities');
  const { amenities } = await admin.get('/admin/amenities');
  const rows = amenities.map((a) => html`<tr><td><b>${a.name}</b></td><td class="num">${a.rooms}</td><td class="act"><button class="btn btn-outline btn-sm" data-act="a-rename" data-id="${a.amenity_id}" data-name="${a.name}">Rename</button> <button class="btn btn-outline btn-sm" data-act="a-del" data-id="${a.amenity_id}" data-name="${a.name}" data-n="${a.rooms}">Delete</button></td></tr>`);
  layout('amenities', table([{ h: 'Amenity' }, { h: 'Rooms', cls: 'num' }, { h: '', cls: 'act' }], rows),
    'Amenities', 'Equipment and features students can filter by. Step-free access and quiet zone live here too.', html`<button class="btn btn-primary" data-act="a-new">Add amenity ${icons.arrow}</button>`);
}
function nameModal(title, value, onSave) {
  const m = modal(html`<h2>${title}</h2><form id="nf" novalidate><div class="field"><input id="nv" class="inp" value="${value}" maxlength="60"></div><div class="errtxt" id="m-err" role="alert"></div>
    <div class="row"><button class="btn btn-outline" type="button" data-m="close">Cancel</button><button class="btn btn-primary" type="submit">Save</button></div></form>`);
  m.el.addEventListener('click', (e) => { if (e.target.dataset.m === 'close') m.close(); });
  m.el.querySelector('#nf').addEventListener('submit', async (ev) => { ev.preventDefault(); try { await onSave(m.el.querySelector('#nv').value); m.close(); } catch (e) { m.el.querySelector('#m-err').textContent = e.message; } });
}
function confirmModal(title, text, label, onYes) {
  const m = modal(html`<h2>${title}</h2><p class="muted">${text}</p><div class="errtxt" id="m-err" role="alert"></div><div class="row" style="margin-top:20px"><button class="btn btn-outline" data-m="no">Cancel</button><button class="btn btn-dark" data-m="yes">${label}</button></div>`);
  m.el.addEventListener('click', async (e) => {
    if (e.target.dataset.m === 'no') return m.close();
    if (e.target.dataset.m === 'yes') { e.target.disabled = true; try { await onYes(); m.close(); } catch (x) { e.target.disabled = false; m.el.querySelector('#m-err').textContent = x.message; } }
  });
}

/* ------------------------------ purposes ------------------------------ */
async function pagePurposes() {
  loading('purposes', 'Purposes');
  const { purposes } = await admin.get('/admin/purposes');
  const rows = purposes.map((p) => html`<tr><td class="num">${p.sort_order}</td><td><b>${p.label}</b></td><td>${p.suggested_room_types.length ? p.suggested_room_types.join(', ') : html`<span class="muted">all room types</span>`}</td><td class="num">${p.bookings}</td>
    <td><span class="pill ${p.is_active ? 'ok' : 'off'}">${p.is_active ? 'In use' : 'Retired'}</span></td>
    <td class="act"><button class="btn btn-outline btn-sm" data-act="p-edit" data-id="${p.purpose_id}">Edit</button> <button class="btn btn-outline btn-sm" data-act="p-toggle" data-id="${p.purpose_id}" data-on="${p.is_active}">${p.is_active ? 'Retire' : 'Restore'}</button>${p.bookings === 0 ? html` <button class="btn btn-outline btn-sm" data-act="p-del" data-id="${p.purpose_id}" data-name="${p.label}">Delete</button>` : ''}</td></tr>`);
  S.purposes = purposes;
  layout('purposes', table([{ h: 'Order', cls: 'num' }, { h: 'Purpose' }, { h: 'Suggests rooms' }, { h: 'Bookings', cls: 'num' }, { h: 'Status' }, { h: '', cls: 'act' }], rows),
    'Purposes', 'What students pick when they book. A purpose also narrows search to suitable room types. Retire rather than delete once used: old bookings keep their label.', html`<button class="btn btn-primary" data-act="p-new">Add purpose ${icons.arrow}</button>`);
}
function purposeForm(p) {
  const x = p || { label: '', suggested_room_types: [], sort_order: (S.purposes?.length || 0) + 1 };
  const m = modal(html`<h2>${p ? 'Edit purpose' : 'Add a purpose'}</h2><form id="pf" novalidate>
    <div class="field"><label for="pl">Label</label><input id="pl" class="inp" value="${x.label}" maxlength="60"></div>
    <div class="field"><label>Suggested room types <span class="muted" style="font-weight:400">(none ticked = all)</span></label><div style="display:flex;gap:6px 18px;flex-wrap:wrap">${TYPES.map(([v, l]) => html`<label class="check"><input type="checkbox" name="pt" value="${v}" ${x.suggested_room_types.includes(v) ? 'checked' : ''}> ${l}</label>`)}</div></div>
    <div class="field"><label for="po">Order</label><input id="po" class="inp" type="number" value="${x.sort_order}"></div>
    <div class="errtxt" id="m-err" role="alert"></div><div class="row"><button class="btn btn-outline" type="button" data-m="close">Cancel</button><button class="btn btn-primary" type="submit">Save</button></div></form>`);
  m.el.addEventListener('click', (e) => { if (e.target.dataset.m === 'close') m.close(); });
  m.el.querySelector('#pf').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const body = { label: m.el.querySelector('#pl').value, suggested_room_types: [...m.el.querySelectorAll('[name=pt]:checked')].map((c) => c.value), sort_order: Number(m.el.querySelector('#po').value) };
    try { p ? await admin.patch(`/admin/purposes/${p.purpose_id}`, body) : await admin.post('/admin/purposes', body); m.close(); flash('ok', 'Purpose saved.'); pagePurposes(); }
    catch (e) { m.el.querySelector('#m-err').textContent = e.message; }
  });
}

/* ------------------------------ closures ------------------------------ */
async function pageClosures() {
  loading('closures', 'Closed days'); await loadRef();
  const { closures } = await admin.get('/admin/closures');
  const where = (c) => (c.scope === 'campus' ? 'Whole campus' : c.scope === 'building' ? c.building_name : `Room ${c.room_code}`);
  const rows = closures.map((c) => html`<tr><td>${c.first_date === c.last_date ? c.first_date : `${c.first_date} to ${c.last_date}`}</td><td><b>${where(c)}</b></td><td><span class="pill">${c.scope}</span></td><td>${c.reason || html`<span class="muted">no reason</span>`}</td><td class="kvs">${c.created_by}</td>
    <td class="act"><button class="btn btn-outline btn-sm" data-act="c-del" data-id="${c.closure_id}">Remove</button></td></tr>`);
  layout('closures', table([{ h: 'Dates' }, { h: 'Applies to' }, { h: 'Scope' }, { h: 'Reason' }, { h: 'Added by' }, { h: '', cls: 'act' }], rows, 'No closed days. Rooms follow their normal hours every day.'),
    'Closed days', 'Whole days when rooms can’t be booked. Existing bookings on those days are cancelled and students told.', html`<button class="btn btn-primary" data-act="c-new">Add closed days ${icons.arrow}</button>`);
}
function closureForm() {
  const today = T.dateStr(new Date());
  const m = modal(html`<h2>Add closed days</h2><form id="cf2" novalidate><div class="form-grid">
    <div class="field"><label for="cs">Applies to</label><select id="cs" class="sel"><option value="campus">Whole campus</option><option value="building">One building</option><option value="room">One room</option></select></div>
    <div class="field" id="cwb" style="display:none"><label for="cb">Building</label><select id="cb" class="sel">${S.buildings.map((b) => html`<option value="${b.building_id}">${b.name}</option>`)}</select></div>
    <div class="field" id="cwr" style="display:none"><label for="cr">Room code</label><input id="cr" class="inp" placeholder="ENG-201"></div>
    <div class="field"><label for="c1">First day</label><input id="c1" class="inp" type="date" value="${today}"></div><div class="field"><label for="c2">Last day</label><input id="c2" class="inp" type="date" value="${today}"></div>
    <div class="field full"><label for="cx">Reason</label><input id="cx" class="inp" maxlength="120" placeholder="Public holiday"></div></div>
    <div id="cp"></div><div class="errtxt" id="m-err" role="alert"></div>
    <div class="row" style="margin-top:20px"><button class="btn btn-outline" type="button" data-m="close">Cancel</button><button class="btn btn-outline" type="button" data-m="preview">Check impact</button><button class="btn btn-primary" type="submit">Add closed days</button></div></form>`);
  const q = (s) => m.el.querySelector(s);
  q('#cs').addEventListener('change', () => { q('#cwb').style.display = q('#cs').value === 'building' ? '' : 'none'; q('#cwr').style.display = q('#cs').value === 'room' ? '' : 'none'; });
  async function body() {
    const b = { scope: q('#cs').value, first_date: q('#c1').value, last_date: q('#c2').value, reason: q('#cx').value };
    if (b.scope === 'building') b.building_id = Number(q('#cb').value);
    if (b.scope === 'room') {
      const code = q('#cr').value.trim().toUpperCase();
      const r = await admin.get('/admin/rooms', { q: code, limit: 5 });
      const hit = r.rooms.find((x) => x.code === code);
      if (!hit) throw new Error(`No room with code ${code}.`);
      b.room_id = hit.room_id;
    }
    return b;
  }
  m.el.addEventListener('click', async (e) => {
    if (e.target.dataset.m === 'close') return m.close();
    if (e.target.dataset.m === 'preview') {
      q('#m-err').textContent = '';
      try { const pv = await admin.post('/admin/closures/preview', await body()); q('#cp').innerHTML = out(html`<div class="callout ${pv.bookings_affected ? '' : 'ok'}"><b>${pv.bookings_affected} active booking${pv.bookings_affected === 1 ? '' : 's'} will be cancelled and ${pv.students_affected} student${pv.students_affected === 1 ? '' : 's'} notified.</b></div>`); }
      catch (x) { q('#m-err').textContent = x.message; }
    }
  });
  q('#cf2').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try { const r = await admin.post('/admin/closures', await body()); m.close(); flash('ok', `Closed days added.${r.bookings_cancelled ? ` ${r.bookings_cancelled} booking${r.bookings_cancelled === 1 ? '' : 's'} cancelled and students notified.` : ''}`); pageClosures(); }
    catch (x) { q('#m-err').textContent = x.message; }
  });
}

/* ------------------------------ announcements ------------------------------ */
async function pageAnnouncements() {
  loading('announcements', 'Announcements');
  const { announcements } = await admin.get('/admin/announcements');
  const now = Date.now();
  const rows = announcements.map((a) => html`<tr><td>${fmtDt(a.starts_at)} to ${fmtDt(a.ends_at)} ${T.TZ_LABEL}</td><td>${a.message}</td><td><span class="pill ${new Date(a.ends_at) < now ? '' : new Date(a.starts_at) < now ? 'warn' : 'ok'}">${new Date(a.ends_at) < now ? 'Past' : new Date(a.starts_at) < now ? 'Now' : 'Upcoming'}</span></td><td class="kvs">${a.notified_at ? `Notified ${fmtDt(a.notified_at)}` : 'Not yet notified'}</td>
    <td class="act"><button class="btn btn-outline btn-sm" data-act="an-del" data-id="${a.announcement_id}">Remove</button></td></tr>`);
  layout('announcements', table([{ h: 'Downtime window' }, { h: 'Message' }, { h: 'Status' }, { h: 'Notices' }, { h: '', cls: 'act' }], rows, 'No announcements.'),
    'Announcements', 'Planned downtime: students with bookings in the window, and all active users, are notified, and the app shows a banner. Announce at least 24 hours ahead.', html`<button class="btn btn-primary" data-act="an-new">Announce downtime ${icons.arrow}</button>`);
}
function announcementForm() {
  const d = T.addDays(T.dateStr(new Date()), 2);
  const m = modal(html`<h2>Announce planned downtime</h2><form id="af" novalidate><div class="form-grid">
    <div class="field"><label for="d1">Starts</label><input id="d1" class="inp" type="datetime-local" value="${d}T02:00"></div><div class="field"><label for="d2">Ends</label><input id="d2" class="inp" type="datetime-local" value="${d}T04:00"></div>
    <div class="field full"><label for="dm">Message to students</label><input id="dm" class="inp" maxlength="200" placeholder="Booking will be unavailable while we upgrade the system."></div></div>
    <p class="small muted">Times are ${T.TZ_LABEL} (campus time). Students are notified straight away.</p><div class="errtxt" id="m-err" role="alert"></div>
    <div class="row"><button class="btn btn-outline" type="button" data-m="close">Cancel</button><button class="btn btn-primary" type="submit">Publish</button></div></form>`);
  m.el.addEventListener('click', (e) => { if (e.target.dataset.m === 'close') m.close(); });
  const inst = (v) => { const [dd, tt] = v.split('T'); return T.toInstant(dd, tt).toISOString(); };
  m.el.querySelector('#af').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try { await admin.post('/admin/announcements', { starts_at: inst(m.el.querySelector('#d1').value), ends_at: inst(m.el.querySelector('#d2').value), message: m.el.querySelector('#dm').value }); m.close(); flash('ok', 'Announcement published. Students have been notified.'); pageAnnouncements(); }
    catch (e) { m.el.querySelector('#m-err').textContent = e.code === 'TOO_LATE' ? 'Planned downtime must be announced at least 24 hours ahead.' : e.message; }
  });
}

/* ------------------------------ policy ------------------------------ */
async function pagePolicy() {
  loading('policy', 'Policy');
  const { policy } = await admin.get('/admin/policy');
  const input = (p) => (p.type === 'bool' ? html`<select class="sel pol-in" data-k="${p.key}"><option value="true" ${p.value ? 'selected' : ''}>On</option><option value="false" ${!p.value ? 'selected' : ''}>Off</option></select>`
    : p.type === 'int' ? html`<input class="inp pol-in" type="number" data-k="${p.key}" value="${p.value}">` : html`<input class="inp pol-in" data-k="${p.key}" value="${p.value}">`);
  const rows = policy.map((p) => html`<tr><td><code class="k">${p.key}</code></td><td>${p.note}</td><td>${input(p)}</td><td class="kvs">${String(p.default)}</td></tr>`);
  layout('policy', html`${table([{ h: 'Setting' }, { h: 'What it does' }, { h: 'Value' }, { h: 'Default' }], rows)}<div style="margin-top:20px;text-align:right"><button class="btn btn-primary" data-act="pol-save">Save changes ${icons.arrow}</button></div>`,
    'Policy', 'Every limit and time window the service reads. Changes apply straight away, no deploy needed.');
  S.policy = policy;
}

/* ------------------------------ admin users ------------------------------ */
async function pageUsers() {
  loading('users', 'Admin users');
  const { admins } = await admin.get('/admin/users');
  const st = { invited: ['warn', 'Invited'], active: ['ok', 'Active'], revoked: ['off', 'Revoked'] };
  const rows = admins.map((a) => html`<tr><td><b>${a.email}</b></td><td><span class="pill">${a.role === 'super_admin' ? 'Super admin' : 'Admin'}</span></td><td><span class="pill ${st[a.status][0]}">${st[a.status][1]}</span>${a.must_change_password && a.status !== 'revoked' ? html` <span class="small muted">temporary password</span>` : ''}</td><td class="kvs">${a.last_login_at ? fmtDt(a.last_login_at) : 'Never'}</td>
    <td class="act">${a.status !== 'revoked' ? html`<button class="btn btn-outline btn-sm" data-act="u-role" data-id="${a.operator_id}" data-role="${a.role}">${a.role === 'admin' ? 'Make super admin' : 'Make admin'}</button> <button class="btn btn-outline btn-sm" data-act="u-reset" data-id="${a.operator_id}" data-email="${a.email}">Reset password</button> ${a.operator_id !== S.me.operator_id ? html`<button class="btn btn-outline btn-sm" data-act="u-revoke" data-id="${a.operator_id}" data-email="${a.email}">Revoke</button>` : ''}` : html`<button class="btn btn-outline btn-sm" data-act="u-reinvite" data-email="${a.email}" data-role="${a.role}">Invite again</button>`}</td></tr>`);
  layout('users', table([{ h: 'Email' }, { h: 'Role' }, { h: 'Status' }, { h: 'Last sign-in' }, { h: '', cls: 'act' }], rows),
    'Admin users', 'Only super admins manage access. New admins sign in with the default temporary password and must change it at first login.', html`<button class="btn btn-primary" data-act="u-new">Invite admin ${icons.arrow}</button>`);
}
function inviteForm(email = '', role = 'admin') {
  const m = modal(html`<h2>Invite an admin</h2><form id="uf" novalidate><div class="field"><label for="ue">Email</label><input id="ue" class="inp" type="email" value="${email}"></div>
    <div class="field"><label for="ur">Role</label><select id="ur" class="sel"><option value="admin" ${role === 'admin' ? 'selected' : ''}>Admin: catalogue, hours, closures, announcements, policy</option><option value="super_admin" ${role === 'super_admin' ? 'selected' : ''}>Super admin: also manages admin access</option></select></div>
    <div class="callout">They sign in with the default temporary password and must set their own at first login. It expires if unused. Tell them directly, as no email is sent.</div>
    <div class="errtxt" id="m-err" role="alert"></div><div class="row"><button class="btn btn-outline" type="button" data-m="close">Cancel</button><button class="btn btn-primary" type="submit">Create access</button></div></form>`);
  m.el.addEventListener('click', (e) => { if (e.target.dataset.m === 'close') m.close(); });
  m.el.querySelector('#uf').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try { await admin.post('/admin/users', { email: m.el.querySelector('#ue').value, role: m.el.querySelector('#ur').value }); m.close(); flash('ok', 'Access created. Share the temporary password with them directly.'); pageUsers(); }
    catch (e) { m.el.querySelector('#m-err').textContent = e.message; }
  });
}

/* ------------------------------ audit ------------------------------ */
async function pageAudit() {
  loading('audit', 'Audit log');
  const { entries } = await admin.get('/admin/audit-log', { limit: 200 });
  const rows = entries.map((e) => html`<tr><td class="kvs" style="white-space:nowrap">${fmtDt(e.at)}</td><td>${e.operator_email || html`<span class="muted">system</span>`}</td><td><span class="pill">${e.entity}</span></td><td><b>${e.action}</b></td>
    <td class="kvs" style="max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${JSON.stringify(e.after ?? e.before ?? '')}">${e.after ? JSON.stringify(e.after) : e.before ? JSON.stringify(e.before) : ''}</td></tr>`);
  layout('audit', table([{ h: 'When' }, { h: 'Who' }, { h: 'What' }, { h: 'Action' }, { h: 'Details' }], rows, 'No admin actions recorded yet.'), 'Audit log', 'Every admin change, newest first.');
}

/* ------------------------------ events ------------------------------ */
async function roomById(id) { return (await admin.get(`/admin/rooms/${id}`)).room; }
const acts = {
  signout: () => signOut(),
  'room-new': () => roomForm(null),
  'room-edit': async (el) => roomForm(await roomById(el.dataset.id)),
  'room-import': () => importModal(),
  'rooms-prev': () => { R.offset = Math.max(0, R.offset - R.limit); pageRooms(); },
  'rooms-next': () => { R.offset += R.limit; pageRooms(); },
  'b-new': () => buildingForm(null),
  'b-edit': (el) => buildingForm(S.buildings.find((b) => String(b.building_id) === el.dataset.id)),
  'a-new': () => nameModal('Add an amenity', '', async (v) => { await admin.post('/admin/amenities', { name: v }); flash('ok', 'Amenity added.'); pageAmenities(); }),
  'a-rename': (el) => nameModal('Rename amenity', el.dataset.name, async (v) => { await admin.patch(`/admin/amenities/${el.dataset.id}`, { name: v }); flash('ok', 'Amenity renamed.'); pageAmenities(); }),
  'a-del': (el) => confirmModal('Delete this amenity?', `“${el.dataset.name}” will be removed from ${el.dataset.n} room${el.dataset.n === '1' ? '' : 's'} and from the search filter.`, 'Delete', async () => { await admin.del(`/admin/amenities/${el.dataset.id}`); flash('ok', 'Amenity deleted.'); pageAmenities(); }),
  'p-new': () => purposeForm(null),
  'p-edit': (el) => purposeForm(S.purposes.find((p) => String(p.purpose_id) === el.dataset.id)),
  'p-toggle': async (el) => { await admin.patch(`/admin/purposes/${el.dataset.id}`, { is_active: el.dataset.on !== 'true' }); flash('ok', el.dataset.on === 'true' ? 'Purpose retired. Old bookings keep it.' : 'Purpose restored.'); pagePurposes(); },
  'p-del': (el) => confirmModal('Delete this purpose?', `“${el.dataset.name}” has no bookings, so it can be removed completely.`, 'Delete', async () => { await admin.del(`/admin/purposes/${el.dataset.id}`); flash('ok', 'Purpose deleted.'); pagePurposes(); }),
  'c-new': () => closureForm(),
  'c-del': (el) => confirmModal('Remove these closed days?', 'Rooms open again for booking on those days. Bookings already cancelled stay cancelled.', 'Remove', async () => { await admin.del(`/admin/closures/${el.dataset.id}`); flash('ok', 'Closed days removed.'); pageClosures(); }),
  'an-new': () => announcementForm(),
  'an-del': (el) => confirmModal('Remove this announcement?', 'The banner disappears. Notices already sent stay in students’ notifications.', 'Remove', async () => { await admin.del(`/admin/announcements/${el.dataset.id}`); flash('ok', 'Announcement removed.'); pageAnnouncements(); }),
  'pol-save': async () => {
    const values = {};
    for (const el of document.querySelectorAll('[data-k]')) {
      const p = S.policy.find((x) => x.key === el.dataset.k);
      const v = p.type === 'bool' ? el.value === 'true' : p.type === 'int' ? Number(el.value) : el.value;
      if (v !== p.value) values[p.key] = v;
    }
    if (!Object.keys(values).length) { flash('ok', 'Nothing changed.'); return pagePolicy(); }
    try { await admin.put('/admin/policy', { values }); flash('ok', `Saved ${Object.keys(values).length} setting${Object.keys(values).length === 1 ? '' : 's'}. Live now.`); }
    catch (e) { flash('warn', e.message); }
    pagePolicy();
  },
  'u-new': () => inviteForm(),
  'u-reinvite': (el) => inviteForm(el.dataset.email, el.dataset.role),
  'u-role': async (el) => { try { await admin.patch(`/admin/users/${el.dataset.id}/role`, { role: el.dataset.role === 'admin' ? 'super_admin' : 'admin' }); flash('ok', 'Role changed.'); } catch (e) { flash('warn', e.message); } pageUsers(); },
  'u-reset': (el) => confirmModal('Reset this password?', `${el.dataset.email} is signed out and must use the temporary password, then set a new one.`, 'Reset password', async () => { await admin.post(`/admin/users/${el.dataset.id}/reset-password`); flash('ok', 'Password reset. Tell them to sign in with the temporary password.'); pageUsers(); }),
  'u-revoke': (el) => confirmModal('Revoke access?', `${el.dataset.email} is signed out and can no longer use the admin console.`, 'Revoke access', async () => { await admin.post(`/admin/users/${el.dataset.id}/revoke`); flash('ok', 'Access revoked.'); pageUsers(); }),
};
document.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el || !acts[el.dataset.act]) return;
  ev.preventDefault();
  try { await acts[el.dataset.act](el); } catch (e) { if (e.status === 401) { signOut(); } else { flash('warn', friendly(e)); render(); } }
});

/* ------------------------------ router ------------------------------ */
const pages = { rooms: pageRooms, buildings: pageBuildings, amenities: pageAmenities, purposes: pagePurposes, closures: pageClosures, announcements: pageAnnouncements, policy: pagePolicy, users: pageUsers, audit: pageAudit };
async function render() {
  if (!S.me) return;
  const id = hash().split('?')[0];
  const fn = pages[id] && !(id === 'users' && S.me.role !== 'super_admin') ? pages[id] : pageRooms;
  try { await fn(); } catch (e) { if (e.status === 401) return signOut(); layout(id, html`<div class="empty"><h2>Couldn’t load this page.</h2><p class="muted">${friendly(e)}</p><div class="row"><button class="btn btn-primary" data-act="reload">Try again</button></div></div>`, 'Something went wrong', ''); }
}
acts.reload = () => render();

async function boot() {
  if (!S.cfg) { try { S.cfg = await pub.get('/policy/public'); T.setTz(S.cfg.timezone, S.cfg.timezone_label); } catch { /* retried below */ } }
  if (!tokens.get('admin')) return pageLogin();
  try {
    const { operator } = await admin.get('/admin/me');
    S.me = operator;
    if (!location.hash) location.hash = '#/rooms';
    await render();
  } catch (e) {
    if (e.code === 'PASSWORD_CHANGE_REQUIRED') return pageChangePassword('your account');
    if (e instanceof ApiError && e.status === 401) { tokens.clear('admin'); return pageLogin(); }
    $app.innerHTML = out(html`<div class="wrap"><div class="empty"><h2>Service unavailable.</h2><p class="muted">${friendly(e)}</p><div class="row"><button class="btn btn-primary" onclick="location.reload()">Try again</button></div></div></div>`);
  }
}
window.addEventListener('hashchange', render);
boot();
void initials;
