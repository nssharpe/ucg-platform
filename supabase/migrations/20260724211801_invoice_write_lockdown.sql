-- Security hardening Phase 3 — invoice write lockdown (found 2026-07-24, not in
-- the original 2026-07-02 plan).
--
-- 20260623000070_self_pay_invoice_rls.sql added two policies for a client-side
-- "Pay now" membership flow (Membership.tsx direct-pay "card" step) that has
-- SINCE BEEN REMOVED — see the comment above `complete()` in Membership.tsx
-- ("'card' is intentionally NOT an option here"). Today those two leftover
-- policies let ANY signed-in member forge a paid invoice via raw PostgREST:
--   - invoice_self_insert: `for insert with check (athlete_id = my_person_id())`
--     lets a member insert an invoice row with an arbitrary number/paid_at for
--     themself.
--   - invoice_items_owner_write: `for all` (the FOR-ALL-silently-grants-DELETE
--     trap — see CLAUDE.md "RLS upsert trap") governed only by
--     `i.athlete_id = my_person_id() or manages_club(i.club_id)`, so that same
--     forged invoice's line items (amounts, labels) are fully writable, and
--     ANY invoice's line items are deletable by the invoice's own athlete.
-- Finance dashboards (src/pages/admin/league/Finance.tsx) read these tables
-- directly, so this is financial-record pollution, not just a cosmetic bug.
--
-- Controller review (2026-07-24) caught that the first draft of this migration
-- left `invoice_admin` (invoices, 20260601000002_rls.sql, also `for all` — the
-- same FOR-ALL-grants-DELETE shape) untouched, with its `manages_club(club_id)`
-- write branch intact. That is the SAME hole, just scoped to managers instead
-- of members: a club manager could UPDATE their club's invoice (`paid_at`,
-- `number`) or INSERT/UPDATE `invoice_items` under it via the (also
-- manager-admitting) `invoice_items_owner_write` policy — forging a paid club
-- invoice into the same Finance dashboards. This revision folds that fix in.
--
-- Enumeration of EVERY write to invoices/invoice_items, client AND
-- edge-function (re-verified 2026-07-24 specifically to check for a
-- club-manager-JWT writer before dropping the manages_club branch):
--   - src/pages/Membership.tsx `complete('comp')` (~line 210-320): the ONLY
--     caller of `pushInvoice` (src/lib/supabase.ts:957). The button that
--     invokes it is rendered ONLY behind `{caps.isAdmin && (...)}`
--     (Membership.tsx:682-691) — no other call site reaches `complete('comp')`
--     (grepped `complete\('comp'\)` project-wide: one hit, the onClick itself).
--   - src/lib/supabase.ts `pushAll` (~line 2427-2492, the "Push local DB →
--     Supabase" admin seed tool) also upserts `invoices`/`invoice_items` in
--     bulk. Its only caller is src/pages/admin/league/DemoTools.tsx, reachable
--     only via the `/admin/league` route, which App.tsx wraps in
--     `<RequireAdmin>`.
--   - No other client writer exists: grepped `'invoice_items'|"invoice_items"|
--     'invoices'|"invoices"` and `from\('invoices'\)|from\('invoice_items'\)`
--     across all of `src/**/*.ts*` — every remaining hit is one of the two
--     writers above, a read (Finance.tsx/Club.tsx/loadAll — display only,
--     RLS-scoped), or a `database.types.ts` FK annotation.
--   - supabase/functions/_shared/fulfill.ts (upserts `invoices`/`invoice_items`
--     at fulfillment — called by `stripe-webhook` and the $0-coupon free-order
--     path in `create-checkout-session`), supabase/functions/process-refund
--     (`invoice_items.update({refunded:true})`, index.ts:313), and
--     supabase/functions/admin-delete-person (`invoice_items.update({label})`
--     scrub, index.ts:260) are the only edge-function writers. ALL THREE
--     construct their `db` client with `SUPABASE_SERVICE_ROLE_KEY` (grepped
--     `createClient`/`SUPABASE_SERVICE_ROLE_KEY` in each file) — service role
--     bypasses RLS entirely, so none of them depend on (or are affected by)
--     the invoices/invoice_items write policies at all, regardless of which
--     branch those policies contain.
--   - supabase/functions/request-refund reads invoices/invoice_items
--     (request-refund/index.ts:150-188, e.g. the `.from('invoices').select(...)`
--     at line 185) but never writes either table — confirmed by grepping
--     `from\('invoice(s|_items)'\)\.(update|insert|upsert|delete)` across
--     supabase/functions: zero hits in request-refund (its only writes are to
--     `refund_requests`, out of scope here).
-- Conclusion: no club-manager-JWT writer of invoices/invoice_items exists
-- anywhere in the app. The `manages_club(...)` write branches on
-- `invoice_admin` and `invoice_items_owner_write` are vestigial and safe to
-- drop entirely (write-side only — see below for what stays read-only).
--
-- invoices: drop the member self-insert branch AND replace `invoice_admin`
-- (FOR ALL) with separate insert/update/delete policies, admin-only.
-- SELECT is UNCHANGED: `invoice_owner`
-- (20260601000004_text_ids_score_extras.sql, `for select using (is_admin() or
-- athlete_id = my_person_id() or manages_club(club_id))`) already covers
-- club-manager reads on its own, so managers keep seeing their club's
-- invoices — only writes are being restricted. `invoices_refund_manager_read`
-- / `invoices_finance_read` (their own unrelated SELECT policies) are also
-- untouched.
drop policy if exists invoice_self_insert on invoices;
drop policy if exists invoice_admin on invoices;

-- Collision cleanup (2026-07-24): a PARALLEL session, spawned from a background
-- task chip while this migration was being reviewed, independently split
-- `invoice_admin` into `invoice_admin_insert`/`_update`/`_delete` and pushed
-- that to STAGING as migration 20260724212606. Its insert/update arms KEPT the
-- `manages_club(club_id)` branch — i.e. exactly the manager-side forgery hole
-- this migration exists to close — because it assumed Membership.tsx still had
-- a member-run direct-pay flow whose `pushInvoice` needed manager writes. That
-- flow was removed (the only `pushInvoice` caller, `complete('comp')`, is gated
-- on `caps.isAdmin`, Membership.tsx:682), so the branch is vestigial.
-- Since RLS policies are OR'd, leaving those three in place alongside the
-- admin-only ones below would silently keep the hole open. Dropping them here
-- (rather than in a follow-up migration) makes this file self-healing and
-- ORDER-INDEPENDENT: on staging it removes the already-applied stray policies,
-- and on prod — where 20260724212606 was never applied and has been reverted
-- out of staging's history — all three drops are harmless no-ops.
drop policy if exists invoice_admin_insert on invoices;
drop policy if exists invoice_admin_update on invoices;
drop policy if exists invoice_admin_delete on invoices;

create policy invoices_insert on invoices for insert
  with check (is_admin());

create policy invoices_update on invoices for update
  using (is_admin())
  with check (is_admin());

create policy invoices_delete on invoices for delete
  using (is_admin());

-- invoice_items: replace the FOR-ALL owner-write policy with separate
-- insert/update policies (never FOR ALL — it silently grants DELETE, the
-- exact trap CLAUDE.md's "RLS upsert trap" section warns about), admin-only.
-- Both the member/self branch (`i.athlete_id = my_person_id()`) and the
-- manager branch (`manages_club(i.club_id)`) are dropped entirely: no
-- surviving writer needs either (see the enumeration above). Deletes are
-- admin-only. SELECT is UNCHANGED: `invoice_items_read` (its own pre-existing
-- SELECT-only policy) still admits `manages_club(i.club_id)`, so managers
-- keep reading their club's line items.
drop policy if exists invoice_items_owner_write on invoice_items;

create policy invoice_items_insert on invoice_items for insert
  with check (is_admin());

create policy invoice_items_update on invoice_items for update
  using (is_admin())
  with check (is_admin());

create policy invoice_items_delete on invoice_items for delete
  using (is_admin());
