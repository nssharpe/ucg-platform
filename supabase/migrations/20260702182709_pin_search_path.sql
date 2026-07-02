-- M3: pin `search_path` on SECURITY DEFINER helpers that don't already have it.
-- Without a pinned search_path, a SECURITY DEFINER function resolves unqualified
-- identifiers against whatever search_path the CALLER's session has set, which
-- (in Postgres generally) can be abused to shadow a table/function the definer
-- didn't intend to call. These functions already write fully-qualified-enough
-- SQL, but pinning is cheap, standard hardening and costs nothing behaviorally.
-- RETURNS shape is unchanged for every function below, so CREATE OR REPLACE is
-- safe (no drop-then-create needed). Bodies are copied verbatim from the latest
-- version of each (is_admin/auth_has_role/manages_club: 20260601000002_rls.sql;
-- my_person_id: 20260601000004_text_ids_score_extras.sql [returns text, latest];
-- link_or_create_person: 20260601000005_account_foundation.sql). redeem_coupon
-- is handled in 20260702182713_coupons_lockdown.sql (it's being recreated there
-- anyway for the H2 hardening), not here.

create or replace function auth_has_role(r app_role) returns boolean as $$
  select exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.role = r);
$$ language sql stable security definer set search_path = public, pg_temp;

create or replace function is_admin() returns boolean as $$
  select auth_has_role('admin');
$$ language sql stable security definer set search_path = public, pg_temp;

create or replace function my_person_id() returns text as $$
  select id from people where auth_user_id = auth.uid();
$$ language sql stable security definer set search_path = public, pg_temp;

create or replace function manages_club(cid text) returns boolean as $$
  select is_admin() or exists (
    select 1 from club_managers cm
    join people p on p.id = cm.person_id
    where cm.club_id = cid and p.auth_user_id = auth.uid()
  );
$$ language sql stable security definer set search_path = public, pg_temp;

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

  -- Claim ONE unclaimed row with a matching verified email. email is not unique,
  -- so pick the oldest match deterministically and link only that row (never
  -- claim several rows for one auth user).
  if v_email <> '' then
    update people
      set auth_user_id = v_uid
      where id = (
        select id from people
        where auth_user_id is null and lower(email) = v_email
        order by created_at asc
        limit 1
      )
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
$$ language plpgsql volatile security definer set search_path = public, pg_temp;
