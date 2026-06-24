-- No-login "Request Club Admin Role" (manager access) approve/deny flow.
-- A member requests manager access to their club; the club's managers + league
-- admins get an email with a tokenized review link that needs no login. The
-- first person to approve/deny decides it (idempotent); approval adds the
-- requester to club_managers.

create table if not exists manager_access_requests (
  id                  uuid primary key default gen_random_uuid(),
  token               text not null unique,
  requester_person_id text not null references people(id) on delete cascade,
  club_id             text not null references clubs(id) on delete cascade,
  status              text not null default 'pending',  -- pending | approved | denied
  decided_by          text,                              -- who reviewed (name/email)
  decided_at          timestamptz,
  created_at          timestamptz not null default now()
);
create index if not exists mar_token_idx on manager_access_requests (token);

alter table manager_access_requests enable row level security;
-- Admins read all; a requester reads their own. Decisions go through the RPC
-- below (no anon read/write of the table directly).
drop policy if exists mar_read on manager_access_requests;
create policy mar_read on manager_access_requests for select
  using (is_admin() or requester_person_id = my_person_id());

-- Public token lookup for the no-login review page (the table itself isn't
-- anon-readable). Returns the request status + display names only.
create or replace function get_manager_access_request(p_token text)
returns table (status text, requester_name text, club_name text)
language sql stable security definer set search_path = public as $$
  select r.status,
         p.first_name || ' ' || p.last_name,
         c.name
  from manager_access_requests r
  join people p on p.id = r.requester_person_id
  join clubs  c on c.id = r.club_id
  where r.token = p_token;
$$;
grant execute on function get_manager_access_request(text) to anon, authenticated;

-- Decide a request by token (no login), idempotent. Returns one of:
-- 'approved' | 'denied' | 'already' (someone already reviewed) | 'invalid'.
-- On approval the requester is added to club_managers.
create or replace function decide_manager_access(p_token text, p_decision text, p_decider text)
returns text
language plpgsql volatile security definer set search_path = public as $$
declare r manager_access_requests;
begin
  select * into r from manager_access_requests where token = p_token;
  if not found then return 'invalid'; end if;
  if r.status <> 'pending' then return 'already'; end if;

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
