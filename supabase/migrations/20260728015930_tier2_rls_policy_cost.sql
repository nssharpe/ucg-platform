-- Fix RLS-policy compounding on memberships / invoice_items that causes
-- statement timeouts under ANON/AUTHENTICATED at 10k+ rows (whats-next §7
-- finding, investigated 2026-07-27). Confirmed via EXPLAIN (ANALYZE, BUFFERS)
-- at 0.5x projected scale as a real non-admin club-manager JWT:
--   memberships:    7,334 ms (vs 151 ms baseline)
--   invoices:       5,990 ms (vs 9.6 ms baseline)
--   invoice_items:  7,396 ms (vs 12.3 ms baseline)
--
-- ROOT CAUSE: memberships_read, memberships_write, and invoice_items_read
-- each contain a raw correlated `exists (select 1 from <other RLS table> ...)`
-- subquery instead of a SECURITY DEFINER helper. That subquery runs as the
-- CALLING role (not the function owner), so it is itself subject to the
-- referenced table's full RLS policy stack -- which has grown every phase
-- (people: self + refund_manager + finance_admin; invoices: owner +
-- finance_admin + refund_manager). Evaluating memberships/invoice_items thus
-- silently re-evaluates ALL of people's/invoices' policies for every row
-- touched. Same bug class already hit and fixed once before in this repo
-- (20260711023234, the 42P17 recursion fix) -- same root cause (raw
-- cross-table policy subquery), different symptom (cost instead of
-- recursion, because these two tables don't happen to policy-cycle back).
--
-- FIX: mirror the existing pattern (manages_club, my_person_id,
-- refund_request_covers_item/invoice) -- SECURITY DEFINER functions that
-- bypass RLS on the referenced table entirely, so cost is a single indexed
-- lookup instead of "re-run that table's whole policy stack."

-- ---------------------------------------------------------------------------
-- 1. memberships: drop the redundant `memberships_read` policy.
-- ---------------------------------------------------------------------------
-- memberships_write is `for all`, so its USING clause already governs SELECT
-- (Postgres applies a FOR ALL policy's USING to SELECT/UPDATE/DELETE). Its
-- predicate is byte-for-byte identical to memberships_read's. Both are
-- evaluated and OR'd for every SELECT today -- pure duplicated cost, zero
-- semantic difference.
drop policy if exists memberships_read on memberships;

-- ---------------------------------------------------------------------------
-- 2. memberships_write: replace the raw `people` subquery with a helper.
-- ---------------------------------------------------------------------------
-- BEFORE (both memberships_read and memberships_write used this):
--   is_admin()
--   or person_id = my_person_id()
--   or exists (select 1 from people p
--              where p.id = memberships.person_id and manages_club(p.main_club_id))
--
-- AFTER: same three branches, but the third is a single SECURITY DEFINER
-- call instead of a correlated subquery into a policy-protected table.
create or replace function manages_club_of_person(pid text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from people p
    where p.id = pid and manages_club(p.main_club_id)
  );
$$;
-- Fail-closed grants (CLAUDE.md "new functions revoke the default PUBLIC
-- execute grant"), then explicitly widened to match every existing RLS
-- helper (my_person_id/manages_club/is_admin/auth_has_role, which have never
-- had their PUBLIC grant revoked and are therefore callable by anon,
-- authenticated, AND service_role). anon specifically matters because RLS
-- policy predicates are ACL-checked for whichever role is querying,
-- regardless of whether that branch would evaluate true or false for them --
-- an anon caller reading a table whose policy calls a function anon can't
-- execute gets "permission denied for function", not a filtered/empty
-- result. memberships/invoice_items are read during signed-out app boot
-- (loadAll), so these helpers must stay anon-executable or boot breaks.
revoke execute on function manages_club_of_person(text) from public;
grant execute on function manages_club_of_person(text) to anon, authenticated, service_role;

drop policy if exists memberships_write on memberships;
create policy memberships_write on memberships for all
  using (is_admin()
    or person_id = my_person_id()
    or manages_club_of_person(person_id))
  with check (is_admin()
    or person_id = my_person_id()
    or manages_club_of_person(person_id));

-- Semantics check: manages_club_of_person(pid) returns true iff there exists
-- a people row p with p.id = pid whose main_club_id the caller manages() --
-- byte-identical to the dropped `exists (select 1 from people p where p.id =
-- ... and manages_club(p.main_club_id))`. The ONLY behavioral difference is
-- that evaluating it no longer also implicitly ANDs in people's own SELECT
-- policy (self/refund_manager/finance_admin) as a side effect of the
-- subquery being RLS-scanned -- that ANDed clause was never part of the
-- intended predicate; it was an accidental (and expensive) side effect of
-- writing the subquery unwrapped. The rows a caller can see are unchanged:
-- read access to `people` is irrelevant to whether that person's row exists
-- and has the given main_club_id, which is all this check needs. is_admin()
-- and my_person_id() are unaffected (already SECURITY DEFINER, no behavior
-- change).

-- ---------------------------------------------------------------------------
-- 3. invoice_items_read: replace the raw `invoices` subquery with a helper.
-- ---------------------------------------------------------------------------
-- BEFORE:
--   is_admin() or exists (
--     select 1 from invoices i where i.id = invoice_items.invoice_id
--     and (i.athlete_id = my_person_id() or manages_club(i.club_id)))
--
-- AFTER: same predicate, single SECURITY DEFINER lookup instead of a
-- correlated subquery into invoices (which is itself RLS-protected by
-- invoice_owner / invoices_finance_read / invoices_refund_manager_read).
create or replace function invoice_owner_or_manager(inv_id text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select i.athlete_id = my_person_id() or manages_club(i.club_id)
     from invoices i where i.id = inv_id),
    false
  );
$$;
revoke execute on function invoice_owner_or_manager(text) from public;
grant execute on function invoice_owner_or_manager(text) to anon, authenticated, service_role;

drop policy if exists invoice_items_read on invoice_items;
create policy invoice_items_read on invoice_items for select
  using (is_admin() or invoice_owner_or_manager(invoice_id));

-- Semantics check: identical predicate, evaluated without incurring
-- invoices' own policy stack as a side effect. `coalesce(..., false)` covers
-- the fail-closed case where invoice_id doesn't resolve to a row (matches
-- the original: NOT EXISTS -> false).
--
-- invoice_items_admin (for all, using (is_admin())) and
-- invoice_items_finance_read / invoice_items_refund_manager_read are
-- untouched -- they don't reference another RLS table via subquery and are
-- not part of this cost path.

-- ---------------------------------------------------------------------------
-- NOT changed here, deliberately:
-- ---------------------------------------------------------------------------
-- - invoice_owner (invoices SELECT): `is_admin() or athlete_id =
--   my_person_id() or manages_club(club_id)` already avoids the compounding
--   pattern (no subquery into another RLS table -- manages_club/my_person_id
--   are already SECURITY DEFINER). Its remaining per-row cost is one
--   manages_club() call per invoices row, which is a plain indexed lookup,
--   not a policy-stack re-evaluation -- much cheaper, and not the dominant
--   contributor per the EXPLAIN evidence.
-- - invoices_finance_read, invoices_refund_manager_read,
--   invoice_items_finance_read, invoice_items_refund_manager_read, and
--   everything the 2026-07-24 invoice write lockdown created
--   (invoices_insert/update/delete, invoice_items_insert/update/delete)
--   already use the SECURITY DEFINER-helper pattern (auth_has_role,
--   refund_request_covers_item/invoice) or a role-only predicate and are
--   unaffected by this migration.
