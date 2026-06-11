-- UCG Registration & Scoring Platform — initial schema
-- Mirrors the TypeScript data model in src/lib/types.ts so the localStorage
-- prototype store can be swapped for Supabase with minimal churn.
--
-- Apply with the Supabase CLI:  supabase db push
-- or paste into the Supabase SQL editor (run 0001 then 0002_rls.sql).

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type discipline       as enum ('MAG', 'WAG', 'TNT');
create type person_kind      as enum ('athlete', 'coach');
create type gender_kind      as enum ('Male', 'Female', 'Non-binary', 'Genderfluid', 'Agender', 'Other');
create type student_status   as enum ('Student', 'Non-Student');
create type membership_status as enum ('active', 'pending-club-payment', 'none');
create type pay_method        as enum ('card', 'club', 'comp');
create type meet_status       as enum ('draft', 'reg-open', 'reg-closed', 'in-progress', 'complete');
create type invoice_item_kind as enum ('membership', 'meet-entry', 'banquet', 'addon', 'donation', 'discount');
create type score_source      as enum ('manual', 'mag-calc', 'wag-open-calc', 'masters-calc');
create type app_role          as enum ('admin', 'club-manager', 'athlete', 'judge', 'meet-host', 'spectator');

-- ---------------------------------------------------------------------------
-- League configuration
-- ---------------------------------------------------------------------------
create table seasons (
  id          text primary key,
  name        text not null,
  starts_on   date not null,
  ends_on     date not null,
  athlete_fee numeric(8,2) not null default 0,
  coach_fee   numeric(8,2) not null default 0,
  active      boolean not null default false, -- purchasable now
  current     boolean not null default false,
  created_at  timestamptz not null default now()
);

create table levels (
  id          text primary key,
  discipline  discipline not null,
  name        text not null,
  sv_max      numeric(5,2),          -- null = open / FIG
  vaults      smallint not null default 1,
  sort_order  smallint not null default 0
);

create table regions (
  state  text primary key,
  region text not null
);

-- ---------------------------------------------------------------------------
-- Clubs & people
-- ---------------------------------------------------------------------------
create table clubs (
  id            text primary key,
  name          text not null,
  short_name    text not null,
  state         text,
  region        text,
  email         text,
  allow_club_pay boolean not null default false,
  created_at    timestamptz not null default now()
);

create table people (
  id              uuid primary key default gen_random_uuid(),
  auth_user_id    uuid unique references auth.users (id) on delete set null,
  kind            person_kind not null default 'athlete',
  first_name      text not null,
  last_name       text not null,
  email           text not null,
  dob             date,
  gender          gender_kind,
  placement       jsonb not null default '{}'::jsonb, -- { MAG: 'men+', WAG: 'women+', ... }
  grad_year       int,
  student_status  student_status,
  shirt           text,
  country         text,
  state           text,
  phone           text,
  main_club_id    text references clubs (id) on delete set null,
  levels          jsonb not null default '{}'::jsonb, -- { WAG: 'wag-open', ... } level ids per discipline
  emergency       jsonb not null default '{}'::jsonb, -- { contact, relation, phone }
  dietary         text[] not null default '{}',
  dietary_notes   text not null default '',
  achievements    text[] not null default '{}',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index on people (main_club_id);
create index on people (auth_user_id);

-- Many-to-many: a person can compete for alternate clubs
create table person_alt_clubs (
  person_id uuid references people (id) on delete cascade,
  club_id   text references clubs (id) on delete cascade,
  primary key (person_id, club_id)
);

-- Club managers (managerIds)
create table club_managers (
  club_id   text references clubs (id) on delete cascade,
  person_id uuid references people (id) on delete cascade,
  primary key (club_id, person_id)
);

create table memberships (
  id                uuid primary key default gen_random_uuid(),
  person_id         uuid not null references people (id) on delete cascade,
  season_id         text not null references seasons (id) on delete cascade,
  status            membership_status not null default 'none',
  waiver_signed_at  timestamptz,
  waiver_signed_by  text,
  paid_via          pay_method,
  activated_by_admin boolean not null default false,
  created_at        timestamptz not null default now(),
  unique (person_id, season_id)
);
create index on memberships (season_id, status);

-- ---------------------------------------------------------------------------
-- Meets, sessions, squads
-- ---------------------------------------------------------------------------
create table meets (
  id                    text primary key,
  slug                  text unique not null,
  name                  text not null,
  host_club_id          text references clubs (id) on delete set null,
  city                  text,
  state                 text,
  timezone              text not null default 'America/Chicago',
  start_date            date,
  end_date              date,
  status                meet_status not null default 'draft',
  reg_opens             timestamptz,
  reg_closes            timestamptz,
  entry_fee             numeric(8,2) not null default 0,
  second_discipline_fee numeric(8,2) not null default 0,
  disciplines           discipline[] not null default '{}',
  private_reg_code      text,
  banquet               jsonb,            -- { price, name } or null
  created_at            timestamptz not null default now()
);

create table meet_sessions (
  id          text primary key,
  meet_id     text not null references meets (id) on delete cascade,
  name        text not null,
  discipline  discipline not null,
  date        date,
  "time"      text,
  level_ids   text[] not null default '{}',
  sort_order  smallint not null default 0
);
create index on meet_sessions (meet_id);

create table squads (
  id          text primary key,
  session_id  text not null references meet_sessions (id) on delete cascade,
  name        text not null,
  start_event smallint not null default 0,
  holding     boolean not null default false,
  sort_order  smallint not null default 0
);
create index on squads (session_id);

create table registrations (
  id          uuid primary key default gen_random_uuid(),
  meet_id     text not null references meets (id) on delete cascade,
  athlete_id  uuid not null references people (id) on delete cascade,
  club_id     text references clubs (id) on delete set null,
  discipline  discipline not null,
  level_id    text references levels (id) on delete set null,
  events      text[] not null default '{}',
  session_id  text references meet_sessions (id) on delete set null,
  squad_id    text references squads (id) on delete set null,
  refunded    boolean not null default false,
  keep_listed boolean not null default false,
  created_at  timestamptz not null default now()
);
create index on registrations (meet_id, session_id);
create index on registrations (athlete_id);
create index on registrations (club_id);

create table scores (
  id          text primary key,            -- `${meetId}|${regId}|${event}`
  meet_id     text not null references meets (id) on delete cascade,
  session_id  text references meet_sessions (id) on delete set null,
  reg_id      uuid not null references registrations (id) on delete cascade,
  event       text not null,
  sv          numeric(6,3),                -- D / start value
  deductions  numeric(6,3),                -- E deductions (capped levels: final = sv - deductions)
  e_score     numeric(6,3),                -- E-score out of 10 (open scoring: final = sv + e_score)
  final       numeric(6,3),
  source      score_source not null default 'manual',
  entered_by  text,
  entered_at  timestamptz not null default now(),
  flashed     boolean not null default false
);
create index on scores (meet_id, session_id);
create index on scores (reg_id);

-- ---------------------------------------------------------------------------
-- Money: coupons, carts, invoices
-- ---------------------------------------------------------------------------
create table coupons (
  code        text primary key,
  pct_off     numeric(5,2),
  amount_off  numeric(8,2),
  applies_to  text not null default 'any'  -- 'membership' | 'meet-entry' | 'any'
);

-- A cart is keyed by its owner: a club (club_id) or an individual (person_id).
create table cart_items (
  id          uuid primary key default gen_random_uuid(),
  club_id     text references clubs (id) on delete cascade,
  person_id   uuid references people (id) on delete cascade,
  label       text not null,
  amount      numeric(8,2) not null default 0,
  kind        invoice_item_kind not null,
  ref_user_id uuid references people (id) on delete set null,
  created_at  timestamptz not null default now(),
  check (club_id is not null or person_id is not null)
);

create table invoices (
  id          uuid primary key default gen_random_uuid(),
  number      text unique not null,
  club_id     text references clubs (id) on delete set null,
  athlete_id  uuid references people (id) on delete set null,
  coupon_code text references coupons (code) on delete set null,
  created_at  timestamptz not null default now(),
  paid_at     timestamptz
);

create table invoice_items (
  id          uuid primary key default gen_random_uuid(),
  invoice_id  uuid not null references invoices (id) on delete cascade,
  label       text not null,
  amount      numeric(8,2) not null default 0,
  kind        invoice_item_kind not null,
  ref_user_id uuid references people (id) on delete set null,
  refunded    boolean not null default false
);
create index on invoice_items (invoice_id);

-- ---------------------------------------------------------------------------
-- Roles: links an auth user to their role(s) and (for athletes) their person
-- ---------------------------------------------------------------------------
create table user_roles (
  user_id   uuid not null references auth.users (id) on delete cascade,
  role      app_role not null,
  primary key (user_id, role)
);

-- updated_at trigger for people
create or replace function set_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

create trigger people_updated_at before update on people
  for each row execute function set_updated_at();
