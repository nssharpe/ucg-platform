-- B8: "unknown email -> immediate alert" on the sign-in gate. On a failed
-- sign-in, the client needs to tell "wrong password" apart from "no account
-- exists for that email" so it can show the right message instead of quietly
-- offering forgot-password/magic-link options that will never deliver
-- anything for an email with no account. Account-enumeration via this check
-- is an accepted tradeoff here (confirmed with Nate) — this ONLY returns a
-- boolean, no other data.
--
-- Checks auth.users (not `people`) because "has an account" means "can sign
-- in", which is exactly what auth.users represents; a `people` row can exist
-- without ever having a linked auth account (e.g. an athlete added by a
-- coach who never signed up themselves).
create or replace function email_has_account(p_email text)
returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
  select exists(
    select 1 from auth.users where lower(email) = lower(trim(p_email))
  );
$$;

grant execute on function email_has_account(text) to anon, authenticated;
