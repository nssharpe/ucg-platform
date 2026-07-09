-- Event-management v2 Phase 1, Task 1: event owner assignment + owner task
-- checklist (spec §B3-4). Data model + RLS + a helper RPC only -- due-date
-- computation is pure TS (_shared/owner-checklist.ts) and reminder emails are
-- a later task.

-- { userId?: uuid-as-text, name: text, email: text } or null (unassigned).
alter table events add column if not exists owner jsonb;

-- Keyed by task id ('contact' | 'hotel' | 'medalsOrdered' | 'medalsTracking' |
-- 'insurance' | 'onsiteRep' | 'payHost'); each value is
-- { done?: boolean, doneAt?: string, note?: string, ...task-specific payload }.
-- See src/lib/types.ts OwnerChecklist / supabase/functions/_shared/owner-checklist.ts
-- for the shape and due-date rules.
alter table events add column if not exists owner_checklist jsonb;

-- ---------------------------------------------------------------------------
-- RLS: sanctioning-team members (app_role 'sanctioning') can now UPDATE
-- events, not just admins (spec §A: event details editable by sanctioning +
-- league admins). `admin_all` (for all, using is_admin()) already covers
-- admins; this adds an UPDATE-only permissive policy for sanctioning (RLS
-- policies for the same command are OR'd, so this only ADDS reach, never
-- narrows the existing admin grant). Deliberately NOT `for all` -- that would
-- silently also grant DELETE to sanctioning, which is not intended here.
-- `auth_has_role()` (20260601000002_rls.sql) is already the fail-closed,
-- security-definer helper for this -- no new helper needed. Wrapped in
-- coalesce for belt-and-suspenders fail-closed on an unauthenticated caller.
create policy sanctioning_update on public.events for update
  using (is_admin() or coalesce(auth_has_role('sanctioning'), false))
  with check (is_admin() or coalesce(auth_has_role('sanctioning'), false));

-- ---------------------------------------------------------------------------
-- list_sanctioning_team(): the sanctioning/admin roster for the owner-assign
-- dropdown. SECURITY DEFINER so a non-admin sanctioning caller can read
-- other users' people/user_roles rows (which their own RLS wouldn't allow) --
-- authorization is checked ONCE up front, fail-closed, mirroring
-- replace_club_managers (20260703221303_fix_club_managers_self_lockout.sql).
create or replace function list_sanctioning_team()
returns table(user_id uuid, name text, email text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not (is_admin() or coalesce(auth_has_role('sanctioning'), false)) then
    raise exception 'Not authorized to view the sanctioning team.';
  end if;

  return query
    select distinct p.auth_user_id as user_id,
      trim(p.first_name || ' ' || p.last_name) as name,
      p.email
    from user_roles ur
    join people p on p.auth_user_id = ur.user_id
    where ur.role in ('sanctioning', 'admin')
    order by 2;
end;
$$;

revoke execute on function list_sanctioning_team() from public;
grant execute on function list_sanctioning_team() to authenticated;
