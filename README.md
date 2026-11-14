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

## Deploy a demo on Vercel

The whole app runs as one Vercel function (`api/index.js`); `public/` is served as static files. There is no always-on worker on Vercel, so the time-driven jobs run two ways: a throttled sweep during normal requests (`SWEEP_ON_REQUEST`, on automatically on Vercel), plus a daily cron (`/cron/daily`) for retention and the overlap check. `/cron/tick` runs the every-minute work and can be pinged by any scheduler (Vercel Pro cron, GitHub Actions, cron-job.org).

1. **Create a hosted Postgres 16** (Neon, Supabase, etc.). Use the pooled connection string, with `?sslmode=require`. `btree_gist` must be available (it is on Neon and Supabase).
2. **Load the schema and seed from your machine:**
   ```bash
   DATABASE_URL='postgres://…' npm run setup
   ```
   This applies `db/schema.sql` and seeds 300 rooms, purposes, policy and the super admin (`superadmin@university.test`, temporary password `admin`). **Sign in to `/admin.html` straight away and set your own password**: until you do, the default is guessable by anyone who finds the URL.
3. **Set these environment variables in the Vercel project** (Settings, Environment Variables):

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | the pooled Postgres URL |
   | `DEMO_MODE` | `1` (enables the mock student sign-in; no real SSO) |
   | `DEV_SSO_SECRET` | a long random string |
   | `ADMIN_SESSION_SECRET` | a different long random string |
   | `RETENTION_HASH_SALT` | another random string |
   | `CRON_SECRET` | another random string (Vercel sends it to the cron route automatically) |
   | `BOOTSTRAP_SUPER_ADMIN_EMAIL` | optional: only read by `npm run setup` |

   Optional: `CAMPUS_TZ`, `PG_POOL_MAX` (defaults to 3 on Vercel).
4. **Deploy** (push to GitHub; Vercel builds with no build step). Check `https://<your-app>.vercel.app/health`: it should say `{"ok":true,"primary":true}`.

Notes: on Vercel's free plan a cron may run at most once a day, which is why `vercel.json` only schedules the daily job. With demo mode on, anyone can sign in as any student, so treat the data as disposable. For real use, drop `DEMO_MODE` and set `SSO_JWKS_URL` instead.
