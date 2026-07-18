-- Passkey amendment to the aal2-conditional is_admin() (20260717140238),
-- decided by Nate 2026-07-18: a session established via passkey SIGN-IN is
-- exempt from the aal2 requirement — a passkey is already possession +
-- user-verification, so demanding a TOTP step-up on top is pure burden.
--
-- GoTrue keeps passkey-sign-in sessions at aal1 (models.AMRClaim.IsAAL2Claim
-- counts only totp / mfa/phone / mfa/webauthn), so the exemption must key on
-- the JWT's `amr` claim instead: PasskeyLogin stamps method 'passkey'
-- (supabase/auth internal/models/factor.go String(), verified against source
-- 2026-07-18). amr claims are session-scoped and server-signed — a caller
-- can only carry 'passkey' by having completed a real ceremony, and a token
-- refresh keeps the entry — so trusting amr is equivalent to trusting aal.
--
-- Must stay in lockstep with the other two enforcement layers (client
-- needsMfaStepUp in src/lib/mfa-core.ts; edge-function guard
-- _shared/jwt-aal.ts callerAalSatisfies) — if any layer disagrees, a
-- passkey-signed-in TOTP-enrolled admin is locked out of admin surfaces.
--
-- Fail-closed per CLAUDE.md: whole expression coalesce(..., false); the amr
-- probe guards jsonb_typeof so a missing/non-array amr contributes false,
-- never NULL/error.
create or replace function is_admin() returns boolean as $$
  select coalesce(
    auth_has_role('admin')
    and (
      (select auth.jwt() ->> 'aal') = 'aal2'
      or coalesce(
        (
          select bool_or(e ->> 'method' = 'passkey')
          from jsonb_array_elements(
            case when jsonb_typeof(auth.jwt() -> 'amr') = 'array'
                 then auth.jwt() -> 'amr'
                 else '[]'::jsonb end
          ) e
        ),
        false
      )
      or not exists (
        select 1 from auth.mfa_factors mf
        where mf.user_id = auth.uid() and mf.status = 'verified'
      )
    ),
    false
  );
$$ language sql stable security definer set search_path = public, pg_temp;
