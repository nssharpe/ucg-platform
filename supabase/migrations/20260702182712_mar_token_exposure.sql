-- C3: stop exposing manager_access_requests.token to the requester, and add a
-- belt-and-braces requester!=decider check in decide_manager_access.
--
-- Enumeration (grepped src/ for `manager_access_requests` before writing
-- this): the table has NO direct requester-facing reader. The only two
-- consumers are the RPCs `get_manager_access_request` (no-login token lookup,
-- returns status/requester_name/club_name — never the token itself) and
-- `decide_manager_access`, both called exclusively from
-- src/pages/ManagerAccessReview.tsx via src/lib/supabase.ts's
-- fetchManagerAccessRequest/decideManagerAccess wrappers. `mar_read` (select
-- using is_admin() or requester_person_id = my_person_id()) is unused by any
-- requester-facing UI, so it's dropped outright rather than replaced with a
-- token-excluding view (the plan's "if none, plain drop is cleanest" case).
-- Admins keep table access via a small admin-only replacement policy (there
-- was no admin UI reading this table either, but keep an admin escape hatch
-- for support/debugging rather than removing all direct access to the table).

drop policy if exists mar_read on manager_access_requests;
create policy mar_admin_read on manager_access_requests for select
  using (is_admin());

-- Recreate decide_manager_access identically except for one added check:
-- return 'invalid' when the caller IS the requester (my_person_id() would
-- normally be null for the anonymous no-login reviewer, but if a requester is
-- ALSO signed in and tries to decide their own request via this same RPC,
-- reject it). RETURNS shape (text) is unchanged, so CREATE OR REPLACE is fine
-- (no drop-then-create needed) — body is otherwise byte-identical to
-- 20260624000020_manager_access_requests.sql, which already pins search_path.
create or replace function decide_manager_access(p_token text, p_decision text, p_decider text)
returns text
language plpgsql volatile security definer set search_path = public as $$
declare r manager_access_requests;
begin
  select * into r from manager_access_requests where token = p_token;
  if not found then return 'invalid'; end if;
  if r.status <> 'pending' then return 'already'; end if;

  -- Belt-and-braces (C3): a requester must never be able to approve/deny
  -- their own request, even if they happen to be signed in when they open the
  -- review link (the intended flow is anonymous/no-login).
  if my_person_id() is not null and my_person_id() = r.requester_person_id then
    return 'invalid';
  end if;

  if p_decision = 'approve' then
    insert into club_managers (club_id, person_id)
      values (r.club_id, r.requester_person_id)
      on conflict (club_id, person_id) do nothing;
    update manager_access_requests
      set status = 'approved', decided_by = nullif(p_decider, ''), decided_at = now()
      where id = r.id;
    return 'approved';
  else
    update manager_access_requests
      set status = 'denied', decided_by = nullif(p_decider, ''), decided_at = now()
      where id = r.id;
    return 'denied';
  end if;
end;
$$;
grant execute on function decide_manager_access(text, text, text) to anon, authenticated;
