-- Defense-in-depth follow-up to 20260704133502: Postgres grants EXECUTE to
-- the PUBLIC pseudo-role by default on function creation, which the prior
-- migration's `revoke ... from anon` did NOT remove (anon still inherits
-- EXECUTE via PUBLIC regardless of the explicit per-role revoke). The
-- actual vulnerability is already closed by 20260704133502's fail-closed
-- auth check (verified: an unauthenticated/null-auth caller now gets a
-- clean `raise exception`, not a silent bypass), so this is hardening, not
-- a fix for a live exploit — but there's no reason to leave the redundant
-- PUBLIC grant in place for a function meant only for signed-in callers.
revoke execute on function sync_synchro_partner_level(text, text) from public;
