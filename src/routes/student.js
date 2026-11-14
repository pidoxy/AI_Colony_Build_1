import { Router } from 'express';
import { config } from '../config.js';
import { clock } from '../clock.js';
import { getPolicy } from '../policy.js';
import { readQuery } from '../db.js';
import { studentAuth, signDevStudentToken } from '../auth.js';
import { bad, ApiError } from '../errors.js';
import { searchRooms, availableSoon, justReleased } from '../services/search.js';
import * as bk from '../services/bookings.js';
import * as nt from '../services/notifications.js';

export const router = Router();

/** Public: values the landing page shows. Read from the policy table, never hardcoded. */
router.get('/policy/public', async (_req, res) => {
  const p = await getPolicy();
  res.json({
    timezone: config.tz, timezone_label: config.tzLabel,
    time_grid_minutes: p.time_grid_minutes, duration_min_minutes: p.duration_min_minutes, duration_max_minutes: p.duration_max_minutes,
    horizon_days: p.horizon_days, weekly_limit: p.weekly_limit,
    checkin_open_before_minutes: p.checkin_open_before_minutes, checkin_close_after_minutes: p.checkin_close_after_minutes,
    available_soon_window_minutes: p.available_soon_window_minutes, just_released_window_minutes: p.just_released_window_minutes,
    search_staleness_seconds: p.search_staleness_seconds, university_email_domain: p.university_email_domain,
    noshow_threshold: p.noshow_threshold, noshow_window_days: p.noshow_window_days, suspension_length_days: p.suspension_length_days,
    dev_sso: !!config.sso.devSecret,
    demo: config.demo,
    sso_login_url: process.env.SSO_LOGIN_URL || null,
  });
});

/** Development-only mock of the university SSO sign-in (disabled when a real JWKS is configured). */
router.post('/dev/sso/login', async (req, res) => {
  if (!config.sso.devSecret) throw new ApiError(404, 'NOT_FOUND', 'Not found');
  const { student_id, email, name } = req.body || {};
  if (!student_id || !email) throw bad('INVALID_LOGIN', 'student_id and email are required');
  const token = await signDevStudentToken({ studentId: String(student_id), email: String(email).trim().toLowerCase(), name: name || email });
  res.json({ token });
});

router.use(studentAuth);

router.post('/session', async (req, res) => res.json(await bk.recordSignIn(req.student)));

/* reads (replica) */
router.get('/rooms/search', async (req, res) => res.json(await searchRooms(req.query)));
router.get('/rooms/available-soon', async (req, res) => res.json(await availableSoon(req.query)));
router.get('/rooms/released', async (req, res) => res.json(await justReleased(req.query)));

router.get('/buildings', async (_req, res) => {
  const { rows } = await readQuery('select building_id, name, zone from building order by name');
  res.json({ buildings: rows });
});
router.get('/amenities', async (_req, res) => {
  const { rows } = await readQuery('select amenity_id, name from amenity order by name');
  res.json({ amenities: rows });
});
router.get('/purposes', async (_req, res) => {
  const { rows } = await readQuery(
    `select purpose_id, label, suggested_room_types from purpose where is_active order by sort_order, label`);
  res.json({ purposes: rows });
});

router.get('/announcements', async (_req, res) => {
  const { rows } = await readQuery(
    `select announcement_id, starts_at, ends_at, message from announcement
     where ends_at > $1 and notify_at <= $1 order by starts_at`, [clock.now()]);
  res.json({ announcements: rows });
});

router.get('/me/bookings', async (req, res) => res.json(await bk.myBookings(req.student, req.query.status || 'upcoming')));
router.get('/me/standing', async (req, res) => res.json(await bk.standing(req.student)));
router.get('/me/notifications', async (req, res) => res.json(await nt.listNotifications(req.student.studentId, req.query)));
router.post('/me/notifications/read-all', async (req, res) => res.json(await nt.markAllRead(req.student.studentId)));
router.post('/me/notifications/:id/read', async (req, res) => res.json(await nt.markRead(req.student.studentId, req.params.id)));

/* writes (primary) */
router.post('/bookings', async (req, res) => {
  const { status, booking } = await bk.createBooking(req.student, req.get('Idempotency-Key'), req.body);
  res.status(status).json(booking);
});
router.get('/bookings/:id', async (req, res) => res.json(await bk.getBooking(req.student, req.params.id)));
router.put('/bookings/:id/attendees', async (req, res) => {
  const { booking } = await bk.setAttendees(req.student, req.params.id, req.body?.attendees);
  res.json(booking);
});
router.post('/bookings/:id/cancel', async (req, res) => res.json((await bk.cancelBooking(req.student, req.params.id)).booking));
router.post('/bookings/:id/check-in', async (req, res) => res.json((await bk.checkIn(req.student, req.params.id)).booking));
router.post('/bookings/:id/invitation/accept', async (req, res) => res.json((await bk.respondInvitation(req.student, req.params.id, 'accept')).booking));
router.post('/bookings/:id/invitation/decline', async (req, res) => res.json((await bk.respondInvitation(req.student, req.params.id, 'decline')).booking));
