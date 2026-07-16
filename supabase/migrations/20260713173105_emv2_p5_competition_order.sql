-- Event-management v2 Phase 5, Task B1: "Set Competition Order" data
-- foundation ONLY (spec §E6). No UI, no drag-and-drop logic, no ordering
-- enforcement in checkout/scoring — those are later P5 tasks (B2 club UI).
-- This migration just lays the table/lock-flag/RLS the UI will need.

-- ---------------------------------------------------------------------------
-- events.competition_order_locked
-- ---------------------------------------------------------------------------
-- Event-settings checkbox (host/admin-set): once true, club managers may only
-- VIEW competition orders — only admins may keep editing. Absent/false is the
-- default (clubs edit freely pre-lock).
alter table events add column if not exists competition_order_locked boolean not null default false;
comment on column events.competition_order_locked is
  'event-mgmt v2 P5 §E6: once true, club managers view competition_orders read-only — only admins may still write. Default false.';

-- ---------------------------------------------------------------------------
-- competition_orders
-- ---------------------------------------------------------------------------
-- MAG/WAG only (not T&T) — a club's drag-and-drop-ordered competing order for
-- one apparatus at one level, at one event. `sections` is an array of arrays
-- of registration ids: the outer array is section (flight) order, each inner
-- array is that section's athlete competing order. This single jsonb column
-- encodes BOTH the athlete order AND the club's section split (capped at 12
-- for WAG / 15 for MAG per section — see `sectionCap` in
-- src/lib/competition-order.ts) rather than needing a separate sections
-- table, since the whole shape is rewritten together on every drag-drop save.
--
-- id is app-generated text like every other table (CLAUDE.md convention).
create table competition_orders (
  id           text primary key,
  event_id     text not null references events (id) on delete cascade,
  club_id      text not null references clubs (id) on delete cascade,
  level_id     text not null references levels (id) on delete cascade,
  -- Apparatus code, matches the values used in registrations.apparatus.
  apparatus    text not null,
  -- [[regId, regId, ...], [regId, ...], ...] — outer = section order, inner =
  -- competing order within that section. See src/lib/competition-order.ts
  -- (splitIntoSections/flattenSections/sectionsValid/moveInSections) for the
  -- pure helpers that build/validate/edit this shape; the B2 UI is the only
  -- writer of a real column value.
  sections     jsonb not null default '[]'::jsonb,
  updated_at   timestamptz not null default now()
);

-- One row per (event, club, level, apparatus) — re-saving the same key
-- updates the existing row (upsert) rather than creating a duplicate.
create unique index on competition_orders (event_id, club_id, level_id, apparatus);

-- ---------------------------------------------------------------------------
-- event_order_locked(eid) — SECURITY DEFINER lock-check helper
-- ---------------------------------------------------------------------------
-- Mirrors the codebase's is_admin()/manages_club()/my_person_id() helper
-- idiom (CLAUDE.md 42P17 recursion trap): a raw RLS subquery reading `events`
-- is safe here in principle (events' own policies never read back into
-- competition_orders, so there's no cycle), but a helper function keeps the
-- lock-check readable/reusable across the insert/update/delete policies below
-- and fail-closed by construction (coalesce(...,true) — an event row that's
-- somehow missing is treated as LOCKED, the safer default, rather than open;
-- unreachable in practice since event_id is a NOT NULL FK, but the default
-- must match the documented intent).
create or replace function event_order_locked(eid text) returns boolean as $$
  select coalesce((select competition_order_locked from events where id = eid), true);
$$ language sql stable security definer set search_path = public, pg_temp;
revoke all on function event_order_locked(text) from public;
grant execute on function event_order_locked(text) to authenticated;

-- ---------------------------------------------------------------------------
-- RLS — competition_orders
-- ---------------------------------------------------------------------------
-- Follows the codebase's SECURITY DEFINER helper pattern (is_admin(),
-- auth_has_role(), manages_club()) rather than raw cross-table subqueries in
-- the club/admin predicates, to avoid the 42P17 policy-recursion trap
-- (CLAUDE.md) — same template as waitlist_groups (20260711135842) and
-- session_requests (20260713140000). event_order_locked() itself reads
-- `events` directly (not through another policy-guarded helper chain), and
-- events' policies never read competition_orders, so there is no cycle.
alter table competition_orders enable row level security;

-- SELECT: admin, sanctioning (nationals-ops visibility), or the club manager
-- — locked or not, a club can always VIEW its own order (view-only-after-lock
-- is enforced by omitting write access below, not by hiding the row).
create policy competition_orders_select on competition_orders for select
  using (
    is_admin()
    or auth_has_role('sanctioning')
    or manages_club(club_id)
  );

-- INSERT: admin always; a club manager only while the event is UNlocked.
create policy competition_orders_insert on competition_orders for insert
  with check (
    is_admin()
    or (manages_club(club_id) and not event_order_locked(event_id))
  );

-- UPDATE: same predicate on both USING and WITH CHECK — a locked event's
-- existing rows become read-only for club managers (the USING clause blocks
-- them from targeting the row at all); admins can always edit, including to
-- fix up an order after lock.
create policy competition_orders_update on competition_orders for update
  using (
    is_admin()
    or (manages_club(club_id) and not event_order_locked(event_id))
  )
  with check (
    is_admin()
    or (manages_club(club_id) and not event_order_locked(event_id))
  );

-- DELETE: same predicate — lets a club clean up a stale apparatus/level row
-- (e.g. after a registration change) while still unlocked.
create policy competition_orders_delete on competition_orders for delete
  using (
    is_admin()
    or (manages_club(club_id) and not event_order_locked(event_id))
  );

revoke all on competition_orders from public;
grant select, insert, update, delete on competition_orders to authenticated;

-- ---------------------------------------------------------------------------
-- Content validation — competition_orders_validate() trigger
-- ---------------------------------------------------------------------------
-- RLS above scopes WHO may write a row (the club's manager, pre-lock), but
-- says nothing about WHAT `sections` contains — a caller hitting PostgREST
-- directly could otherwise store malformed JSON or registration ids from a
-- different club/event, which downstream host tooling (session assignment,
-- scoring order) would then trust. This trigger pins the content invariants:
--   - `sections` is an array of arrays of strings (the [[regId,...],...] shape);
--   - no registration id appears twice across the whole order;
--   - every id references a registration of THIS event and THIS club.
-- Per-section size caps (12 WAG / 15 MAG, `sectionCap` in
-- src/lib/competition-order.ts) stay client-side: the cap depends on the
-- discipline taxonomy, which lives in application code.
--
-- SECURITY DEFINER (the guard-trigger idiom, e.g. guard_registration_paid)
-- so the registrations lookup can't false-reject on RLS visibility. Reads
-- only NEW — exempt from the upsert-trigger trap (CLAUDE.md), which only
-- bites triggers that consult OLD/tg_op.
create or replace function competition_orders_validate() returns trigger as $$
declare
  ids text[];
  n_ids int;
  n_bad int;
begin
  if jsonb_typeof(new.sections) is distinct from 'array' then
    raise exception 'sections must be a JSON array of arrays of registration ids';
  end if;
  if exists (
    select 1 from jsonb_array_elements(new.sections) sec(s)
    where jsonb_typeof(sec.s) <> 'array'
  ) then
    raise exception 'each section must be a JSON array of registration ids';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(new.sections) sec(s)
    cross join lateral jsonb_array_elements(sec.s) el(e)
    where jsonb_typeof(el.e) <> 'string'
  ) then
    raise exception 'registration ids in sections must be strings';
  end if;

  select coalesce(array_agg(el.e #>> '{}'), '{}') into ids
  from jsonb_array_elements(new.sections) sec(s)
  cross join lateral jsonb_array_elements(sec.s) el(e);

  n_ids := coalesce(array_length(ids, 1), 0);
  if n_ids <> (select count(distinct u) from unnest(ids) u) then
    raise exception 'sections may not list the same registration id twice';
  end if;

  select count(*) into n_bad
  from unnest(ids) rid
  where not exists (
    select 1 from registrations r
    where r.id = rid and r.event_id = new.event_id and r.club_id = new.club_id
  );
  if n_bad > 0 then
    raise exception '% registration id(s) in sections do not belong to this event/club', n_bad;
  end if;

  return new;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

create trigger competition_orders_validate
  before insert or update on competition_orders
  for each row execute function competition_orders_validate();
