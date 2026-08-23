-- Concurrency-safe invoice numbering (UAT Z-01 follow-up, whats-next §3.1 /
-- 2026-07-31 findings §6.4).
--
-- THE BUG. Both invoice-number generators derived the sequence from a row
-- COUNT taken and used with no lock in between:
--   - _shared/fulfill.ts (stripe-webhook fulfillment AND the $0/free-coupon
--     checkout path in create-checkout-session, which calls the same shared
--     fulfillPayment core): `select count(*) ... {head:true}` then
--     `UCG-2026-<count+1>`.
--   - Membership.tsx's admin "comp" (free membership) path:
--     `UCG-2026-${d.invoices.length + 1}`, from the CLIENT's locally cached
--     invoice list -- staler and racier still.
-- Two concurrent fulfillments (a Stripe webhook retry racing a fresh
-- checkout, or two admins comping memberships back-to-back) can read the
-- same count and mint the SAME number. `invoices.number` has carried a
-- `unique not null` constraint since the very first schema migration
-- (`…000001_schema.sql`), so the LOSER doesn't silently duplicate a row -- it
-- throws. For the webhook path that failure happens BEFORE the atomic
-- fulfilled_at claim at the end of fulfillPayment, so it leaves the payment
-- permanently `pending` until a human intervenes; Stripe's retry hits the
-- exact same race again.
--
-- THE FIX. Same shape as `reserve_coupon` (20260726130005) and
-- `claim_refund_approval` (20260731210000): put the entire read-and-bump in
-- ONE statement so there is no gap between "read the count" and "use it" for
-- a concurrent caller to land in. Here that's `insert into
-- invoice_number_counters ... on conflict (year) do update set next_seq =
-- next_seq + 1 returning next_seq` -- the row lock Postgres takes to
-- evaluate the ON CONFLICT branch IS the serialization, so a per-year insert/
-- update pair with no separate SELECT can't race the way the two old count-
-- based generators did.
create table invoice_number_counters (
  year     int primary key,
  next_seq int not null default 1
);

alter table invoice_number_counters enable row level security;
-- Intentionally NO policies -- same server-only shape as `coupon_reservations`
-- (20260726130005) and `refund_requests`: the table has no direct client
-- read or write path at all. The only access is `next_invoice_number` below
-- (SECURITY DEFINER, so it bypasses RLS while running) and the service role,
-- which bypasses RLS regardless.
comment on table invoice_number_counters is
  'Per-year sequence counter backing next_invoice_number(). next_seq is the LAST issued '
  'sequence number for that year (0/absent = none issued yet), not "the next one to hand '
  'out" despite the column name -- see next_invoice_number for why that makes the atomic '
  'increment-and-return correct.';

-- Seed the counter so freshly-minted numbers continue AFTER the highest
-- existing `UCG-YYYY-NNNN` number for that year -- this keeps the still-live
-- test-data rows (up to at least UCG-2026-0056 as of 2026-08-21) unique even
-- before the pre-launch wipe UAT D-4 calls for. Legacy `UCG-I-<epoch>` rows
-- don't match the pattern and are correctly ignored (that format is retired,
-- not extended). A year with NO matching rows gets no seed row at all here --
-- next_invoice_number's own `insert ... on conflict` creates it lazily on
-- first use, starting at 1, which is the correct behavior for a year that
-- has never had an invoice (including prod, which currently has none).
insert into invoice_number_counters (year, next_seq)
select year, max(seq)
from (
  select
    (regexp_match(number, '^UCG-([0-9]{4})-([0-9]+)$'))[1]::int as year,
    (regexp_match(number, '^UCG-([0-9]{4})-([0-9]+)$'))[2]::int as seq
  from invoices
  where number ~ '^UCG-[0-9]{4}-[0-9]+$'
) matched
group by year
on conflict (year) do update
  -- Idempotent re-run safety: never move the counter BACKWARD, only forward
  -- to a freshly-computed max (relevant only if this migration is somehow
  -- re-applied after next_invoice_number has already issued numbers).
  set next_seq = greatest(invoice_number_counters.next_seq, excluded.next_seq);

-- next_invoice_number: atomically claim the next sequence number for a year
-- and format it as UCG-YYYY-NNNN (4-digit zero-padded; lpad does not
-- truncate, so a seq > 9999 naturally widens to 5+ digits instead of
-- corrupting the number).
--
-- The insert/on-conflict/returning below is ONE statement -- the row lock
-- Postgres takes on (year) to resolve the ON CONFLICT branch IS the
-- serialization point, so there is no separate read to race against (this is
-- the same "the lock IS the fix" idiom `claim_refund_approval`'s comment
-- documents, applied via an upsert instead of `select ... for update` since
-- there's only ever one row to serialize per year).
--
-- VALUES (p_year, 1) is deliberately the literal starting value, not a
-- computed one: on the no-conflict (brand-new year) branch, RETURNING gives
-- back exactly that inserted 1 -- the year's first invoice is numbered 0001.
-- On the conflict (existing year) branch, RETURNING gives back
-- next_seq + 1 post-update. Both branches converge on "next_seq column value
-- == the sequence number just issued," so the seed migration above only
-- needs to store the LAST issued seq (not seq + 1) for a pre-existing year.
create function next_invoice_number(p_year int default extract(year from now())::int)
returns text as $$
declare
  v_seq int;
begin
  -- Fail-closed authorization. Unlike reserve_coupon/claim_refund_approval
  -- (edge-function/service-role only), this function is ALSO called directly
  -- by an authenticated admin's browser session: Membership.tsx's "Admin
  -- Payment Override" comp path invokes it via supabase.rpc() to number the
  -- $0 invoice it writes client-side (that write itself still requires
  -- is_admin() at the RLS layer per 20260724211801 -- this check guards
  -- number-MINTING specifically, since minting a number with no invoice to
  -- attach it to would burn a gap in the sequence). service_role covers
  -- stripe-webhook and create-checkout-session's free-order path. Same
  -- coalesce-wrapped fail-closed idiom as the guard triggers
  -- (`guard_registration_paid` etc., 20260702182711) and
  -- `error_logs_rate_limit`'s v_privileged check: an anon/no-role caller
  -- must fail CLOSED (raise), not have the OR-chain evaluate to NULL and
  -- slip past a bare `if not`.
  if not coalesce(auth.role() = 'service_role' or is_admin(), false) then
    raise exception 'next_invoice_number: not authorized';
  end if;

  insert into invoice_number_counters (year, next_seq)
  values (p_year, 1)
  on conflict (year) do update
    set next_seq = invoice_number_counters.next_seq + 1
  returning next_seq into v_seq;

  return 'UCG-' || p_year || '-' || lpad(v_seq::text, 4, '0');
end;
$$ language plpgsql volatile security definer set search_path = public, pg_temp;

comment on function next_invoice_number(int) is
  'Atomically claims and formats the next UCG-YYYY-NNNN invoice number for the given year '
  '(default: current year). The insert-on-conflict-returning is the entire atomic operation '
  '-- no separate read to race. service_role or is_admin() only (fail-closed); everyone else '
  'gets a raised exception, never a fallback count.';

-- A fresh function grants EXECUTE to PUBLIC by default (see 20260702182713's
-- note) -- revoke that, then grant explicitly to service_role (stripe-webhook,
-- create-checkout-session's free-order path) AND authenticated (Membership.tsx's
-- admin comp path calls this RPC directly from the browser). Granting
-- `authenticated` broadly and relying on the in-body is_admin()/service_role
-- check above is a DELIBERATE deviation from reserve_coupon/claim_refund_approval's
-- "grant service_role only, gate happens in the calling edge function" shape --
-- there is no edge function in front of the comp path's call, so the gate has
-- to live here. `anon` is never granted: an anonymous caller has no way to be
-- is_admin() or service_role, so it would only ever hit the raised exception,
-- but there's no reason to hand out the grant at all.
revoke execute on function next_invoice_number(int) from public;
revoke execute on function next_invoice_number(int) from anon;
grant execute on function next_invoice_number(int) to service_role;
grant execute on function next_invoice_number(int) to authenticated;
