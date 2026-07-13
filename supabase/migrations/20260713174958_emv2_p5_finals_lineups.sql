-- Event-management v2 Phase 5, Task C1: "Finals roster" data foundation ONLY
-- (spec §E7, §L.3). No UI (that's C2), no reminder/hard-lock scheduling logic
-- (that's C3). This migration just lays the table/lock-flag/RLS the finals
-- lineup editor will need — same shape/idiom as the B1 competition-order
-- migration (20260713173105_emv2_p5_competition_order.sql).

-- ---------------------------------------------------------------------------
-- events.finals_roster_locked
-- ---------------------------------------------------------------------------
-- Separate lock from competition_order_locked above — finals lineups have
-- their own hard-lock timing (10pm day-1, per spec §E7/§L.3, enforced by C3).
-- Once true, club managers may only VIEW finals_lineups rows — only admins
-- may keep editing. Absent/false is the default (clubs edit freely pre-lock).
alter table events add column if not exists finals_roster_locked boolean not null default false;
comment on column events.finals_roster_locked is
  'event-mgmt v2 P5 §E7/§L.3: once true, club managers view finals_lineups read-only — only admins may still write. Default false. Distinct from competition_order_locked.';

-- ---------------------------------------------------------------------------
-- finals_lineups
-- ---------------------------------------------------------------------------
-- A nationals team's (club + level + placement category) pick of up to 4
-- athletes per apparatus for finals, plus drag order. "category" is the
-- placement category string produced by the nationals engine's
-- deriveCategory (e.g. 'Collegiate Women+') — stored as free text since the
-- category taxonomy lives in application code, not a DB enum.
--
-- id is app-generated text like every other table (CLAUDE.md convention).
create table finals_lineups (
  id           text primary key,
  event_id     text not null references events (id) on delete cascade,
  club_id      text not null references clubs (id) on delete cascade,
  level_id     text not null references levels (id) on delete cascade,
  category     text not null,
  apparatus    text not null,
  -- [regId, regId, ...] — ordered, at most 4 (finals competing order). See
  -- src/lib/finals-lineup.ts (finalsLineupValid/moveInLineup/toggleInLineup)
  -- for the pure helpers that build/validate/edit this shape; the C2 UI is
  -- the only writer of a real column value.
  reg_ids      jsonb not null default '[]'::jsonb,
  updated_at   timestamptz not null default now()
);

-- One row per (event, club, level, category, apparatus) — re-saving the same
-- key updates the existing row (upsert) rather than creating a duplicate.
create unique index on finals_lineups (event_id, club_id, level_id, category, apparatus);

-- ---------------------------------------------------------------------------
-- event_finals_locked(eid) — SECURITY DEFINER lock-check helper
-- ---------------------------------------------------------------------------
-- Mirrors event_order_locked()'s idiom (CLAUDE.md 42P17 recursion trap): a
-- raw RLS subquery reading `events` is safe here in principle (events' own
-- policies never read back into finals_lineups, so there's no cycle), but a
-- helper function keeps the lock-check readable/reusable across the
-- insert/update/delete policies below and fail-closed by construction
-- (coalesce(...,false) — an event row that's somehow missing is treated as
-- LOCKED, the safer default, rather than open).
create or replace function event_finals_locked(eid text) returns boolean as $$
  select coalesce((select finals_roster_locked from events where id = eid), false);
$$ language sql stable security definer set search_path = public, pg_temp;
revoke all on function event_finals_locked(text) from public;
grant execute on function event_finals_locked(text) to authenticated;

-- ---------------------------------------------------------------------------
-- RLS — finals_lineups
-- ---------------------------------------------------------------------------
-- Follows the codebase's SECURITY DEFINER helper pattern (is_admin(),
-- auth_has_role(), manages_club()) rather than raw cross-table subqueries in
-- the club/admin predicates, to avoid the 42P17 policy-recursion trap
-- (CLAUDE.md) — same template as competition_orders (20260713173105).
-- event_finals_locked() itself reads `events` directly (not through another
-- policy-guarded helper chain), and events' policies never read
-- finals_lineups, so there is no cycle.
alter table finals_lineups enable row level security;

-- SELECT: admin, sanctioning (nationals-ops visibility), or the club manager
-- — locked or not, a club can always VIEW its own lineup (view-only-after-
-- lock is enforced by omitting write access below, not by hiding the row).
create policy finals_lineups_select on finals_lineups for select
  using (
    is_admin()
    or auth_has_role('sanctioning')
    or manages_club(club_id)
  );

-- INSERT: admin always; a club manager only while the event's finals roster
-- is UNlocked.
create policy finals_lineups_insert on finals_lineups for insert
  with check (
    is_admin()
    or (manages_club(club_id) and not event_finals_locked(event_id))
  );

-- UPDATE: same predicate on both USING and WITH CHECK — a locked event's
-- existing rows become read-only for club managers (the USING clause blocks
-- them from targeting the row at all); admins can always edit, including to
-- fix up a lineup after lock.
create policy finals_lineups_update on finals_lineups for update
  using (
    is_admin()
    or (manages_club(club_id) and not event_finals_locked(event_id))
  )
  with check (
    is_admin()
    or (manages_club(club_id) and not event_finals_locked(event_id))
  );

-- DELETE: same predicate — lets a club clean up a stale category/apparatus
-- row (e.g. after a registration change) while still unlocked.
create policy finals_lineups_delete on finals_lineups for delete
  using (
    is_admin()
    or (manages_club(club_id) and not event_finals_locked(event_id))
  );

revoke all on finals_lineups from public;
grant select, insert, update, delete on finals_lineups to authenticated;
