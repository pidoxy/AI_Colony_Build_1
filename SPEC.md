# Campus Rooms: Classroom Reservation System. Consolidated Spec

Status: planning. No code is written. Sources: the Build Brief (17 Oct 2026), the "Campus Rooms — Booking Journey" designs, and the decisions made in review.
Where this spec departs from the brief, it is listed in section 2 so nothing changes silently.

---

## 1. Purpose and success measures

A web and mobile service that lets 30,000+ students find a free study, group or seminar room, book it instantly, and cancel it, across roughly 300 bookable rooms today.

It works when:
- No room is ever confirmed to two students for overlapping time. Zero tolerance.
- Search answers in under 1 s at p95 at peak load (about 50 searches/s and 5 booking writes/s in exam weeks).
- A booking nobody checks in to is released within 15 min of its start, and other students can see and take it.
- Students are told before every booking and before planned downtime (in-app for now, see 8.4).

## 2. Register of departures from the brief

| # | Brief says | This spec | Reason |
|---|---|---|---|
| D1 | Room types: study, seminar, other (R1) | Adds `group` | Product decision. Group rooms allow other attendees. |
| D2 | Admin tools out of scope | Admin console is in scope: buildings, rooms, hours, closed days, amenities, purposes, announcements, policy, admin users | Product decision. |
| D3 | A1: SSO for sign-in | Students use SSO. Admins sign in with email and a temporary password, reset on first login | Product decision (simple setup). |
| D4 | A5: email and push channels | Email is not integrated yet. v1 delivers in-app notifications. Push is optional, behind a flag, off by default | Product decision. See 8.4 for what this weakens. |
| D5 | A6 "Rooms grow slowly" | Rooms grow by 700 to 800 per year (about 1,100 in year one, about 4,000 by year five) | Confirmed by the product owner. |
| D6 | Retention open (proposed 1 year) | Tiered anonymise-then-delete (section 9) | Product decision. |
| D7 | R14: "[2 h] or until the slot starts" | Just released lasts [2 h] from release. A cancelled slot also leaves the list when it starts. A no-show's remainder is listed for up to [2 h] | Product decision. A no-show slot has already started, so "until it starts" cannot apply. |
| D8 | Booking has no attendees | Group-room bookings may invite attendees by university email, who accept or decline | Product decision. |
| D9 | R1 "purpose" filter (undefined) | Purpose is an admin-editable lookup. Choosing one narrows results to suitable room types | Interpretation. Confirm. |

Designs are used as visual and interaction reference only. Where a design shows something the brief does not define, the brief wins:
- No `floor`. "Level 2" is dropped unless facilities put it in the room name.
- No stored booking reference. The "CR-1027-021" style code is derived from `booking_id` for display.
- "Main campus · WAT" is a static label (one campus, one time zone, A3).
- Amenities such as "Step-free access" and "Quiet zone" are catalogue data. They appear only if admins add them.
- Landing-page rules text (30 min to 3 hr, 14 days, 5 bookings, 10 min) reads from the policy table (R20).

## 3. Scope

In scope: everything in the brief's requirements R1 to R20, plus D1 to D9.
Still out of scope: payments, approvals, recurring bookings, reports, staff and lecturer bookings, waitlists, penalty appeals, ending a booking early, hardware check-in, live GPS, email delivery (until integrated), admin overrides of individual bookings.

## 4. Roles

| Role | Sign-in | Can do |
|---|---|---|
| Student | University SSO (token carries student id; never accepted from a request body) | Search, book, cancel, check in, edit own attendee list, accept or decline invitations, read own notifications |
| Invitee | Same as student | Accept or decline an invitation, see the booking. Cannot cancel or check in |
| Admin | Email and password (D3) | Manage buildings, rooms, hours, closures, amenities, purposes, announcements, policy |
| Super admin | Email and password | Everything an admin can, plus invite, change role, revoke and reset admins |

Students never see who booked a room. Attendee lists are visible only to the booker and the invitees.

## 5. Policy table (R20)

Every value below lives in one `policy` table, read by the service and the worker. Changing one needs no deploy.

| Key | Default | Notes |
|---|---|---|
| `time_grid` | 30 min | Start and end sit on it |
| `duration_min` / `duration_max` | 30 min / 3 h | Per booking |
| `horizon_days` | 14 | How far ahead |
| `weekly_limit` | 5 | Per student, Monday to Sunday, campus time. Cancelled excluded, no-shows included |
| `reminder_lead` | 60 min | Allowed range 30 to 60 |
| `checkin_open_before` / `checkin_close_after` | 10 min / 15 min | Close = no-show cutoff |
| `noshow_threshold` / `noshow_window` | 3 / 30 days | Triggers suspension |
| `suspension_length` | 7 days | Booking blocked, search allowed |
| `available_soon_window` | 2 h (max 120 min) | R3 |
| `just_released_window` | 2 h | R14, D7 |
| `search_staleness` | 5 s | Replica lag budget |
| `active_user_days` | 30 | A student who signed in within this many days is "active" (R18) |
| `university_email_domain` | set at install | Attendee email check |
| `invitation_nudge_lead` | 24 h before start | One nudge to pending invitees. Optional |
| `email_enabled` | false | D4 |
| `push_enabled` | false | D4, pending a provider |
| `admin_temp_password_ttl_days` | 7 | Unused temporary password expires |
| `admin_max_failed_logins` / `admin_lockout_minutes` | 5 / 15 | Admin login protection |
| Retention keys | see section 9 | |

The default temporary admin password is deployment configuration, not a policy row, and is never stored in plain text (section 7).

## 6. Data model (PostgreSQL)

One relational database holds everything. Needs the `btree_gist` extension. All instants are `timestamptz` (UTC). Grid, week boundaries, opening hours and closures are computed in campus local time; the UI shows local time.
Availability is never stored. It is derived: free = open hours, minus closures, minus active bookings.

### 6.1 Tables

| Table | Fields | Key rules |
|---|---|---|
| **student** | `student_id` (SSO), `email`, `display_name`, `suspended_until`, `last_login_at`, `created_at` | Row is created at first sign-in. On creation, pending attendee rows with the same email are linked |
| **building** | `building_id`, `name`, `zone`, `latitude`, `longitude` | Admin or import written |
| **room** | `room_id` (uuid), `code` (unique, e.g. ENG-201), `building_id`, `name`, `type` (study, seminar, group, other), `capacity`, `opens_at`, `closes_at`, `is_active` | Check `capacity > 0`, `opens_at < closes_at`. Indexes on `type`, `capacity`, `building_id` |
| **amenity** | `amenity_id`, `name` | Admin written |
| **room_amenity** | `room_id`, `amenity_id` | Join table |
| **room_hours_exception** | `room_id`, `weekday`, `opens_at`, `closes_at` | Optional per-weekday override of the room default. Unique on (`room_id`, `weekday`) |
| **closure** | `closure_id`, `scope` (campus, building, room), `building_id`, `room_id`, `during` (daterange, whole campus days), `reason`, `created_by` | Check that the target column matches `scope` |
| **purpose** | `purpose_id`, `label`, `suggested_room_types`, `is_active`, `sort_order`, `created_by` | Retire rather than delete once used |
| **booking** | `booking_id` (uuid), `room_id`, `student_id`, `during` (tstzrange, half-open), `purpose_id`, `status`, `idempotency_key`, `request_hash`, `checked_in_at`, `cancelled_at`, `created_at` | See 6.2 |
| **booking_attendee** | `attendee_id`, `booking_id`, `email`, `student_id` (nullable), `status` (invited, accepted, declined), `invited_at`, `responded_at` | Unique on (`booking_id`, `email`). Email must match `university_email_domain` |
| **booking_event** | `event_id`, `booking_id`, `from_status`, `to_status`, `actor` (student, system, worker, admin), `reason`, `at` | Insert-only. Reasons include ROOM_UNAVAILABLE, CLOSED_DAY |
| **penalty** | `penalty_id`, `student_id`, `booking_id`, `kind` (no_show), `at` | Unique on `booking_id` |
| **notification** (outbox) | `notification_id`, `student_id`, `booking_id`, `announcement_id`, `type`, `channel` (in_app, push, email), `send_at`, `sent_at`, `read_at`, `attempts`, `last_error`, `dedupe_key` | Unique on `dedupe_key`. Partial index on `send_at` where `sent_at` is null |
| **announcement** | `announcement_id`, `starts_at`, `ends_at`, `message`, `notify_at`, `created_by` | Downtime windows |
| **policy** | `key`, `value`, `updated_at` | Section 5 |
| **operator** | `operator_id`, `email` (unique), `role` (admin, super_admin), `status` (invited, active, revoked), `password_hash`, `must_change_password`, `temp_password_expires_at`, `failed_attempts`, `locked_until`, `token_version`, `last_login_at`, `invited_by`, `created_at`, `revoked_at` | Section 7 |
| **admin_audit_log** | `log_id`, `operator_id`, `entity`, `entity_id`, `action`, `before`, `after`, `at` | Insert-only |
| **booking_archive** | `booking_id`, `room_id`, `during`, `status`, `student_hash`, `created_at` | No personal data (section 9) |

### 6.2 Booking states

| From | To | Who | When |
|---|---|---|---|
| (new) | CONFIRMED | Student | All booking rules pass |
| CONFIRMED | CANCELLED | Student | Before start |
| CONFIRMED | CANCELLED | System | Room deactivated or closure added (reason recorded) |
| CONFIRMED | CHECKED_IN | Student (booker) | Inside the check-in window |
| CONFIRMED | NO_SHOW | Worker | No check-in by start + `checkin_close_after` |
| CHECKED_IN | COMPLETED | Worker | At end time |

CANCELLED, NO_SHOW and COMPLETED are final. Active means CONFIRMED or CHECKED_IN. Any other change is refused.

### 6.3 Rules that must always hold (enforced in the database)

1. No two active bookings for one room overlap: exclusion constraint on (`room_id` =, `during` &&) where status is active. Ranges are half-open, so 10:00 to 11:00 and 11:00 to 12:00 do not clash.
2. A student has at most one active booking per room: partial unique index on (`student_id`, `room_id`) where active.
3. One booking per (`student_id`, `idempotency_key`): unique index.
4. `upper(during) > lower(during)`, and status is one of the six values: check constraints.
5. Also: GiST index on (`room_id`, `during`); index on (`student_id`, `lower(during)`) for weekly counts.

Rules that need policy values live in the service and are checked inside the same transaction as the insert: grid, duration, opening hours (using the weekday exception if present), closures, horizon, weekly limit, suspension, attendee rules.

### 6.4 Derived, never stored

Availability, weekly used count and reset date, no-shows in the window (with dates), Available soon, Just released, building distance (computed from coordinates at query time), booking display code.

## 7. Authentication and admin access

**Students.** SSO token verified against cached SSO keys. `student_id` comes only from the token.

**Admins (D3).**
- A super admin creates an `operator` row by email with `status = invited`. It gets the default temporary password from deployment configuration (initial value `admin`), stored only as a hash, with `must_change_password = true` and an expiry of `admin_temp_password_ttl_days`.
- The first super admin is seeded at setup the same way.
- Login with a temporary password allows one action only: set a new password.
- A new password must be at least 10 characters, must not equal the default or the admin's email, and ends `must_change_password`.
- `failed_attempts` reaches `admin_max_failed_logins`, then `locked_until` blocks login for `admin_lockout_minutes`.
- Admin sessions use their own signed token. The role is read from `operator` on every request, never from the request body. `token_version` increments on revoke, role change and password reset, which ends existing sessions.
- No email service, so "forgot password" is handled by a super admin resetting the account to the temporary password again, which forces a new change.
- Every operator change goes to `admin_audit_log`.

**Known risk.** A shared well-known default (`admin`) is guessable until the admin changes it. The forced change on first login, the 7-day expiry, lockout, and the rule that the default is not an accepted new password reduce this. Hand out accounts only when the admin is ready to log in.

## 8. Behaviour

### 8.1 Search (R1 to R3, R19)

Inputs: date, start, end; optional min capacity, room type, room name, amenities, purpose, duration, near building.
- Duration: a shortcut that sets end = start + duration, or on Available soon "free for at least this long".
- Purpose: restricts to the purpose's suggested room types.
- Result: rooms that are active, open for the whole range (weekday exception applied), not under a closure, and with no overlapping active booking (anti-join on the GiST index). Sorted by distance if `near_building` is given, otherwise by code.
- Response carries building, distance, capacity, amenities and `as_of`. Paginated, since rooms grow quickly (section 12).
- Served from the read replica (up to `search_staleness` old). The replica falls back to the primary if it is down.
- Available soon: rooms free now or within the window, soonest first.
- Just released: slots freed by cancel or no-show within `just_released_window`, still bookable, newest first. A cancelled slot also leaves the list at its start. A no-show's remainder (from the next grid slot) is listed for up to the window.
- A suspended student searches normally and sees a banner.

### 8.2 Booking (R5 to R10)

One transaction on the primary:
1. Look up (`student_id`, key). Same `request_hash` returns 200 with the stored booking. Different hash returns 422 IDEMPOTENCY_KEY_REUSED.
2. Lock the student row and check suspension.
3. Check the policy rules (6.3), room active, closures, hours.
4. For group rooms only, check attendees (8.3).
5. Insert booking as CONFIRMED (R7, no approval), an event row, a confirmation notification, and the reminder row (send at start minus `reminder_lead`).
6. Commit. The exclusion constraint turns a race into 409 SLOT_TAKEN (E1), with alternatives (same time other rooms, same room later).

### 8.3 Group bookings and invitations (D1, D8)

- Attendees are accepted only on `group` rooms. Each email must match `university_email_domain`.
- Booker plus invited people must not exceed `room.capacity`. Attendees do not count toward any weekly limit or one-booking-per-room rule.
- The booking is CONFIRMED at once. Acceptance is an RSVP, not an approval (R7 holds).
- Invitees get an `invited` notification, and the booking appears in their My bookings under Invitations. A person who has never signed in is linked on first sign-in by email and sees it then.
- Invitee actions: accept or decline, changeable before start. Refused after start (ALREADY_STARTED) and on a non-active booking (NOT_ACTIVE). Repeating the same response returns the same result.
- Declining frees a seat for the booker to invite someone else.
- Booker is notified of each response (`invitation_response`) and sees statuses on the card.
- Booker may add or remove attendees before start. Added people get `invited`, removed people get `attendee_removed`.
- On cancellation (student or system), invited and accepted attendees get a notice.
- Reminders go to the booker and accepted attendees. Pending invitees get one nudge (`invitation_nudge_lead`).
- Only the booker checks in. No-shows and penalties apply only to the booker.

### 8.4 Notifications (R16 to R18) and the no-email decision (D4)

Types: booking_confirmed, booking_cancelled, booking_released_no_show, suspension_started, reminder, system_cancelled (with alternatives), downtime, invited, invitation_response, attendee_removed, booking_cancelled_for_attendee, invitation_nudge.

- Notifications are written to the outbox in the same transaction as the event that causes them, so none is lost.
- v1 channel is `in_app`: an outbox row becomes visible in the notification centre when due, with unread state. Push runs only if `push_enabled`. Email rows are not created while `email_enabled` is false. Turning it on later needs a provider, not a data change.
- Cost of D4: reminders (R17) and downtime notices (R18) reach a student only when they open the app, and an invitee who has never signed in cannot be told by the system, so the booker must tell them. The banner for downtime still shows in-app. Brief targets for reminder timing (within 2 min) apply to the in-app row becoming due, not to guaranteed delivery.
- Downtime: notified at `notify_at` to students with bookings in the window and to all active users (signed in within `active_user_days`). At least 24 h ahead.
- Delivery is at least once and deduplicated by `dedupe_key`. A cancelled booking's reminder row is skipped at send time. Provider failure never blocks a booking.

### 8.5 Cancel, check-in, release (R11 to R15)

- Cancel any time before start. Sets CANCELLED, writes an event, queues notices, skips the reminder. The slot is free at once. Repeat returns 200 with the same result. After start: 409 ALREADY_STARTED with a prompt to check in.
- Check-in from `checkin_open_before` before to `checkin_close_after` after the start. Repeat returns 200 with no new event. Too early: 409 TOO_EARLY. Already released: 409 RELEASED.
- Worker, every minute, one active copy by advisory lock:
  - No-show sweep: unchecked CONFIRMED bookings past the cutoff become NO_SHOW, with a penalty, an event and a notice. The remainder is freed within 1 min. The rolling count of `noshow_threshold` in `noshow_window` sets `suspended_until` and queues a suspension notice.
  - Completion sweep: CHECKED_IN past end becomes COMPLETED.
  - Outbox sender, nudges, downtime fan-out, retention jobs.

### 8.6 Standing (R4, R15)

`GET /me/standing` returns: used this week, weekly limit, reset date, suspension end date, and the list of no-shows in the window, each with room and date.

### 8.7 Admin (D2)

- Buildings, rooms (including type, capacity, amenities, default hours, weekday exceptions, activate or deactivate) and bulk room import.
- Closures: campus, building or room, whole days.
- Amenities, purposes (add, edit, reorder, retire, delete if unused), announcements, policy values.
- Admin users (super admin only): invite, change role, revoke, reset to temporary password.
- Audit log view.
- Deactivating a room or adding a closure shows "N active bookings will be cancelled and N students notified" before saving. On save, those bookings are cancelled by the system with reason ROOM_UNAVAILABLE or CLOSED_DAY, notices go out with alternatives (E17), and attendees are told.
- Every admin write is audited.

## 9. Retention

All periods are policy keys.

| Data | Kept | After |
|---|---|---|
| Bookings, student-visible | 90 days | Hidden from the student. Kept for ops |
| Booking rows, full | 13 months | Moved to `booking_archive`: student replaced by a salted hash, purpose and attendees dropped |
| Booking events | 13 months | Archived with the booking |
| Attendee emails | 90 days | Deleted |
| Sent notifications | 90 days | Deleted |
| Penalties | 12 months (only 30 days are needed for rules) | Deleted |
| Students inactive 13 months | Hard-deleted with their data | Archive rows lose the link |
| Admin audit log | 24 months | Deleted |

The archive keeps usage numbers for capacity planning with no personal data. The nightly overlap check runs on the live table only.

## 10. API

All calls are HTTPS JSON. Student calls carry the SSO token. Admin calls carry the admin session token. Times are ISO 8601 with offset. Every call may return 401 UNAUTHENTICATED or 503 SERVICE_UNAVAILABLE. Reads can use the replica. Writes use the primary.

### 10.1 Student

| Operation | Notes |
|---|---|
| `GET /rooms/search` | Filters per 8.1. 400 INVALID_RANGE, OUT_OF_HORIZON, UNKNOWN_FILTER |
| `GET /rooms/available-soon` | `within` up to 120 min. 400 INVALID_WINDOW |
| `GET /rooms/released` | Optional `near_building` |
| `GET /buildings`, `/amenities`, `/purposes`, `/policy/public` | Filter lists and the landing-page rules values |
| `GET /me/bookings` | `status` = upcoming, past, invited. Includes attendee statuses for the booker |
| `GET /me/standing` | Per 8.6 |
| `POST /bookings` | `room_id`, `start`, `end`, `purpose_id`, optional `attendees[]` (emails), header `Idempotency-Key`. 201 CONFIRMED, or 200 same booking on repeat. Errors: 409 SLOT_TAKEN, 409 ALREADY_BOOKED_THIS_ROOM, 422 WEEKLY_LIMIT_REACHED (used, limit, `resets_at`), 403 SUSPENDED (`suspended_until`), 422 OFF_GRID, DURATION_NOT_ALLOWED, OUTSIDE_OPENING_HOURS, IN_PAST, OUT_OF_HORIZON, ROOM_CLOSED, ATTENDEE_EMAIL_INVALID_DOMAIN, TOO_MANY_ATTENDEES, ATTENDEES_NOT_ALLOWED, 404 ROOM_NOT_FOUND, 422 IDEMPOTENCY_KEY_REUSED |
| `PUT /bookings/{id}/attendees` | Booker only, before start |
| `POST /bookings/{id}/cancel` | 404 NOT_FOUND (not yours or none), 409 ALREADY_STARTED, 409 NOT_CANCELLABLE |
| `POST /bookings/{id}/check-in` | 404 NOT_FOUND, 409 TOO_EARLY, RELEASED, NOT_ACTIVE |
| `POST /bookings/{id}/invitation/accept` and `/decline` | Invitee only. 409 ALREADY_STARTED, NOT_ACTIVE |
| `GET /me/notifications`, `POST /me/notifications/{id}/read` | In-app notification centre |
| `GET /announcements` | Current and upcoming downtime |

### 10.2 Admin

| Operation | Notes |
|---|---|
| `POST /admin/login`, `POST /admin/password/change` | Lockout and temporary-password rules per section 7 |
| Buildings, rooms, hours exceptions, amenities: create, update, list | Room bulk import |
| Closures: preview, create, delete | Preview returns the count of bookings that would be cancelled |
| Purposes, announcements, policy | Policy values validated (for example reminder 30 to 60 min) |
| Admin users (super admin only): list, invite, change role, revoke, reset | |
| `GET /admin/audit-log` | Filter by entity and operator |

## 11. System design

Six parts, same as the brief: the app, the SSO (students), one stateless API service, one PostgreSQL primary with a read replica, one background worker, and an external notification provider (empty in v1 apart from optional push). No cache, no message broker, no microservices.
- The app talks only to the API.
- The API owns every policy rule and all student and admin writes.
- The primary decides every booking. The replica only serves reads.
- The worker owns time-driven changes and sending. It never takes student requests.
- The admin console is part of the same app and API, behind the admin session.

Failure behaviour is unchanged from the brief: API copy down, the load balancer routes around it. All API down, "Service unavailable" plus cached My bookings. Primary down, search works from the replica with a "booking paused" banner and writes return 503. Replica down, search uses the primary. Worker down, late no-shows and reminders that catch up. Notification delivery issues never block bookings. SSO down, signed-in students keep working until their token expires.

## 12. Scale note (D5)

Rooms: about 300 now, about 1,100 in year one, about 4,000 by year five.
- Search should stay inside targets with the room indexes and the GiST anti-join, but results are paginated and the building filter matters more.
- Load tests seed 300, 1,100 and 5,000 rooms.
- Admin needs bulk import and room search.
- Add a short-lived cache only if p95 exceeds 1 s at 5,000 rooms.

## 13. Screens

### 13.1 Design reference (already designed)

Landing; Find a room (desktop and mobile); Review and confirm; Room just taken; No results; My bookings (confirmed, empty, past and cancelled); Cancel modal; Button and Room row components.

Visual language to keep: near-black ink (`#17201C`) on white, yellow (`#F2D34F`) primary buttons and room tiles, soft grey and mint-tinted panels and chips, very large tight headings with small uppercase eyebrow labels, arrow-icon CTAs, building and room-number tiles, rounded cards and modals, top navigation with "Find a room" and "My bookings" plus the avatar and "Main campus · WAT", bottom tab bar on mobile, "Updated N seconds ago · Refresh" freshness line.

### 13.2 To design, student (desktop and mobile)

- Sign-in hand-off and session expired.
- Search with the full filter set: room type, room name, purpose, duration, near building, amenities, min capacity. Plus loading, error and pagination states.
- Available soon and Just released lists (Room row with "free from" or "released 4 min ago").
- Review and confirm for group rooms: add people by university email, capacity counter, validation errors.
- My bookings: live check-in, checked-in, completed and no-show states, attendee statuses on the booker's card, Invitations section (Accept and Decline), invited booking detail, standing panel with weekly count, dated no-show list and suspension date.
- Suspended: banner and disabled Book with the end date.
- Error states: weekly limit, already booked this room, off-grid and out-of-hours field errors, room closed, already started, check-in too early and released.
- Banners: planned downtime, booking paused.
- Outage page with cached My bookings, 404.
- Notification centre.
- Booking detail page.
- Avatar menu.
- Mobile versions of Landing, Review, My bookings, Cancel, Conflict and No results.
- Email and push copy for every type in 8.4, ready for when email is integrated.

### 13.3 To design, admin

Admin login; first-login change password; Buildings; Rooms (list, edit, bulk import); Hours and closed days calendar; Closure preview ("N bookings will be cancelled"); Amenities; Purposes; Announcements; Policy; Admin users (super admin); Audit log.

## 14. Edge cases and acceptance tests

All brief cases (E1 to E22, T-R1 to T-E22) stand. Additions:

| ID | Given | When | Then |
|---|---|---|---|
| T-G1 | Group room cap 6, booker plus 5 invitees | Booker submits | 201. A 6th invitee returns 422 TOO_MANY_ATTENDEES |
| T-G2 | Non-university email in attendees | Booker submits | 422 ATTENDEE_EMAIL_INVALID_DOMAIN, nothing stored |
| T-G3 | Study room with attendees | Booker submits | 422 ATTENDEES_NOT_ALLOWED |
| T-G4 | Pending invitation | Invitee accepts twice | Both 200, one state change |
| T-G5 | Booking started | Invitee accepts | 409 ALREADY_STARTED |
| T-G6 | Booker cancels | | Accepted and pending invitees each get one notice |
| T-G7 | Invitee not yet a student | Signs in | Invitation is linked and shows in My bookings |
| T-C1 | Campus closure on a date | Student searches that date | No rooms returned. Booking returns 422 ROOM_CLOSED |
| T-C2 | Closure added with 3 future bookings | Admin saves | All 3 CANCELLED, actor system, reason CLOSED_DAY, 3 notices |
| T-A1 | Admin has the temporary password | Logs in | Only change-password is allowed. Using the default as the new password is refused |
| T-A2 | 5 wrong passwords | Next login | Locked for the lockout period |
| T-A3 | Admin revoked | Next request | 401 |
| T-A4 | Non-super admin | Calls admin users | 403 |
| T-P1 | Purpose retired | Student opens booking form | Retired purpose is absent. Old bookings still show its label |
| T-N1 | No-show happened | Student opens standing | List shows each no-show with room and date |
| T-J1 | Booking cancelled at 10:00 | Student opens Just released at 12:05 | Not listed (past the window) |
| T-J2 | No-show at 10:16 on a 10:00 to 12:00 booking | Student opens Just released | 10:30 to 12:00 listed until 12:16 or taken |
| T-R1 | 5,000 rooms seeded | 50 searches/s for 10 min | p95 under 1 s |
| T-D1 | Email disabled | A booking is confirmed | In-app row exists, no email row, booking unaffected |

## 15. Build order

1. Schema and constraints, policy table, seed (rooms, buildings, amenities, purposes). Tests: T-R6, T-E1, T-E5 as direct SQL.
2. Student auth, search, available soon. Tests: T-R1 to T-R3.
3. Booking with idempotency and all rules. Tests: T-R5 to T-R10, T-R20, T-E1, T-E3, T-E15, T-E21.
4. Cancel, My bookings, standing (with dated no-shows). Tests: T-R4, T-R11, T-E8, T-E11, T-N1.
5. Read replica and `as_of`. Tests: T-R2 freshness, T-E6.
6. Worker: check-in, no-shows, penalties, suspension, completion, Just released. Tests: T-R12 to T-R15, T-E22, T-J1, T-J2.
7. Admin console foundation: operator auth, buildings, rooms, hours, closures, amenities, purposes. Tests: T-A1 to T-A4, T-C1, T-C2, T-P1, T-E17.
8. Group bookings and invitations. Tests: T-G1 to T-G7.
9. Outbox and in-app notifications, reminders, downtime, announcements, banners. Tests: T-R16 to T-R18, T-D1, T-E19.
10. Policy admin screen, retention jobs, failure behaviour. Tests: T-E20.
11. Load tests at 300, 1,100 and 5,000 rooms, nightly overlap check, failover drill. Tests: T-R19, T-R1 and every quality target.

## 16. Open items

1. Push provider: none chosen. `push_enabled` stays off until one is.
2. Email: when integrated, turn on `email_enabled`, add provider delivery, and consider moving admin password reset to email.
3. Purpose mapping (D9): confirm purpose filters rooms by `suggested_room_types`.
4. Closures are whole days only. Partial-day closures are not in v1.
5. An invitee who has never signed in can only be told by the booker.
6. Confirm the "temporary password" approach is acceptable for production use given the risk in section 7.

---

## 17. Implementation notes (as built)

Small additions made while building, all consistent with the sections above:
- `notification` also has `payload` (jsonb, the data a message is rendered from) and `skipped_at` (a reminder or nudge that was not sent because the booking was cancelled or the invitee replied). Wording lives in one place (`src/templates.js`) so email and push can reuse it later.
- `announcement` also has `notified_at` (set once the downtime notices have gone out).
- `booking.purpose_id` is a foreign key to `purpose`. The check on `during` also rejects empty ranges.
- Reminders to accepted attendees are created when they accept. The booker's reminder is created with the booking.
- A booking that starts less than `reminder_lead_minutes` from now gets no reminder row (the confirmation just went out).
- Search: `date` + `HH:MM` times (campus time) or ISO instants. `duration` can replace `end`. Responses are paginated (`limit`, `offset`).
- Search, Available soon, Just released and lists read from the replica (`REPLICA_DATABASE_URL`) and fall back to the primary. `booking_paused` is returned when the primary is unreachable. Booking, cancel, check-in and invitation responses always use the primary and return 503 if it is down.
- Admin sessions: temporary-password logins carry a change-password-only scope. Password change, role change, revoke and reset all bump `token_version`, which ends existing sessions.
- Booking display code `CR-MMDD-NNN` is derived from the booking id and start date. It is not unique by itself; the booking id is.
