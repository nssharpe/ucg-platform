-- Fix: the four host-scoped SECURITY DEFINER RPCs
-- (event_host_roster / event_host_addons / event_collected_total /
-- mark_medals_received) all opened with
--
--   select e.host_club_id into v_host_club_id from events e where e.id = p_event_id;
--   if v_host_club_id is null then raise exception 'Event not found.'; end if;
--
-- which conflates "no such event row" with "the event has no host club".
-- Since 2026-07-22 UCG-hosted events (FlipFest / Nationals) legitimately carry
-- host_club_id = NULL (they need no host club -- see 20260722221027 /
-- CLAUDE.md "Camps / UCG events"). So for a real, existing UCG event the guard
-- raised 'Event not found.' before ever reaching the authorization check --
-- breaking the host dashboard roster fetch and the nationals event-summary
-- add-on fetch, and spamming `[supabase] event_host_roster failed` /
-- `event_host_addons failed` to the console for every admin/host who opened
-- one (reproduced live against prod on ucg-nationals-2027, HTTP 400 P0001).
--
-- Correct existence check: `if not found` after the SELECT INTO (the plpgsql
-- FOUND flag is false only when zero rows matched -- a NULL host_club_id on a
-- present row does NOT trip it). A host-club-less UCG event then flows to the
-- unchanged authorization predicate; manages_club(NULL) is false (and returns
-- true for admins regardless), so admin / sanctioning / granted event-admin
-- callers are authorized exactly as before, and a stranger is still rejected.
--
-- Everything else in each function (return shape, body query, grants) is
-- preserved verbatim; only the null-guard line changes. Same-signature
-- CREATE OR REPLACE is legal for the table-returning pair (no column change).

-- ---------------------------------------------------------------------------
-- event_host_roster() -- latest definition 20260710151638 (26-col table).
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
  region text,
  dob date,
  gender text,
  camp_survey jsonb,
  created_at timestamptz
)
language plpgsql stable security definer set search_path = public as $$
declare
  v_host_club_id text;
begin
  select e.host_club_id into v_host_club_id from events e where e.id = p_event_id;
  if not found then
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
      c.region,
      p.dob,
      p.gender::text,
      r.camp_survey,
      r.created_at
    from registrations r
    join people p on p.id = r.athlete_id
    left join clubs c on c.id = r.club_id
    where r.event_id = p_event_id and not r.refunded;
end;
$$;

revoke execute on function event_host_roster(text) from public;
grant execute on function event_host_roster(text) to authenticated;

-- ---------------------------------------------------------------------------
-- event_host_addons() -- latest definition 20260710151638 (8-col table).
-- ---------------------------------------------------------------------------
create or replace function event_host_addons(p_event_id text)
returns table(
  item_id text,
  ref_line_type text,
  addon_size text,
  addon_assignee text,
  assignee_first_name text,
  assignee_last_name text,
  label text,
  ref_user_id text
)
language plpgsql stable security definer set search_path = public as $$
declare
  v_host_club_id text;
begin
  select e.host_club_id into v_host_club_id from events e where e.id = p_event_id;
  if not found then
    raise exception 'Event not found.';
  end if;

  if not (
    is_admin()
    or coalesce(auth_has_role('sanctioning'), false)
    or coalesce(manages_club(v_host_club_id), false)
    or exists (select 1 from event_admins ea where ea.event_id = p_event_id and ea.user_id = auth.uid())
  ) then
    raise exception 'Not authorized to view this event''s add-on purchases.';
  end if;

  return query
    select
      ii.id::text,
      ii.ref_line_type,
      ii.addon_size,
      ii.addon_assignee,
      p.first_name,
      p.last_name,
      ii.label,
      ii.ref_user_id::text
    from invoice_items ii
    left join people p on p.id::text = ii.addon_assignee
    where ii.ref_event_id = p_event_id
      and ii.kind = 'addon'
      and ii.ref_line_type in ('tshirt', 'leo', 'banquet')
      and not ii.refunded;
end;
$$;

revoke execute on function event_host_addons(text) from public;
grant execute on function event_host_addons(text) to authenticated;

-- ---------------------------------------------------------------------------
-- event_collected_total() -- latest definition 20260709211656 (returns numeric).
-- ---------------------------------------------------------------------------
create or replace function event_collected_total(p_event_id text)
returns numeric
language plpgsql stable security definer set search_path = public as $$
declare
  v_host_club_id text;
  v_total numeric;
begin
  select e.host_club_id into v_host_club_id from events e where e.id = p_event_id;
  if not found then
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
-- mark_medals_received() -- latest definition 20260709211656 (returns void).
-- ---------------------------------------------------------------------------
create or replace function mark_medals_received(p_event_id text)
returns void
language plpgsql volatile security definer set search_path = public as $$
declare
  v_host_club_id text;
begin
  select e.host_club_id into v_host_club_id from events e where e.id = p_event_id;
  if not found then
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
      '{medalsTracking}',
      coalesce(owner_checklist->'medalsTracking', '{}'::jsonb) || jsonb_build_object('hostReceived', true),
      true
    )
    where id = p_event_id;
end;
$$;

revoke execute on function mark_medals_received(text) from public;
grant execute on function mark_medals_received(text) to authenticated;
