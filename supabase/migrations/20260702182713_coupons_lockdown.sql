-- H2: kill public coupon read; harden redeem_coupon (active window +
-- restricted_to_person_id enforcement), keeping the deployed stripe-webhook's
-- existing 1-arg call working until Phase 2 redeploys it.
--
-- Enumeration (grepped `from('coupons')` and every `redeem_coupon` caller in
-- src/ AND supabase/functions/ before writing this):
--   - `from('coupons')`: only src/lib/supabase.ts's loadAll (full-DB sync,
--     RLS-filtered — dropping public_read_coupons just makes a non-admin's
--     db.coupons come back empty, which is fine, it's not in loadAll's
--     fail-the-sync error list) and pushAll (admin-only Demo Tools seed).
--     Non-admin consumer: src/pages/Admin.tsx's `Promos` UI, which is itself
--     admin-only (RequireAdmin) — admin_all already covers it. No member-
--     facing coupon read exists anywhere (post-2026-07-02, coupon validation
--     is server-side only per create-checkout-session, matching the plan's
--     assumption). Safe to drop the public policy outright.
--   - redeem_coupon callers: (1) src/lib/supabase.ts's `redeemCoupon()` export
--     — grepped every src/pages and src/components file for `redeemCoupon`:
--     ZERO callers (dead code left over from the retired Membership.tsx
--     direct-pay coupon UI, per the CLAUDE.md 2026-07-02 retirement note).
--     Safe to revoke EXECUTE from `authenticated` entirely. (2) The deployed
--     supabase/functions/stripe-webhook/index.ts line ~287:
--     `db.rpc('redeem_coupon', { p_code: payment.coupon_code })` — ONE
--     argument, service role. This is the only real caller left, and the
--     function isn't being redeployed in this phase (Phase 2 territory), so
--     the new signature MUST keep accepting a bare `p_code` call. Solution:
--     add `p_person_id text default null` — an optional trailing param with a
--     default, so the existing 1-arg RPC call still resolves to this function
--     unchanged. When Phase 2 redeploys the webhook, it can start passing the
--     payer's person_id (already in scope there as `personId`) to get the
--     restricted_to_person_id check; until then p_person_id is null, which
--     the check below correctly treats as least-privilege (a person-restricted
--     coupon fails closed if no person id is provided, and it's admin-only
--     coupon creation that sets restricted_to_person_id in the first place, so
--     no legitimate current caller is scoping a code that way through this
--     RPC yet).

drop policy if exists public_read_coupons on coupons;
-- admin_all (is_admin()) already covers full admin read/write; no
-- replacement policy needed for any other reader.

drop function if exists redeem_coupon(text);
create function redeem_coupon(p_code text, p_person_id text default null)
returns boolean as $$
declare
  v_ok boolean;
begin
  update coupons
     set used_count = coalesce(used_count, 0) + 1
   where code = p_code
     and (max_uses is null or coalesce(used_count, 0) < max_uses)
     -- H2: active window — a coupon outside starts_at/ends_at can't be redeemed
     -- even if the caller somehow still holds the code.
     and (starts_at is null or now() >= starts_at)
     and (ends_at is null or now() <= ends_at)
     -- H2: person-restricted coupons only redeem for the matching person. If
     -- the caller didn't pass a person id (legacy 1-arg call), a restricted
     -- coupon fails closed rather than silently redeeming for anyone.
     and (restricted_to_person_id is null or restricted_to_person_id = p_person_id)
  returning true into v_ok;
  return coalesce(v_ok, false);
end;
$$ language plpgsql volatile security definer set search_path = public, pg_temp;

-- No client path calls this anymore (dead code — see enumeration above); only
-- the service-role stripe-webhook does. A freshly-created function grants
-- EXECUTE to PUBLIC by default, and every role (incl. anon/authenticated)
-- inherits PUBLIC — so revoking from `authenticated` alone leaves the grant
-- intact via PUBLIC. Revoke from PUBLIC to actually lock it down, then grant
-- back only to service_role.
revoke execute on function redeem_coupon(text, text) from public;
revoke execute on function redeem_coupon(text, text) from authenticated;
grant execute on function redeem_coupon(text, text) to service_role;
