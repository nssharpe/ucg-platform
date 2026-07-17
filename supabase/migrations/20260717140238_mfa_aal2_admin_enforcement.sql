-- Auth hardening (docs/research/2026-06-22-auth-2fa-passkeys.md Phase B):
-- once a league admin has enrolled a verified MFA factor, `is_admin()` must
-- only return true when the CALLER'S live JWT is at aal2 — a stolen/replayed
-- aal1 JWT for an MFA-enrolled admin can no longer exercise admin RLS
-- branches. Uses the Supabase-documented conditional pattern: an account
-- with NO verified factor is entirely unaffected (keeps every seeded dev/E2E
-- user, and any admin who hasn't enrolled yet, working exactly as before —
-- enrollment is opt-in from the client side, so we can't force aal2 on
-- accounts that have no way to reach it yet).
--
-- Fail-closed per CLAUDE.md: the whole boolean expression is wrapped in
-- coalesce(..., false) so a NULL from either subexpression denies rather
-- than silently allowing (mirrors the auth.uid()-is-null traps fixed in
-- 20260704133502/20260702182710).
--
-- Only is_admin() is changed. Other privileged helpers were reviewed and
-- deliberately left alone (see report to controller for the full list) —
-- none of them govern the highest-value admin surface this phase targets,
-- and widening scope here isn't part of Phase B.
create or replace function is_admin() returns boolean as $$
  select coalesce(
    auth_has_role('admin')
    and (
      (select auth.jwt() ->> 'aal') = 'aal2'
      or not exists (
        select 1 from auth.mfa_factors mf
        where mf.user_id = auth.uid() and mf.status = 'verified'
      )
    ),
    false
  );
$$ language sql stable security definer set search_path = public, pg_temp;
