-- Security hardening Phase 3, M1: coupon-reservation to close the concurrent-
-- checkout coupon-reuse gap.
--
-- Finding (docs/specs/2026-07-02-security-review-findings.md, M1):
-- `create-checkout-session` validates a coupon (window / max_uses vs
-- used_count / restricted_to_person_id) at checkout-session-create time and
-- applies the discount, but reserves nothing — `redeem_coupon` only bumps
-- `used_count` at FULFILLMENT time (webhook / free-order path). N concurrent
-- checkout sessions for the same single-use or person-restricted code all
-- pass the same `used_count < max_uses` check and all collect the discount,
-- for as long as those sessions stay open (up to Stripe's checkout session
-- lifetime).
--
-- Fix: a time-bounded reservation, the same pattern emv2 P4's capacity holds
-- already use (`hold_expires_at`, 30-min countdown) — NOT a decrement-on-
-- failure scheme, which would permanently burn a use if the release never
-- runs (a missed webhook, a crashed request). An expired reservation simply
-- stops counting against capacity; nothing needs to actively clean it up for
-- correctness (though nothing stops a future janitor sweep either).
--
-- coupon_reservations is a server-only table — same write model as
-- `payments`/`refund_requests`: RLS enabled, ZERO client policies. Every
-- writer is either the service role (bypasses RLS) or a SECURITY DEFINER RPC
-- owned by the migration-applying role (also bypasses RLS during execution).
create table coupon_reservations (
  id          text primary key,               -- deterministic: 'cr-' || payment_id
  code        text not null references coupons (code) on delete cascade,
  -- payments.id is the one uuid PK in the schema (20260625231808) — every
  -- other app id is text. Deliberately NOT a foreign key to payments: by
  -- design reserve_coupon runs BEFORE the payments row exists (reservation
  -- happens first, then the Stripe session, then the payments insert with
  -- this same id) — a `references payments(id)` constraint would make every
  -- reservation insert fail with a FK violation on the payments row that
  -- hasn't been created yet.
  payment_id  uuid not null,
  person_id   text references people (id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);

create index coupon_reservations_code_idx on coupon_reservations (code);
create index coupon_reservations_payment_id_idx on coupon_reservations (payment_id);

alter table coupon_reservations enable row level security;
-- Intentionally NO policies: this table has no client-facing read or write
-- path at all (unlike `payments`, which at least grants a self-read select).
-- The only access is via reserve_coupon/release_coupon_reservation below and
-- the service role, both of which bypass RLS.

-- reserve_coupon: atomically claim a use of `p_code` for `p_payment_id`,
-- re-checking the SAME predicates `redeem_coupon` enforces at fulfillment
-- (active window, person restriction) plus a capacity check that counts
-- both already-redeemed uses (`used_count`) and other LIVE (unexpired)
-- reservations. `select ... for update` on the coupons row is what makes
-- this atomic against concurrent callers for the same code — without that
-- lock this is theatre, since two callers could both read
-- `capacity < max_uses` before either inserts its reservation.
--
-- Idempotent on `p_payment_id`: a retry for the same payment (e.g. the
-- client re-POSTs after a network blip) upserts the SAME reservation row
-- rather than consuming a second use, and the capacity count below excludes
-- the payment's own existing reservation so retrying never double-counts
-- itself against `max_uses`.
create function reserve_coupon(
  p_code text,
  p_payment_id uuid,
  p_person_id text,
  p_expires_at timestamptz
) returns boolean as $$
declare
  v_reservation_id text := 'cr-' || p_payment_id::text;
  v_coupon coupons%rowtype;
  v_capacity integer;
begin
  select * into v_coupon from coupons where code = p_code for update;
  if not found then
    return false;
  end if;

  -- Active window — mirrors redeem_coupon's starts_at/ends_at check.
  if v_coupon.starts_at is not null and now() < v_coupon.starts_at then
    return false;
  end if;
  if v_coupon.ends_at is not null and now() > v_coupon.ends_at then
    return false;
  end if;

  -- Person restriction — mirrors redeem_coupon's restricted_to_person_id
  -- check. A restricted coupon with no p_person_id (or a mismatched one)
  -- fails closed.
  if v_coupon.restricted_to_person_id is not null
     and v_coupon.restricted_to_person_id is distinct from p_person_id then
    return false;
  end if;

  if v_coupon.max_uses is not null then
    select coalesce(v_coupon.used_count, 0) + coalesce(count(*), 0)
      into v_capacity
      from coupon_reservations
     where code = p_code
       and expires_at > now()
       and id <> v_reservation_id;
    if v_capacity >= v_coupon.max_uses then
      return false;
    end if;
  end if;

  insert into coupon_reservations (id, code, payment_id, person_id, expires_at)
  values (v_reservation_id, p_code, p_payment_id, p_person_id, p_expires_at)
  on conflict (id) do update
    set code = excluded.code,
        person_id = excluded.person_id,
        expires_at = excluded.expires_at;

  return true;
end;
$$ language plpgsql volatile security definer set search_path = public, pg_temp;

-- release_coupon_reservation: idempotent delete-by-payment. Called when a
-- reservation must not linger — checkout-session/payments-insert failure in
-- create-checkout-session, or a Stripe session expiring/failing in
-- stripe-webhook. Deleting a row that doesn't exist (already released,
-- already redeemed, or never reserved) is a silent no-op, matching every
-- other idempotent-delete pattern in this codebase (e.g. fulfillPayment's
-- cart_items clear).
create function release_coupon_reservation(p_payment_id uuid) returns void as $$
begin
  delete from coupon_reservations where payment_id = p_payment_id;
end;
$$ language plpgsql volatile security definer set search_path = public, pg_temp;

-- A fresh function grants EXECUTE to PUBLIC by default and every role
-- inherits it (see 20260702182713's note) — revoke from PUBLIC and
-- authenticated explicitly, then grant back only to service_role.
revoke execute on function reserve_coupon(text, uuid, text, timestamptz) from public;
revoke execute on function reserve_coupon(text, uuid, text, timestamptz) from authenticated;
grant execute on function reserve_coupon(text, uuid, text, timestamptz) to service_role;

revoke execute on function release_coupon_reservation(uuid) from public;
revoke execute on function release_coupon_reservation(uuid) from authenticated;
grant execute on function release_coupon_reservation(uuid) to service_role;

-- redeem_coupon: add a trailing p_payment_id (default null, same defaulted-
-- arg compatibility discipline 20260702182713 used so any still-deployed
-- caller with the OLD 2-arg signature keeps resolving unchanged). When a
-- payment id is supplied, redemption also deletes that payment's
-- reservation as part of the same call — the reservation and the used_count
-- bump must not both be live at once, or the use is double-counted (once as
-- a reservation, once as a redeemed use) against a concurrent reserve_coupon
-- capacity check.
drop function if exists redeem_coupon(text, text);
create function redeem_coupon(
  p_code text,
  p_person_id text default null,
  p_payment_id uuid default null
) returns boolean as $$
declare
  v_ok boolean;
begin
  update coupons
     set used_count = coalesce(used_count, 0) + 1
   where code = p_code
     and (max_uses is null or coalesce(used_count, 0) < max_uses)
     and (starts_at is null or now() >= starts_at)
     and (ends_at is null or now() <= ends_at)
     and (restricted_to_person_id is null or restricted_to_person_id = p_person_id)
  returning true into v_ok;

  if coalesce(v_ok, false) and p_payment_id is not null then
    delete from coupon_reservations where payment_id = p_payment_id;
  end if;

  return coalesce(v_ok, false);
end;
$$ language plpgsql volatile security definer set search_path = public, pg_temp;

revoke execute on function redeem_coupon(text, text, uuid) from public;
revoke execute on function redeem_coupon(text, text, uuid) from authenticated;
grant execute on function redeem_coupon(text, text, uuid) to service_role;
