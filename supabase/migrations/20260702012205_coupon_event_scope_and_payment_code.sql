-- Promo-code feedback: expand "Applies to" scope (specific event, not just the
-- generic 'meet-entry' bucket) so a code can be tied to one future event and hard-
-- expire once that event is over; carry the applied coupon onto the payments row so
-- the Stripe webhook can write it to the invoice (ledger/receipt) and redeem it.
alter table coupons
  add column if not exists applies_to_event_id text references events(id) on delete set null;

alter table payments
  add column if not exists coupon_code text references coupons(code) on delete set null;
