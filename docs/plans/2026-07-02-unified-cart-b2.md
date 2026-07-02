# Unified cart + cart mutation sync (B2)

Source: `docs/plans/2026-06-28-feedback-tracker.md` B2. Full merge confirmed with Nate
(2026-07-02) over the "consistent-but-separate-pages" alternative.

## Research findings (already confirmed, don't re-derive)
- `Capabilities.managedClubIds: string[]` already exists (`capabilities-core.ts` ~L128),
  derived from `db.clubs.filter(c => c.managerIds.includes(personId)).map(c => c.id)`.
- `Registration` (`types.ts` L278-313) has **no prior-state snapshot field** — only
  current state + an `updatedPending` boolean flag. A "change" cart item
  (`kind:'meet-entry', refLineType:'change'`) is created in `Club.tsx` (~L918) and
  `MyRegistrations.tsx` (~L159) by immediately overwriting the registration row; nothing
  captures what it looked like before. **Reverting a change on cart-item delete requires
  a new snapshot mechanism — there is no way to do this from existing data.**
- Deleting an unpaid `registrations` row is safe: FKs are `ON DELETE CASCADE` from
  `scores`/`meets`/`people`, `ON DELETE SET NULL` from `clubs`/`levels`/`meet_sessions`/
  `squads` (`20260601000001_schema.sql` L171-191). No blocking constraint.
- `src/lib/receipt.ts` `downloadReceipt(inv, forName)` is the jsPDF pattern to mirror for
  a new pre-payment "Print Invoice" export (header, item loop skipping discount lines,
  subtotal/discount/total, `doc.save(filename)`).
- `Club.tsx`'s `ClubCart` (~L1312-1547) already aggregates everything (memberships + all
  event cards + other) into ONE combined "Continue to checkout →" button — "Checkout
  All" is functionally already true there; it's just not duplicated at the top, and
  Cart.tsx's personal cart has the same single-bottom-button shape.
- Already done (2026-07-02, commit b13943b): generic ✕ delete in `Cart.tsx` (personal
  cart only, simple removal, no registration-state sync yet); Club.tsx's cart already had
  its OWN separate ✕ per line (older code, also simple removal, no sync).

## Scope (per Nate, 2026-07-02)
Full single-page merge: `/cart` shows the signed-in person's own items AND a separate
card-section per club they manage (from `managedClubIds`), each with its own
checkout/print-invoice/edit/delete, plus a receipts/invoices history section per managed
club. Cross-entity "Checkout Everything" (personal + multiple clubs in one Stripe
session) is explicitly OUT of scope — `create-checkout-session`'s billing model assumes
one payer entity per session (self OR one club); each scope keeps its own "checkout all"
button rather than a single mega-button spanning different billers. Flag this boundary
if Nate wants it revisited later.

## Tasks

### Task A — cart-registration mutation sync (foundational, do first)
1. Migration: `alter table cart_items add column if not exists prior_reg_snapshot jsonb;`
   (nullable — a JSON array of the registration row(s)' pre-change field values;
   `null` for non-change items or old rows created before this existed).
2. `CartItem` type (`types.ts`): add `priorRegSnapshot?: Registration[]`. Row
   mapper in `supabase.ts` (`cartItemToRow`/row-to-CartItem): map to/from
   `prior_reg_snapshot`.
3. At both change-fee-creation sites (`Club.tsx` ~L918, `MyRegistrations.tsx` ~L159):
   capture the FULL prior `Registration` row(s) (the ones in `refRegIds`) as they are
   BEFORE applying the new values, and store on the new cart item's `priorRegSnapshot`.
4. New shared helper, e.g. `src/lib/cart-sync.ts`, exported function
   `removeCartItemWithSync(ownerKey: string, isClub: boolean, item: CartItem)`
   (or equivalent name) that, given the item being removed:
   - `kind==='meet-entry' && refLineType==='entry'` (brand-new unpaid registration):
     delete the registration row(s) in `item.refRegIds` entirely (+ any `scores` rows
     referencing them, though FK cascade may already handle this) — restores the
     athlete to "eligible to register" implicitly, since the row is gone.
   - `kind==='meet-entry' && refLineType==='change'` with a `priorRegSnapshot`: restore
     the registration(s) to the snapshotted values.
   - `kind==='meet-entry' && refLineType==='change'` with NO snapshot (legacy row):
     remove the cart item only, and surface a toast that the registration itself
     couldn't be auto-reverted (be honest, don't silently under-deliver).
   - anything else (membership, addon, other): remove the cart item only (current
     behavior, unchanged).
   - Always also removes the cart item itself (mirroring today's `pushCart`
     replace-semantics removal).
5. Wire this into the TWO existing delete buttons (today's `Cart.tsx` `removeItem`, and
   Club.tsx's three existing inline ✕ handlers) — replace their ad-hoc
   filter+pushCart with a call to the new shared function.
6. Tests: extract the pure "which action applies to this item" decision as a testable
   pure function if feasible (e.g. `classifyCartRemoval(item): 'delete-registration' |
   'revert-registration' | 'remove-only'`), add vitest coverage. The actual DB
   read/write parts aren't unit-testable (no DB in vitest env) — that's fine, verify
   those live in the browser per this repo's usual pattern.

### Task B — unified /cart page + Print Invoice + Edit links + Checkout-All top/bottom
(Depends on Task A's `removeCartItemWithSync` existing — call it, don't reinvent it.)
1. Extend `Cart.tsx`'s `CartInner`: for each id in `caps.managedClubIds`, render an
   additional card-section sourced from `db.carts[clubId]` (grouped the same way as the
   personal cart: Memberships / per-event / Other), each with its own Stripe checkout
   (via the existing `CartCheckout`, club-scoped) — mirroring the structure Club.tsx's
   `ClubCart` already has, not reinventing grouping logic from scratch.
2. Add a Receipts section per managed club (relocate/adapt Club.tsx's existing
   search/date-filter/receipt-detail-modal UI from `ClubCart`).
3. Retire `Club.tsx`'s `ClubCart` component and its route; add `/club/:id/cart` as a
   `<Navigate replace>` redirect to `/cart` (matching this repo's established
   redirect-old-routes pattern from the Meet→Event rename). Update the "Club Cart &
   Receipts" nav link in Club.tsx's roster page to point at `/cart`.
4. Print Invoice: new `downloadCartInvoice(items, forName, title)` in `receipt.ts`
   (mirror `downloadReceipt`'s jsPDF structure; label it clearly as a pre-payment
   estimate, not a paid receipt — no "paid" stamp; a line noting it does not process
   payment). Add a "Print Invoice" button next to each section's checkout button
   (personal + every managed-club section).
5. Edit link per meet-entry cart line: a link back to the relevant editing surface —
   personal items → `/me/registrations`; club items → `/club/:id/registrations` — same
   idiom Cart.tsx's event cards already use for "Return to registration", just also
   labeled/available on club sections (which don't have one today).
6. Checkout-All: duplicate the existing bottom aggregate-checkout button at the TOP of
   each section too (personal cart + each managed-club section) — the aggregation
   itself already exists (per research above), this is purely adding the second button.

## Verify gate (both tasks)
`npm run build`, `npx eslint <touched files>` (incl. any new `supabase/functions/**` —
none expected here, this is pure frontend + one migration), `npx vitest run` + new tests
for Task A's pure classifier. Live-verify in the preview: create a real change-fee cart
item, delete it, confirm the registration reverts; create a real new-entry item, delete
it, confirm the registration disappears and the athlete is eligible again; confirm the
unified `/cart` page shows a managed club's section for a club-manager account; Print
Invoice downloads a PDF; old `/club/:id/cart` redirects to `/cart`.

## Explicitly NOT in this pass
Cross-entity "Checkout Everything" spanning personal + multiple clubs in one Stripe
session (billing-model constraint, see Scope above) — flag to Nate as a possible later
ask, don't build it speculatively.
