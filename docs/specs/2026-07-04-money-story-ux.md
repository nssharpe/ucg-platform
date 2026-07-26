# Money-story UX reconciliation (task O1)

**Status:** design spec, decided 2026-07-24. Implements the O1 brief in
[`../plans/2026-07-04-uiux-review-fixes.md`](../plans/2026-07-04-uiux-review-fixes.md).
Hands S4 its exact behavior. No code was written as part of this task.

**S4 implemented 2026-07-25** on branch `money/s4-cart-price-agreement` (unmerged,
undeployed — pending the controller's fable review of the money-path diff per standing
process). See `docs/whats-next.md` §3 item 1 for current status.

## The problem this closes

The 2026-07-04 live review found three money surfaces that disagreed with each other
and had no connecting path:

| Surface | Said |
|---|---|
| Cart page (`Cart.tsx`) | **Total $45** |
| Checkout summary (`CartCheckout.tsx`, server-priced) | **Subtotal $55 / Total due $56.95** |
| Purchase History | an **UNPAID $65** invoice, on a page subtitled "Receipts processed on your account", with no way to pay it |

Same user, same session. Two different prices for the same line with no explanation
reads as an overcharge, which is the single worst trust failure a registration
platform can have.

---

## 1. Cart display amounts vs. the server's price

### Why they legitimately diverge today

`cart_items.amount` is written by the client when the line is created and never
updated. `create-checkout-session` recomputes every line server-side and never trusts
that stored value (CLAUDE.md "Payments"). Both behaviors are correct in isolation; the
gap between them is the bug. Known divergence sources:

1. **The stored amount went stale** — the season's membership fee, the event's entry
   fee, or an add-on price changed after the line was added to the cart.
2. **Entry-vs-change derivation.** The server decides whether a `meet-entry` line is a
   new entry or a change *from the referenced registrations' DB state* (`paid` /
   `updated_pending`), deliberately ignoring the client's `ref_line_type` tag — that
   is the C4 fix and it is not negotiable. The client's tag can therefore disagree with
   the server's classification, and the two prices differ accordingly.
3. **Late-registration surcharge.** `lateFeeAnchor` attaches the surcharge to exactly
   one line, anchored on the earliest reg `createdAt`. The client computes this from
   possibly-stale store data and deliberately fails toward *not* surcharging; the
   server recomputes from real DB timestamps. The window can also simply be crossed
   between add-to-cart and checkout.
4. **Host-club $0** — resolved consistently on both sides, but only if the client's
   view of the competing club and the event's host club is current.
5. **Coupons** — applied server-side only, per line scope, never stored on the cart row.

### Decision: the server prices the cart, not the client

**Rejected: recomputing display prices client-side from `src/lib/pricing.ts`.** That is
the O1 brief's baseline suggestion and it is the wrong call. `pricing.ts` already
carries four separate "MIRRORED IN `supabase/functions/_shared/stripe.ts` — keep in
sync" contracts (`lateFeeAnchor`, `addonPurchaseOpen`, `addonPriceDollars`,
`processingFee`). Widening that mirror to cover the whole cart adds drift surface to
the exact logic — entry-vs-change from reg state, late-fee anchoring — where the client
is *structurally* unable to match the server, because the server reads DB rows the
client may hold stale. A mirror that can never be exactly right cannot fix a
"the two numbers disagree" bug; it just moves where they disagree.

**Adopted: a price-preview mode on `create-checkout-session`.** Split the function's
existing two phases — it already (a) recomputes and validates every line, then (b)
creates the payments row and the Stripe session. Add a `mode: 'preview'` request that
returns after (a) with the priced line set, subtotal, service fee, and total, and
performs **no side effects**: no `payments` insert, no Stripe call, no `lines_snapshot`
write, and (once M1 lands) **no coupon reservation**. The cart renders those numbers.

This makes exactly one component authoritative for price, so the cart and the checkout
summary cannot disagree — they are literally the same computation.

**Safety properties (must hold, verify in review):**

- Preview is a pure read. Any code path that writes must be behind the non-preview
  branch, and the preview branch must return before reaching it.
- Preview runs the **same** auth, ownership (H4) and validation checks as a real
  session-create. It must not become a way to price a cart you don't own, and it must
  reject exactly what checkout would reject.
- Preview reveals nothing the caller couldn't learn by clicking "Check out". No new
  information disclosure.
- Preview must not be reachable as a way to *skip* validation — a client cannot preview
  and then check out with a different line set, because checkout re-derives everything
  anyway.

### Cart page behavior

1. On cart render, show the stored `cart_items.amount` values immediately, explicitly
   labelled **"Estimated"**, so the page paints without waiting on the network.
2. Fire the preview request. When it returns, replace the displayed amounts with the
   server's and drop the "Estimated" label.
3. If any line's server price differs from what was displayed, show a single
   non-alarming notice above the totals — *"We updated these prices to today's rates"* —
   listing the changed lines with their old and new amounts. Not an error style; this
   is normal and honest.
4. If the preview call fails, keep the stored amounts, keep the "Estimated" label, and
   say so plainly: *"Showing estimated prices — final total is confirmed at checkout."*
   Never block the cart on the preview.
5. The existing rule stands unchanged: **the UI never sums client amounts as
   authoritative.** The "Total" shown once the preview lands is the server's total.

### Checkout behavior

`CartCheckout.tsx` already renders the server-returned Subtotal / Coupon / Fee / Total.
With the cart previewing from the same source, the "prices were updated" notice at
checkout becomes a fallback for the narrow race where the price changed *between*
preview and session-create. Keep it, same wording as the cart notice.

### Explicitly out of scope

No change to `create-checkout-session`'s authority model. No client-side writes to
`payments`. `classifyCartRemoval` / `removeCartItemWithSync` semantics unchanged.
Beware the in-place `mutate()` trap: read `db.*` directly each render, never `useMemo`
on a nested `db.*` path.

---

## 2. Unpaid invoices

### Decision: an unpaid invoice is not a supported state

Confirmed with Nate 2026-07-24: **UCG never bills anyone.** There is no invoice-then-pay
flow, no PO, no net terms. An invoice in this system is a *receipt* — a record of money
that already moved through Stripe. Nobody should ever be able to receive something
without having successfully paid for it.

Verified against the code the same day — every path that creates an `invoices` row
already sets `paid_at`:

| Writer | `paid_at` |
|---|---|
| `_shared/fulfill.ts:236` — fulfillment core (Stripe webhook + $0-coupon free-order path) | always `now` |
| `Membership.tsx:292` — admin comp override ($0 membership grant) | `now` |
| `seed.ts:253` — seeded test data | set |

So the UNPAID $65 row seen on 2026-07-04 is a legacy artifact of the removed
client-side "Pay now" membership flow (see the comment at `Membership.tsx:204`), not a
live defect. It will disappear in the pre-launch data sweep.

**One real hole was found and is being closed** as part of security hardening Phase 3
(item 2.0): migration `20260623000070_self_pay_invoice_rls.sql` still grants
`invoice_self_insert on invoices for insert with check (athlete_id = my_person_id())`,
left over from that same removed flow. Any signed-in member can insert a forged PAID
invoice row via raw PostgREST, and the companion `invoice_items_owner_write ... for all`
silently grants DELETE. It cannot produce a free membership or a free registration (the
Phase 1 guard triggers block those), but it pollutes the financial record and the
Finance dashboards, which read these tables directly. Both policies are being dropped /
narrowed.

### UX consequences

1. **Purchase History shows receipts only.** Filter the member-facing list to invoices
   with a non-null `paid_at`. The page keeps its name and its "Receipts processed on
   your account" subtitle, both of which then become true.
2. **No "Pay now" affordance, no cart link, no relabel to "Invoices & receipts."** Adding
   a payment path for a state that cannot legitimately occur would create a second way
   to build a payable cart — more money-path surface to secure, for zero real cases.
3. **A null-`paid_at` invoice is an anomaly, not a UI state.** It should surface to
   admins, not members: the `reconcile-payments` function already scans stuck-pending
   payments for the Finance → Reconciliation tab, which is where an orphaned invoice
   belongs. Do not build a member-facing story for it.
4. **Remove the dead `Unpaid` badge branches** at `PurchaseHistory.tsx:104` and `:159`
   once the list is filtered. `Cart.tsx:481` / `:496` render the same badge in the
   receipts section — same treatment. `receipt.ts:62` and `person-export.ts:93` may keep
   their unpaid wording as defensive output for a data export; they are not UI.

---

## 3. Invoice numbering

### Decision: leave both formats as they are

Two formats exist side by side — friendly `UCG-2026-0029` (from
`fulfill.ts:231` and `Membership.tsx:288`) and raw `UCG-I-<epoch>` on older rows.

Per Nate 2026-07-24: everything currently in the database is test data from closed
development, with no real users. The database will be swept and invoice numbering reset
before launch, so a historical mix of formats in test data has no consequence. **No
display-side prettifier, and no data migration.** Revisit only if real invoices ever end
up in two formats, which the pre-launch sweep is designed to prevent.

One latent issue worth recording, since it survives the sweep: both live generators
derive the sequence number from a **row count** (`select count(*) from invoices` in
`fulfill.ts`, `d.invoices.length + 1` in `Membership.tsx`). That is not
concurrency-safe — two fulfillments racing produce the same number — and it is not
gap-stable if a row is ever deleted. Not a launch blocker at current volume, and
explicitly out of scope for O1. Logged to `docs/whats-next.md` as a follow-up.

---

## What S4 implements

1. `mode: 'preview'` on `create-checkout-session` (side-effect-free, same auth and
   ownership checks, no coupon reservation).
2. Cart renders stored amounts as "Estimated", then replaces them with preview prices;
   "We updated these prices to today's rates" notice on any diff; graceful degradation
   when the preview fails.
3. Purchase History filtered to `paid_at != null`; dead Unpaid badge branches removed.
4. Vitest coverage for any new pure helper (the line-diff calculation is the obvious
   candidate — keep it pure and test it).

**Controller gate (task O2):** fable review of the full diff before merge, reading
specifically for a path where a display change became an authority change, and for the
preview branch leaking a side effect.
