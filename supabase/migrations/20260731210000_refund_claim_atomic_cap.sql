-- Atomic refund cap + claim (2026-07-31 money-path review finding §8.1).
--
-- THE BUG. `process-refund`'s handleApprove ran, in order:
--   1. read every APPROVED refund_amount_cents for this payment -> priorRefunded
--   2. availableCents = payments.amount_subtotal - priorRefunded
--   3. refundCents    = min(computed, max(0, available))
--   4. atomic claim: update refund_requests ... where id = <this request>
--                                              and status = 'pending'
--   5. stripe.refunds.create(...)
--
-- The claim in (4) is keyed on the REQUEST'S OWN id. It correctly stops one
-- request being processed twice (a double-click, a retry). It does NOT
-- serialize two DIFFERENT pending requests against the SAME payment: both can
-- finish (1) before either reaches (4), so both compute `available` from the
-- same stale baseline and both pass the cap.
--
-- WHY IT WASN'T A LARGE OVER-REFUND, AND WHY IT STILL MATTERED. Stripe enforces
-- its own cumulative ceiling per charge, so a genuinely excessive second refund
-- fails and the TS reverts the claim. The money was protected -- by Stripe, not
-- by us. But Stripe's ceiling is the CHARGE, which per M5 is
-- `amount_subtotal + service_fee`, while our cap is `amount_subtotal` alone
-- because THE SERVICE FEE IS NEVER REFUNDED. Stripe's ceiling therefore sits
-- strictly above ours, and a concurrent pair landing in that gap succeeds at
-- Stripe while violating our invariant. Worked example: subtotal $100, fee
-- $3.30, charge $103.30; two concurrent $51 approvals -> both read
-- available = $100, both claim (different rows), Stripe sees $102 <= $103.30
-- and allows both. Net $102 refunded against a $100 subtotal -- $2 of service
-- fee refunded.
--
-- THE FIX: THE LOCK IS THE FIX. Same shape and same idiom as `reserve_coupon`
-- (20260726130005), which solved the identical "concurrent claims against one
-- shared budget" race: take `select ... for update` on the row that OWNS the
-- budget -- here the `payments` row -- and do the sum, the cap, and the claim
-- inside that one transaction. A concurrent caller for the same payment blocks
-- on the lock until the first commits, then reads a sum that already includes
-- it. Serialization is per-payment, so refunds against different payments are
-- unaffected.
--
-- SECURITY INVOKER, DELIBERATELY -- a considered deviation from
-- `reserve_coupon`'s SECURITY DEFINER. Both are granted to service_role only,
-- and service_role bypasses RLS regardless, so DEFINER buys nothing here. It
-- costs something, though: `refund_requests` RLS is SELECT-only with NO client
-- write policies, so under INVOKER this function physically cannot write for
-- any non-service_role caller even if the EXECUTE grant were later widened by
-- mistake. Under DEFINER, widening the grant would immediately hand out write
-- access to refund approvals. Defense in depth on the money path is worth the
-- inconsistency; this comment is the reason, so it does not read as an
-- oversight later.
--
-- Authorization is NOT duplicated here. `process-refund` already gates on
-- refund_manager/admin + the AAL guard before it ever reaches this call, and
-- this function is unreachable by any client (grants below). Re-implementing
-- the role check in SQL would be a second copy of an authorization rule to
-- keep in sync -- exactly the drift the repo avoids elsewhere.

create function claim_refund_approval(
  p_request_id    text,
  p_payment_id    uuid,
  p_computed_cents integer,
  p_reviewed_by   text,
  p_reviewed_at   timestamptz
) returns jsonb as $$
declare
  v_subtotal integer;
  v_prior    integer;
  v_available integer;
  v_refund   integer;
  v_rows     integer;
begin
  -- (1) THE LOCK. Everything below is serialized per payment by this line.
  -- Must be the first statement that touches payment state -- moving the sum
  -- above it silently restores the original race.
  select amount_subtotal into v_subtotal
    from payments
   where id = p_payment_id
     for update;

  if not found then
    -- Fail closed: no payment row means no budget to refund against.
    return jsonb_build_object('ok', false, 'reason', 'payment_not_found');
  end if;

  -- (2) Sum only APPROVED requests. A 'pending' row (including this one) has
  -- no refund_amount_cents yet and must not count; a 'rejected' one never
  -- moved money. Reading this AFTER the lock is what makes it correct.
  select coalesce(sum(refund_amount_cents), 0) into v_prior
    from refund_requests
   where payment_id = p_payment_id
     and status = 'approved';

  -- (3) Cap. Mirrors src/lib/pricing.ts capRefundCents:
  --     min(computed, max(0, available)). The outer greatest(0, ...) also
  --     defends against a negative p_computed_cents ever being passed in.
  v_available := coalesce(v_subtotal, 0) - coalesce(v_prior, 0);
  v_refund := greatest(0, least(p_computed_cents, greatest(0, v_available)));

  -- (4) Claim, still under the lock. The `status = 'pending'` predicate keeps
  -- the original single-request idempotency guarantee intact.
  update refund_requests
     set status              = 'approved',
         reviewed_by         = p_reviewed_by,
         reviewed_at         = p_reviewed_at,
         refund_amount_cents = v_refund
   where id = p_request_id
     and status = 'pending';
  get diagnostics v_rows = row_count;

  if v_rows = 0 then
    return jsonb_build_object('ok', false, 'reason', 'already_reviewed');
  end if;

  return jsonb_build_object(
    'ok', true,
    'refund_cents', v_refund,
    'available_cents', v_available,
    'prior_refunded_cents', v_prior
  );
end;
$$ language plpgsql set search_path = public, pg_temp;

-- A fresh function grants EXECUTE to PUBLIC by default and every role inherits
-- it (see 20260702182713's note) -- revoke from PUBLIC and authenticated
-- explicitly, then grant back only to service_role.
revoke execute on function claim_refund_approval(text, uuid, integer, text, timestamptz) from public;
revoke execute on function claim_refund_approval(text, uuid, integer, text, timestamptz) from anon;
revoke execute on function claim_refund_approval(text, uuid, integer, text, timestamptz) from authenticated;
grant execute on function claim_refund_approval(text, uuid, integer, text, timestamptz) to service_role;

comment on function claim_refund_approval(text, uuid, integer, text, timestamptz) is
  'Atomically caps and claims a refund approval. Locks the payments row (select ... for update), '
  'sums already-approved refunds against it, caps the computed amount at what is left, and claims '
  'the request -- all in one transaction, so concurrent approvals against the same payment cannot '
  'both spend the same remaining balance. Returns {ok, refund_cents, available_cents, '
  'prior_refunded_cents} or {ok:false, reason}. service_role only.';
