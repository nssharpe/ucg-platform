# Plan: cart/registration state-machine fixes (client side)

Fixes for Part 2 of `docs/specs/2026-07-02-security-review-findings.md` (C5, H5–H8,
M6–M9, L2). Sonnet-tier implementer session(s); pure-logic changes get vitest tests
(the classifier and any new pure helpers). Independent of the security-hardening plan
except where noted.

> **STATUS — SHIPPED 2026-07-02** (branch merged to `main`). All 8 tasks implemented;
> build + eslint(touched) + vitest (217) green; smoke-tested (athlete + manager roles,
> /cart, /my-registrations, /club/:id/registrations all render, zero console errors).
> **Two defects caught in controller review of the Sonnet draft before merge:**
> 1. **H6 was a free-membership bug.** The draft "cleared the hold" by mirroring the
>    payment-SUCCESS path (clubCartPending=false, status→active). But `membershipHolds()`
>    derives `active` purely from the holds, so clearing them on a signed-waiver adult
>    row marks it ACTIVE — a free membership. Removing an UNPAID club-pushed membership
>    is a *cancellation*: the fix DELETES the row (new `deleteMembership` helper), guarded
>    to `clubCartPending===true` so a since-paid row is never nuked.
> 2. **H7 could over-charge.** The added-discipline entry-fee branch fired whenever
>    `changeFee===0`, which includes a non-host event configured with a $0 change fee —
>    charging full entry for a discipline added *within* the free-change window. Re-gated
>    on `!changeFeeApplies` (outside the window only), matching MyRegistrations.
>
> **Known residuals (minor, non-money-loss, flagged for later):** (a) removing BOTH an
> entry line and a stacked change line for the same reg leaves the reg as an unpaid
> orphan (pending, no line) rather than deleted — recoverable, doesn't block checkout;
> (b) the $0-change-window added discipline lands unpaid-with-no-line (same orphan shape,
> consistent with MyRegistrations). **Not yet manually exercised in-browser:** the full
> H6 push→remove and H5 stacked-removal flows (need seeded multi-step setup) — logic is
> unit-tested + reasoned; worth one manual pass.

## Task 1 — C5: club cart entry dedupe (small, ship first)
`Club.tsx` `addToCart`: replace the athlete-only `already` set with a per-event,
entry-only check: skip the push only if the cart already has a line with
`kind==='meet-entry' && refLineType !== 'change' && refUserId===athleteId &&
refEventId===event.id`. Add a regression test if any of this is extractable pure;
otherwise verify via seeded manager: register same athlete for two events → two entry
lines, both regs payable.

## Task 2 — H5 + M7 + L2: one-reg-many-lines removal semantics
Make `removeCartItemWithSync` (`cart-sync.ts`) + `classifyCartRemoval` (`pricing.ts`)
handle shared `refRegIds` deterministically:
- `delete-registration`: skip reg ids still referenced by another cart line in the
  same scope (leave them; toast which were kept), or cascade-remove the other lines
  with their own correct semantics — pick ONE, document it. Recommend: skip + toast.
- `revert-registration`: never `push`/`pushRegistration` a reg that no longer exists
  locally; reg ids in `refRegIds` with NO snapshot entry were *created* by that change
  → delete them on removal.
- Prevent the stacking at the source: `Club.tsx` `saveRegs` gets the same
  `alreadyPending` guard as `MyRegistrations` — extend the existing change line's
  `refRegIds` and add snapshot entries ONLY for regs not already covered (never
  overwrite an existing snapshot — it must stay the ORIGINAL pre-change state). This
  is also the M7 fix — apply it to `MyRegistrations.tsx` too.
- L2: before shipping, re-run the live-data check for null-`refLineType` +
  non-null-`refRegIds` rows; if any exist, backfill `ref_line_type` first.
- Tests: `classifyCartRemoval` cases for shared refs / created-by-change / missing
  snapshot in `tests/lib/cart-removal-classify.test.ts`.

## Task 3 — H6: membership-line removal clears the payment hold
In `removeCartItemWithSync`, when the removed item is a membership push (`kind:
'membership'` with `refUserId`/`refSeasonId`/`refType`), find the matching membership
(same match keys the webhook uses) and clear `clubCartPending` (set status back if it
is `pending-club-payment` — decide: revert to the pre-push state; check what
`Membership.complete('club')` sets so the clear is its exact mirror), push the
membership, and toast ("removed — X's membership is no longer pending club payment").

## Task 4 — H7: club edit paid-stamping parity
Port `MyRegistrations.tsx`'s else-branch into `Club.tsx` `saveRegs`: no-prior regs get
`paid = (nothing owed)`, `updatedPending = false`, and when a discipline is added via
Edit outside the change-fee window, charge the appropriate entry/second-discipline fee
(consult `newRegistrationEntryTotal`) instead of silently free. Also make the grid
status cell treat `paid !== true` as unpaid (undefined-safe).

## Task 5 — H8: checkout retry actually retries
`CartCheckout.tsx`: make `retry()` call `startSession()` directly (set
`startedRef.current = true` first), or key the mount effect on an explicit attempt
counter. Verify by forcing a failure (e.g. temporarily bad function URL) → Try again
→ session created.

## Task 6 — M6: in-place-mutation-trap sweep
Fix the live instance (`MyRegistrations.tsx` `byEvent`) and audit/fix the flagged
ones (`Club.tsx` allRoster/athletes memos, the `[db, clubId]` cleanup effects in
`Cart.tsx`/`Club.tsx`): read directly per render (the `Cart.tsx` cart precedent) or
key on a store snapshot version. Grep `useMemo(.*db\.|useEffect(.*\[db` across `src/`
for any others.

## Task 7 — M8: cross-club cleanup uses removal-with-sync
`cleanupCrossClubCart` (`cart-sync.ts`): route each stale line through
`removeCartItemWithSync` (entry lines delete moot regs; change lines revert) instead
of bare cart filtering; keep the single toast.

## Task 8 — M9: guard removal against an in-flight checkout session (smallest useful step)
When removing a cart item, check for a `pending` `payments` row whose `cart_item_ids`
include it (self-read RLS already allows this); if found, require an explicit confirm
("A checkout for this item may be in progress…"). Full session-expiry is Phase-3
territory; don't build it here.

## Ordering / verification
Task 1 alone is a shippable hotfix. Tasks 2+3+7 form one cohesive cart-sync group
(same files); 4, 5, 6, 8 are independent. Standard gate per CLAUDE.md: `npm run build`
+ eslint touched files + `npx vitest run`; exercise club two-event registration,
edit-stacking, membership push/remove, and a forced checkout failure with the seeded
users before merge.
