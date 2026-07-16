-- Event-management v2 Phase 5, Task A1: nationals session-request survey —
-- schema foundation ONLY. No UI, no edge-function/checkout logic (those are
-- later P5 tasks A2/A3); this migration just lays the table/RLS they'll need.

-- ---------------------------------------------------------------------------
-- session_requests
-- ---------------------------------------------------------------------------
-- On nationals events (event.kind = 'nationals'), clubs and independent
-- athletes each answer a "session-request survey" so the host can plan
-- session assignments before finalizing the schedule (spec §L.1 / §E5.4):
--   - Club variant: one survey per registered WAG level, PLUS one combined
--     survey for all MAG, PLUS one combined survey for all T&T. Scoped to
--     the club (club_id set, level_id set for WAG, null for MAG/TNT).
--   - Independent-athlete variant: one survey per discipline the athlete is
--     registered in. Scoped to the person (person_id set, level_id always
--     null — the survey doesn't split by level for an individual).
--
-- A row is keyed by (event, scope, discipline, level) where scope is EITHER
-- a club_id (club variant) OR a person_id (independent variant) — never
-- both, never neither. `answers` is a free-form jsonb payload (arrival
-- window/day, preferred session ids, separate-gyms preference, notes) —
-- kept as jsonb rather than fixed columns since A2 UI is expected to refine
-- the exact field set without needing another migration.
--
-- id is app-generated text like every other table (CLAUDE.md convention).
create table session_requests (
  id           text primary key,
  event_id     text not null references events (id) on delete cascade,
  -- Exactly one of club_id/person_id identifies the requesting scope — same
  -- dual-scoping idiom as waitlist_groups (20260711135842). XOR, not OR:
  -- security-relevant, see the check constraint below.
  club_id      text references clubs (id) on delete cascade,
  person_id    text references people (id) on delete cascade,
  discipline   discipline not null,
  -- WAG club variant only (one row per registered WAG level); null for the
  -- combined MAG/TNT club surveys and for every independent-athlete survey.
  level_id     text references levels (id) on delete set null,
  -- Survey payload: { arrival?, preferredSessionIds?, separateGyms?, notes? }.
  -- See src/lib/types.ts SessionRequestAnswers for the client-side shape.
  answers      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  -- XOR, not OR: EXACTLY one scope column is set. Security-relevant — if
  -- both were allowed, a personal caller could smuggle a club_id they don't
  -- manage onto their own-person row (the per-branch INSERT/UPDATE policy
  -- below would pass on the person_id branch while the row still carries the
  -- foreign club_id) — same rationale as waitlist_groups.
  check ((club_id is null) <> (person_id is null))
);

-- One survey per (event, scope, discipline, level) — re-submitting the same
-- key updates the existing row (upsert) rather than creating a duplicate.
-- coalesce(...,'') treats the two possible-null scope/level columns as part
-- of one composite uniqueness key.
create unique index on session_requests (event_id, coalesce(club_id, ''), coalesce(person_id, ''), discipline, coalesce(level_id, ''));
create index on session_requests (event_id);

-- ---------------------------------------------------------------------------
-- RLS — session_requests
-- ---------------------------------------------------------------------------
-- Follows the codebase's SECURITY DEFINER helper pattern (is_admin(),
-- auth_has_role(), manages_club(), my_person_id()) rather than raw
-- cross-table subqueries, to avoid the 42P17 policy-recursion trap
-- (CLAUDE.md — a subquery into a table whose OWN policies read back into
-- this one recurses and breaks every caller's reads, not just the
-- offending query's).
--
-- Unlike waitlist_groups (append-only + cancel-only), surveys are fully
-- EDITABLE — the whole point is for a club/athlete to revise their answers
-- up until the host locks sessions (a later A3 concern) — so UPDATE allows
-- rewriting `answers` in full, not just a pinned status transition.
alter table session_requests enable row level security;

-- SELECT: admin, sanctioning (needs visibility to plan sessions), the club
-- manager (club variant), the requesting person (independent variant).
create policy session_requests_select on session_requests for select
  using (
    is_admin()
    or auth_has_role('sanctioning')
    or (club_id is not null and manages_club(club_id))
    or coalesce(person_id = my_person_id(), false)
  );

-- INSERT: admin/sanctioning, a manager creating their own club's survey, or
-- a person creating their own. Each actor branch is pinned to ITS scope
-- column: the person branch requires person_id to actually be set, and
-- combined with the table's XOR check, that means a personal survey can't
-- carry any club_id — a member can't smuggle a club scope they don't manage.
create policy session_requests_insert on session_requests for insert
  with check (
    is_admin()
    or auth_has_role('sanctioning')
    or (club_id is not null and manages_club(club_id))
    or (person_id is not null and coalesce(person_id = my_person_id(), false))
  );

-- UPDATE: same actor predicate on both USING and WITH CHECK — editing
-- answers is the whole point of the table, so (unlike waitlist_groups)
-- there's no status to pin; the actor predicate alone is the guard.
create policy session_requests_update on session_requests for update
  using (
    is_admin()
    or auth_has_role('sanctioning')
    or (club_id is not null and manages_club(club_id))
    or coalesce(person_id = my_person_id(), false)
  )
  with check (
    is_admin()
    or auth_has_role('sanctioning')
    or (club_id is not null and manages_club(club_id))
    or coalesce(person_id = my_person_id(), false)
  );

-- DELETE: same actor predicate — lets a club/athlete clean up a survey for a
-- level/discipline they've since dropped from their registrations.
create policy session_requests_delete on session_requests for delete
  using (
    is_admin()
    or (club_id is not null and manages_club(club_id))
    or coalesce(person_id = my_person_id(), false)
  );

revoke all on session_requests from public;
grant select, insert, update, delete on session_requests to authenticated;
