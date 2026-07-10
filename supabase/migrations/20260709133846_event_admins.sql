-- Event-management v2 Phase 1, Task 3: per-event admin grants (spec §C).
-- Hosts can give other accounts the same host-level access to ONE event --
-- a net-new per-event ACL, not a club role. Writes go through two SECURITY
-- DEFINER RPCs (never direct table inserts/updates/deletes) -- mirrors
-- replace_club_managers (20260703221303_fix_club_managers_self_lockout.sql):
-- authorize ONCE up front, fail-closed with coalesce(...,false), and avoid
-- exposing a general people-search to any event host.

create table if not exists event_admins (
  id          text primary key,
  event_id    text not null references events(id) on delete cascade,
  user_id     uuid not null,
  email       text not null,
  name        text,
  granted_by  uuid,
  created_at  timestamptz not null default now(),
  unique (event_id, user_id)
);
create index if not exists event_admins_event_idx on event_admins (event_id);

alter table event_admins enable row level security;

-- Read-only RLS -- no insert/update/delete policies; all writes go through
-- grant_event_admin/revoke_event_admin below. Readable by: admins, the
-- sanctioning team, the admin-grant's own subject (so a granted user can see
-- their own access), and anyone who manages the event's host club. Wrapped
-- fail-closed (coalesce) so an anon/errored auth_has_role()/manages_club()
-- lookup denies rather than raising NULL through the OR-chain (CLAUDE.md
-- "fail-closed SQL" trap). This policy reads `events` (already public_read),
-- never `event_admins` itself, so there's no RLS recursion risk.
create policy event_admins_read on event_admins for select using (
  is_admin()
  or coalesce(auth_has_role('sanctioning'), false)
  or user_id = auth.uid()
  or coalesce(manages_club((select host_club_id from events e where e.id = event_admins.event_id)), false)
);

grant select on event_admins to authenticated;

-- grant_event_admin(): looks up the target account by exact email (case-
-- insensitive) on `people` and grants them event-admin access. Deliberately
-- does NOT support name/substring search -- an exact-email lookup only
-- confirms the matched person's identity for an email the caller already
-- knows, which is an acceptable PII exposure; a general people-search is not
-- (per-event ACL controller decision -- Julia's "search by name" ask is
-- deferred). Authorized for: admins, the event's host-club managers, or an
-- existing event admin for that event (so a granted admin can add others).
create or replace function grant_event_admin(p_event_id text, p_email text)
returns table(user_id uuid, email text, name text)
language plpgsql volatile security definer set search_path = public as $$
declare
  v_host_club_id text;
  v_person record;
  v_id text;
begin
  select e.host_club_id into v_host_club_id from events e where e.id = p_event_id;
  if v_host_club_id is null then
    raise exception 'Event not found.';
  end if;

  if not (
    is_admin()
    or coalesce(manages_club(v_host_club_id), false)
    or exists (select 1 from event_admins ea where ea.event_id = p_event_id and ea.user_id = auth.uid())
  ) then
    raise exception 'Not authorized to manage admins for this event.';
  end if;

  select p.auth_user_id, p.email, trim(p.first_name || ' ' || p.last_name) as full_name
    into v_person
    from people p
    where p.auth_user_id is not null and lower(p.email) = lower(p_email)
    limit 1;

  if not found then
    raise exception 'No account found for that email.';
  end if;

  v_id := gen_random_uuid()::text;

  insert into event_admins (id, event_id, user_id, email, name, granted_by)
    values (v_id, p_event_id, v_person.auth_user_id, v_person.email, v_person.full_name, auth.uid())
    on conflict (event_id, user_id) do update
      set email = excluded.email, name = excluded.name;

  return query select v_person.auth_user_id, v_person.email, v_person.full_name;
end;
$$;

revoke execute on function grant_event_admin(text, text) from public;
grant execute on function grant_event_admin(text, text) to authenticated;

-- revoke_event_admin(): same authorization as grant_event_admin.
create or replace function revoke_event_admin(p_event_id text, p_user_id uuid)
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
    or coalesce(manages_club(v_host_club_id), false)
    or exists (select 1 from event_admins ea where ea.event_id = p_event_id and ea.user_id = auth.uid())
  ) then
    raise exception 'Not authorized to manage admins for this event.';
  end if;

  delete from event_admins where event_id = p_event_id and user_id = p_user_id;
end;
$$;

revoke execute on function revoke_event_admin(text, uuid) from public;
grant execute on function revoke_event_admin(text, uuid) to authenticated;
