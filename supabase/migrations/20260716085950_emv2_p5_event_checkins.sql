-- Event-management v2 Phase 5, Task E1: nationals check-in flow (spec §L.4).
--
-- League/meet admins OPEN check-in for a club (or an independent athlete) at
-- a nationals event; the club manager (or the athlete themself) then confirms
-- with a checkbox + typed signature. A row only EXISTS once an admin has
-- opened it — "no row" is the "not opened yet" state, so there's no separate
-- boolean for that.

-- ---------------------------------------------------------------------------
-- event_checkins
-- ---------------------------------------------------------------------------
-- Dual-scoped by EITHER club_id (club variant) OR person_id (independent-
-- athlete variant) — never both, never neither. Same XOR idiom as
-- waitlist_groups/session_requests: if both were allowed, a personal caller
-- could smuggle a club_id they don't manage onto their own-person row (the
-- per-branch policy would pass on the person_id branch while the row still
-- carried the foreign club_id).
create table event_checkins (
  id             text primary key,
  event_id       text not null references events (id) on delete cascade,
  club_id        text references clubs (id) on delete cascade,
  person_id      text references people (id) on delete cascade,
  status         text not null default 'open' check (status in ('open', 'checked-in')),
  signed_name    text,
  checked_in_at  timestamptz,
  checked_in_by  text references people (id) on delete set null,
  opened_by      text references people (id) on delete set null,
  created_at     timestamptz not null default now(),
  -- XOR, not OR — see rationale above (mirrors waitlist_groups/session_requests).
  check ((club_id is null) <> (person_id is null))
);

-- One check-in row per (event, scope) — re-opening the same scope updates
-- the existing row (upsert) rather than creating a duplicate.
create unique index on event_checkins (event_id, coalesce(club_id, ''), coalesce(person_id, ''));

-- ---------------------------------------------------------------------------
-- RLS — event_checkins
-- ---------------------------------------------------------------------------
-- Follows the codebase's SECURITY DEFINER helper pattern (is_admin(),
-- auth_has_role(), manages_club(), my_person_id()) rather than raw
-- cross-table subqueries, to avoid the 42P17 policy-recursion trap
-- (CLAUDE.md — a subquery into a table whose OWN policies read back into
-- this one recurses and breaks every caller's reads, not just the
-- offending query's).
alter table event_checkins enable row level security;

-- SELECT: admin, sanctioning, the club manager (club variant), the checked-in
-- person themself (independent variant).
create policy event_checkins_select on event_checkins for select
  using (
    is_admin()
    or auth_has_role('sanctioning')
    or (club_id is not null and manages_club(club_id))
    or coalesce(person_id = my_person_id(), false)
  );

-- INSERT: admin/sanctioning ONLY — opening check-in is an admin/league
-- action; a club cannot self-open its own check-in. WITH CHECK also pins
-- status = 'open' so a client can't insert an already-checked-in row.
create policy event_checkins_insert on event_checkins for insert
  with check (
    status = 'open'
    and (is_admin() or auth_has_role('sanctioning'))
  );

-- UPDATE: the club manager / athlete confirms (open -> checked-in). USING
-- lets the actor see/target their own scope's row; WITH CHECK re-pins the
-- same actor predicate AND restricts the new status to the two valid values
-- (defense in depth — the check constraint already does this) so a client
-- can't flip a row back to some other state.
--
-- The column-level GRANT below is the real guard against a club editing
-- event_id/club_id/person_id/opened_by (e.g. re-pointing its own row at a
-- different scope, or self-opening by writing status alongside a fabricated
-- opened_by) — RLS alone can't restrict WHICH columns an authorized UPDATE
-- touches, only WHICH ROWS. Only admins bypass the column grant (they act
-- through the same policies but hold blanket table privileges besides).
create policy event_checkins_update on event_checkins for update
  using (
    is_admin()
    or auth_has_role('sanctioning')
    or (club_id is not null and manages_club(club_id))
    or coalesce(person_id = my_person_id(), false)
  )
  with check (
    status in ('open', 'checked-in')
    and (
      is_admin()
      or auth_has_role('sanctioning')
      or (club_id is not null and manages_club(club_id))
      or coalesce(person_id = my_person_id(), false)
    )
  );

-- DELETE: admin only — lets an admin undo an erroneous "open" action.
create policy event_checkins_delete on event_checkins for delete
  using (is_admin());

revoke all on event_checkins from public;
grant select, insert on event_checkins to authenticated;
-- Column-scoped UPDATE grant: a club/athlete confirming check-in may only
-- write the confirmation columns, never event_id/club_id/person_id/opened_by
-- (mirrors waitlist_groups' `grant update (status)` — CLAUDE.md "RLS upsert
-- trap"/column-grant pattern). Admins operate via the same policies; this
-- grant is what stops a manager from tampering with rows outside their own
-- confirmation action (e.g. reassigning club_id, or self-stamping opened_by
-- to fake an admin-opened check-in).
grant update (status, signed_name, checked_in_at, checked_in_by) on event_checkins to authenticated;
