-- 0007_feedback_2026_06_18.sql
-- Schema for the 2026-06-18 feedback batch (Waves 2 & 3). Idempotent.
-- See docs/specs/2026-06-18-feedback-batch-decomposition.md.
--
-- APPLY ON LIVE BEFORE deploying the Wave 2/3 code: supabase.ts row mappers now
-- write these columns, so meet/person/coupon/registration/club/season saves will
-- fail until this is applied (same situation as 0006).

-- ── People: coach/athlete/both identity ────────────────────────────────────
alter table people
  add column if not exists roles jsonb not null
    default '{"athlete":true,"coach":false}'::jsonb;
-- Backfill roles from the legacy single `kind` column.
update people set roles = case
    when kind = 'coach' then '{"athlete":false,"coach":true}'::jsonb
    else '{"athlete":true,"coach":false}'::jsonb
  end
  where roles = '{"athlete":true,"coach":false}'::jsonb and kind = 'coach';

-- ── Memberships: typed (athlete | coach), allow both in the same season ─────
alter table memberships
  add column if not exists type text not null default 'athlete';
-- Widen uniqueness so a person can hold one athlete AND one coach membership
-- per season. Drop the old 2-col unique; add the 3-col unique.
alter table memberships drop constraint if exists memberships_person_id_season_id_key;
do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'memberships_person_season_type_key'
  ) then
    alter table memberships
      add constraint memberships_person_season_type_key
      unique (person_id, season_id, type);
  end if;
end $$;

-- ── Clubs: access policy ───────────────────────────────────────────────────
-- open | affiliates | any-student | any-undergrad | any-affiliated-student |
-- any-affiliated-undergrad
alter table clubs
  add column if not exists access text not null default 'open';

-- ── Seasons: club membership fee ───────────────────────────────────────────
alter table seasons
  add column if not exists club_fee numeric not null default 109;

-- ── Levels: soft-delete (retire) so past meets keep deleted levels ─────────
alter table levels
  add column if not exists retired boolean not null default false;

-- ── Coupons: time window + usage limits ────────────────────────────────────
alter table coupons add column if not exists starts_at  timestamptz;
alter table coupons add column if not exists ends_at    timestamptz;
alter table coupons add column if not exists max_uses   integer;       -- null = unlimited
alter table coupons add column if not exists used_count integer not null default 0;

-- ── Registrations: refund request, synchro partner, per-event levels ───────
alter table registrations
  add column if not exists refund_requested boolean not null default false;
alter table registrations
  add column if not exists partner_athlete_id text references people (id) on delete set null;
-- event_levels: per-event levelId override (T&T now; future-proofs MAG/WAG).
alter table registrations
  add column if not exists event_levels jsonb;

-- ── Meets: add-ons (t-shirt, club banner) + change fee ─────────────────────
alter table meets add column if not exists tshirt_addon jsonb; -- {price, sizes[]}
alter table meets add column if not exists banner_addon jsonb; -- {price}
alter table meets add column if not exists change_fee   jsonb; -- {amount, startsAt}

-- ── app_settings: small key/value store (region→state overrides, etc.) ─────
create table if not exists app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
alter table app_settings enable row level security;
drop policy if exists app_settings_read on app_settings;
create policy app_settings_read on app_settings for select using (true);
drop policy if exists app_settings_write on app_settings;
create policy app_settings_write on app_settings for all
  using  (exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.role = 'admin'))
  with check (exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.role = 'admin'));

-- ── account_invites: admin "create account for this athlete" + setup email ─
create table if not exists account_invites (
  id         text primary key,
  person_id  text references people (id) on delete cascade,
  email      text not null,
  token      text not null,
  status     text not null default 'pending', -- pending | accepted | revoked
  created_at timestamptz not null default now(),
  accepted_at timestamptz
);
alter table account_invites enable row level security;
drop policy if exists account_invites_admin on account_invites;
create policy account_invites_admin on account_invites for all
  using  (exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.role = 'admin'))
  with check (exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.role = 'admin'));
