# Campus Rooms

Classroom reservation system: students find, book, cancel and check in to study, group and seminar rooms; admins manage the catalogue. Built to [SPEC.md](SPEC.md) and the Build Brief, with the "Campus Rooms: Booking Journey" designs as visual reference.

Stack: Node 20+ (Express 5), PostgreSQL 16, plain ES-module front end (no build step).

## Run it

```bash
npm install
# a PostgreSQL 16 database with the btree_gist extension available
export DATABASE_URL=postgres://campus@127.0.0.1:5440/campus_rooms
npm run migrate            # applies db/schema.sql  (use -- --reset to rebuild)
npm run seed               # 300 rooms, buildings, amenities, purposes, policy, super admin
npm start                  # API + student app (/) + admin console (/admin.html) on :3000
npm run worker             # scheduler: no-shows, completion, reminders, outbox, retention
npm test                   # 68 tests against a separate test database
npm run loadtest -- --rooms=300 --seconds=30
```

Tests use `TEST_DATABASE_URL` (default `campus_rooms_test` on the same server).

## Configuration (environment)

| Variable | Purpose | Default |
|---|---|---|
| `DATABASE_URL` | Primary (all writes, exact checks) | local dev URL |
| `REPLICA_DATABASE_URL` | Read replica for search and lists | primary |
| `CAMPUS_TZ`, `CAMPUS_TZ_LABEL` | The single campus time zone | `Africa/Lagos`, `WAT` |
| `SSO_JWKS_URL`, `SSO_ISSUER`, `SSO_AUDIENCE` | University SSO token verification (required in production) | unset |
| `SSO_LOGIN_URL` | Where the app sends students to sign in | unset |
| `DEV_SSO_SECRET` | Development mock SSO (`/dev/sso/login`). Disabled whenever `SSO_JWKS_URL` is set | dev secret |
| `ADMIN_SESSION_SECRET` | Signs admin sessions (required in production) | dev secret |
| `ADMIN_DEFAULT_TEMP_PASSWORD` | Temporary password for new admins. Stored only hashed. Must be changed at first login | `admin` |
| `BOOTSTRAP_SUPER_ADMIN_EMAIL` | The first super admin created by `npm run seed` | `superadmin@university.test` |
| `RETENTION_HASH_SALT` | Salt for anonymised archive rows (required in production) | dev salt |
| `PORT` | HTTP port | `3000` |

Every limit and window (grid, durations, horizon, weekly limit, reminder lead, check-in window, no-show rule, retention periods, email/push switches) lives in the `policy` table and is editable in the admin console. No deploy needed.

## Where things are

- `db/schema.sql`: tables and the rules enforced by the database (overlap exclusion constraint, one active booking per student per room, idempotency uniqueness, status and range checks).
- `src/services/`: booking, search, admin, notification logic. `src/jobs.js` and `src/worker.js`: time-driven work.
- `public/`: student app (`index.html`) and admin console (`admin.html`).
- `test/`: acceptance tests named after the brief's T-R / T-E / T-G / T-A ids.

## Notes

- Email is not integrated (decision D4 in SPEC.md). Notifications are in-app. Push stays off until a provider is wired in `src/providers.js`; `email_enabled` and `push_enabled` are policy switches.
- The first super admin and every invited admin sign in with the default temporary password and must set their own. A shared default is guessable until changed: hand out accounts only when the person is ready to log in.
- Student sign-in is the university SSO in production. `/dev/sso/login` is a development stand-in.
