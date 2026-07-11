-- Event-management v2 Phase 4, Task 1: capacity & sessions — schema + TS
-- plumbing foundation ONLY. No UI, no edge-function logic, no cap
-- enforcement, no waitlist promotion/matching logic. Those are later P4
-- tasks; this migration just lays the columns/table/RLS they'll need.

-- ---------------------------------------------------------------------------
-- events.registration_mode
-- ---------------------------------------------------------------------------
-- 'by-discipline' (default — today's behavior: an athlete registers per
-- discipline/level, choosing apparatus freely) vs 'by-session' (P4: sessions
-- are pre-created with per-apparatus routine caps and athletes register into
-- a specific session).
alter table events add column if not exists registration_mode text not null default 'by-discipline';
alter table events add constraint events_registration_mode_check
  check (registration_mode in ('by-discipline', 'by-session'));

-- ---------------------------------------------------------------------------
-- events.capacity — ALREADY EXISTS (20260706193421_event_v2_fields.sql).
-- ---------------------------------------------------------------------------
-- No new column here. Recording the counting rule the P4 enforcement tasks
-- will implement, since the original comment ("stored only, not enforced")
-- predates the rule being nailed down:
--   - `total` counts ATHLETES registered for the event (competitions AND
--     camps) — one athlete counts once regardless of how many
--     disciplines/apparatus they enter.
--   - `perDiscipline` (T&T) and `perLevel` (WAG/MAG) count ROUTINES, i.e.
--     apparatus entries — one athlete entering 4 apparatus at a level counts
--     as 4 against that level's cap, not 1.
comment on column events.capacity is
  'Capacity caps (event-mgmt v2 P4). Shape: { total?: number, perDiscipline?: Partial<Record<Discipline, number>>, perLevel?: Record<levelId, number> }. '
  '`total` counts ATHLETES (competitions + camps). `perDiscipline` (T&T) and `perLevel` (WAG/MAG) count ROUTINES (apparatus entries), not athletes. '
  'Null/absent = no cap. Stored only as of P4 T1 — enforcement lands in a later P4 task.';

-- ---------------------------------------------------------------------------
-- event_sessions.max_routines
-- ---------------------------------------------------------------------------
-- By-session mode only: per-apparatus routine cap for the session, e.g.
-- { "vault": 12, "bars": 12 }. Null/absent = uncapped. Keyed by apparatus
-- code (matches registrations.apparatus entries), not by level.
alter table event_sessions add column if not exists max_routines jsonb;
comment on column event_sessions.max_routines is
  'By-session-mode routine cap per apparatus code, e.g. {"vault": 12}. Null = uncapped. Stored only as of P4 T1 — not enforced yet.';

-- ---------------------------------------------------------------------------
-- waitlist_groups
-- ---------------------------------------------------------------------------
-- Waitlists are grouped all-or-nothing per (event, club-or-person, level):
-- a club's whole cohort of athletes at one level joins/leaves the waitlist
-- together, in strict FIFO order (queued_at). A promoted group gets a 24h
-- hold (hold_expires_at) to complete checkout before being re-queued to the
-- back (queued_at bumped to now(), status back to 'waiting').
--
-- id is app-generated text like every other table (CLAUDE.md convention).
create table waitlist_groups (
  id           text primary key,
  event_id     text not null references events (id) on delete cascade,
  -- Exactly one of club_id/person_id identifies the requesting scope: a club
  -- group (manager queuing a cohort of the club's athletes) vs a personal
  -- group (a member queuing themselves, e.g. self-registration). Registration
  -- rows still each carry their own club_id regardless of which scope queued
  -- them.
  club_id      text references clubs (id) on delete cascade,
  person_id    text references people (id) on delete cascade,
  discipline   discipline not null,
  level_id     text references levels (id) on delete set null,
  -- By-session mode only; null in by-discipline mode.
  session_id   text references event_sessions (id) on delete set null,
  status       text not null default 'waiting'
               check (status in ('waiting', 'notified', 'promoted', 'cancelled', 'expired')),
  -- FIFO key. Re-queueing (a lapsed 24h promotion hold) bumps this to now()
  -- and resets status to 'waiting' rather than deleting/recreating the row.
  queued_at    timestamptz not null default now(),
  notified_at  timestamptz,
  -- The 24h promotion hold: the group must complete checkout before this
  -- lapses or it goes back to the end of the queue.
  hold_expires_at timestamptz,
  created_at   timestamptz not null default now(),
  -- XOR, not OR: EXACTLY one scope column is set. Security-relevant — if
  -- both were allowed, a personal caller could smuggle a club_id they don't
  -- manage onto their own-person row (the per-branch INSERT policy below
  -- would pass on the person_id branch while the row still carries the
  -- foreign club_id).
  check ((club_id is null) <> (person_id is null))
);
create index on waitlist_groups (event_id, status, queued_at);

-- ---------------------------------------------------------------------------
-- registrations: waitlist + soft-hold columns
-- ---------------------------------------------------------------------------
-- A waitlisted registration is a placeholder: no cart line, does not count
-- toward any capacity cap, and is excluded from rosters/exports until
-- promoted (waitlisted flips false).
alter table registrations add column if not exists waitlisted boolean not null default false;
alter table registrations add column if not exists waitlist_group_id text
  references waitlist_groups (id) on delete set null;
-- Soft hold on a capacity-capped event: holds the registration's spot for
-- 30 minutes from cart-add, refreshed when checkout starts. Null = no
-- active hold (unlimited event, or hold already consumed/expired).
alter table registrations add column if not exists hold_expires_at timestamptz;

create index on registrations (event_id) where waitlisted;
create index on registrations (waitlist_group_id);

-- ---------------------------------------------------------------------------
-- RLS — waitlist_groups
-- ---------------------------------------------------------------------------
-- Follows the codebase's SECURITY DEFINER helper pattern (is_admin(),
-- manages_club(), my_person_id()) rather than raw cross-table subqueries, to
-- avoid the 42P17 policy-recursion trap (CLAUDE.md — a subquery into a table
-- whose OWN policies read back into this one recurses and breaks every
-- caller's reads, not just the offending query's).
alter table waitlist_groups enable row level security;

-- SELECT: admin, the club manager (for a club group), the requesting person
-- (for a personal group). Kept minimal per the task brief — hosts/other
-- managers get no visibility here in T1.
create policy waitlist_groups_select on waitlist_groups for select
  using (
    is_admin()
    or (club_id is not null and manages_club(club_id))
    or coalesce(person_id = my_person_id(), false)
  );

-- INSERT: a person queuing themselves, or a manager queuing their own club's
-- cohort. WITH CHECK pins status to 'waiting' (clients cannot create a row
-- in any other state — promotion/notify/expiry are service-role concerns,
-- added in later P4 tasks) AND pins each actor branch to ITS scope column:
-- the person branch requires person_id to actually be set (combined with
-- the XOR table check, a personal group therefore cannot carry any club_id,
-- so a member can't smuggle a club scope they don't manage).
create policy waitlist_groups_insert on waitlist_groups for insert
  with check (
    status = 'waiting'
    and (
      is_admin()
      or (club_id is not null and manages_club(club_id))
      or (person_id is not null and coalesce(person_id = my_person_id(), false))
    )
  );

-- UPDATE: clients may CANCEL their own group, nothing else. Two layers:
--   (a) the column-level grant below permits authenticated UPDATE on the
--       `status` column ONLY — a client can't rewrite queued_at (FIFO
--       queue-jump) or self-set notified_at/hold_expires_at (a self-granted
--       capacity reservation once enforcement counts notified holds);
--   (b) WITH CHECK pins the NEW row's status to 'cancelled'. (WITH CHECK
--       can't see the OLD row, but it CAN constrain the NEW one — and
--       "clients may only cancel" means the only status a client may write
--       is 'cancelled', which needs no OLD-row visibility.)
-- All other transitions (waiting→notified, →promoted, →expired, re-queue
-- bumping queued_at) happen via service-role Edge Functions, which bypass
-- RLS and column grants entirely.
create policy waitlist_groups_update on waitlist_groups for update
  using (
    is_admin()
    or (club_id is not null and manages_club(club_id))
    or (person_id is not null and coalesce(person_id = my_person_id(), false))
  )
  with check (
    status = 'cancelled'
    and (
      is_admin()
      or (club_id is not null and manages_club(club_id))
      or (person_id is not null and coalesce(person_id = my_person_id(), false))
    )
  );

revoke all on waitlist_groups from public;
grant select, insert on waitlist_groups to authenticated;
grant update (status) on waitlist_groups to authenticated;
