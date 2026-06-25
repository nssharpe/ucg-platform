-- Stripe foundations (Phase S1). The `payments` table is the server-side record
-- of a Stripe Embedded Checkout session: a `pending` row is inserted when the
-- session is created, then the verified webhook flips it to `paid` and runs
-- fulfillment. All amounts are in CENTS (Stripe's unit). The browser only ever
-- *reads* its own rows (poll for `status='paid'`); only the service role writes.
create table if not exists payments (
  id                       uuid primary key default gen_random_uuid(),
  stripe_session_id        text unique,                 -- idempotency: one row per Checkout Session
  stripe_payment_intent_id text,
  person_id                text references people (id) on delete set null,  -- people.id is text (see 20260601000004)
  status                   text not null default 'pending'
                             check (status in ('pending', 'paid', 'failed', 'refunded')),
  amount_subtotal          integer,                     -- cents (order subtotal, pre service fee)
  service_fee              integer,                     -- cents (3% + $0.30 passed to payer)
  stripe_fee               integer,                     -- cents; filled from the balance txn on fulfillment
  currency                 text not null default 'usd',
  cart_item_ids            text[],                      -- the exact cart lines this payment covers
  ref_reg_ids              text[],                      -- registration id(s) to flip paid (mirrors cart_items.ref_reg_ids)
  ref_season_id            text,                        -- mirrors cart_items.ref_season_id (text)
  ref_type                 text,                        -- mirrors cart_items.ref_type (athlete|coach|club|…)
  invoice_id               text references invoices (id) on delete set null, -- invoices.id is text (see 20260601000004); set on fulfillment
  stripe_event_id          text,                        -- idempotency on the webhook event
  created_at               timestamptz not null default now(),
  fulfilled_at             timestamptz                  -- set once fulfillment completes
);

-- Idempotency: at most one event handled per Stripe event id (nullable until set).
create index if not exists payments_stripe_event_id_idx on payments (stripe_event_id);
create index if not exists payments_person_id_idx on payments (person_id);

alter table payments enable row level security;

-- The service role (used by the webhook + create-checkout-session functions)
-- bypasses RLS, so there is intentionally NO permissive client write policy.
-- A signed-in person may READ their OWN payment rows (drives the confirming/
-- polling UI), keyed on the same auth.uid()->people linkage every other table uses.
create policy payments_self_read on payments for select
  using (is_admin() or person_id = my_person_id());

-- invoices: carry Stripe's real payment-intent id + actual processing fee so the
-- Phase 5 finance dashboards read true fees instead of placeholder rates.
alter table invoices add column if not exists stripe_payment_intent_id text;
alter table invoices add column if not exists stripe_fee integer;  -- cents, nullable
