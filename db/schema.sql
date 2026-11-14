-- Campus Rooms schema (PostgreSQL 16). Availability is never stored; it is derived.
create extension if not exists btree_gist;

create table student (
  student_id      text primary key,
  email           text not null,
  display_name    text not null,
  suspended_until timestamptz,
  last_login_at   timestamptz,
  created_at      timestamptz not null default now()
);
create index student_email_idx on student (lower(email));

create table building (
  building_id int generated always as identity primary key,
  name        text not null,
  zone        text not null default '',
  latitude    double precision not null,
  longitude   double precision not null
);

create table room (
  room_id     uuid primary key default gen_random_uuid(),
  code        text not null unique,
  building_id int not null references building,
  name        text not null,
  type        text not null,
  capacity    int not null,
  opens_at    time not null,
  closes_at   time not null,
  is_active   boolean not null default true,
  constraint room_type_chk check (type in ('study','seminar','group','other')),
  constraint room_capacity_chk check (capacity > 0),
  constraint room_hours_chk check (opens_at < closes_at)
);
create index room_type_idx on room (type);
create index room_capacity_idx on room (capacity);
create index room_building_idx on room (building_id);

create table amenity (
  amenity_id int generated always as identity primary key,
  name       text not null unique
);
create table room_amenity (
  room_id    uuid not null references room on delete cascade,
  amenity_id int  not null references amenity on delete cascade,
  primary key (room_id, amenity_id)
);

create table room_hours_exception (
  room_id   uuid not null references room on delete cascade,
  weekday   smallint not null,          -- ISO: 1 = Monday ... 7 = Sunday
  opens_at  time not null,
  closes_at time not null,
  primary key (room_id, weekday),
  constraint rhe_weekday_chk check (weekday between 1 and 7),
  constraint rhe_hours_chk check (opens_at < closes_at)
);

create table closure (
  closure_id  uuid primary key default gen_random_uuid(),
  scope       text not null,
  building_id int references building on delete cascade,
  room_id     uuid references room on delete cascade,
  during      daterange not null,       -- whole campus days, [first, last+1)
  reason      text not null default '',
  created_by  text not null default '',
  created_at  timestamptz not null default now(),
  constraint closure_scope_chk check (
    (scope = 'campus'   and building_id is null and room_id is null) or
    (scope = 'building' and building_id is not null and room_id is null) or
    (scope = 'room'     and room_id is not null and building_id is null))
);
create index closure_during_idx on closure using gist (during);

create table purpose (
  purpose_id           int generated always as identity primary key,
  label                text not null unique,
  suggested_room_types text[] not null default '{}',
  is_active            boolean not null default true,
  sort_order           int not null default 0,
  created_by           text not null default ''
);

create table booking (
  booking_id      uuid primary key default gen_random_uuid(),
  room_id         uuid not null references room,
  student_id      text not null references student,
  during          tstzrange not null,
  purpose_id      int not null references purpose,
  status          text not null,
  idempotency_key text not null,
  request_hash    text not null,
  checked_in_at   timestamptz,
  cancelled_at    timestamptz,
  created_at      timestamptz not null default now(),
  constraint booking_status_chk check (status in
    ('CONFIRMED','CANCELLED','CHECKED_IN','NO_SHOW','COMPLETED')),
  constraint booking_range_chk check (
    not isempty(during) and not lower_inf(during) and not upper_inf(during) and upper(during) > lower(during)),
  -- Rule 1: no two active bookings for one room overlap (half-open ranges)
  constraint booking_no_overlap exclude using gist (room_id with =, during with &&)
    where (status in ('CONFIRMED','CHECKED_IN'))
);
-- Rule 2: a student holds at most one active booking per room
create unique index booking_one_active_per_room on booking (student_id, room_id)
  where status in ('CONFIRMED','CHECKED_IN');
-- Rule 3: one booking per (student, idempotency key)
create unique index booking_idem on booking (student_id, idempotency_key);
create index booking_room_during_idx on booking using gist (room_id, during);
create index booking_student_start_idx on booking (student_id, lower(during));
create index booking_status_start_idx on booking (status, lower(during));

create table booking_attendee (
  attendee_id  uuid primary key default gen_random_uuid(),
  booking_id   uuid not null references booking on delete cascade,
  email        text not null,
  student_id   text references student,
  status       text not null default 'invited',
  invited_at   timestamptz not null default now(),
  responded_at timestamptz,
  constraint attendee_status_chk check (status in ('invited','accepted','declined')),
  constraint attendee_unique unique (booking_id, email)
);
create index attendee_student_idx on booking_attendee (student_id);
create index attendee_email_idx on booking_attendee (lower(email));

create table booking_event (
  event_id    uuid primary key default gen_random_uuid(),
  booking_id  uuid not null references booking on delete cascade,
  from_status text,
  to_status   text not null,
  actor       text not null,
  reason      text,
  at          timestamptz not null default now(),
  constraint event_actor_chk check (actor in ('student','system','worker','admin'))
);
create index booking_event_booking_idx on booking_event (booking_id);

create table penalty (
  penalty_id uuid primary key default gen_random_uuid(),
  student_id text not null references student,
  booking_id uuid not null unique references booking on delete cascade,
  kind       text not null default 'no_show',
  at         timestamptz not null default now(),
  constraint penalty_kind_chk check (kind = 'no_show')
);
create index penalty_student_at_idx on penalty (student_id, at);

create table announcement (
  announcement_id uuid primary key default gen_random_uuid(),
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  message     text not null,
  notify_at   timestamptz not null default now(),
  notified_at timestamptz,
  created_by  text not null default '',
  created_at  timestamptz not null default now(),
  constraint announcement_range_chk check (ends_at > starts_at)
);

create table notification (
  notification_id uuid primary key default gen_random_uuid(),
  student_id      text not null references student on delete cascade,
  booking_id      uuid references booking on delete set null,
  announcement_id uuid references announcement on delete set null,
  type            text not null,
  channel         text not null default 'in_app',
  payload         jsonb not null default '{}',
  send_at         timestamptz not null default now(),
  sent_at         timestamptz,
  skipped_at      timestamptz,
  read_at         timestamptz,
  attempts        int not null default 0,
  last_error      text,
  dedupe_key      text not null unique,
  created_at      timestamptz not null default now(),
  constraint notification_channel_chk check (channel in ('in_app','push','email'))
);
create index notification_due_idx on notification (send_at) where sent_at is null and skipped_at is null;
create index notification_student_idx on notification (student_id, sent_at desc);

create table policy (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

create table operator (
  operator_id              uuid primary key default gen_random_uuid(),
  email                    text not null unique,
  role                     text not null default 'admin',
  status                   text not null default 'invited',
  password_hash            text not null,
  must_change_password     boolean not null default true,
  temp_password_expires_at timestamptz,
  failed_attempts          int not null default 0,
  locked_until             timestamptz,
  token_version            int not null default 1,
  last_login_at            timestamptz,
  invited_by               uuid references operator,
  created_at               timestamptz not null default now(),
  revoked_at               timestamptz,
  constraint operator_role_chk check (role in ('admin','super_admin')),
  constraint operator_status_chk check (status in ('invited','active','revoked'))
);

create table admin_audit_log (
  log_id      uuid primary key default gen_random_uuid(),
  operator_id uuid references operator,
  entity      text not null,
  entity_id   text,
  action      text not null,
  before      jsonb,
  after       jsonb,
  at          timestamptz not null default now()
);
create index audit_entity_idx on admin_audit_log (entity, at desc);

create table booking_archive (
  booking_id   uuid primary key,
  room_id      uuid not null,
  during       tstzrange not null,
  status       text not null,
  student_hash text not null,
  created_at   timestamptz not null
);
