-- Event-management v2 Phase 6, Task T1: finance foundations (spec §M).
--
-- Two new tables for the finance-admin dashboards: `accounting_codes` (an
-- app-maintained lookup mapping purchase-item-type keys to an external
-- accounting code, e.g. QuickBooks) and `host_payouts` (manual records of
-- money paid OUT to an event host club, since payouts happen outside
-- Stripe). Both are plain CRUD tables editable by admins/finance_admin —
-- unlike refund_requests/payments there is no server-only write model here.
--
-- Also adds finance_admin SELECT parity on five existing tables the finance
-- dashboards need to read across (payments/invoices/invoice_items/
-- refund_requests/people) — admins already read these via existing
-- policies; finance_admin currently cannot.

-- ---------------------------------------------------------------------------
-- accounting_codes
-- ---------------------------------------------------------------------------
create table accounting_codes (
  id         text primary key,
  -- App-defined purchase-item-type key, e.g. 'membership', 'meet-entry:entry',
  -- 'addon:tshirt'. Unique — one code mapping per item type.
  item_key   text not null unique,
  code       text not null,
  label      text,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- host_payouts
-- ---------------------------------------------------------------------------
create table host_payouts (
  id           text primary key,
  event_id     text not null references events (id) on delete cascade,
  amount_cents integer not null,
  method       text not null check (method in ('check', 'paypal', 'ach')),
  -- Check #, PayPal txn id, or ACH reference -- free text, method-dependent.
  reference    text,
  paid_on      date not null,
  notes        text,
  -- The finance user who recorded the payout. Not a strict FK (matching
  -- refund_requests.reviewed_by's convention) -- a reviewer's people row can
  -- be independently deleted without invalidating the historical record.
  created_by   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index on host_payouts (event_id);

-- ---------------------------------------------------------------------------
-- RLS -- accounting_codes / host_payouts
-- ---------------------------------------------------------------------------
-- Both tables use the SAME admin-or-finance_admin predicate on all four
-- policies (SELECT/INSERT/UPDATE/DELETE kept SEPARATE per CLAUDE.md's
-- "RLS upsert trap" -- the app's whole-row upsert write pattern needs a row
-- to pass an INSERT-or-UPDATE policy depending on the conflict path, and
-- `for all` silently grants DELETE, which we don't want to hand out via a
-- single blanket policy). `is_admin()`/`auth_has_role()` are existing
-- SECURITY DEFINER helpers (0002_rls.sql) -- both fail-closed via coalesce
-- per CLAUDE.md (an anon/unauthenticated caller's role check must not
-- evaluate to NULL and slip past `if not NULL`).
alter table accounting_codes enable row level security;

create policy accounting_codes_select on accounting_codes for select
  using (coalesce(is_admin(), false) or coalesce(auth_has_role('finance_admin'), false));
create policy accounting_codes_insert on accounting_codes for insert
  with check (coalesce(is_admin(), false) or coalesce(auth_has_role('finance_admin'), false));
create policy accounting_codes_update on accounting_codes for update
  using (coalesce(is_admin(), false) or coalesce(auth_has_role('finance_admin'), false))
  with check (coalesce(is_admin(), false) or coalesce(auth_has_role('finance_admin'), false));
create policy accounting_codes_delete on accounting_codes for delete
  using (coalesce(is_admin(), false) or coalesce(auth_has_role('finance_admin'), false));

alter table host_payouts enable row level security;

create policy host_payouts_select on host_payouts for select
  using (coalesce(is_admin(), false) or coalesce(auth_has_role('finance_admin'), false));
create policy host_payouts_insert on host_payouts for insert
  with check (coalesce(is_admin(), false) or coalesce(auth_has_role('finance_admin'), false));
create policy host_payouts_update on host_payouts for update
  using (coalesce(is_admin(), false) or coalesce(auth_has_role('finance_admin'), false))
  with check (coalesce(is_admin(), false) or coalesce(auth_has_role('finance_admin'), false));
create policy host_payouts_delete on host_payouts for delete
  using (coalesce(is_admin(), false) or coalesce(auth_has_role('finance_admin'), false));

-- Explicit table grants (RLS still gates every row) -- CLAUDE.md: a missing
-- grant made a policy unreachable in a previous phase (event_checkins), so
-- new tables always get an explicit grant rather than relying solely on
-- whatever default privileges the project has.
grant select, insert, update, delete on accounting_codes, host_payouts to authenticated;

-- ---------------------------------------------------------------------------
-- finance_admin read parity on existing money/roster tables
-- ---------------------------------------------------------------------------
-- Admins already have blanket read access to these five tables via existing
-- policies; finance_admin currently does not. These are NEW additive
-- permissive policies (existing policies are untouched) -- Postgres RLS ORs
-- all applicable policies together, so this only WIDENS read access, never
-- narrows it. `auth_has_role` is SECURITY DEFINER, so there is no
-- cross-table-policy recursion risk (42P17) from adding these.
create policy payments_finance_read on payments for select
  using (coalesce(auth_has_role('finance_admin'), false));

create policy invoices_finance_read on invoices for select
  using (coalesce(auth_has_role('finance_admin'), false));

create policy invoice_items_finance_read on invoice_items for select
  using (coalesce(auth_has_role('finance_admin'), false));

create policy refund_requests_finance_read on refund_requests for select
  using (coalesce(auth_has_role('finance_admin'), false));

create policy people_finance_read on people for select
  using (coalesce(auth_has_role('finance_admin'), false));

-- NOTE on table-level grants for the five tables above: grepping every prior
-- migration (incl. 20260625231808, which created `payments`) turns up NO
-- explicit `grant ... to authenticated` statement for payments, invoices,
-- invoice_items, refund_requests, or people. All five already work for
-- other authenticated roles (admin, self, club managers, refund_manager)
-- purely off RLS policies, which is only possible if the underlying table
-- privilege already exists -- i.e. the project's default Supabase schema
-- privileges (set once at project setup, outside migration history) already
-- grant SELECT/INSERT/UPDATE/DELETE on public-schema tables to
-- anon/authenticated, and RLS is the only gate in practice. No new grant
-- statement is added for these five tables; the new finance_admin policies
-- ride on the same existing table privilege.
