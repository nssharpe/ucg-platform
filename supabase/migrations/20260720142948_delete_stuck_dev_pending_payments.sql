-- One-time cleanup: delete stuck-pending `payments` rows left over from dev/
-- test Stripe Checkout sessions that were abandoned before the webhook fired
-- (all `cs_test_...` sessions from 2026-06-26, surfaced in Admin > Finance >
-- Reconciliation "Stuck pending" and the daily digest email). Same "stuck"
-- criteria as isStuckPending() (src/lib/reconciliation.ts): status still
-- 'pending' and older than the 1-hour cutoff, so no in-flight checkout is
-- touched. Safe to delete: these never reached fulfillment, so no invoice /
-- invoice_items / registration.paid flip ever happened for them, and the
-- only inbound FK (refund_requests.payment_id) is `on delete set null`.
delete from payments
where status = 'pending'
  and now() - created_at >= interval '1 hour';
