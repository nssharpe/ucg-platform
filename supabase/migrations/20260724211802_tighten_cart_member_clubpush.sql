-- Security hardening Phase 3 — M2: tighten `cart_member_clubpush`.
--
-- Finding (docs/specs/2026-07-02-security-review-findings.md M2):
-- `cart_member_clubpush` (20260624000010_member_club_cart_rls.sql) lets a
-- member at an `allow_club_pay` club insert/read/delete ANY cart_items row
-- with `ref_user_id = self`, regardless of `kind` — e.g. a `meet-entry` or
-- `change` line referencing someone else's registration. This is
-- defense-in-depth (create-checkout-session already re-derives pricing and
-- validates ref ownership server-side per the Phase 2 C4/H4 fix — a forged
-- club-cart line cannot be checked out for more than its true cost, and
-- ownership violations 400), but the DB itself should not admit the shape.
--
-- The only legitimate writer through this policy is the "Send to Club Cart"
-- membership-fee push, src/pages/Membership.tsx `complete('club')` branch
-- (~line 254-282): it always pushes `kind: 'membership'`, `refUserId: me.id`,
-- with no `ref_reg_ids`/`ref_line_type` at all — via `pushCartItem(club.id,
-- item, true)` (src/lib/supabase.ts:953, a single-row upsert, never a
-- delete). No other call site in src/ pushes a club-cart row through this
-- ref_user_id-is-self path with a non-membership kind.
--
-- Tighten both USING (governs SELECT/UPDATE/DELETE) and WITH CHECK (governs
-- INSERT/UPDATE) to require `kind = 'membership'` in addition to the existing
-- self-ref and allow_club_pay checks. `clubs` SELECT is `public_read using
-- (true)` (20260601000002_rls.sql) — no RLS-recursion risk from the `clubs`
-- subquery (unchanged from the pre-existing policy).
drop policy if exists cart_member_clubpush on cart_items;
create policy cart_member_clubpush on cart_items for all
  using (
    ref_user_id = my_person_id()
    and kind = 'membership'
  )
  with check (
    ref_user_id = my_person_id()
    and kind = 'membership'
    and club_id is not null
    and exists (select 1 from clubs c where c.id = cart_items.club_id and c.allow_club_pay)
  );
