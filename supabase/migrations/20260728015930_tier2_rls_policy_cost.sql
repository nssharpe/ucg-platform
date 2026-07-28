-- memberships RLS hygiene fix (whats-next §7 addendum, 2026-07-28).
--
-- SUPERSEDES an earlier draft of this same (unmerged, staging-only) file
-- that additionally wrapped memberships_write's and invoice_items_read's
-- raw correlated `exists (select 1 from <other RLS table> ...)` subqueries
-- in new SECURITY DEFINER helper functions (manages_club_of_person,
-- invoice_owner_or_manager). That draft was applied to staging and measured
-- with EXPLAIN (ANALYZE, BUFFERS) at 0.5x-projected scale (5570 memberships /
-- 9014 invoices / 12514 invoice_items) as a real club-manager JWT:
--   memberships:    ~5.0-5.3s either way (OLD vs NEW, rolled-back A/B) --
--                   inside measurement noise, no real improvement.
--   invoice_items:  7.4s (old) -> 11.4s (new) -- MEASURABLY WORSE.
-- Root cause (confirmed via the actual plan, not guessed): Postgres can
-- hash-materialize a raw correlated EXISTS subquery into a single
-- semi-join scan of the referenced table -- one pass total, not one per
-- outer row (visible in the old plan as a `hashed SubPlan` node). A
-- SECURITY DEFINER function call is opaque to the planner and can NEVER be
-- hashed that way -- it pays its own per-call overhead (~0.9ms measured)
-- on every outer row of the OUTER query. On loadAll's access pattern (an
-- unfiltered `select *` of the whole table), that per-row tax loses to the
-- hashed-subquery plan whenever the referenced table's own policy stack
-- isn't already the dominant cost -- which is exactly the invoice_items
-- case. That draft is reverted here (functions dropped, invoice_items_read
-- restored verbatim to its original form) -- full data + narrative in
-- supabase/README.md's entry for this migration and docs/whats-next.md §7.
--
-- **The RLS-policy-shape angle is a dead end for the timeout under
-- loadAll's unfiltered full-table reads -- under RLS the planner must still
-- evaluate the predicate against every row in the table to know what the
-- caller may see, so cost is O(table size) regardless of how cheap any
-- single predicate call is. The actual fix is Tier-2 QUERY scoping in
-- loadAll (`docs/specs/2026-07-24-data-layer-scale.md`, Tier 2) -- filter
-- memberships/invoices/invoice_items to the caller's own rows + managed
-- clubs so the planner can use an index and touch a handful of rows, not
-- the whole table. Not implemented by this migration; tracked in
-- whats-next.md §7.**
--
-- ---------------------------------------------------------------------------
-- What THIS migration actually keeps: a real, scale-independent hygiene fix
-- ---------------------------------------------------------------------------
-- memberships_read (SELECT) and memberships_write (`for all`) carried
-- BYTE-IDENTICAL predicates -- both evaluated and OR'd on every SELECT,
-- pure duplicated cost for zero semantic difference. Separately,
-- memberships_write being `for all` silently grants DELETE too (the trap
-- CLAUDE.md calls out under "RLS upsert trap": "Prefer separate
-- insert/update policies over `for all` (which silently grants DELETE)")
-- -- the same shape already retired from invoices/invoice_items in the
-- 2026-07-24 write lockdown, just never applied to memberships.
--
-- Fix: keep memberships_read exactly as-is (now the ONLY SELECT policy, so
-- it's evaluated once instead of twice), and replace memberships_write with
-- explicit insert/update/delete policies carrying the identical predicate --
-- same write semantics, no more implicit for-all DELETE grant, SELECT stops
-- being duplicated. No SECURITY DEFINER helpers, no change to the
-- referenced-table-subquery shape -- this is a correctness/hygiene change,
-- not a performance claim (the noise band above means it should NOT be sold
-- as a speed fix).

drop policy if exists memberships_write on memberships;
drop policy if exists invoice_items_read on invoice_items;

drop function if exists manages_club_of_person(text);
drop function if exists invoice_owner_or_manager(text);

-- memberships_read: explicit drop-then-recreate (identical predicate,
-- verbatim) rather than a true no-op. This file is applied on top of
-- whichever state staging is currently in -- including the superseded
-- draft of THIS SAME migration, which already dropped memberships_read and
-- never recreated it. `if exists` makes this safe against a clean baseline
-- too (where memberships_read was never touched).
drop policy if exists memberships_read on memberships;
create policy memberships_read on memberships for select
  using (is_admin()
    or person_id = my_person_id()
    or exists (select 1 from people p where p.id = memberships.person_id and manages_club(p.main_club_id)));

create policy memberships_insert on memberships for insert
  with check (is_admin()
    or person_id = my_person_id()
    or exists (select 1 from people p where p.id = memberships.person_id and manages_club(p.main_club_id)));

create policy memberships_update on memberships for update
  using (is_admin()
    or person_id = my_person_id()
    or exists (select 1 from people p where p.id = memberships.person_id and manages_club(p.main_club_id)))
  with check (is_admin()
    or person_id = my_person_id()
    or exists (select 1 from people p where p.id = memberships.person_id and manages_club(p.main_club_id)));

create policy memberships_delete on memberships for delete
  using (is_admin()
    or person_id = my_person_id()
    or exists (select 1 from people p where p.id = memberships.person_id and manages_club(p.main_club_id)));

-- invoice_items_read: reverted to its ORIGINAL form (the superseded draft's
-- invoice_owner_or_manager() rewrite is undone; already dropped above,
-- before invoice_owner_or_manager() itself was dropped).
create policy invoice_items_read on invoice_items for select
  using (is_admin() or exists (
    select 1 from invoices i where i.id = invoice_items.invoice_id
    and (i.athlete_id = my_person_id() or manages_club(i.club_id))));

-- ---------------------------------------------------------------------------
-- NOT changed here, deliberately:
-- ---------------------------------------------------------------------------
-- - invoice_owner, invoices_finance_read, invoices_refund_manager_read,
--   invoice_items_admin, invoice_items_finance_read,
--   invoice_items_refund_manager_read, and everything the 2026-07-24 invoice
--   write lockdown created (invoices_insert/update/delete,
--   invoice_items_insert/update/delete) are all unaffected by this
--   migration.
