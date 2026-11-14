import { student, pub, tokens, ApiError, uuid } from './api.js';
import * as T from './time.js';
import { html, raw, out, esc, icons, logo, modal, initials, jwt, roomTile } from './ui.js';

const $app = document.getElementById('app');
const PAGE = 10;
const state = {
  cfg: null, user: null, standing: null, announcements: [], annAt: 0, unread: 0,
  f: null, res: null, items: [], loading: false, paused: false, amenities: [], buildings: [], purposes: [],
  flash: null, bt: 'upcoming', bookings: {}, rv: null, timers: [], menu: false, filtersOpen: false,
};

/* ------------------------------ utilities ------------------------------ */
const protectedPaths = new Set(['rooms', 'review', 'bookings', 'notifications']);
function parseHash() {
  const raw_ = location.hash.replace(/^#\/?/, '');
  const [p, qs] = raw_.split('?');
  return { path: p || '', parts: (p || '').split('/'), q: Object.fromEntries(new URLSearchParams(qs || '')) };
}
const go = (h) => { location.hash = h; };
const sameWeek = (iso) => state.standing && new Date(iso) < new Date(state.standing.resets_at);
function clearTimers() { state.timers.forEach(clearInterval); state.timers = []; }
function every(ms, fn) { state.timers.push(setInterval(fn, ms)); }
function flash(kind, text) { state.flash = { kind, text }; }
function takeFlash() { const f = state.flash; state.flash = null; return f; }
const pad = T.pad;
function money(n) { return n; }
void money;

function friendly(e) {
  if (e?.status === 0) return 'No connection. Check your network and try again.';
  if (e?.status === 503) return 'Try again in a few minutes.';
  if (e?.status === 401) return 'Your session ended. Sign in again.';
  return e?.message || 'Something went wrong.';
}

/* ------------------------------ shell ------------------------------ */
function navHtml({ active, landing = false }) {
  const signedIn = !!state.user;
  if (landing) {
    return html`<header class="nav"><div class="wrap">
      ${logo()}
      <nav class="nav-links" style="margin-left:auto">
        <a href="#/" data-scroll="spaces">Spaces</a><a href="#/" data-scroll="how">How it works</a><a href="#/" data-scroll="faq">Good to know</a>
        <a href="#/bookings">My bookings</a>
      </nav>
      <a class="btn btn-primary btn-sm" href="#/rooms">Find a room ${icons.arrow}</a>
    </div></header>`;
  }
  return html`<header class="nav"><div class="wrap">
    ${logo()}
    <nav class="nav-links">
      <a href="#/rooms" class="${active === 'rooms' ? 'active' : ''}">Find a room</a>
      <a href="#/bookings" class="${active === 'bookings' ? 'active' : ''}">My bookings</a>
    </nav>
    <div class="nav-right">
      <span class="loc">Main campus · ${T.TZ_LABEL}</span>
      ${signedIn ? html`
        <button class="nav-bell" data-act="bell" aria-label="Notifications">${icons.bell}${state.unread ? html`<span class="dot">${state.unread > 9 ? '9+' : state.unread}</span>` : ''}</button>
        <button class="avatar" data-act="menu" aria-label="Account menu" aria-haspopup="true">${initials(state.user.name)}</button>` : html`<a class="btn btn-primary btn-sm" href="#/login">Sign in</a>`}
    </div></div>
    ${state.menu && signedIn ? html`<div class="menu"><div style="padding:10px 12px"><b>${state.user.name}</b><div class="small muted">${state.user.email}</div></div>
      <a href="#/bookings">My bookings</a><a href="#/notifications">Notifications</a><button data-act="signout">Sign out</button></div>` : ''}
  </header>`;
}
function bannersHtml() {
  const parts = [];
  const now = new Date();
  for (const a of state.announcements) {
    parts.push(html`<div class="top-banner"><div class="wrap">${icons.info}<span><b>Planned downtime</b> · ${T.longDate(new Date(a.starts_at))}, ${T.range(a.starts_at, a.ends_at)} ${T.TZ_LABEL}. ${a.message}</span></div></div>`);
  }
  if (state.cfg?.demo) parts.push(html`<div class="top-banner paused"><div class="wrap">${icons.info}<span><b>Demo.</b> Data here is for trying the app and may be reset. Real university sign-in is not connected.</span></div></div>`);
  if (state.paused) parts.push(html`<div class="top-banner paused"><div class="wrap">${icons.info}<span><b>Booking paused.</b> You can still search. Booking, cancelling and check-in will be back shortly.</span></div></div>`);
  void now;
  return parts;
}
function tabbar(active) {
  return html`<nav class="tabbar" aria-label="Main"><a href="#/rooms" class="${active === 'rooms' ? 'active' : ''}">↗ Find a room</a><a href="#/bookings" class="${active === 'bookings' ? 'active' : ''}">My bookings</a></nav>`;
}
function shell(inner, { active = '', landing = false, footer = false } = {}) {
  $app.innerHTML = out(html`${navHtml({ active, landing })}${landing ? '' : bannersHtml()}<main id="page">${inner}</main>${footer ? footerHtml() : ''}${landing || !state.user ? '' : tabbar(active)}`);
  window.scrollTo(0, 0);
}
function footerHtml() {
  return html`<footer class="site"><div class="wrap"><div>${logo()}<div style="margin-top:8px">Shared spaces. Better campus days.</div></div>
    <div><a href="#/" data-scroll="how">How it works</a><a href="#/" data-scroll="faq">Booking guidelines</a><a href="#/" data-scroll="faq">Questions</a><div style="margin-top:14px">Need help? Contact your campus facilities team.</div></div></div></footer>`;
}

/* ------------------------------ data loaders ------------------------------ */
async function loadCfg() {
  state.cfg = await pub.get('/policy/public');
  T.setTz(state.cfg.timezone, state.cfg.timezone_label);
}
async function loadLists() {
  if (state.amenities.length && state.buildings.length) return;
  const [a, b, p] = await Promise.all([student.get('/amenities'), student.get('/buildings'), student.get('/purposes')]);
  state.amenities = a.amenities; state.buildings = b.buildings; state.purposes = p.purposes;
}
async function loadChrome(force = false) {
  if (!state.user) return;
  const tasks = [];
  if (force || Date.now() - state.annAt > 60000) {
    tasks.push(student.get('/announcements').then((r) => { state.announcements = r.announcements; state.annAt = Date.now(); }).catch(() => {}));
  }
  tasks.push(student.get('/me/standing').then((r) => { state.standing = r; }).catch(() => {}));
  tasks.push(student.get('/me/notifications', { limit: 50 }).then((r) => { state.unread = r.unread; }).catch(() => {}));
  await Promise.all(tasks);
}
function setUserFromToken() {
  const t = tokens.get('student');
  const p = t && jwt(t);
  state.user = p && p.exp * 1000 > Date.now() ? { id: p.sub, email: p.email, name: p.name || p.email } : null;
  if (!state.user && t) tokens.clear('student');
}
const suspended = () => state.standing?.suspended_until && new Date(state.standing.suspended_until) > new Date();

/* ------------------------------ router ------------------------------ */
async function render() {
  clearTimers();
  state.menu = false;
  const r = parseHash();
  setUserFromToken();
  const root = r.parts[0];
  if (protectedPaths.has(root) && !state.user) {
    sessionStorage.setItem('cr_return', location.hash);
    return go('#/login');
  }
  try {
    if (state.user) await loadChrome();
    if (root === '') return pageLanding();
    if (root === 'login') return pageLogin();
    if (root === 'auth') return pageAuth(r.q);
    if (root === 'rooms') return await pageRooms(r.q);
    if (root === 'review') return await pageReview(r.q);
    if (root === 'bookings' && r.parts[1]) return await pageBookingDetail(r.parts[1]);
    if (root === 'bookings') return await pageBookings();
    if (root === 'notifications') return await pageNotifications();
    return pageNotFound();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) { tokens.clear('student'); state.user = null; sessionStorage.setItem('cr_return', location.hash); return go('#/login'); }
    return pageOutage(e);
  }
}

/* ------------------------------ landing ------------------------------ */
function pageLanding() {
  const c = state.cfg;
  const dur = `${T.minutes(c.duration_min_minutes).replace(' min', ' min')}–${T.minutes(c.duration_max_minutes).replace(' hours', ' hr').replace(' hour', ' hr')}`;
  shell(html`
    <div class="wrap"><section class="hero">
      <div>
        <div class="eyebrow green">More room for campus life</div>
        <h1 class="display">Great ideas start with a little space.</h1>
        <p class="lead" style="max-width:480px">Find and book study rooms and seminar spaces across campus. Choose your time, find your fit, and make room for what matters.</p>
        <div style="display:flex;gap:24px;align-items:center;margin:28px 0 20px;flex-wrap:wrap">
          <a class="btn btn-primary" href="#/rooms">Find your room ${icons.arrow}</a>
          <a class="link" href="#/" data-scroll="how">See how it works ${icons.arrowDown}</a>
        </div>
        <div class="small muted">For students · Book ahead · Manage it all in one place</div>
      </div>
      <div class="hero-img"><img src="/img/hero.jpg" alt="A bright meeting room with a long wooden table, green chairs and a whiteboard" width="1152" height="928">
        <div class="hero-badge">${icons.arrow} Space to think. Room together.</div>
        <div class="hero-card"><div style="display:flex;justify-content:space-between"><b>Your next study session</b>${icons.arrow}</div>
          <div class="row"><div class="mini"><small>ENG</small><b>201</b></div><div><b>ENG-201 · 8 seats</b><div class="small muted">10:00–11:00 · Group study</div></div></div>
          <div class="small" style="color:#245c3e">${icons.check} Availability checked when you confirm</div></div>
      </div></section></div>
    <div class="band"><div class="wrap"><span>Quiet study</span><span>Group projects</span><span>Seminars</span><b>One campus. More possibilities.</b></div></div>
    <section class="section" id="spaces"><div class="wrap">
      <div style="display:flex;justify-content:space-between;align-items:flex-end;gap:24px;flex-wrap:wrap"><div><div class="eyebrow">Find your fit</div><h2 class="h1" style="margin-bottom:0">Different plans.<br>The right kind of room.</h2></div>
        <p class="muted" style="max-width:420px">A solo study session or a lively group discussion: start with a space that suits what you’re here to do.</p></div>
      <div class="cards3">
        <div><div class="art"><svg width="180" height="130" viewBox="0 0 180 130" fill="none" aria-hidden="true"><rect x="2" y="2" width="172" height="96" rx="16" fill="#fff" stroke="#17201c" stroke-width="3"/><rect x="48" y="20" width="44" height="40" rx="3" fill="#dfe3dc" stroke="#17201c" stroke-width="2"/><circle cx="146" cy="24" r="10" fill="#245c3e"/><rect x="40" y="108" width="72" height="22" rx="11" fill="#17201c"/></svg></div>
          <h3 class="h3" style="font-size:26px">Study rooms</h3><p class="muted">Find a quieter setting for reading, revision and focused work.</p><a class="link" href="#/rooms?type=study">Explore rooms ${icons.arrow}</a></div>
        <div><div class="art y"><svg width="200" height="130" viewBox="0 0 200 130" fill="none" aria-hidden="true"><rect x="14" y="30" width="172" height="72" rx="20" fill="#fff" stroke="#17201c" stroke-width="3"/><rect x="40" y="52" width="30" height="26" rx="3" fill="#dfe3dc"/><path d="M92 58h40M92 66h40M92 74h26" stroke="#17201c" stroke-width="2.4"/><rect x="26" y="8" width="62" height="22" rx="11" fill="#17201c"/><rect x="112" y="8" width="62" height="22" rx="11" fill="#17201c"/><rect x="26" y="104" width="62" height="22" rx="11" fill="#17201c"/><rect x="112" y="104" width="62" height="22" rx="11" fill="#17201c"/></svg></div>
          <h3 class="h3" style="font-size:26px">Group spaces</h3><p class="muted">Get your project team together, with room to share ideas.</p><a class="link" href="#/rooms?type=group">Explore rooms ${icons.arrow}</a></div>
        <div><div class="art g"><svg width="200" height="130" viewBox="0 0 200 130" fill="none" aria-hidden="true"><rect x="10" y="4" width="180" height="12" rx="6" fill="#fff" stroke="#17201c" stroke-width="2.4"/><rect x="62" y="28" width="76" height="34" rx="8" fill="#fff" stroke="#17201c" stroke-width="2.4"/><rect x="10" y="76" width="50" height="24" rx="6" fill="#fff" stroke="#17201c" stroke-width="2.4"/><rect x="75" y="76" width="50" height="24" rx="6" fill="#fff" stroke="#17201c" stroke-width="2.4"/><rect x="140" y="76" width="50" height="24" rx="6" fill="#fff" stroke="#17201c" stroke-width="2.4"/><rect x="10" y="106" width="50" height="20" rx="6" fill="#17201c"/><rect x="75" y="106" width="50" height="20" rx="6" fill="#17201c"/><rect x="140" y="106" width="50" height="20" rx="6" fill="#17201c"/></svg></div>
          <h3 class="h3" style="font-size:26px">Seminar rooms</h3><p class="muted">Find capacity and equipment for your next discussion.</p><a class="link" href="#/rooms?type=seminar">Explore rooms ${icons.arrow}</a></div>
      </div></div></section>
    <section class="section" style="padding-top:0"><div class="wrap" style="display:grid;grid-template-columns:1fr 1.4fr;gap:80px;border-top:1px solid var(--line);padding-top:72px">
      <div><div class="eyebrow">What Campus Rooms does</div><h2 class="h1">Less searching.<br>More doing.</h2><p class="muted">Everything you need to go from “where can we meet?” to a room that’s yours.</p></div>
      <div class="feats">
        <div class="feat"><div>▢</div><div><b>Find the right fit</b><span>Search by date and time. Filter rooms by capacity, building and useful equipment.</span></div></div>
        <div class="feat"><div>▣</div><div><b>Reserve with confidence</b><span>Review the details, then confirm. A room is yours only after the booking succeeds.</span></div></div>
        <div class="feat"><div>↻</div><div><b>Keep your plans flexible</b><span>See upcoming bookings, check in and cancel before the start if your plans change.</span></div></div>
      </div></div></section>
    <section class="section panel-bg" id="how"><div class="wrap" style="display:block;padding-top:0;padding-bottom:0">
      <div style="display:flex;justify-content:space-between;gap:24px;flex-wrap:wrap;align-items:flex-end"><div><div class="eyebrow">Your first booking</div><h2 class="h1" style="margin-bottom:0">From looking to booked.<br>Three simple steps.</h2></div><p class="muted" style="max-width:360px">You choose the time and space. Campus Rooms keeps the booking details together.</p></div>
      <div class="steps">
        <div><big>01</big><h3 class="h3">Pick your time</h3><p class="muted">Choose a date, start time and end time. We’ll show rooms available for your whole session.</p></div>
        <div><big>02</big><h3 class="h3">Choose your space</h3><p class="muted">Compare locations, capacity and equipment. Open the room that works for your plans.</p></div>
        <div><big>03</big><h3 class="h3">Confirm. Then check in.</h3><p class="muted">Review your details, confirm the booking, and check in when your session is about to start.</p></div>
      </div><a class="btn btn-primary" style="margin-top:32px" href="#/rooms">Let’s find your room ${icons.arrow}</a></div></section>
    <section class="dark"><div class="wrap"><div class="eyebrow" style="color:var(--yellow)">Shared spaces. A little consideration.</div><h2 class="h1" style="color:#fff">A few rules keep it fair.</h2>
      <div class="rules">
        <div><big>${dur}</big><b>Make time for your work</b><span>Book in ${c.time_grid_minutes}-minute intervals.</span></div>
        <div><big>${c.horizon_days} days</big><b>Plan a little ahead</b><span>Reserve up to ${c.horizon_days === 14 ? 'two weeks' : `${c.horizon_days} days`} ahead.</span></div>
        <div><big>${c.weekly_limit} bookings</big><b>Share the opportunity</b><span>Up to ${c.weekly_limit} bookings per calendar week.</span></div>
        <div><big>${c.checkin_open_before_minutes} min before</big><b>Check in for your session</b><span>Check-in opens before your start time.</span></div>
      </div></div></section>
    <section class="section" id="faq"><div class="wrap" style="display:grid;grid-template-columns:1fr 1.6fr;gap:80px">
      <div><div class="eyebrow">Good to know</div><h2 class="h1">A few answers before you begin.</h2><p class="muted">Clear plans make shared spaces work better for everyone.</p></div>
      <div class="faq">
        <details open><summary>What if my plans change?</summary><p>Cancel your booking in My bookings any time before it starts. The slot becomes available for someone else.</p></details>
        <details><summary>When should I check in?</summary><p>Check-in opens ${c.checkin_open_before_minutes} minutes before your booking. Check in no later than ${c.checkin_close_after_minutes} minutes after the start, or the rest of the slot is released.</p></details>
        <details><summary>Can a room become unavailable after I search?</summary><p>Yes. Another student may book it first. Availability is checked again when you confirm, and you’ll be shown alternatives if it was taken.</p></details>
        <details><summary>What happens if I miss a booking?</summary><p>A booking with no check-in is recorded as a no-show. After ${c.noshow_threshold} no-shows in ${c.noshow_window_days} days, booking is paused for ${c.suspension_length_days} days. Searching still works.</p></details>
        <details><summary>Can I bring other people?</summary><p>In group rooms you can invite other students by their university email. They accept or decline in My bookings.</p></details>
        <details><summary>Where do I find my reservations?</summary><p>Open My bookings to see upcoming sessions, booking details and cancellation options.</p></details>
      </div></div></section>
    <div class="wrap"><div class="cta-band"><div><h2>Make room for your next idea.</h2><div>A study session. A project meeting. Your next great conversation.</div></div><a class="btn btn-dark" href="#/rooms">Find a room ${icons.arrow}</a></div></div>`, { landing: true, footer: true });
}

/* ------------------------------ login ------------------------------ */
function pageLogin() {
  const c = state.cfg;
  const ret = sessionStorage.getItem('cr_return') || '#/rooms';
  shell(html`<div class="wrap"><div class="card">
    <div class="eyebrow">${c.demo ? 'Demo sign-in' : 'University sign-in'}</div><h1 class="h2">Sign in to book a room.</h1>
    ${c.sso_login_url ? html`<p class="muted">You’ll sign in with your university account.</p><a class="btn btn-primary btn-block" href="${c.sso_login_url}">Continue to university sign-in ${icons.arrow}</a>` : ''}
    ${c.dev_sso ? html`<p class="muted small" style="margin-top:16px">${c.demo ? html`<b>Demo sign-in.</b> Enter any ID and name. Use an email ending <b>@${c.university_email_domain}</b> so invitations to other demo users work. No password.` : 'Development sign-in. Stands in for the university SSO, which issues the signed token in production.'}</p>
      <form id="devlogin" novalidate>
        <div class="field"><label for="sid">Student ID</label><input id="sid" class="inp" autocomplete="username" value="${localStorage.getItem('cr_dev_sid') || ''}" required></div>
        <div class="field"><label for="snm">Name</label><input id="snm" class="inp" autocomplete="name" value="${localStorage.getItem('cr_dev_name') || ''}" required></div>
        <div class="field"><label for="sem">University email</label><input id="sem" class="inp" type="email" autocomplete="email" placeholder="you@${c.university_email_domain}" value="${localStorage.getItem('cr_dev_email') || ''}" required></div>
        <div class="errtxt" id="lerr" role="alert"></div>
        <button class="btn btn-primary btn-block" style="margin-top:16px" type="submit">Sign in ${icons.arrow}</button>
      </form>` : (!c.sso_login_url ? html`<p class="muted">Sign-in is not configured. Ask your campus IT team.</p>` : '')}
    <p class="small muted" style="margin-top:24px"><a href="#/">← Back to Campus Rooms</a></p></div></div>`);
  const form = document.getElementById('devlogin');
  form?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const sid = document.getElementById('sid').value.trim(); const nm = document.getElementById('snm').value.trim(); const em = document.getElementById('sem').value.trim();
    const err = document.getElementById('lerr');
    if (!sid || !nm || !em) { err.textContent = 'Fill in all three fields.'; return; }
    try {
      const { token } = await student.post('/dev/sso/login', { student_id: sid, email: em, name: nm });
      tokens.set('student', token);
      localStorage.setItem('cr_dev_sid', sid); localStorage.setItem('cr_dev_name', nm); localStorage.setItem('cr_dev_email', em);
      await student.post('/session');
      sessionStorage.removeItem('cr_return');
      state.standing = null;
      go(ret);
    } catch (e) { err.textContent = friendly(e); }
  });
}
async function pageAuth(q) {
  if (q.token) { tokens.set('student', q.token); try { await student.post('/session'); } catch { /* retried later */ } }
  const ret = sessionStorage.getItem('cr_return') || '#/rooms';
  sessionStorage.removeItem('cr_return');
  go(ret);
}
function signOut() { tokens.clear('student'); state.user = null; state.standing = null; state.unread = 0; go('#/'); }

/* ------------------------------ rooms (search, soon, released) ------------------------------ */
function defaultFilters(q = {}) {
  const c = state.cfg; const g = c.time_grid_minutes; const now = new Date(); const p = T.parts(now);
  let ds = T.dateStr(now);
  let mins = Math.ceil((p.hour * 60 + p.minute + 1) / g) * g;
  if (mins >= 21 * 60) { ds = T.addDays(ds, 1); mins = 10 * 60; }
  const fmtM = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
  return { view: 'search', date: ds, start: fmtM(mins), end: fmtM(mins + 60), near: '', cap: '', type: q.type || '', name: '', purpose: '', amen: [] };
}
const toM = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const fromM = (m) => (m >= 1440 ? '24:00' : `${pad(Math.floor(m / 60))}:${pad(m % 60)}`);
const DURATIONS = [30, 60, 90, 120, 180];

async function pageRooms(q) {
  await loadLists();
  if (!state.f || q.type !== undefined) state.f = { ...(state.f || defaultFilters(q)), ...(q.type !== undefined ? { type: q.type } : {}) };
  state.f.view = q.view === 'soon' || q.view === 'released' ? q.view : 'search';
  shell(roomsShell(), { active: 'rooms' });
  await loadResults();
  every(1000, tickFresh);
  every(20000, () => { if (!document.hidden && !state.loading) loadResults(false, true); });
}

function timeOptions(ds, sel, mode) {
  const c = state.cfg; const g = c.time_grid_minutes;
  const now = new Date(); const today = T.dateStr(now);
  const nowM = T.parts(now).hour * 60 + T.parts(now).minute;
  let opts = [];
  if (mode === 'start') {
    for (let m = 6 * 60; m <= 23 * 60 + 30; m += g) if (ds !== today || m > nowM - g + 1) opts.push(fromM(m));
  } else {
    const sm = toM(state.f.start);
    for (let m = sm + g; m <= Math.min(sm + c.duration_max_minutes, 1440); m += g) opts.push(fromM(m));
  }
  return opts.map((t) => html`<option value="${t}" ${t === sel ? 'selected' : ''}>${t}</option>`);
}

function roomsShell() {
  const f = state.f; const c = state.cfg;
  const dates = Array.from({ length: c.horizon_days + 1 }, (_, i) => T.addDays(T.dateStr(new Date()), i));
  const now = new Date();
  const activeDur = (toM(f.end) - toM(f.start));
  const isSearch = f.view === 'search';
  return html`<div class="wrap">
    <div class="page-head"><div><div class="eyebrow">A little space to do big things</div><h1 class="display" style="margin-bottom:6px;font-size:clamp(36px,5vw,60px)">Find your next focus spot.</h1>
      <p class="lead" style="margin:0">A quiet hour, a group project, a room that works for you.</p></div>
      <div class="muted" style="font-size:15px">${T.longDate(now)}</div></div>
    <div class="seg" role="tablist"><a href="#/rooms" class="${isSearch ? 'active' : ''}">Search by time</a><a href="#/rooms?view=soon" class="${f.view === 'soon' ? 'active' : ''}">Available soon</a><a href="#/rooms?view=released" class="${f.view === 'released' ? 'active' : ''}">Just released</a></div>
    ${isSearch ? html`<div class="searchbar" id="sbar">
      <div class="field-b"><label for="f-date">Date</label><select id="f-date" class="sel sb-sel" data-f="date">${dates.map((d) => html`<option value="${d}" ${d === f.date ? 'selected' : ''}>${T.shortDate(d)}</option>`)}</select></div>
      <div class="field-b"><label for="f-start">Start time</label><select id="f-start" class="sel sb-sel" data-f="start">${timeOptions(f.date, f.start, 'start')}</select></div>
      <div class="field-b"><label for="f-end">End time</label><select id="f-end" class="sel sb-sel" data-f="end">${timeOptions(f.date, f.end, 'end')}</select></div>
      <div class="chips" aria-label="Booking duration">${DURATIONS.filter((d) => d >= c.duration_min_minutes && d <= c.duration_max_minutes).map((d) => html`<button type="button" class="chip-btn ${activeDur === d ? 'on' : ''}" data-act="dur" data-d="${d}">${T.minutes(d)}</button>`)}</div>
      <div class="spacer"><span class="small muted">All times in ${T.TZ_LABEL}</span><button class="btn btn-primary" data-act="search">Find a room ${icons.arrow}</button></div>
    </div>` : ''}
    <div id="suspbanner"></div>
    <div class="layout"><aside class="filters" id="filters">${filtersHtml()}</aside><section><div id="results"><div class="skeleton"></div><div class="skeleton"></div></div></section></div>
  </div>`;
}
function filtersHtml() {
  const f = state.f;
  return html`<h3>Refine your search</h3><hr>
    <div class="fgroup"><b>Building</b><select class="sel" data-f="near" aria-label="Building"><option value="">All buildings</option>${state.buildings.map((b) => html`<option value="${b.building_id}" ${String(f.near) === String(b.building_id) ? 'selected' : ''}>${f.near === '' ? '' : 'Nearest to '}${b.name}</option>`)}</select><div class="small muted" style="margin-top:6px">Choosing one lists the closest rooms first.</div></div>
    <div class="fgroup"><b>People</b><select class="sel" data-f="cap" aria-label="Group size"><option value="">Any group size</option>${[2, 4, 6, 8, 10, 12, 20, 30].map((n) => html`<option value="${n}" ${String(f.cap) === String(n) ? 'selected' : ''}>${n}+ people</option>`)}</select></div>
    <div class="fgroup"><b>Room type</b><select class="sel" data-f="type" aria-label="Room type"><option value="">Any type</option>${[['study', 'Study'], ['group', 'Group'], ['seminar', 'Seminar'], ['other', 'Other']].map(([v, l]) => html`<option value="${v}" ${f.type === v ? 'selected' : ''}>${l}</option>`)}</select></div>
    <div class="fgroup"><b>Room name</b><input class="inp" data-f="name" aria-label="Room name or code" placeholder="e.g. ENG-201" value="${f.name}"></div>
    <div class="fgroup"><b>What it’s for</b><select class="sel" data-f="purpose" aria-label="Purpose"><option value="">Anything</option>${state.purposes.map((p) => html`<option value="${p.purpose_id}" ${String(f.purpose) === String(p.purpose_id) ? 'selected' : ''}>${p.label}</option>`)}</select></div>
    <div class="fgroup"><b>Room features</b>${state.amenities.map((a) => html`<label class="check"><input type="checkbox" data-amen="${a.amenity_id}" ${f.amen.includes(String(a.amenity_id)) ? 'checked' : ''}> ${a.name}</label>`)}</div>
    <button class="link" data-act="clear">Clear filters</button>`;
}

async function loadResults(append = false, quiet = false) {
  const f = state.f; if (!f) return;
  const box = document.getElementById('results'); if (!box) return;
  state.loading = true;
  if (!append && !quiet) box.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
  const q = { limit: PAGE, offset: append ? state.items.length : 0, min_capacity: f.cap, type: f.type, name: f.name, purpose: f.purpose, amenities: f.amen, near_building: f.near };
  try {
    let res;
    if (f.view === 'search') res = await student.get('/rooms/search', { ...q, date: f.date, start: f.start, end: f.end });
    else if (f.view === 'soon') res = await student.get('/rooms/available-soon', q);
    else res = await student.get('/rooms/released', q);
    state.res = res;
    state.items = append ? [...state.items, ...(res.rooms || res.slots)] : (res.rooms || res.slots);
    state.paused = !!res.booking_paused;
    const sb = document.getElementById('suspbanner');
    if (sb) sb.innerHTML = suspended() ? out(html`<div class="banner warn">${icons.info}<div class="grow"><b>Booking is paused until ${T.longDate(new Date(state.standing.suspended_until))}.</b> You’ve had ${state.standing.no_shows_30d} no-shows in ${state.standing.no_show_window_days} days. You can still search.</div></div>`) : '';
    paintResults();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) throw e;
    const msg = e.code === 'OUT_OF_HORIZON' ? 'That time has already started or is too far ahead. Pick a later time.' : e.code === 'INVALID_RANGE' ? 'Check the start and end times.' : friendly(e);
    box.innerHTML = out(html`<div class="empty"><h2>Couldn’t search.</h2><p class="muted">${msg}</p><div class="row"><button class="btn btn-primary" data-act="search">Try again</button></div></div>`);
  } finally { state.loading = false; }
}

function tickFresh() {
  const el = document.getElementById('fresh-ago');
  if (el && state.res?.as_of) el.textContent = `Updated ${T.ago(state.res.as_of)}`;
}

function paintResults() {
  const box = document.getElementById('results'); if (!box) return;
  const f = state.f; const res = state.res; const items = state.items;
  const head = (title) => html`<div class="results-head"><h2>${title}</h2><button class="link show-m" data-act="filters" style="text-decoration:none;font-weight:600">Filters \u2304</button><div class="fresh"><span class="live"></span><span id="fresh-ago">Updated ${T.ago(res.as_of)}</span> · <button class="link" data-act="refresh" style="color:var(--green);text-decoration:none">Refresh ${icons.refresh}</button></div></div>`;
  if (!items.length) {
    const t = f.view === 'search'
      ? ['No rooms for this time.', `Nothing matches ${T.longDate(T.toInstant(f.date, '12:00')).replace(/^\w+, /, (m) => m)}, ${f.start}–${f.end} ${T.TZ_LABEL}. Try another time or remove a filter.`]
      : f.view === 'soon' ? ['Nothing free soon.', `No rooms are free in the next ${state.cfg.available_soon_window_minutes} minutes. Try searching by time.`]
        : ['Nothing just released.', `Cancelled and no-show slots appear here for ${T.minutes(state.cfg.just_released_window_minutes)}.`];
    box.innerHTML = out(html`${head('0 rooms available')}<div class="empty"><div class="ico">${icons.mark}</div><h2>${t[0]}</h2><p class="muted">${t[1]}</p>
      <div class="row">${f.view === 'search' ? html`<button class="btn btn-primary" data-act="focus-time">Change time</button>` : html`<a class="btn btn-primary" href="#/rooms">Search by time</a>`}<button class="btn btn-outline" data-act="clear">Clear filters</button></div>
      <div class="small muted" style="margin-top:18px">Updated just now · <button class="link" data-act="refresh">Refresh</button></div></div>`);
    return;
  }
  const susp = suspended();
  const rows = items.map((r, i) => roomRow(r, i, susp));
  const total = res.total;
  const title = f.view === 'search' ? `${total} room${total === 1 ? '' : 's'} available` : f.view === 'soon' ? `${total} free soon` : `${total} just released`;
  box.innerHTML = out(html`${head(title)}${rows}
    <div class="more-row"><span>Showing ${items.length} of ${total} rooms${f.view === 'search' ? ' · Available for your full time slot' : ''}</span>${items.length < total ? html`<button class="link" data-act="more">Show ${Math.min(PAGE, total - items.length)} more ${icons.arrowDown}</button>` : ''}</div>`);
}

function roomRow(r, i, susp) {
  const f = state.f; let start; let end; let slot; let sub;
  const g = state.cfg.time_grid_minutes;
  if (f.view === 'search') {
    start = r.available.start; end = r.available.end;
    slot = html`<b>${T.range(start, end)}</b><span>Available for ${T.minutes((new Date(end) - new Date(start)) / 60000)}</span>`;
  } else if (f.view === 'soon') {
    const now = new Date();
    const ff = new Date(r.free_from);
    let s = ff;
    if (r.free_now) { const p = T.parts(now); const m = Math.ceil((p.hour * 60 + p.minute + (now.getSeconds() > 0 ? 1 : 0)) / g) * g; s = T.toInstant(T.dateStr(now), fromM(m)); if (s < now) s = new Date(s.getTime() + g * 60000); }
    const avail = r.available_minutes == null ? 180 : Math.max(g, r.available_minutes - Math.round((s - ff) / 60000));
    const len = Math.min(60, state.cfg.duration_max_minutes, Math.max(state.cfg.duration_min_minutes, Math.floor(avail / g) * g));
    start = s.toISOString(); end = new Date(s.getTime() + len * 60000).toISOString();
    slot = html`<b>${r.free_now ? 'Free now' : `Free from ${T.timeStr(ff)}`}</b><span>${r.available_minutes == null ? 'Free for the rest of the day' : `Free for ${T.minutes(r.available_minutes)}`}</span>`;
  } else {
    start = r.start; end = new Date(Math.min(new Date(r.end), new Date(new Date(r.start).getTime() + state.cfg.duration_max_minutes * 60000))).toISOString();
    slot = html`<b>${T.range(r.start, r.end)}</b><span class="warn">Released ${T.ago(r.released_at)} · ${r.reason === 'no_show' ? 'no-show' : 'cancelled'}</span>`;
  }
  sub = [r.building.name, `${r.capacity} people`, r.distance_km != null ? `${r.distance_km} km away` : null].filter(Boolean).join(' · ');
  return html`<div class="room-row">
    ${roomTile(r.code, i === 0)}
    <div class="room-info"><h3>${r.code}</h3><p>${sub} · ${r.type[0].toUpperCase() + r.type.slice(1)}</p><p class="small">${r.amenities.map((a) => a.name).join(' · ')}</p></div>
    <div class="room-slot">${slot}</div>
    <button class="btn btn-outline" data-act="book" data-room="${r.room_id}" data-code="${r.code}" data-start="${start}" data-end="${end}" ${susp ? `disabled title="Booking is paused until ${T.longDate(new Date(state.standing.suspended_until))}"` : ''}>Book room</button></div>`;
}

/* ------------------------------ review and confirm ------------------------------ */
function bookingErrorMessage(e) {
  const d = e.data || {};
  switch (e.code) {
    case 'WEEKLY_LIMIT_REACHED': return `You’ve used ${d.used} of ${d.limit} bookings this week. It resets ${T.longDate(new Date(d.resets_at)).replace(/^\w+,/, (m) => m)}.`;
    case 'ALREADY_BOOKED_THIS_ROOM': return 'You already have this room booked. Manage it in My bookings.';
    case 'SUSPENDED': return `Booking is paused until ${T.longDate(new Date(d.suspended_until))}. You can still search.`;
    case 'OFF_GRID': return `Start and end must be on the ${state.cfg.time_grid_minutes}-minute grid.`;
    case 'DURATION_NOT_ALLOWED': return `Bookings are ${T.minutes(d.min_minutes)} to ${T.minutes(d.max_minutes)}. Pick a different end time.`;
    case 'OUTSIDE_OPENING_HOURS': return `This room is open ${d.opens_at} to ${d.closes_at}. Pick a time inside those hours.`;
    case 'IN_PAST': return 'That time has already started. Pick a later time.';
    case 'OUT_OF_HORIZON': return `You can book up to ${d.horizon_days || state.cfg.horizon_days} days ahead.`;
    case 'ROOM_CLOSED': return 'The campus is closed for this room on that day.';
    case 'ROOM_NOT_FOUND': return 'This room is no longer available.';
    case 'ATTENDEE_EMAIL_INVALID_DOMAIN': return `${d.email} isn’t a university email. Use an address ending @${d.domain}.`;
    case 'TOO_MANY_ATTENDEES': return `This room holds ${d.capacity} people including you.`;
    case 'ATTENDEES_NOT_ALLOWED': return 'Only group rooms take other people.';
    case 'UNKNOWN_PURPOSE': return 'Choose what you’ll use the room for.';
    default: return friendly(e);
  }
}

async function pageReview(q) {
  await loadLists();
  const { room: roomId, code, start, end } = q;
  if (!roomId || !start || !end) return go('#/rooms');
  shell(html`<div class="wrap"><div class="skeleton" style="margin-top:80px;height:240px"></div></div>`, { active: 'rooms' });
  let room = null;
  try {
    const r = await student.get('/rooms/search', { name: code, start, end, limit: 5 });
    state.paused = !!r.booking_paused;
    room = r.rooms.find((x) => x.room_id === roomId) || null;
  } catch (e) {
    if (e.status === 401) throw e;
    if (e.code === 'OUT_OF_HORIZON' || e.code === 'INVALID_RANGE') {
      return shell(html`<div class="wrap"><div class="empty"><h2>That time has passed.</h2><p class="muted">Pick a new time to continue.</p><div class="row"><a class="btn btn-primary" href="#/rooms">Find a room</a></div></div></div>`, { active: 'rooms' });
    }
    throw e;
  }
  if (!room) {
    // not free any more: same screen as losing a race (E6)
    const cur = { room_id: roomId, code, start, end };
    let alts = { same_time: [], same_room_later: null };
    try { const r = await student.get('/rooms/search', { start, end, limit: 3 }); alts.same_time = r.rooms.filter((x) => x.room_id !== roomId); } catch { /* ignore */ }
    return pageTaken(cur, alts);
  }
  state.rv = { room, start, end, attendees: [], purposeId: '', key: uuid(), pending: false, error: '' };
  const fit = state.purposes.filter((p) => !p.suggested_room_types.length || p.suggested_room_types.includes(room.type));
  state.rv.purposeId = fit[0]?.purpose_id ?? '';
  drawReview(fit);
}

function drawReview(fit) {
  const rv = state.rv; const room = rv.room; const s = new Date(rv.start); const e = new Date(rv.end);
  const dur = (e - s) / 60000;
  const st = state.standing;
  const countLine = st ? (sameWeek(rv.start) ? `This will be booking ${st.used_this_week + 1} of ${st.weekly_limit} this week.` : `You have ${st.used_this_week} of ${st.weekly_limit} bookings used this week. This one counts toward the week it falls in.`) : '';
  const isGroup = room.type === 'group';
  const cap = room.capacity;
  shell(html`<div class="wrap"><a class="back link" href="#/rooms" style="text-decoration:underline">← Back to available rooms</a>
    <div class="split"><div>
      <div class="eyebrow">Your space for the next ${T.minutes(dur).replace(/^1 hour$/, 'hour')}</div><h1 class="display" style="font-size:clamp(40px,5vw,64px)">A room for<br>your next idea.</h1>
      ${bigTile(room)}
      <p class="muted small" style="margin-top:18px">↳ ${room.building.name}. The room number is on the door.</p></div>
    <div><h2 class="h1" style="font-size:clamp(34px,4vw,48px)">Make it yours.</h2><p class="muted">Check the details before you confirm.<br>We’ll check availability again when you book.</p>
      <div class="kv"><div><span>Room</span><b>${room.code} · ${room.building.name}</b></div><div><span>Date</span><b>${T.longDate(s)}</b></div><div><span>Time</span><b>${T.range(rv.start, rv.end)} ${T.TZ_LABEL} · ${T.minutes(dur)}</b></div></div>
      <div class="field"><label for="purpose">What will you use the room for?</label><select id="purpose" class="sel">${fit.map((p) => html`<option value="${p.purpose_id}" ${String(p.purpose_id) === String(rv.purposeId) ? 'selected' : ''}>${p.label}</option>`)}</select></div>
      ${isGroup ? html`<div class="field"><label for="att-in">Who’s coming? <span class="muted" style="font-weight:400">(optional)</span></label>
        <div style="display:flex;gap:8px"><input id="att-in" class="inp" type="email" placeholder="name@${state.cfg.university_email_domain}" autocomplete="off"><button class="btn btn-outline" type="button" data-act="att-add">Add</button></div>
        <div id="att-err" class="errtxt" role="alert"></div><div class="people-list" id="att-list"></div>
        <div class="cap" id="att-cap"></div></div>` : ''}
      ${countLine ? html`<div class="note">${icons.info} &nbsp;${countLine}<br><span style="padding-left:24px">You can manage or cancel it in My bookings.</span></div>` : ''}
      ${suspended() ? html`<div class="banner warn">${icons.info}<div class="grow">Booking is paused until ${T.longDate(new Date(st.suspended_until))}.</div></div>` : ''}
      <div id="rv-err" role="alert"></div>
      <button class="btn btn-primary btn-block" id="confirm" data-act="confirm" ${suspended() ? 'disabled' : ''}>Confirm booking ${icons.arrow}</button>
      <p class="muted small center" style="margin-top:14px">Your room is reserved only after confirmation.</p></div></div></div>`, { active: 'rooms' });
  if (isGroup) paintAttendees();
}
function bigTile(room) {
  const [pre, num] = room.code.split('-');
  return html`<div class="bigtile"><div class="top"><span>${room.building.name}</span><span>${room.type} room ${icons.arrow}</span></div><div class="num">${num}</div>
    <div class="foot">${room.type[0].toUpperCase() + room.type.slice(1)} · ${room.capacity} seats${room.amenities.length ? ' · ' + room.amenities.map((a) => a.name).join(' · ') : ''}</div></div>`;
  void pre;
}
function paintAttendees() {
  const rv = state.rv; const list = document.getElementById('att-list'); const cap = document.getElementById('att-cap');
  if (!list) return;
  list.innerHTML = out(rv.attendees.map((a, i) => html`<div class="person"><span>${a}</span><button class="link" data-act="att-del" data-i="${i}">Remove</button></div>`));
  const left = rv.room.capacity - 1 - rv.attendees.length;
  cap.textContent = `${rv.attendees.length + 1} of ${rv.room.capacity} seats (including you). ${left} left.`;
}

async function confirmBooking() {
  const rv = state.rv; if (!rv || rv.pending) return;
  const btn = document.getElementById('confirm'); const err = document.getElementById('rv-err');
  rv.pending = true; btn.disabled = true; btn.textContent = 'Confirming…'; err.innerHTML = '';
  try {
    const body = { room_id: rv.room.room_id, start: rv.start, end: rv.end, purpose_id: Number(document.getElementById('purpose').value), attendees: rv.attendees };
    const b = await student.post('/bookings', body, { 'Idempotency-Key': rv.key });
    state.bookings = {};
    state.bt = 'upcoming';
    flash('ok', `You’re booked. ${b.room.code} is yours ${T.dayLabel(new Date(b.start)).toLowerCase()}, ${T.range(b.start, b.end)} ${T.TZ_LABEL}.`);
    go('#/bookings');
  } catch (e) {
    rv.pending = false;
    const retryable = e.status === 0 || e.status === 503;
    if (!retryable) rv.key = uuid(); // a definitive answer: next attempt is a new request (E21)
    if (e.code === 'SLOT_TAKEN') {
      const alts = e.data.alternatives || { same_time: [], same_room_later: null };
      return pageTaken({ room_id: rv.room.room_id, code: rv.room.code, start: rv.start, end: rv.end, room: rv.room }, alts);
    }
    btn.disabled = false; btn.innerHTML = out(html`Confirm booking ${icons.arrow}`);
    const kind = ['SUSPENDED', 'WEEKLY_LIMIT_REACHED', 'ALREADY_BOOKED_THIS_ROOM'].includes(e.code) ? 'warn' : 'error';
    err.innerHTML = out(html`<div class="banner ${kind}" style="margin:0 0 16px">${icons.info}<div class="grow">${bookingErrorMessage(e)}</div></div>`);
    if (e.code === 'SUSPENDED') { await loadChrome(true); }
  }
}

function pageTaken(cur, alts) {
  const room = cur.room || { code: cur.code, building: { name: '' }, type: 'study', capacity: '', amenities: [] };
  const s = cur.start; const e = cur.end;
  const roomRows = (alts.same_time || []).map((r) => html`<div class="alt"><div><h4>${r.code}</h4><div class="muted">Same time · ${T.range(s, e)} · ${r.capacity} seats</div></div>
    <a class="btn btn-primary btn-sm" href="#/review?room=${r.room_id}&code=${r.code}&start=${encodeURIComponent(s)}&end=${encodeURIComponent(e)}">Choose room ${icons.arrow}</a></div>`);
  const later = alts.same_room_later ? html`<div class="alt"><div><h4>${room.code}</h4><div class="muted">Same room, later · ${T.range(alts.same_room_later.start, alts.same_room_later.end)}${room.capacity ? ` · ${room.capacity} seats` : ''}</div></div>
    <a class="btn btn-outline btn-sm" href="#/review?room=${cur.room_id}&code=${room.code}&start=${encodeURIComponent(alts.same_room_later.start)}&end=${encodeURIComponent(alts.same_room_later.end)}">Choose time ${icons.arrow}</a></div>` : '';
  const f = state.f;
  if (f) { f.date = T.dateStr(new Date(s)); f.start = T.timeStr(new Date(s)); f.end = T.timeStr(new Date(e)); }
  shell(html`<div class="wrap"><a class="back link" href="#/rooms" style="text-decoration:underline">← Back to available rooms</a>
    <div class="split"><div><div class="eyebrow">Your space for the next hour</div><h1 class="display" style="font-size:clamp(40px,5vw,64px)">A room for<br>your next idea.</h1>${cur.room ? bigTile(room) : ''}</div>
    <div><div class="eyebrow amber">Availability changed</div><h2 class="h1" style="font-size:clamp(34px,4vw,48px)">That room was just taken.</h2>
      <p class="muted">Someone booked ${room.code} before you confirmed.<br>Your booking wasn’t created. Let’s find another space.</p>
      <div class="note">Your original time was ${T.range(s, e)} ${T.TZ_LABEL}.<br>We kept it while looking for another room.</div>
      <h3 class="h3" style="margin-top:28px">Try one of these</h3><div class="small muted" style="margin-bottom:12px">Availability refreshed just now</div>
      <div class="alts">${roomRows}${later}${!roomRows.length && !later ? html`<div class="alt"><div class="muted">No other rooms are free at this exact time.</div></div>` : ''}</div>
      <p style="margin-top:20px"><a class="link" href="#/rooms">See all available rooms</a></p></div></div></div>`, { active: 'rooms' });
}

/* ------------------------------ my bookings ------------------------------ */
const STATUS = { CONFIRMED: ['CONFIRMED', ''], CHECKED_IN: ['CHECKED IN', ''], CANCELLED: ['CANCELLED', 'grey'], NO_SHOW: ['NO-SHOW', 'red'], COMPLETED: ['COMPLETED', 'grey'] };

async function fetchBookings() {
  try {
    const [up, past, inv] = await Promise.all([student.get('/me/bookings', { status: 'upcoming' }), student.get('/me/bookings', { status: 'past' }), student.get('/me/bookings', { status: 'invited' })]);
    state.bookings = { upcoming: up.bookings, past: past.bookings, invited: inv.bookings };
    try { localStorage.setItem('cr_cache_bookings', JSON.stringify({ at: Date.now(), up: up.bookings })); } catch { /* ignore */ }
  } catch (e) {
    if (e.status === 401) throw e;
    throw e;
  }
}

async function pageBookings() {
  shell(html`<div class="wrap"><div class="skeleton" style="margin-top:56px;height:120px"></div><div class="skeleton"></div></div>`, { active: 'bookings' });
  await fetchBookings();
  paintBookings();
  every(30000, () => { if (!document.hidden) paintBookings(); });
  every(60000, async () => { if (!document.hidden) { try { await fetchBookings(); await loadChrome(true); paintBookings(); } catch { /* keep showing */ } } });
}

function paintBookings() {
  if (parseHash().path !== 'bookings') return;
  const f = takeFlash(); const st = state.standing; const b = state.bookings;
  const tab = state.bt;
  const upcoming = b.upcoming; const invited = b.invited; const susp = suspended();
  const list = tab === 'upcoming' ? upcoming : b.past;
  const wasScroll = window.scrollY;
  const standingHtml = st ? html`<div class="standing"><div><b>This week: ${st.used_this_week} of ${st.weekly_limit} bookings used</b> <span class="muted">· Resets ${T.longDate(new Date(new Date(st.resets_at).getTime() - 1)).split(',')[0] === '' ? '' : `Monday, ${T.parts(new Date(st.resets_at)).day} ${T.monthName(new Date(st.resets_at))}`}</span></div>
    <div class="${st.no_shows_30d ? 'bad' : 'ok'}">${susp ? `Booking paused until ${T.parts(new Date(st.suspended_until)).day} ${T.monthName(new Date(st.suspended_until))}` : st.no_shows_30d ? `${st.no_shows_30d} no-show${st.no_shows_30d === 1 ? '' : 's'} in ${st.no_show_window_days} days` : 'Good standing · 0 no-shows'}</div></div>
    ${st.no_shows.length ? html`<details style="padding:14px 0;border-bottom:1px solid var(--line)"><summary style="cursor:pointer;font-weight:600">Recent no-shows (${st.no_shows.length} of ${st.noshow_threshold} before a pause)</summary>
      <div style="margin-top:10px">${st.no_shows.map((n) => html`<div class="small" style="padding:6px 0;display:flex;justify-content:space-between;max-width:520px"><span>${n.room_code} · ${T.longDate(new Date(n.start))}</span><span class="muted">${T.range(n.start, n.end)} ${T.TZ_LABEL}</span></div>`)}</div></details>` : ''}` : '';
  const invHtml = invited.length ? html`<h2 class="section-title">Invitations (${invited.length})</h2>${invited.map(inviteCard)}` : '';
  const empty = tab === 'upcoming' && !upcoming.length;
  $app.querySelector('#page').innerHTML = out(html`<div class="wrap">
    ${f ? html`<div class="banner ${f.kind === 'ok' ? '' : 'warn'}" role="status">${icons.check}<div class="grow">${f.text}</div></div>` : ''}
    <div class="page-head" style="padding-top:${f ? 36 : 56}px"><div><h1 class="display" style="font-size:clamp(34px,4.6vw,56px);margin:0 0 8px">Your space. Your schedule.</h1><p class="lead" style="margin:0">Everything you’ve booked, in one place.</p></div>
      ${upcoming.length || f || tab !== 'upcoming' ? html`<a class="btn btn-primary" href="#/rooms">Find another room ${icons.arrow}</a>` : ''}</div>
    <div style="border-bottom:1px solid var(--line);margin-top:28px"></div>${standingHtml}${invHtml}
    <div class="tabs" role="tablist"><button class="${tab === 'upcoming' ? 'active' : ''}" data-act="tab" data-t="upcoming">Upcoming (${upcoming.length})</button><button class="${tab === 'past' ? 'active' : ''}" data-act="tab" data-t="past">Past &amp; cancelled</button></div>
    ${empty ? html`<div class="empty"><div class="ico hot">${icons.mark}</div><h2>Your next good idea needs a room.</h2><p class="muted">You don’t have any upcoming bookings.<br>Find a space for your next study session or group project.</p><div class="row"><a class="btn btn-primary" href="#/rooms">Find a room ${icons.arrow}</a></div></div>`
      : list.length ? list.map((x, i) => bookingCard(x, i)) : html`<div class="empty"><h2 style="font-size:28px">Nothing here yet.</h2><p class="muted">Past and cancelled bookings from the last ${state.cfg.horizon_days * 0 + 90} days appear here.</p></div>`}
    ${tab === 'upcoming' && upcoming.length ? html`<p class="muted small" style="margin-top:28px">Plans changed? Cancel a room you won’t use so someone else can book it.</p>` : ''}
    ${tab === 'past' && f?.kind === 'ok' && upcoming.length ? html`<p class="muted small" style="margin-top:28px">Your ${upcoming[0].room.code} booking for ${T.dayLabel(new Date(upcoming[0].start)).toLowerCase()} is still in Upcoming.</p>` : ''}</div>`);
  window.scrollTo(0, wasScroll);
}

function whenLabel(x) { return `${T.dayLabel(new Date(x.start))} · ${T.range(x.start, x.end)} ${T.TZ_LABEL}`; }
function dateBox(x, hot) {
  const d = new Date(x.start);
  return html`<div class="datebox ${hot ? 'hot' : ''}"><small>${T.monthShort(d)}</small><b>${T.parts(d).day}</b><small style="text-transform:none;letter-spacing:0">${T.weekdayName(d)}</small></div>`;
}

function checkInBlock(x) {
  const now = new Date(); const opens = new Date(x.check_in_opens_at); const closes = new Date(x.check_in_closes_at);
  if (x.status === 'CHECKED_IN') return html`<span class="status">CHECKED IN</span>`;
  if (now < opens) return html`<button class="btn btn-ghost" disabled>Check in · opens ${T.timeStr(opens)}</button><div class="small muted">Opens ${state.cfg.checkin_open_before_minutes} min before your slot</div>`;
  if (now <= closes) return html`<button class="btn btn-primary" data-act="checkin" data-id="${x.booking_id}">Check in ${icons.arrow}</button><div class="small muted">Open until ${T.timeStr(closes)}</div>`;
  return html`<div class="small muted">Check-in window closed</div>`;
}

function attendeesHtml(x) {
  if (!x.attendees.length) return '';
  const label = { invited: 'waiting', accepted: 'accepted', declined: 'declined' };
  return html`<div class="attendees" aria-label="People invited">${x.attendees.map((a) => html`<span class="att ${a.status}">${a.name || a.email} · ${label[a.status]}</span>`)}</div>`;
}

function bookingCard(x, idx) {
  const [lbl, cls] = STATUS[x.status];
  const active = x.status === 'CONFIRMED' || x.status === 'CHECKED_IN';
  const future = new Date(x.start) > new Date();
  const inv = x.role === 'invitee';
  let acts = '';
  if (active && !inv) {
    acts = html`${x.status === 'CONFIRMED' ? checkInBlock(x) : checkInBlock(x)}
      ${x.status === 'CONFIRMED' && future ? html`<button class="link" data-act="cancel" data-id="${x.booking_id}">Cancel booking</button>` : ''}
      ${x.room.type === 'group' && future ? html`<button class="link" data-act="people" data-id="${x.booking_id}">Edit people</button>` : ''}`;
  } else if (inv && active) {
    acts = html`<span class="status ${x.my_invitation === 'accepted' ? '' : 'amber'}">${x.my_invitation === 'accepted' ? 'YOU’RE GOING' : 'INVITED'}</span>
      ${future ? html`<button class="link" data-act="leave" data-id="${x.booking_id}">Can’t make it</button>` : ''}`;
  } else if (x.status === 'CANCELLED') acts = html`<span class="muted small">This booking is no longer active.</span>`;
  else if (x.status === 'NO_SHOW') acts = html`<span class="muted small">Released after no check-in.</span>`;
  else acts = html`<span class="muted small">Completed.</span>`;
  const foot = x.status === 'CANCELLED' ? `Cancelled ${T.ago(x.cancelled_at)} · Reference ${x.reference}` : `Booking reference ${x.reference}`;
  return html`<article class="bcard" ${inv ? '' : ''}>
    ${dateBox(x, idx === 0 && active && future !== undefined && x.role === 'booker')}
    <div><div><h3><a href="#/bookings/${x.booking_id}" style="text-decoration:none">${x.room.code}</a></h3><span class="status ${cls}">${inv ? 'INVITED BY ' + (x.booker.name || '').toUpperCase() : lbl}</span></div>
      <div class="when">${whenLabel(x)}</div>
      <p>${x.room.building.name} · ${x.purpose.label}${x.role === 'invitee' ? '' : ''}</p><p class="small">${foot}</p>${attendeesHtml(x)}</div>
    <div class="acts">${acts}</div></article>`;
}

function inviteCard(x) {
  return html`<article class="bcard">
    ${dateBox(x, false)}
    <div><div><h3>${x.room.code}</h3><span class="status amber">INVITATION</span></div>
      <div class="when">${whenLabel(x)}</div><p>${x.room.building.name} · ${x.purpose.label}</p>
      <p class="small">${x.booker.name} invited you${x.attendees.length > 1 ? ` and ${x.attendees.length - 1} other${x.attendees.length > 2 ? 's' : ''}` : ''}. Booking reference ${x.reference}</p>${attendeesHtml(x)}</div>
    <div class="acts"><button class="btn btn-primary btn-sm" data-act="accept" data-id="${x.booking_id}">Accept ${icons.arrow}</button><button class="btn btn-outline btn-sm" data-act="decline" data-id="${x.booking_id}">Decline</button></div></article>`;
}

function cancelModal(x) {
  const m = modal(html`<h2>Give this room back?</h2><p class="muted">Cancelling releases your slot so another student can use it.<br>You’ll need to book again if your plans change.</p>
    <div class="box"><b>${x.room.code} · ${x.room.building.name}</b><div class="small" style="margin-top:6px">${T.dayLabel(new Date(x.start))}, ${T.parts(new Date(x.start)).day} ${T.monthName(new Date(x.start))} · ${T.range(x.start, x.end)} ${T.TZ_LABEL}</div>${x.attendees.length ? html`<div class="small muted" style="margin-top:6px">${x.attendees.length} invited ${x.attendees.length === 1 ? 'person' : 'people'} will be told.</div>` : ''}</div>
    <div class="errtxt" id="m-err" role="alert"></div>
    <div class="row"><button class="btn btn-outline" data-m="keep">Keep booking</button><button class="btn btn-dark" data-m="yes">Yes, cancel booking</button></div>`);
  m.el.addEventListener('click', async (ev) => {
    const a = ev.target.closest('[data-m]'); if (!a) return;
    if (a.dataset.m === 'keep') return m.close();
    a.disabled = true;
    try {
      await student.post(`/bookings/${x.booking_id}/cancel`);
      m.close(); state.bt = 'past';
      flash('ok', `Booking cancelled. ${x.room.code} is available for others to book again.`);
      await fetchBookings(); await loadChrome(true);
      if (parseHash().parts[0] === 'bookings' && parseHash().parts[1]) go('#/bookings'); else paintBookings();
    } catch (e) {
      a.disabled = false;
      m.el.querySelector('#m-err').textContent = e.code === 'ALREADY_STARTED' ? 'This booking has started, so it can’t be cancelled. Check in instead.' : friendly(e);
      if (e.code === 'ALREADY_STARTED') { await fetchBookings(); }
    }
  });
}

function peopleModal(x) {
  let list = x.attendees.map((a) => a.email);
  const dom = state.cfg.university_email_domain;
  const draw = () => html`<h2>Who’s coming?</h2><p class="muted">Invite other students to ${x.room.code}. They’ll be asked to accept.</p>
    <div class="field"><div style="display:flex;gap:8px"><input id="pm-in" class="inp" type="email" placeholder="name@${dom}"><button class="btn btn-outline" data-m="add">Add</button></div><div class="errtxt" id="m-err" role="alert"></div>
    <div class="people-list">${list.map((e, i) => html`<div class="person"><span>${e}</span><button class="link" data-m="del" data-i="${i}">Remove</button></div>`)}</div>
    <div class="cap">${list.length + 1} of ${x.room.capacity} seats (including you)</div></div>
    <div class="row"><button class="btn btn-outline" data-m="close">Close</button><button class="btn btn-primary" data-m="save">Save ${icons.arrow}</button></div>`;
  const m = modal(draw());
  const repaint = () => { m.el.innerHTML = out(draw()); m.el.querySelector('#pm-in')?.focus(); };
  m.el.addEventListener('click', async (ev) => {
    const a = ev.target.closest('[data-m]'); if (!a) return; const err = m.el.querySelector('#m-err');
    if (a.dataset.m === 'close') return m.close();
    if (a.dataset.m === 'del') { list.splice(Number(a.dataset.i), 1); return repaint(); }
    if (a.dataset.m === 'add') {
      const v = m.el.querySelector('#pm-in').value.trim().toLowerCase();
      if (!v) return;
      if (!v.endsWith(`@${dom}`)) { err.textContent = `Use a university email ending @${dom}.`; return; }
      if (v === state.user.email) { err.textContent = 'You’re already in the booking.'; return; }
      if (list.includes(v)) { err.textContent = 'Already added.'; return; }
      if (list.length + 1 >= x.room.capacity) { err.textContent = `This room holds ${x.room.capacity} people including you.`; return; }
      list.push(v); return repaint();
    }
    if (a.dataset.m === 'save') {
      a.disabled = true;
      try { await student.put(`/bookings/${x.booking_id}/attendees`, { attendees: list }); m.close(); flash('ok', 'People updated. Newly added students have been invited.'); await fetchBookings(); if (parseHash().parts[1]) route(); else paintBookings(); }
      catch (e) { a.disabled = false; err.textContent = bookingErrorMessage(e); }
    }
  });
}
const route = () => render();

/* ------------------------------ booking detail ------------------------------ */
async function pageBookingDetail(id) {
  let x;
  try { x = await student.get(`/bookings/${id}`); } catch (e) {
    if (e.status === 404) return shell(html`<div class="wrap"><div class="empty"><h2>We can’t find that booking.</h2><p class="muted">It may not be yours, or it was removed.</p><div class="row"><a class="btn btn-primary" href="#/bookings">My bookings</a></div></div></div>`, { active: 'bookings' });
    throw e;
  }
  const [lbl, cls] = STATUS[x.status]; const s = new Date(x.start); const dur = (new Date(x.end) - s) / 60000;
  const active = ['CONFIRMED', 'CHECKED_IN'].includes(x.status); const future = s > new Date(); const inv = x.role === 'invitee';
  shell(html`<div class="wrap"><a class="back link" href="#/bookings" style="text-decoration:underline">← Back to my bookings</a>
    <div class="split"><div><div class="eyebrow">${x.reference}</div><h1 class="display" style="font-size:clamp(40px,5vw,64px)">${T.dayLabel(s)}, ${T.range(x.start, x.end)}</h1>${bigTile({ ...x.room, amenities: [] })}</div>
    <div><span class="status ${cls}">${lbl}</span><h2 class="h1" style="font-size:clamp(30px,3.6vw,44px);margin-top:12px">${x.room.code} · ${x.room.building.name}</h2>
      <div class="kv"><div><span>Date</span><b>${T.longDate(s)}</b></div><div><span>Time</span><b>${T.range(x.start, x.end)} ${T.TZ_LABEL} · ${T.minutes(dur)}</b></div><div><span>Purpose</span><b>${x.purpose.label}</b></div><div><span>Booked by</span><b>${x.booker.name}</b></div></div>
      ${x.attendees.length ? html`<h3 class="h3">People</h3>${attendeesHtml(x)}` : ''}
      <div style="margin-top:28px;display:flex;gap:16px;flex-wrap:wrap;align-items:center">
        ${active && !inv ? checkInBlock(x) : ''}
        ${inv && active && future ? html`<button class="btn btn-primary" data-act="accept" data-id="${x.booking_id}">Accept</button><button class="btn btn-outline" data-act="decline" data-id="${x.booking_id}">Decline</button>` : ''}
        ${active && !inv && x.status === 'CONFIRMED' && future ? html`<button class="link link-danger" data-act="cancel" data-id="${x.booking_id}">Cancel booking</button>` : ''}
        ${active && !inv && x.room.type === 'group' && future ? html`<button class="link" data-act="people" data-id="${x.booking_id}">Edit people</button>` : ''}</div></div></div></div>`, { active: 'bookings' });
  state.detail = x;
  every(30000, () => { if (!document.hidden) render(); });
}

/* ------------------------------ notifications ------------------------------ */
async function pageNotifications() {
  const r = await student.get('/me/notifications', { limit: 100 });
  state.unread = r.unread;
  shell(html`<div class="wrap"><div class="page-head"><div><h1 class="display" style="font-size:clamp(34px,4.6vw,56px);margin:0 0 8px">Notifications.</h1><p class="lead" style="margin:0">Confirmations, reminders and notices about your bookings.</p></div>
    ${r.unread ? html`<button class="btn btn-outline" data-act="readall">Mark all read</button>` : ''}</div>
    <div class="nlist">${r.notifications.length ? r.notifications.map((n) => html`<div class="nitem ${n.read ? 'read' : ''}"><span class="dot"></span><div><b>${n.title}</b><span>${n.body}</span>${n.booking_id ? html`<div style="margin-top:6px"><a class="link" href="#/bookings/${n.booking_id}">View booking</a></div>` : ''}</div><time>${T.ago(n.at)}</time></div>`)
      : html`<div class="empty"><div class="ico">${icons.bell}</div><h2>All caught up.</h2><p class="muted">You’ll see confirmations, reminders and notices here.</p></div>`}</div></div>`, { active: '' });
  if (r.unread) { await student.post('/me/notifications/read-all').catch(() => {}); }
}

/* ------------------------------ errors ------------------------------ */
function pageNotFound() {
  shell(html`<div class="wrap"><div class="empty"><div class="ico">${icons.mark}</div><h2>We can’t find that page.</h2><p class="muted">The link may be old or mistyped.</p><div class="row"><a class="btn btn-primary" href="#/rooms">Find a room</a><a class="btn btn-outline" href="#/">Home</a></div></div></div>`);
}
function pageOutage(e) {
  let cached = [];
  try { cached = JSON.parse(localStorage.getItem('cr_cache_bookings') || '{}').up || []; } catch { /* ignore */ }
  shell(html`<div class="wrap"><div class="empty"><div class="ico">${icons.info}</div><h2>Service unavailable.</h2><p class="muted">${friendly(e)} Your bookings are still valid.</p><div class="row"><button class="btn btn-primary" data-act="reload">Try again</button></div></div>
    ${cached.length ? html`<h2 class="section-title">Your last known bookings</h2><p class="small muted">Saved on this device. They may be out of date.</p>${cached.map((x, i) => bookingCardStatic(x, i))}` : ''}</div>`, { active: '' });
}
function bookingCardStatic(x, i) {
  return html`<article class="bcard">${dateBox(x, i === 0)}<div><h3>${x.room.code}</h3><span class="status">${STATUS[x.status][0]}</span><div class="when">${whenLabel(x)}</div><p>${x.room.building.name} · ${x.purpose.label}</p><p class="small">Booking reference ${x.reference}</p></div><div></div></article>`;
}

/* ------------------------------ events ------------------------------ */
function findBooking(id) {
  return [...(state.bookings.upcoming || []), ...(state.bookings.past || []), ...(state.bookings.invited || [])].find((b) => b.booking_id === id) || (state.detail?.booking_id === id ? state.detail : null);
}
async function respond(id, kind) {
  try { await student.post(`/bookings/${id}/invitation/${kind}`); flash('ok', kind === 'accept' ? 'You’re in. The booker has been told.' : 'Invitation declined. The booker has been told.'); }
  catch (e) { flash('warn', e.code === 'ALREADY_STARTED' ? 'That booking has already started.' : e.code === 'NOT_ACTIVE' ? 'That booking is no longer active.' : friendly(e)); }
  await loadChrome(true);
  if (parseHash().parts[1]) return render();
  await fetchBookings(); paintBookings();
}

const actions = {
  menu: () => { state.menu = !state.menu; rerenderNav(); },
  bell: () => go('#/notifications'),
  signout: () => signOut(),
  search: () => { state.items = []; loadResults(); },
  refresh: () => loadResults(),
  filters: () => { state.filtersOpen = !state.filtersOpen; document.getElementById('filters')?.classList.toggle('open', state.filtersOpen); },
  more: () => loadResults(true),
  clear: () => { state.f = { ...defaultFilters(), view: state.f.view, date: state.f.date, start: state.f.start, end: state.f.end }; shell(roomsShell(), { active: 'rooms' }); loadResults(); },
  'focus-time': () => document.getElementById('f-start')?.focus(),
  dur: (el) => {
    const f = state.f; const d = Number(el.dataset.d); f.end = fromM(Math.min(toM(f.start) + d, 1440));
    document.getElementById('f-end').innerHTML = out(timeOptions(f.date, f.end, 'end')); document.querySelectorAll('[data-act=dur]').forEach((b) => b.classList.toggle('on', b === el)); loadResults();
  },
  book: (el) => go(`#/review?room=${el.dataset.room}&code=${el.dataset.code}&start=${encodeURIComponent(el.dataset.start)}&end=${encodeURIComponent(el.dataset.end)}`),
  confirm: () => confirmBooking(),
  'att-add': () => {
    const rv = state.rv; const inp = document.getElementById('att-in'); const err = document.getElementById('att-err');
    const v = inp.value.trim().toLowerCase(); err.textContent = '';
    if (!v) return;
    const dom = state.cfg.university_email_domain;
    if (!/^[^@\s]+@[^@\s]+$/.test(v) || !v.endsWith(`@${dom}`)) { err.textContent = `Use a university email ending @${dom}.`; return; }
    if (v === state.user.email) { err.textContent = 'You’re already in the booking.'; return; }
    if (rv.attendees.includes(v)) { err.textContent = 'Already added.'; return; }
    if (rv.attendees.length + 1 >= rv.room.capacity) { err.textContent = `This room holds ${rv.room.capacity} people including you.`; return; }
    rv.attendees.push(v); inp.value = ''; paintAttendees(); inp.focus();
  },
  'att-del': (el) => { state.rv.attendees.splice(Number(el.dataset.i), 1); paintAttendees(); },
  tab: (el) => { state.bt = el.dataset.t; paintBookings(); },
  cancel: (el) => { const x = findBooking(el.dataset.id); if (x) cancelModal(x); },
  people: (el) => { const x = findBooking(el.dataset.id); if (x) peopleModal(x); },
  checkin: async (el) => {
    el.disabled = true;
    try { await student.post(`/bookings/${el.dataset.id}/check-in`); flash('ok', 'You’re checked in. Enjoy your session.'); }
    catch (e) { flash('warn', e.code === 'TOO_EARLY' ? `Check-in opens ${state.cfg.checkin_open_before_minutes} minutes before your start.` : e.code === 'RELEASED' ? 'This booking was released because check-in closed.' : friendly(e)); }
    if (parseHash().parts[1]) return render();
    await fetchBookings(); await loadChrome(true); paintBookings();
  },
  accept: (el) => respond(el.dataset.id, 'accept'),
  decline: (el) => respond(el.dataset.id, 'decline'),
  leave: (el) => respond(el.dataset.id, 'decline'),
  readall: async () => { await student.post('/me/notifications/read-all'); state.unread = 0; render(); },
  reload: () => render(),
};

function rerenderNav() {
  const nav = $app.querySelector('header.nav'); if (!nav) return;
  const r = parseHash(); const landing = r.path === '';
  const tmp = document.createElement('div'); tmp.innerHTML = out(navHtml({ active: r.parts[0], landing }));
  nav.replaceWith(tmp.firstElementChild);
}

document.addEventListener('click', (ev) => {
  const sc = ev.target.closest('[data-scroll]');
  if (sc) {
    ev.preventDefault();
    const go_ = () => document.getElementById(sc.dataset.scroll)?.scrollIntoView({ behavior: 'smooth' });
    if (parseHash().path !== '') { location.hash = '#/'; setTimeout(go_, 80); } else go_();
    return;
  }
  const el = ev.target.closest('[data-act]');
  if (el && actions[el.dataset.act]) { ev.preventDefault(); actions[el.dataset.act](el, ev); return; }
  if (state.menu && !ev.target.closest('.menu')) { state.menu = false; rerenderNav(); }
});
document.addEventListener('change', (ev) => {
  const t = ev.target;
  if (t.dataset.amen !== undefined) {
    const id = t.dataset.amen; const f = state.f;
    f.amen = t.checked ? [...new Set([...f.amen, id])] : f.amen.filter((x) => x !== id);
    return loadResults();
  }
  if (t.id === 'purpose' && state.rv) { state.rv.purposeId = t.value; return; }
  const key = t.dataset.f; if (!key || !state.f) return;
  const f = state.f;
  if (key === 'name') { f.name = t.value.trim(); return loadResults(); }
  f[key] = t.value;
  if (key === 'date' || key === 'start') {
    const dur = Math.max(state.cfg.time_grid_minutes, toM(f.end) - toM(f.start));
    if (key === 'start') f.end = fromM(Math.min(toM(f.start) + (dur || 60), 1440));
    if (document.getElementById('f-start')) {
      document.getElementById('f-start').innerHTML = out(timeOptions(f.date, f.start, 'start'));
      if (!document.getElementById('f-start').value) { f.start = document.getElementById('f-start').options[0]?.value || f.start; }
      f.end = f.end > f.start ? f.end : fromM(toM(f.start) + 60);
      document.getElementById('f-end').innerHTML = out(timeOptions(f.date, f.end, 'end'));
    }
  }
  if (['date', 'start', 'end'].includes(key)) {
    document.querySelectorAll('[data-act=dur]').forEach((b) => b.classList.toggle('on', Number(b.dataset.d) === toM(f.end) - toM(f.start)));
  }
  loadResults();
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && ev.target.id === 'att-in') { ev.preventDefault(); actions['att-add'](); }
  if (ev.key === 'Enter' && ev.target.dataset?.f === 'name') ev.target.blur();
});

/* ------------------------------ boot ------------------------------ */
(async function boot() {
  try { await loadCfg(); } catch (e) { $app.innerHTML = '<div class="wrap"><div class="empty"><h2>Service unavailable.</h2><p class="muted">Try again in a few minutes.</p></div></div>'; return; }
  window.addEventListener('hashchange', render);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && parseHash().path === 'rooms') loadResults(false, true); });
  render();
})();
void esc; void raw;
