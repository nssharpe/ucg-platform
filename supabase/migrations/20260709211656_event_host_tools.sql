-- Event-management v2 Phase 1, Task 5: event host viewing page (spec §C —
-- status card + registration summary). Three SECURITY DEFINER RPCs so a host
-- (host-club manager / event admin) can see event-wide data their own RLS
-- would otherwise scope them away from (athlete detail belongs to OTHER
-- clubs; money detail lives in invoice_items which isn't club-scoped at all).
-- Style-matches 20260709133846_event_admins.sql: authorize ONCE up front,
-- fail-closed (coalesce over the OR-chain), search_path pinned, execute
-- revoked from public / granted to authenticated.

-- Shared authorization, inlined into each function (plpgsql has no shared
-- helper for a multi-line predicate without a separate function call per
-- invocation, which would cost an extra event lookup) -- admins, the
-- sanctioning team, the event's host-club managers, or a granted event admin.
-- Kept in comment form here as the canonical predicate; copy verbatim below:
--   is_admin() or coalesce(auth_has_role('sanctioning'), false)
--     or coalesce(manages_club(v_host_club_id), false)
--     or exists (select 1 from event_admins ea where ea.event_id = p_event_id and ea.user_id = auth.uid())

-- ---------------------------------------------------------------------------
-- event_host_roster(): one row per non-refunded registration of the event,
-- joined out to the athlete's full detail. Hosts legitimately need event-wide
-- athlete detail to run the meet (rosters, shirt counts, dietary/medical,
-- emergency contacts), but `people`/`registrations` RLS scopes ordinary
-- callers to their own club's rows -- this RPC is the deliberate, event-
-- scoped exception (mirrors the admin CSV export's column set,
-- src/pages/Events.tsx exportCsv).
-- ---------------------------------------------------------------------------
create or replace function event_host_roster(p_event_id text)
returns table(
  reg_id text,
  athlete_id text,
  first_name text,
  last_name text,
  club_id text,
  club_name text,
  discipline text,
  level_id text,
  apparatus text[],
  apparatus_levels jsonb,
  session_id text,
  paid boolean,
  updated_pending boolean,
  partner_athlete_id text,
  shirt text,
  dietary text[],
  email text,
  phone text,
  emergency_contact text,
  student_status text,
  region text
)
language plpgsql stable security definer set search_path = public as $$
declare
  v_host_club_id text;
begin
  select e.host_club_id into v_host_club_id from events e where e.id = p_event_id;
  if v_host_club_id is null then
    raise exception 'Event not found.';
  end if;

  if not (
    is_admin()
    or coalesce(auth_has_role('sanctioning'), false)
    or coalesce(manages_club(v_host_club_id), false)
    or exists (select 1 from event_admins ea where ea.event_id = p_event_id and ea.user_id = auth.uid())
  ) then
    raise exception 'Not authorized to view this event''s roster.';
  end if;

  return query
    select
      r.id::text,
      r.athlete_id::text,
      p.first_name,
      p.last_name,
      r.club_id,
      c.name,
      r.discipline::text,
      r.level_id,
      r.apparatus,
      r.apparatus_levels,
      r.session_id,
      r.paid,
      r.updated_pending,
      r.partner_athlete_id::text,
      p.shirt,
      p.dietary,
      p.email,
      p.phone,
      trim(coalesce(p.emergency->>'contact', '') || ' ' || coalesce(p.emergency->>'phone', '')),
      p.student_status::text,
      c.region
    from registrations r
    join people p on p.id = r.athlete_id
    left join clubs c on c.id = r.club_id
    where r.event_id = p_event_id and not r.refunded;
end;
$$;

revoke execute on function event_host_roster(text) from public;
grant execute on function event_host_roster(text) to authenticated;

-- ---------------------------------------------------------------------------
-- event_collected_total(): sum of money actually collected for this event
-- through the platform, for the host status card's "Collected so far".
--
-- How money reaches invoice_items (checked against
-- supabase/functions/create-checkout-session/index.ts + stripe-webhook):
-- entry fees, change fees, and add-ons (t-shirt/banner) are ALL written with
-- kind='meet-entry' and ref_event_id = the event (pushLine calls at
-- create-checkout-session/index.ts:328-392); coupons reduce a line's amount
-- in place rather than writing a separate 'discount' row, so summing amount
-- already nets out discounts. The 'fee' kind (card-processing / service fee,
-- stripe-webhook/index.ts:383-386) is always written with ref_event_id NULL
-- -- filtering on ref_event_id already excludes it structurally, but this
-- also excludes kind='fee' defensively in case that ever changes. No
-- 'banquet'/'donation' lines are written with a ref_event_id today (banquet
-- purchases aren't wired into checkout yet), so nothing is silently dropped
-- by the meet-entry filter as of this migration -- if that changes, widen
-- this predicate.
-- ---------------------------------------------------------------------------
create or replace function event_collected_total(p_event_id text)
returns numeric
language plpgsql stable security definer set search_path = public as $$
declare
  v_host_club_id text;
  v_total numeric;
begin
  select e.host_club_id into v_host_club_id from events e where e.id = p_event_id;
  if v_host_club_id is null then
    raise exception 'Event not found.';
  end if;

  if not (
    is_admin()
    or coalesce(auth_has_role('sanctioning'), false)
    or coalesce(manages_club(v_host_club_id), false)
    or exists (select 1 from event_admins ea where ea.event_id = p_event_id and ea.user_id = auth.uid())
  ) then
    raise exception 'Not authorized to view this event''s finances.';
  end if;

  select coalesce(sum(ii.amount), 0) into v_total
    from invoice_items ii
    where ii.ref_event_id = p_event_id
      and not ii.refunded
      and ii.kind <> 'fee';

  return v_total;
end;
$$;

revoke execute on function event_collected_total(text) from public;
grant execute on function event_collected_total(text) to authenticated;

-- ---------------------------------------------------------------------------
-- mark_medals_received(): the host's one scoped write on this page -- hosts
-- can't UPDATE events directly (owner_checklist is sanctioning/admin-writable
-- only, per 20260709131708_event_owner_checklist.sql), so flipping
-- owner_checklist.medalsTracking.hostReceived to true needs a narrow RPC.
-- jsonb_set with create_missing=true so this still works even if the
-- checklist or the medalsTracking entry hasn't been touched by the owner yet.
-- ---------------------------------------------------------------------------
create or replace function mark_medals_received(p_event_id text)
returns void
language plpgsql volatile security definer set search_path = public as $$
declare
  v_host_club_id text;
begin
  select e.host_club_id into v_host_club_id from events e where e.id = p_event_id;
  if v_host_club_id is null then
    raise exception 'Event not found.';
  end if;

  if not (
    is_admin()
    or coalesce(auth_has_role('sanctioning'), false)
    or coalesce(manages_club(v_host_club_id), false)
    or exists (select 1 from event_admins ea where ea.event_id = p_event_id and ea.user_id = auth.uid())
  ) then
    raise exception 'Not authorized to update this event''s checklist.';
  end if;

  update events
    set owner_checklist = jsonb_set(
      coalesce(owner_checklist, '{}'::jsonb),
      '{medalsTracking,hostReceived}',
      'true'::jsonb,
      true
    )
    where id = p_event_id;
end;
$$;

revoke execute on function mark_medals_received(text) from public;
grant execute on function mark_medals_received(text) to authenticated;
