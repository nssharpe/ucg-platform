-- Event-management v2 Phase 2, Task 7: host workbook needs (a) camp-specific
-- athlete detail (dob/gender/camp survey/registered-at) on the existing
-- roster RPC, and (b) purchased per-unit add-on lines (t-shirt/leo/banquet)
-- across ALL competing clubs for the event -- `invoice_items` RLS scopes an
-- ordinary caller to their own/managed-club rows, so a host can't see another
-- club's purchases without a security-definer exception, same reasoning as
-- `event_host_roster` in 20260709211656_event_host_tools.sql (copy its
-- authorization predicate verbatim).

-- ---------------------------------------------------------------------------
-- event_host_roster(): add dob/gender/camp_survey/created_at so the host
-- workbook's camp export (one row per athlete: name, club, birthday, gender,
-- survey answers, date registered) doesn't need a second roster query.
-- CREATE OR REPLACE with a changed return signature requires DROP first
-- (Postgres won't let you change a table function's column list/order
-- in place).
-- ---------------------------------------------------------------------------
drop function if exists event_host_roster(text);

create function event_host_roster(p_event_id text)
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
-- event_host_addons(): one row per purchased add-on UNIT (t-shirt/leo/
-- banquet -- 'banner' is a per-event flat purchase, not a per-unit line, so
-- it's excluded here) for the event, across every competing club. Only
-- fulfilled purchases exist in `invoice_items` at all (rows are written by
-- stripe-webhook from the payment's lines_snapshot at fulfillment time, never
-- at cart-add time -- see stripe-webhook/index.ts) so no separate paid/status
-- filter is needed; `not refunded` excludes refunded units as the host
-- workbook requires. `ref_user_id` is returned alongside `addon_assignee`
-- because the two mean different things: `addon_assignee` (a person id or
-- 'extra') is set ONLY on banquet lines (src/lib/pricing.ts
-- buildAddonCartItems/buildClubAddonCartItems); an athlete's OWN t-shirt/leo
-- self-purchase instead sets `ref_user_id` to their own id (club-manager
-- t-shirt purchases set neither -- unattributed to any one athlete). The
-- camp per-athlete export sheet matches purchased shirt/leo size by
-- ref_user_id since camps are individual-only registration (no club-cart
-- purchase path), so every camp shirt/leo unit does carry it.
-- ---------------------------------------------------------------------------
create function event_host_addons(p_event_id text)
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
  if v_host_club_id is null then
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
