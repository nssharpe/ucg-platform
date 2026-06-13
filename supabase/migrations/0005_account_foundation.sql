-- 0005 — Account & role foundation
-- New-club requests, club managers co-managing their own club, and a
-- security-definer RPC that links a new auth user to an existing (claimed by
-- verified email) or freshly created person row.
--
-- NOTE on id types: 0004 converted people.id and the *_person_id columns from
-- uuid to text (to match the app's slug ids) and dropped people.id's default.
-- So requester_person_id is text, my_person_id() returns text, the RPC returns
-- text, and a freshly created person needs an explicit text id.

-- --- club_requests ---------------------------------------------------------
create table if not exists club_requests (
  id                  uuid primary key default gen_random_uuid(),
  requester_person_id text references people (id) on delete set null,
  proposed_name       text not null,
  short_name          text not null default '',
  state               text,
  region              text,
  note                text not null default '',
  status              text not null default 'pending',  -- pending | approved | dismissed
  created_at          timestamptz not null default now(),
  decided_at          timestamptz,
  decided_by          uuid references auth.users (id) on delete set null,
  created_club_id     text references clubs (id) on delete set null
);
create index if not exists club_requests_status_idx on club_requests (status);

alter table club_requests enable row level security;

create policy club_requests_read on club_requests for select
  using (is_admin() or requester_person_id = my_person_id());
create policy club_requests_insert on club_requests for insert
  with check (requester_person_id = my_person_id());
create policy club_requests_admin on club_requests for update
  using (is_admin()) with check (is_admin());

-- --- widen club_managers writes: admins OR a manager of THAT club -----------
-- manages_club() already returns true for admins, so this also covers them.
drop policy if exists cm_admin on club_managers;
create policy cm_write on club_managers for all
  using (manages_club(club_id)) with check (manages_club(club_id));
-- cm_read (select using true) is unchanged.

-- --- link-or-create person on first sign-in --------------------------------
-- Claims an existing unclaimed row whose email matches the verified auth email
-- (auth confirms the email, so a user can only claim a row they own); otherwise
-- inserts a new person with a generated text id. Idempotent.
create or replace function link_or_create_person(p_first text, p_last text)
returns text as $$
declare
  v_uid   uuid := auth.uid();
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_id    text;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  -- Already linked?
  select id into v_id from people where auth_user_id = v_uid limit 1;
  if v_id is not null then
    return v_id;
  end if;

  -- Claim an unclaimed row with a matching verified email.
  if v_email <> '' then
    update people
      set auth_user_id = v_uid
      where auth_user_id is null
        and lower(email) = v_email
      returning id into v_id;
    if v_id is not null then
      return v_id;
    end if;
  end if;

  -- Otherwise create a fresh person (text id; people.id has no default post-0004).
  v_id := gen_random_uuid()::text;
  insert into people (id, auth_user_id, kind, first_name, last_name, email)
    values (v_id, v_uid, 'athlete',
            coalesce(nullif(p_first, ''), 'New'),
            coalesce(nullif(p_last, ''), 'Member'),
            coalesce(auth.jwt() ->> 'email', ''));
  return v_id;
end;
$$ language plpgsql volatile security definer;

grant execute on function link_or_create_person(text, text) to authenticated;
