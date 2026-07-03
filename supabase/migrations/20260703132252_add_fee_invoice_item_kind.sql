-- Money-display fix: Purchase History / receipt PDFs only ever showed the
-- pre-fee item subtotal (entry/membership/change fees, which are always
-- whole-dollar configured amounts) — the Stripe service fee (3% + $0.30,
-- the only source of cents in what a customer actually paid) was computed
-- and shown at checkout time but never persisted as its own invoice line,
-- so it silently vanished from the paid record. Adds 'fee' so the webhook
-- can write a "Service fee (card processing)" line alongside the other
-- items. Enum addition must be its own migration/transaction (can't be
-- referenced in the same one that uses it).
alter type invoice_item_kind add value 'fee';
