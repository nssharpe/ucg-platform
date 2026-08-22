# UAT round-1 implementation notes (deviations from the triage plan)

## M-10 x Z-04 (2026-08-22 rework): split the mixed line into a pure change line + a pure entry line

**Why.** After Z-04's refund rework shipped (`2d71353`), a `refLineType:'change'` line became
NEVER refundable. M-10-01's combined "mixed" line (added-discipline entry-total + change fee,
tagged `'change'`) meant the added discipline's entry-fee portion became permanently
non-refundable too, and got booked under the change-fee accounting code in finance. The
combined single line was the wrong shape — this rework splits it into two separate cart lines
so each keeps its own refund eligibility and accounting code.

**What changed (client only — server three-way split kept as defense-in-depth, per the rework
request).**
- `src/pages/Club.tsx` `saveRegs` and `src/pages/MyRegistrations.tsx` `saveRegs`: a discipline
  ADDED alongside a chargeable edit now gets a SEPARATE `refLineType:'entry'` cart line
  (`newRegistrationEntryTotal` at the second-discipline rate) instead of being folded into the
  `refLineType:'change'` line. The change line's `refRegIds` no longer includes added regs at
  all — it covers only `changedRegs`.
- New pure helper `regsForChangeLine(newRegs, priorById)` (`src/lib/pricing.ts`): returns the
  subset of `newRegs` that were already PAID or UPDATED_PENDING per their prior row. **This is
  narrower than "has a prior row"** — a prior row that exists but was NEVER paid (e.g. a
  still-unpaid discipline added by an earlier, not-yet-checked-out edit in the same session)
  must NOT land on the change line, or the server would silently reconstruct a mixed line from
  it (entry-vs-change is derived per-reg from DB state, not from which cart line the client put
  it on) and potentially double-charge that reg against its own separate pending entry line.
  Caught during advisor review with a concrete two-edit trace (edit 1 adds B, entry line
  pending unpaid; edit 2 changes something else and would have swept B onto the change line
  under the naive "has a prior row" definition) — the FIRST draft of this rework used that naive
  definition and had this exact bug. Tested directly: `tests/lib/pricing-registration.test.ts`
  `regsForChangeLine` describe block, including the never-paid-prior case.
- `entryFeePendingItem` (both files): a new "already pending ENTRY line" lookup, matched
  structurally (`kind`/`refLineType`/`refUserId`/`refEventId`) so a discipline added across two
  separate not-yet-paid edits extends the same entry line (M7/H5-style) instead of stacking a
  second one — deliberately structural rather than label-based since it's new code with no
  legacy label-matching behavior to preserve (unlike the change-line lookup below).
- The change-fee line's label/lookup (`changeFeeLabel`/`changeFeePendingItem`) is UNCHANGED byte-for-byte
  from before M-10-01 ever touched this file — it's a pure change fee again, so there was never
  a reason to touch its label or matching logic this time either.
- `src/lib/reg-estimate.ts`: the pre-checkout ESTIMATE stays one combined number ($45 in the
  worked example) — it estimates a total, never a line shape — now composed by summing
  `newRegistrationEntryTotal(...) + registrationChangeFee(...)` directly instead of calling
  `addedDisciplineChangeTotal` (which is now cart-line-flavored language that no longer matches
  what the client produces).
- `addedDisciplineChangeTotal`/`addedDisciplineChangeTotalDollars` (pricing.ts / `_shared/stripe.ts`)
  and the server's mixed-line branch in `create-checkout-session/index.ts` are UNTOUCHED and
  KEPT — the server still needs them as defense-in-depth for a forged cart or a legacy
  pre-rework pending mixed line.
- `.claude/rules/money-invariants.md`: updated both the `create-checkout-session` entry (states
  the client no longer produces a mixed line; the server's branch is defense-in-depth only) and
  the Refunds section (the change-fee exclusion note now explains this is WHY the mixed line was
  removed, not just a flagged side effect of it).

**`_shared/fulfill.ts` paid-flip verification (requested explicitly).** `fulfill.ts:213-216`
builds `paidRegIds` as a DEDUPED UNION of `ref_reg_ids` across every item in the payment being
fulfilled's OWN `lines_snapshot`, then a single `update({paid:true, updated_pending:false}).in('id',
paidRegIds)`. This is per-PAYMENT, not literally per-line, but that still gives exactly the
independence the split needs: a payment/checkout containing only the new entry line flips only
the added reg to paid; one containing only the change line flips only the changed reg. When both
lines are checked out together (the common case), the union matches what the old single combined
line would have flipped — no regression there. Confirmed by reading the function, not by
running it (no Deno test harness in this repo).

**Two revenue-affecting consequences of the `regsForChangeLine` fix — flagged for the
requirements owner, not resolved here (found on the final advisor review, after the fix
above was already applied):**
1. **Editing an all-UNPAID existing registration inside the change-fee window is now $0
   instead of the change fee.** Before this rework, `changedRegs` was "has a prior row" — so an
   eligible edit to an athlete's existing-but-never-paid registration (e.g. a level change while
   its original entry line still sits unpaid in the cart) produced a change-fee line regardless
   of paid state. With the `regsForChangeLine` fix, such an edit now has `changedRegs = []` (no
   prior row was ever paid/updated_pending), so the `changedRegs.length > 0` guard drops the
   change line entirely — shipped behavior charged the change fee there; this rework's fix
   charges nothing. Defensible on two grounds — `changeIsEligible` never checked paid state to
   begin with, and `updatedPending`'s own doc comment already frames it as "a *paid* reg edited
   back to pending," so charging a *never-paid* reg a *change* fee was arguably already
   questionable — and it also removes a client/server disagreement (the server's
   `changedRegs.length === 0` branch would have repriced that same line as a full entry total,
   not a change fee, so the OLD client behavior was already going to mismatch and trigger the
   "prices updated" banner). But it is a de-charge nobody explicitly asked for. **Needs a
   requirements-owner decision**, not an implementation call.
2. **`reg-estimate.ts` does not know about consequence #1 and now OVERSTATES in that same
   case.** It has no paid-state input at all, so for an all-unpaid existing registration inside
   the change window it still returns `{kind:'change-fee', amountDollars: changeFeeAmount +
   entryTotal()}` — a non-zero estimate for what the save path will now actually charge $0 for.
   This is the reverse of the failure direction reg-estimate.ts's own header comment warns
   about (understating, not overstating). Documented as a known divergence in the file's header
   comment rather than fixed — closing it needs a new `RegEstimateInput` field (e.g.
   `priorRegsArePaid`) threaded from `RegistrationEditor.tsx`, which is a caller outside the
   files this rework was scoped to touch.

**Minor, non-blocking note:** `entryFeePendingItem` uses `.find()`, so if an athlete somehow
already has TWO pending entry lines for the same event (e.g. `addToCart`'s original entry line
plus a mid-edit "add another discipline" line, both still unpaid), a third edit's increment
lands on whichever one `.find()` returns first. The total charged is still correct either way;
only which of the two lines carries which portion is arbitrary. Not observed as reachable in
the primary flows exercised by tests.

**Verification.** `npm run build` — succeeded. `npx eslint src/lib/pricing.ts
src/lib/reg-estimate.ts src/pages/Club.tsx src/pages/MyRegistrations.tsx
tests/lib/pricing-registration.test.ts` — zero errors/warnings. `npx vitest run` — 1163/1163
passed across 73 files (+4 from this rework: the `regsForChangeLine` describe block in
`tests/lib/pricing-registration.test.ts`; on top of the 1159/73 baseline the Z-04 section above
recorded).

## M-10-01 (S1): price added-discipline edits as extra-discipline fee + change fee

**What changed.**
- New pure helper `addedDisciplineChangeTotal` (`src/lib/pricing.ts`, mirrored as
  `addedDisciplineChangeTotalDollars` in `supabase/functions/_shared/stripe.ts`) =
  `newRegistrationEntryTotal(...)` for the added discipline(s) (priced from
  `priorDisciplineCount` INCLUDING the already-paid ones) + `registrationChangeFee(...)`,
  as one combined amount.
- Server (`supabase/functions/create-checkout-session/index.ts` ~:751-822): replaced the
  binary `isChange = refRegs.every(paid||updated_pending)` with a three-way split —
  `changedRegs` (paid/updated_pending) vs `addedRegs` (neither). `addedRegs.length===0` →
  unchanged change-fee-only path. `changedRegs.length===0` → unchanged full-entry path
  (`priorDisciplineCount = outsideRegs.length`, byte-equivalent to the old inline filter).
  Both non-empty → new combined-line path using the new helper, with
  `priorDisciplineCount = changedRegs.length + outsideRegs.length` and the late-fee anchor
  computed over `lineRegs = addedRegs` vs `outsideRegs = everything else (incl. changed regs
  in this line)`.
- Client: `Club.tsx` `saveRegs` and `MyRegistrations.tsx` `saveRegs` now push the change
  line with the combined amount (via the same helper) whenever the edit both applies a
  change fee AND adds a discipline (`newOnlyRegs.length > 0`), instead of the change fee
  alone. `reg-estimate.ts`'s `registrationEstimate` mirrors this in the `change-fee` branch.
- **Also fixed (required for correctness, found during self-review)**: the "extend an
  already-pending change line in place" branch (M7/H5) in both `Club.tsx` and
  `MyRegistrations.tsx` now bumps `line.amount` by the added discipline's entry-total when a
  SECOND edit adds another discipline into an already-pending mixed line — previously that
  branch never touched `amount` at all (a latent staleness bug, not introduced by this
  change, but it would have compounded the exact under-price this ticket fixes on repeat
  edits into the same pending line).
- **Labels: kept the existing plain "change fee" label, NOT a distinct mixed-case label.**
  The brief suggested a distinct label for the mixed case (e.g. "added discipline + change
  fee"); a first pass implemented that and switched `changeFeePendingItem`'s "already
  pending" detection from label-text matching to structural matching
  (`kind`+`refLineType`+`refUserId`+`refEventId`) so the two label variants wouldn't break
  the M7/H5 extend-in-place dedup. On review this was reverted: `MyRegistrations.tsx`'s
  original matcher only checks `kind==='meet-entry'` + a label prefix — no `refLineType`
  check at all — specifically to still catch a legacy pre-S4 row with `refLineType == null`
  (documented in `classifyCartRemoval`'s L2 note in `pricing.ts`). The structural matcher is
  strictly narrower and would stop recognizing such a legacy row as "already pending,"
  silently stacking a second change line — reintroducing the exact bug M7/H5 was written to
  prevent, unverifiable against prod from here. Final implementation keeps both label
  helpers/matchers byte-identical to before this ticket; only the pushed line's **amount**
  changed. The mixed case is distinguishable by its amount and by `refRegIds` containing a
  reg with no prior paid/updated_pending state, not by a different label string.
- **Also fixed (found on advisor review): a double-charge risk in `Club.tsx`.** The first
  draft's `isMixed = newOnlyRegs.length > 0` didn't respect
  `opts?.skipEntryFeeLine` the way the pre-existing `entryTotal` computation does. `addToCart`
  calls `saveRegs(..., { skipEntryFeeLine: true })` and pushes its OWN separate entry-fee
  line for those same `newOnlyRegs` — folding their total into the change line too would have
  double-charged them across both lines whenever that path also carries a change fee. Fixed
  to `isMixed = !opts?.skipEntryFeeLine && newOnlyRegs.length > 0`, matching `entryTotal`'s
  existing guard.
- **Also fixed (found on advisor review): wrong amount in the `MyRegistrations.tsx` toast.**
  `chargedFee` was being set to the bare `changeFee` while the cart line actually pushed
  carries `combinedChangeTotal` — the post-save toast would have told the athlete a smaller
  number than what's in their cart. `chargedFee` is now reassigned to `combinedChangeTotal`
  before the toast fires.

**Deviations from the brief.**
- Test amounts: the brief specified "4500"/"6000" for the pure-helper tests. Every neighboring
  helper in `src/lib/pricing.ts` (`newRegistrationEntryTotal`, `registrationChangeFee`, etc.)
  and every existing test in `tests/lib/pricing-registration.test.ts` is DOLLAR-denominated
  (e.g. `.toBe(65)`, never `.toBe(6500)`) — cents only ever appear in the Stripe-facing
  `_shared/stripe.ts`/`processingFee` layer. Used dollar amounts (45, 45, 0, 60) instead, to
  stay consistent with the file's existing convention; noting this so it isn't read as a
  missed requirement.
- Labels: did NOT introduce the brief's suggested distinct mixed-case label — see above.

**Noticed but NOT touched (pre-existing, out of this ticket's scope).**
- `MyRegistrations.tsx`'s `saveRegs` computes `entryTotal` only for `!editingExisting` — a
  discipline added to an existing registration while the change-fee window is CLOSED is
  charged nothing at all on the member side (no entry-fee line, unlike `Club.tsx`'s H7 fix,
  which does charge an entry fee there). This is a real pre-existing divergence between the
  two save paths, but is a separate defect from M-10-01 (which is about the window-OPEN,
  already-paid case) — left alone to keep this diff scoped to the confirmed business rule.
- **Client/server `priorDisciplineCount` divergence on a BLANKED discipline.** Client (both
  pages): `existingForAthlete.filter((r) => r.apparatus.length > 0).length` — a reg with
  `apparatus: []` does NOT count as a prior discipline. Server (`create-checkout-session`):
  `changedRegs.length + outsideRegs.length` from `allEventRegs`, with no apparatus filter — a
  blanked reg DOES count. This matters because `MyRegistrations.saveRegs` deliberately
  retains-and-blanks a deselected discipline instead of deleting it (the documented "member
  side NEVER deletes a registration" rule). For an athlete with a blanked prior discipline,
  the server would price a newly-added discipline at the second-discipline rate while the
  client displays the base rate — client/server disagree, and the "prices updated" banner
  would still fire for that specific case, one of this ticket's stated goals. Pre-existing
  (the same mismatch already exists on the unmodified brand-new-entry path) and impossible in
  the M-10-01 scenario itself (one paid + one added, no blanked rows: both sides agree at
  priorDisciplineCount=1). Left untouched — whether a blanked reg SHOULD count as a "prior
  discipline" for pricing purposes is a requirements-owner question, not an implementation
  one.

**Verification.** `npm run build` — succeeded. `npx eslint <touched files>` (including the
two `supabase/functions/**` files) — zero errors/warnings. `npx vitest run` — 1143/1143
passed across 72 files (up from the pre-existing baseline; +64 in
`tests/lib/pricing-registration.test.ts`, +21 in `tests/lib/reg-estimate.test.ts`, both
including the new/updated UAT M-10-01 cases).

## Z-01 follow-up: concurrency-safe invoice numbering

**What changed.**
- New migration `supabase/migrations/20260821140000_invoice_number_counters.sql`: table
  `invoice_number_counters (year int primary key, next_seq int not null default 1)` — RLS
  enabled, ZERO client policies (same server-only shape as `coupon_reservations`/
  `refund_requests`) — plus `next_invoice_number(p_year int default current year) returns
  text`, SECURITY DEFINER, `set search_path = public, pg_temp`. The whole claim is one
  statement: `insert into invoice_number_counters ... on conflict (year) do update set
  next_seq = next_seq + 1 returning next_seq` — the row lock taken to resolve the ON
  CONFLICT branch is the entire serialization mechanism (no separate `select ... for
  update`, since there's only one row to serialize per year). Formats
  `'UCG-' || year || '-' || lpad(seq::text, 4, '0')`.
  - Authorization is fail-closed and INSIDE the function:
    `coalesce(auth.role() = 'service_role' or is_admin(), false)`, else `raise exception`.
    This is a deliberate deviation from `reserve_coupon`/`claim_refund_approval` (both
    granted to `service_role` only, gated by the calling edge function) — `next_invoice_number`
    is ALSO called directly from the browser by `Membership.tsx`'s admin comp path, so it's
    granted to `authenticated` too and has to gate itself. `anon` is never granted.
  - Seed step: backfills each year's counter to `max(seq)` from existing
    `^UCG-[0-9]{4}-[0-9]+$` rows (legacy `UCG-I-<epoch>` rows don't match and are ignored,
    per UAT D-4). A year with zero matching rows gets no seed row at all — the function's own
    `insert ... on conflict` creates it lazily starting at 1, which is correct for a year
    that's never had an invoice (this covers prod today, which has zero invoice rows).
- `supabase/functions/_shared/fulfill.ts` (~line 220-247): replaced the
  `count(*, head:true)` + `UCG-2026-<count+1>` branch with `db.rpc('next_invoice_number')`.
  The pre-existing "reuse the existing number on a retry" branch (looked up by
  `invoice_id`) is untouched. On RPC error or a non-string/empty result, throws — no
  fallback to any guessed number. A throw here propagates exactly like any other write
  failure in `fulfillPayment` already does: the webhook's outer try/catch logs to
  `error_logs` and returns 500, so Stripe retries; the free-order path's existing
  retry-once-then-error_logs wrapper in `create-checkout-session` catches it the same way.
  No changes were needed in either caller — both already treat a `fulfillPayment` throw as
  "this attempt failed, existing recovery path handles it."
- `src/lib/supabase.ts`: new `nextInvoiceNumber(): Promise<string>` wrapping
  `supabase.rpc('next_invoice_number')`. Throws (does not return null/undefined) on any
  error, unconfigured client, or non-string result — matching the "never fall back" rule;
  callers must catch and abort rather than proceed without a real number.
- `src/pages/Membership.tsx`'s `complete()` (admin comp path): made `async`; when
  `via === 'comp'`, calls `nextInvoiceNumber()` and awaits it **before** the `mutate()` call
  that writes the membership + invoice, inside a try/catch that toasts an error and
  `return`s (no `mutate()` call at all) on failure — so a numbering failure can never leave
  a membership activated with no invoice, or vice versa. The invoice's `number` field now
  reads the claimed `invoiceNumber` (asserted non-null via `!`, safe because the `else`
  branch that constructs the invoice is reachable only when `via === 'comp'` — the sibling
  `via === 'club' && club` branch, the only other way into this function per the "Send to
  Club Cart" button's `club?.allowClubPay` gate, takes the cart-push branch instead and
  never reaches the invoice-construction `else`). The year hardcode (`UCG-2026-...`) is
  gone — the year now comes from the server via the RPC's default `extract(year from
  now())`.
- New pure helper `src/lib/invoice-number.ts` (`formatInvoiceNumber(year, seq)`) — documents
  the `UCG-YYYY-NNNN` format contract independently of the SQL side (it isn't called by the
  actual numbering path; numbers are minted exclusively server-side). Tests:
  `tests/lib/invoice-number.test.ts` (padding at 1 and 56, non-truncation at 12345, a second
  year).
- Docs: `supabase/README.md`'s migration table gained the `20260821140000` row (placed after
  `20260731210000`, the prior chronologically-last entry); `docs/whats-next.md` §3 residual
  updated — the concurrency fix is marked shipped (not yet applied to staging/prod), the D-4
  wipe decision and format note are preserved unchanged.

**Deviations from the brief.** None of substance. The brief's literal SQL sketch
(`INSERT ... ON CONFLICT ... RETURNING next_seq`, `VALUES (p_year, ...)`) matches what
shipped once the "returned value == seq just issued" invariant is worked through: the
insert value must be the literal `1` (not a placeholder), and the seed must store the
LAST issued seq (not seq+1) — see the migration's own comment block for the worked-through
case analysis, since the brief's paraphrase left the seed's exact seeded value ambiguous.

**Noticed but NOT touched.**
- `invoices.number` already carries `unique not null` from the very first schema migration
  (`…000001_schema.sql`) — the brief's "add a UNIQUE index if none exists" step was a no-op;
  confirmed by grepping the migrations directory for any later drop/alter of that
  constraint (none found). No action needed, and no legacy-duplicate risk exists: the
  constraint has been live the whole time, so the DB is already structurally guaranteed
  duplicate-free regardless of what the two old generators raced into minting.
- `pushAll` (admin bulk-seed upsert) was left untouched per the brief — it doesn't call
  `next_invoice_number` and doesn't need to.
- Did not touch `docs/plans/2026-08-21-uat-round1-triage.md`'s own §3.1 reference — only
  `docs/whats-next.md` was in scope per the brief.

**Pre-push SQL for the controller (staging, then prod).** The unique constraint means this
should structurally always return zero rows, but worth confirming before relying on the
seed query's per-year `max(seq)` scan:
```sql
select number, count(*) from invoices group by number having count(*) > 1;
```
Sanity-check the seed will compute what's expected (compare against the admin invoice list):
```sql
select
  (regexp_match(number, '^UCG-([0-9]{4})-([0-9]+)$'))[1]::int as year,
  max((regexp_match(number, '^UCG-([0-9]{4})-([0-9]+)$'))[2]::int) as max_seq,
  count(*) as matching_rows
from invoices
where number ~ '^UCG-[0-9]{4}-[0-9]+$'
group by 1;
```
After push, confirm the seeded counter matches:
```sql
select * from invoice_number_counters order by year;
```

**Verification.** `npm run build` — succeeded (562ms, no errors). `npx eslint
src/lib/supabase.ts src/pages/Membership.tsx src/lib/invoice-number.ts
supabase/functions/_shared/fulfill.ts tests/lib/invoice-number.test.ts` — zero
errors/warnings. `npx vitest run` — 1147/1147 passed across 73 files (the +4 from this
ticket's `tests/lib/invoice-number.test.ts`, on top of the 1143/72 baseline this notes file
already recorded above).

No Deno test harness exists in this repo, so `_shared/fulfill.ts`'s RPC-call change has no
automated test — the SQL-level guarantee is the atomic single-statement claim itself
(reviewed line-by-line in the migration's own comments), not a test file.

## Z-04 (S1) + Z-04-02/03 + Nate's Z-04 note + D-5: refund requests per registration

**What changed.**
- New migration `supabase/migrations/20260821150000_refund_request_groups.sql`: adds
  `refund_requests.request_group_id text not null` (backfilled to each row's own `id`, then
  indexed) and `refund_requests.rejection_reason text`. No RLS changes — the table stays
  SELECT-only for clients; both columns are written only by the two edge functions.
- New pure function `allocateRegistrationRefund` (`src/lib/pricing.ts`, mirrored byte-for-byte
  in `supabase/functions/_shared/refund-allocation.ts`, a new file): given a registration's
  refundable lines (`{paymentId, refLineType, paidCents}[]`), groups by `paymentId`, drops any
  `'change'`-tagged line outright (rule 2), sums the rest per payment, and scales each payment's
  sum to 75% (rounded PER PAYMENT, not on the combined total) when `afterDeadline` (rule 4).
  Returns `{paymentId, cents}[]` — one entry per payment that has anything refundable.
- New pure function `decideAfterConflict(currentStatus, attempted) → 'silent'|'toast'`
  (`src/lib/pricing.ts`) for rule 7: a 409 "already reviewed" is silent when the request's
  current status already matches what the reviewer just attempted (two reviewers reached the
  same outcome), a toast otherwise (a genuine conflict).
- `supabase/functions/request-refund/index.ts` — full rewrite for `kind:'registration'`: enumerates
  every `invoice_items` row with `kind='meet-entry'` and `ref_line_type` distinct from `'change'`
  whose `ref_reg_ids` contains the reg id (across every invoice, not just the first resolved),
  resolves each to its invoice's succeeded (`status='paid'`) payment, and inserts one row per
  (payment, invoice_item) sharing one fresh `request_group_id` (`rg-<uuid>`). Zero refundable
  lines (including a host-club $0 entry with no invoice_item at all, or a registration with a
  payment still pending) → 400 "nothing to request a refund for" — see the deviation note below.
  `kind:'addon'` keeps its one-row shape (`request_group_id = id`) but now REFUSES the request
  outright (400) when `addonPurchaseOpen(addonLastPurchaseAt(event, lineType), event.reg_closes,
  now)` says the add-on's own order deadline has passed (rule 5 / UAT D-5) — reusing the exact
  `_shared/stripe.ts` helpers the purchase gate uses, so the two gates can't drift apart. One
  request/confirmation email per call (not per line), listing every refundable line + an
  estimated total + "Service fees are non-refundable." (rule 3).
- `supabase/functions/process-refund/index.ts` — full rewrite to operate on a whole
  `request_group_id` group instead of one row: **reject** is a single UPDATE of every pending row
  in the group to `rejected` with a REQUIRED `rejection_reason` (400 if blank) stored on every
  row and included in the (one) rejection email (rule 6). **Approve**: loads every pending row in
  the group, resolves each to its invoice_item + payment, builds the allocation lines (`paidCents`
  = the payment's `lines_snapshot` entry when present, else `invoice_items.amount` — unchanged
  fallback), computes `onTime` ONCE for the whole group from the event's `last_date_to_edit`
  (add-ons are always `onTime` here since a past-deadline one never reaches approval), calls
  `allocateRegistrationRefund`, then for each returned `{paymentId, cents}` — sequentially —
  calls `claim_refund_approval` **exactly once**, naming one pending row as that payment's
  "carrier" (any other pending row on the same payment, e.g. a second invoice_item in one
  invoice, is claimed alongside it with `refund_amount_cents:0` so the money is attributed to the
  carrier row only, keeping the cap-sum invariant intact). Only THEN calls Stripe for that
  payment; on a Stripe failure it reverts that payment's claim (carrier + zero siblings) back to
  `pending`, logs `error_logs`, and **continues to the next payment** — one payment's failure
  never blocks the others. The registration remove/blank (and `invoice_items.refunded=true`)
  only fires once EVERY payment in that approve call succeeded; a partial failure leaves the
  registration untouched and its still-pending rows retryable by a later approve on the same
  group (idempotent by construction — a retry's `pending` filter only ever contains
  not-yet-successful rows). Returns `{ok:true, refunded:[{paymentId,cents,stripeRefundId}],
  failed:[{paymentId,error}]}` instead of a single `refundAmountCents`.
- `src/lib/supabase.ts`: `requestRefund` now returns `{ok, groupId, error}` (no more
  `requestId`/single-item assumption); `processRefund(groupId, action, rejectionReason?)` now
  takes a group id + optional reason and returns `{ok, refunded, failed, error, status}` — added
  `status` (from the edge-function error's `context.status`) specifically so the client can tell
  a genuine 409 conflict apart from any other failure for rule 7.
- `src/lib/types.ts`: `RefundRequest` gained `requestGroupId: string` (required — defensively
  falls back to `id` in `rowToRefundRequest` if a stale select ever omits the column) and
  `rejectionReason?: string | null`.
- `src/components/RefundRequestDialog.tsx` — rewritten: prop `eventName: string` replaced with
  `event: Event` (all three call sites — `Club.tsx` ×2, `MyRegistrations.tsx` ×1 — already had
  the full `Event` object in scope, confirmed before changing). For each item, computes an
  ESTIMATE client-side from `db.invoices` (Tier-2 boot-scoped to self + managed-club rows, same
  data the old `RefundReview.tsx` already used for its own estimate) — registration items sum
  every non-`'change'` `meet-entry` line referencing the reg (mirrors the server enumeration);
  add-on items look up the single matching line and gate it through `addonConfig`/
  `addonPurchaseOpen` (`src/lib/pricing.ts`, the exact client-side mirror the purchase flow
  already uses). An add-on past its deadline is EXCLUDED from submission and shown struck-through
  with a "No refunds after the order deadline (date)" note (rule 5); the banner always states
  "Service fees are non-refundable." The submit loop is unchanged in shape (one `requestRefund`
  call per passed-in item) — each call is already a complete, correctly-grouped registration
  request server-side, so looping over MULTIPLE REGISTRATIONS (e.g. Club.tsx's multi-discipline
  batch refund) is still correct; nothing loops per invoice line client-side anymore (there never
  was such a loop for invoice lines specifically — the pre-existing loop was already one call per
  registration/add-on item, the bug was server-side only resolving the first payment).
- `src/pages/admin/league/RefundReview.tsx` — rewritten: groups `db.refundRequests` by
  `requestGroupId` (`groupRequests`, a pure local helper), renders ONE card per group (lines,
  payment count when >1, combined estimated total), and separates the reviewer confirmation into
  `ApproveDialog` (unchanged content, now group-aware) and a new `RejectDialog` with a REQUIRED
  textarea wired to `processRefund(groupId, 'reject', reason)`. On a 409 from either action, calls
  `syncFromSupabase()` then `decideAfterConflict` on the refreshed group status to decide
  silent-refetch vs. toast (rule 7). Approve's success toast now sums `res.refunded[].cents` and
  flags any `res.failed.length` for retry.
- `supabase/README.md`: new migration-table row; `docs/whats-next.md` §2 item 0 (Z-04) and §3
  item 4 (D-5) updated to "drafted, not yet applied/reviewed"; `docs/plans/2026-08-21-uat-round1-triage.md`'s
  four Z-04 rows updated from ❓/☐ to 🔧 drafted (Z-04-02 resolved as "no separate defect" per
  Q3's already-confirmed finding — Stripe's own fee reversal, not UCG's service fee).

**Deviations from the brief.**
- **Zero-refundable-lines now 400s instead of falling back to a "manual review" row.** The old
  code let a host-club $0 entry (or any registration whose invoice_item never resolved) through
  with `payment_id: null`, flagged "No traceable payment — manual" in the review queue so an
  admin could still approve it as a no-op record. The brief's literal rule ("If the reg has zero
  refundable paid lines → 400 with a clear message") removes that path: a $0 host-club
  registration cannot get a refund_requests row created for it AT ALL anymore, so a member/manager
  can no longer self-serve "please remove this $0 registration" through the refund flow — there is
  no money to refund, but the FLOW also can no longer record/action the removal. Implemented
  literally per the spec since it's an explicit numbered rule, not a suspected oversight, but
  flagging it clearly: **this is a real behavior change** worth Nate/Julia's attention before
  go-live if $0 host-club removals-via-refund-request are a workflow anyone actually uses today.
- **`claim_refund_approval` sibling-row handling.** The brief says "call it once per distinct
  payment" but doesn't explicitly cover a payment with MORE than one invoice_item in the group
  (e.g. an invoice with a separate entry line and a separate extra-discipline-fee line for the
  SAME registration, both in one payment). Chose to designate one row as the payment's "carrier"
  (claimed via the RPC, gets the full `refund_amount_cents`) and flip any sibling row to
  `approved`/`0` alongside it via a plain UPDATE, rather than either (a) re-entering the RPC per
  row (which would double-cap/double-claim against the same payment) or (b) splitting the
  refunded amount proportionally across sibling rows (adds rounding complexity for a case that
  may not occur in real data — a registration's entry + extra-discipline fee are priced as ONE
  combined line per `create-checkout-session`, not two separate invoice_items, in every path
  read during this task). Documented in both the migration comment and the function's inline
  comments so it doesn't read as an oversight later.
- **Partial-failure state semantics.** Not explicit in the brief. Chose: the registration
  remove/blank and the FULL `invoice_items.refunded=true` sweep happen only when every payment in
  THAT approve call succeeds; a partial failure marks only the succeeded payments' items refunded
  and leaves the registration + failed payments' rows untouched/pending for a retry. This matches
  the brief's "so a retry processes only what's still pending" line and keeps the registration
  never in a half-removed state.
- **`RefundReview.tsx`'s `Approve` button still opens a confirmation dialog** (showing the
  estimated amount + payment count) rather than firing immediately — the brief didn't ask to
  remove this, and an approve is exactly as irreversible as before grouping (registration
  deletion/blanking), so removing the confirmation would have been a regression, not a
  simplification.

**Noticed but NOT touched.**
- **A "mixed" M-10-01 line (added discipline + change fee combined, tagged `ref_line_type:
  'change'`) is now ENTIRELY excluded from refund eligibility**, including the added-discipline's
  entry-fee PORTION that's bundled into it — rule 2 says change-fee lines are never refundable,
  full stop, and the mixed line's `ref_line_type` is `'change'` (confirmed by grepping every
  `refLineType: 'change'` push site — M-10-01's notes above confirm the mixed case deliberately
  kept the plain `'change'` tag rather than a distinct label). This is a real, if narrow,
  consequence: an athlete who added a discipline to an already-paid registration (paying entry +
  change fee combined) cannot get ANY of that money back through the refund flow, not even the
  entry-fee portion. Whether that's the intended reading of rule 2 for the mixed case
  specifically is a judgment call for the requirements owner — flagging it rather than silently
  special-casing mixed lines to be "half refundable," which nothing in the confirmed rules asked
  for.
- **`PurchaseHistory.tsx`/`person-export.ts` now show one line per (payment, invoice_item) row**
  for a multi-payment registration refund instead of one summary row — each row is individually
  correct (it's a real distinct refund against a real distinct payment), but a member with a
  2-payment registration refund will see 2 entries where they might expect 1. Not changed because
  neither file was named in the brief's "grep and check" list produces anything beyond simple
  per-row rendering that still works correctly; grouping the DISPLAY there is a nice-to-have, not
  a correctness fix.
- **`reconciliation.ts`/`Finance.tsx` are UNCHANGED and correctly compatible** — both already key
  off individual `refund_requests` rows' own `payment_id`/`refund_amount_cents` (never assumed
  "one row per registration"), so grouping is transparent to them. Worth noting explicitly since
  they're money-adjacent: this is actually a QUALITY IMPROVEMENT for `reconciliation.ts` — before
  this change, a registration's SECOND payment never got a `refund_requests` row at all, so any
  Stripe-side refund against it would have shown as unexplained drift with no row to reconcile
  against; now every payment that funded a registration gets its own tracked row.
- **The `onTime` (75%) determination on a RETRIED approve call is recomputed fresh from
  `new Date()` at retry time**, same as the pre-grouping single-request code always did. If a
  Stripe failure leaves a payment `pending` and the retry happens after the event's
  `last_date_to_edit` has since passed (crossing the boundary between the original attempt and
  the retry), the retried payment gets scaled at 75% while payments that succeeded in the
  original call kept their on-time 100%. This is a pre-existing behavior (not introduced by
  grouping — the single-request code recomputed `onTime` fresh on every invocation too) and an
  edge case narrow enough (requires a Stripe outage spanning the exact edit-deadline instant)
  that it wasn't worth a design change here; flagging so it isn't rediscovered as new.

**Pre-push SQL for the controller (staging, then prod).** The backfill is a straight
`update ... where request_group_id is null`, so this is mostly a confidence check rather than a
required gate:
```sql
-- Should be zero both before and after — no row should ever be null.
select count(*) from refund_requests where request_group_id is null;
-- Every pre-existing row's group should equal its own id (1 row per group, matching the
-- pre-fix one-call-per-item flow).
select count(*) from refund_requests where request_group_id <> id;
```
After push, confirm the new columns exist and are queryable:
```sql
select id, request_group_id, rejection_reason from refund_requests limit 5;
```
Both edge functions (`request-refund`, `process-refund`) must be redeployed together — a stale
`process-refund` still expecting `{requestId, action}` will 400 the new `{groupId, action,
rejectionReason}` payload the redeployed client sends (it does still accept a bare `requestId`
and resolve its group, so a deploy-order mismatch degrades to "processes one row's group,"
not a hard failure — but redeploy both in the same window regardless).

**Verification.** `npm run build` — succeeded, zero TypeScript errors. `npx eslint
src/lib/pricing.ts src/lib/types.ts src/lib/supabase.ts src/components/RefundRequestDialog.tsx
src/pages/admin/league/RefundReview.tsx src/pages/Club.tsx src/pages/MyRegistrations.tsx
tests/pricing.test.ts tests/finance.test.ts supabase/functions/request-refund/index.ts
supabase/functions/process-refund/index.ts supabase/functions/_shared/refund-allocation.ts` —
zero errors/warnings. `npx vitest run` — 1159/1159 passed across 73 files (+12 from this
ticket: 7 `allocateRegistrationRefund` cases — single payment, two-payment split, change-line
exclusion at the shared-payment and payment-dropped levels, per-payment-independent 75%
rounding, single-payment-unchanged regression, empty input — and 5 `decideAfterConflict`
cases, both in `tests/pricing.test.ts`; on top of the 1147/73 baseline this notes file already
recorded above).

Both edge functions were re-read end-to-end against the four required invariants: (1)
**idempotency on retry** — a retry's `pending` filter only ever contains rows not yet
successfully processed, `claim_refund_approval`'s own `status='pending'` predicate is the
second line of defense, and already-approved/rejected rows from a prior call are structurally
excluded from every write path in a later call; (2) **no path refunds a change line** — enforced
twice (request-refund never inserts a row for a `ref_line_type:'change'` item; `allocateRegistrationRefund`
excludes one defensively even if it somehow got in); (3) **no path exceeds a payment's
subtotal** — every payment is claimed through `claim_refund_approval` exactly once per approve
call, sibling rows on the same payment always carry `0`, so the summed `refund_amount_cents`
for a payment can never exceed what the RPC's own lock-and-cap returned; (4) **75% applied
exactly once** — computed once per approve call as `onTime`, passed once into
`allocateRegistrationRefund`, which itself scales each payment's sum exactly once.

## UAT Z-02-01 (S1): no athlete charged twice for the same (event, discipline)

**What happened.** A league admin and a club manager registered the SAME athlete for the SAME
event at the same moment and both checked out — two invoices, two Stripe charges, two
`registrations` rows. Ids are minted client-side (`reg-<ms>-<athlete>-<disc>`,
`RegistrationEditor.tsx:585/618`), so the two sessions' rows never collided on id and nothing
noticed. No DB constraint prevented two live rows in the same slot; neither checkout nor
fulfillment checked for a paid sibling.

**Layered fix, four pieces:**

1. **Migration `20260822010000_registrations_live_slot_uniq.sql`** (NOT YET applied to staging
   or prod). A `do $$ … $$` block dedupes any existing violation FIRST (for every
   (event_id, athlete_id, discipline) held by >1 non-refunded row: keep the paid row, or the
   earliest-created if none/all paid; mark every other row in that slot `refunded=true,
   keep_listed=false, refund_requested=false`, `raise notice`-ing each slot and each row it
   touched) — then `create unique index if not exists registrations_live_slot_uniq on
   registrations (event_id, athlete_id, discipline) where refunded = false`. Deliberately NOT
   scoped to `club_id` (a cross-club duplicate is the same bug — the existing client-side
   `paidRegistrationClub` cross-club lock already treats this as a conflict) and deliberately
   NOT excluding waitlisted rows (a waitlisted registration is still a real claim on the slot).
   Both the dedupe and the index creation are idempotent on re-run.

   **Pre-push SQL for the controller (staging, then prod) — run BEFORE applying, to see what
   the dedupe will touch:**
   ```sql
   select event_id, athlete_id, discipline, count(*), array_agg(id) as reg_ids
   from registrations
   where refunded = false
   group by event_id, athlete_id, discipline
   having count(*) > 1;
   ```
   Expected: only the two known ZZTEST rows from this UAT run (Stripe test-mode money, no real
   refund needed), or nothing. After applying, the same query (with the `having` clause) should
   return zero rows on both projects, and the migration's `RAISE NOTICE` output (visible in the
   `supabase db push` output / dashboard logs) should list exactly what it touched — confirm it
   matches the pre-push query's contents before trusting the index creation succeeded silently.

2. **`create-checkout-session`** (`supabase/functions/create-checkout-session/index.ts:778-833`,
   in the `meet-entry` block, right after the existing "mixes different athletes or events"
   guard and before pricing): for every reg the line references, checks `allEventRegs` (already
   loaded for the whole request) for a live sibling at the same (event, athlete, discipline) —
   an already-**paid** sibling 409s immediately (`"<Name> is already registered for <discipline>
   at <event> — refresh the page and check the roster before checking out."`); an **unpaid**
   sibling additionally triggers a check for a `pending` payment referencing it created within
   the last `CART_HOLD_MINUTES` (30 min — mirrors the existing capacity soft-hold model), 409ing
   with a "someone else is checking this out right now" message if found. The pending check
   depends on `payments.ref_reg_ids` (line 1197 free path / line 1310 Stripe path) — this column
   existed in the schema but was **never populated** before this change (confirmed via
   `admin-delete-person/index.ts:267-272`, which already queries it with an `.ov.{}` overlap
   filter that has silently always matched nothing beyond `person_id` — populating it also fixes
   that dormant gap as a side effect, out of scope to otherwise touch here). `events` query
   widened to select `name` for the error message (`RegFeeEvent` itself, shared with the
   webhook, deliberately NOT widened — kept as a separate `eventNames` side map).

3. **`_shared/fulfill.ts`** (used by both `stripe-webhook` and the free-checkout path): right
   before flipping `paid` on `paidRegIds`, re-fetches each reg's current (event_id, athlete_id,
   discipline, refunded, paid) plus every other live reg at the same event(s), and re-runs the
   same `findPaidSibling` predicate. A reg with a paid sibling is excluded from the `paid` flip
   and handed to `handleDuplicateSlotRegistrations`, which is deliberately called from the
   **winner-only, once-only side-effects section** (same place as coupon redemption and the
   receipt email) — NOT immediately after detection — because the Stripe refund call inside it
   is not idempotent and must never run twice on a concurrent/retried delivery of the same
   payment. It:
   - Refunds the **full Stripe charge** (omitting `amount` so Stripe refunds exactly what it
     captured) when EVERY chargeable line on the payment was a "clean" duplicate line (every
     referenced reg in the line is a duplicate); refunds only the **duplicate line's
     `paid_cents`** (added a `paid_cents?` field to `SnapshotItem` — it was already being
     written into `lines_snapshot` by `create-checkout-session` but never declared/read on the
     fulfill side) when the payment also covered other, legitimate lines.
   - **Deliberate scope limit:** a line that MIXES a duplicate reg with a legitimate one in the
     SAME line (e.g. one line pricing two disciplines where only one collided) is NOT
     auto-refunded — `paid_cents` is frozen per LINE at checkout time, not per registration
     within a line, and `fulfill.ts` has no access to the pricing internals that priced each
     discipline. Logged to `error_logs` (`context: 'fulfill'`) for manual review instead of
     guessing a split. This is the one place the task's "say which you implemented and why"
     applies — implemented the clean full-line case (the realistic shape of this bug, one
     discipline registered twice), documented the mixed-line gap rather than half-solving it.
   - Marks the duplicate registration(s) `refunded=true, keep_listed=false,
     refund_requested=false` UNCONDITIONALLY (even if the Stripe call fails) — a slot-occupying
     duplicate must never stay `paid:true` regardless of the money side; a Stripe failure is
     logged to `error_logs` for manual follow-up instead.
   - Marks the invoice_item for a "clean" duplicate line `refunded:true` (so it doesn't show as
     a live charge and a later manual `request-refund` skips it) but **deliberately does NOT**
     mark a mixed line's invoice_item `refunded:true` — that item's `ref_reg_ids` also covers a
     legitimate registration, and `request-refund`'s lookup is `invoice_items.ref_reg_ids @>
     [regId]`, so marking the whole row refunded would falsely block a future legitimate refund
     request for the OTHER registration sharing that line.
   - Sends the payer "Your payment was refunded" instead of (whole-payment-duplicate) or
     alongside an amount-adjusted (mixed-payment) receipt — `emailReceipt` gained an optional
     `subtotalOverrideCents` param for the adjusted-receipt case.

   **Known residual gap (documented, not closed):** the duplicate-detection read (fetch sibling
   regs' current `paid` state) and the `paid`-flip write are two separate statements, not one
   atomic SQL operation. Two DIFFERENT payments fulfilling two pre-existing duplicate rows at
   the EXACT same instant could each read the other's row as not-yet-paid and both flip through
   — a narrow TOCTOU window the DB unique index does NOT close (the index guards row *creation*,
   not the `paid` flip). Closing this fully would need an atomic per-slot claim (mirroring
   `claim_refund_approval`'s row-lock idiom) rather than the read-then-write the task's own spec
   described; flagging as a possible follow-up rather than building a new locking RPC out of
   scope for this ticket.

4. **Client:** no code change needed. `CartCheckout.tsx`'s existing generic error branch
   (`r.error ?? 'Could not start checkout...'` → `onError?.(msg)`) already forwards ANY
   `{ok:false, error}` body verbatim, and both `Cart.tsx` call sites already wire `onError` to
   `toast(msg, {variant:'error'})` — the new 409 responses need no special `code` field to reach
   the user, so this flows through unchanged.

5. **Tests:** `findPaidSibling` extracted as a pure predicate in `src/lib/registration-status.ts`
   (camelCase, tested in `tests/lib/registration-status.test.ts` — 8 new cases: paid sibling,
   refunded sibling, same id, different discipline, different event, different athlete, unpaid
   sibling, legacy multi-row camp registration) mirrored snake_case in the new
   `supabase/functions/_shared/registration-status.ts` for both `create-checkout-session` and
   `_shared/fulfill.ts` to import.

**Functions to deploy:** `create-checkout-session`, `stripe-webhook` (unchanged itself, but
bundles `_shared/fulfill.ts` and `_shared/registration-status.ts`, both changed — Edge Functions
bundle `_shared/` automatically on deploy, so no separate step, just don't forget
`stripe-webhook` needs `--no-verify-jwt` re-confirmed per the usual trap).

**Verification.** `npm run build` — succeeded, zero TypeScript errors. `npx eslint
src/lib/registration-status.ts tests/lib/registration-status.test.ts
supabase/functions/create-checkout-session/index.ts supabase/functions/_shared/fulfill.ts
supabase/functions/_shared/registration-status.ts` — zero errors/warnings. `npx vitest run` —
1171/1171 passed across 73 files (+8 from this ticket, confirmed by diffing against the branch
tip before this change: 1163/73 baseline, 1171/73 after — all 8 new cases in
`tests/lib/registration-status.test.ts`'s new `findPaidSibling` describe block). Migration re-read for: dedupe runs
BEFORE index creation (yes — the `do $$` block precedes the `create unique index` statement in
the file), handles a slot with zero paid rows (yes — `order by paid desc, created_at asc, id
asc` degrades to earliest-created when nothing is paid), and is idempotent on re-run (yes — the
dedupe's `having count(*) > 1` finds nothing once every slot has ≤1 live row, and
`create unique index if not exists` no-ops once it exists).

## M-11-01 (S1) + M-11-02/M-20-01: coupon scope + persist/render the discount

**Task A — coupon scope.** Every non-membership line (pure change fee, the MIXED added-
discipline-plus-change line, and add-ons) was tagged coupon-scope `'meet-entry'` — the same tag
as a true new entry — so a promo scoped to "Event entries" silently discounted change fees and
add-ons along with real entries, and effectively discounted the whole cart on most carts (a cart
with only memberships was the one case it didn't).

- `CouponScope` (`supabase/functions/_shared/stripe.ts`, mirrored `src/lib/pricing.ts`) gained
  `'change-fee'` and `'addon'`. Retagged the three affected `pushLine` calls in
  `create-checkout-session/index.ts`: the pure-change branch → `'change-fee'`; the add-on branch
  → `'addon'`; the full-entry branch is unchanged (`'meet-entry'`, correctly).
- **The MIXED added-discipline+change-fee line** (`addedDisciplineChangeTotalDollars`) is also
  tagged `'change-fee'`, even though most of its dollar amount is really an added discipline's
  entry-total. Reasoning (confirmed with reviewer-tier before implementing): it can't be
  cleanly split into an eligible and an ineligible portion, the refund path already treats this
  exact line as `ref_line_type:'change'` — fully non-refundable, "flagged, not fixed" per
  money-invariants.md's Refunds section — and under-discounting (a 'meet-entry' coupon skips
  this line entirely) is the safe-direction error versus over-discounting a glued-on change fee.
  This branch is defense-in-depth only post the M-10 x Z-04 rework above — the client no longer
  produces a mixed line at all.
- Extracted the eligibility rule itself into a pure `couponEligibleLine(line, coupon)` —
  `_shared/stripe.ts` (server, used by the real filter in `create-checkout-session` at what was
  the inline block around old line ~980) mirrored in `src/lib/pricing.ts` (client). The client
  mirror is **not wired into any live call site** — confirmed (with reviewer-tier) that
  `applyCoupon` in `pricing.ts` is called nowhere outside `tests/pricing.test.ts`, and
  `CartCheckout.tsx`'s local `applyCoupon` click handler just round-trips a code to the server
  and renders its `mode:'preview'` response verbatim (`amountSubtotal`/`discountAmount`/
  `serviceFee` are all server numbers) — there is no client-side coupon recompute to fix. The
  mirror exists so the one eligibility rule has a tested implementation on both runtimes, ready
  to reuse if a client preview is ever built.
- Confirmed unchanged: the service fee is computed on the POST-discount subtotal
  (`processingFee(subtotalCents)` is called AFTER `subtotalCents -= discountCents`, near the end
  of the function, well below the coupon-application block).
- Tests: `tests/pricing.test.ts` new `couponEligibleLine` describe block — entry line eligible
  for a `'meet-entry'` coupon; change-fee/addon/membership lines not; `'any'` eligible for
  every scope; a `'membership'` coupon matches all three membership scopes and nothing else; a
  `appliesToEventId` mismatch is ineligible even for the right scope; a fine-grained membership
  coupon matches only its own exact scope.

**Task B — persist and render the discount.** `fulfillPayment` wrote `invoice_items` from each
line's `amount_cents` (pre-discount list price) and never wrote a discount row, even though
`payments.lines_snapshot` already carried post-discount `paid_cents` per line and
`invoices.coupon_code` was already persisted — so every renderer showed the full list-price
items summing to MORE than what the confirmation email said was actually charged.

- **`SnapshotItem.paid_cents` was already present** (added in an earlier pass tonight, before
  this task started) — nothing to add there; just confirmed it's there and used it.
- `_shared/fulfill.ts`: after the `invoice_items` upsert, if `Σ amount_cents − Σ (paid_cents ??
  amount_cents) > 0`, upsert one more row: deterministic id `ii-<paymentId>-discount`,
  `kind: 'discount'`, `label: 'Promo code <code>'` (or `'Discount'` with no code), `amount:
  -(discountCents/100)`, `refunded: false`, every `ref_*`/`addon_*` field null. Idempotent on a
  webhook retry like every other write in this function. The `?? amount_cents` fallback (not `??
  0`) matters: a legacy item reconstructed from live `cart_items` (the pre-2026-07-02
  no-snapshot fallback a few lines above, which has no discount info) must read as
  undiscounted, never as "100% off" — caught by reviewer-tier before writing the line.
- `emailReceipt` (same file): computed `discountCents` the same way but scoped to the `items`
  param actually being emailed (which is already duplicate-slot-filtered in the UAT Z-02 case —
  reused the same shape rather than re-deriving `payment.amount_subtotal`, so it stays correct
  under `subtotalOverrideCents` too) and rendered it as a negative row, styled `#184b56`
  (`--teal-900`, brand-approved as text on white per `src/index.css`'s comment), placed BEFORE
  the service-fee row so items − discount + fee = the existing "Total paid" row.
- **The three in-app renderers needed NO changes** — `invoiceSubtotal`/`invoiceDiscount`/
  `invoiceTotal` (`src/lib/receipt.ts`) and the inline subtotal/discount/total blocks in
  `Cart.tsx` (~640-663) and `PurchaseHistory.tsx` (~178-204) already had correct `kind ===
  'discount'` handling; it was simply dead code because no discount row was ever written. Once
  `fulfillPayment` writes the row, all three "wake up" already-correct. Verified by hand-tracing
  the arithmetic (Cart.tsx/PurchaseHistory.tsx: `subtotal` = non-discount items incl. fee,
  `total = subtotal - discount`) and by the new `tests/receipt.test.ts`.
- `src/lib/finance.ts`: **no double-count risk found, so no change.** `buildFinanceTxns` prefers
  `payments.linesSnapshot` (`paidCents`, already post-discount PER LINE) whenever present, which
  is true for every payment new enough to ever carry a coupon — that path never touches
  `invoice_items` at all, so the new discount row can't double-subtract there. The fallback path
  (very old pre-snapshot payments, `invoice.items` summed directly) already had `'discount'`
  wired end-to-end before this task (`itemKeyFor('discount', …) → 'discount'`, already in
  `KNOWN_ITEM_KEYS`/`ITEM_KEY_LABELS`, already asserted in `tests/finance.test.ts`) — it just had
  no discount rows to sum yet. Added a `buildFinanceTxns`/`buildFinanceSummary` test proving that
  path nets a discount row into `grossCents` correctly rather than inflating it.
- **Flagged, not fixed** (per reviewer-tier — out of this task's scope, a product question for
  Julia): the discount `invoice_item` has `ref_event_id: null` (a coupon can span multiple
  events + memberships in one cart, so it has no single honest event to attribute to). This means
  an EVENT-SCOPED Finance summary (`buildFinanceSummary({ eventId })`) filters the discount line
  out entirely (it only keeps lines whose own `refEventId` matches), so `hostPayoutOwedCents`
  for that event shows the full undiscounted entry-fee gross — consistent with the existing
  "host payout is gross before fees, refunds not deducted" policy Julia confirmed 2026-07-17, but
  worth her explicit confirmation now that a real discount mechanism exists (before this fix, no
  coupon discount was ever visible anywhere, so this gap was theoretical).
- Confirmed `request-refund` never enumerates a `'discount'` item: its registration-kind query
  filters `kind === 'meet-entry' && ref_line_type !== 'change'` (`index.ts:303`) and its addon-kind
  query requires `kind === 'addon'` (`index.ts:174`) — a `'discount'` row matches neither, and the
  function's own header comment (`index.ts:74-76`) documents `'discount'` as explicitly excluded.
- Tests: new `tests/receipt.test.ts` (file didn't exist before) — `invoiceSubtotal`/
  `invoiceDiscount`/`invoiceTotal` with no discount row, with one, with a refunded (non-discount)
  line, with a REFUNDED discount line (must not count), and with multiple discount-eligible
  lines summed. New `tests/finance.test.ts` case (above). All-positive discounts only — a
  discount that somehow exceeded `amount_cents` (shouldn't happen; `create-checkout-session`
  already caps `discountCents` at `eligibleCents`) isn't separately guarded here since it'd
  require a pre-existing pricing bug upstream, not something this task's write path can cause.

**Functions to deploy:** `create-checkout-session` (Task A retagging + `couponEligibleLine`) and
`stripe-webhook` (bundles the changed `_shared/fulfill.ts`; `_shared/stripe.ts`'s new exports are
also bundled into both). No migration — `invoice_item_kind` already had `'discount'` in its enum
(`20260601000001_schema.sql`), and `CouponScope` is an in-memory-only concept, never persisted.

**Verification.** `npm run build` — succeeded, zero TypeScript errors. `npx eslint
supabase/functions/create-checkout-session/index.ts supabase/functions/_shared/stripe.ts
supabase/functions/_shared/fulfill.ts src/lib/pricing.ts src/lib/receipt.ts tests/pricing.test.ts
tests/finance.test.ts tests/receipt.test.ts` — zero errors/warnings. `npx vitest run` —
1185/1185 passed across 74 files (+14 from this ticket: 8 new `couponEligibleLine` cases in
`tests/pricing.test.ts`, 1 new discount-netting case in `tests/finance.test.ts`, 5 new cases in
the new `tests/receipt.test.ts`).

## M-12-01 x M-12-02 (2026-08-22): explicit confirm for $0 orders + registration-cache refresh after fulfillment

**M-12-01 — no client way to safely "peek" at a $0 total.** `create-checkout-session`'s real
(non-preview) mode fulfills a coupon-covered $0 order immediately and unconditionally the moment
it's called — there is no separate "authorize" step to gate. `CartCheckout.tsx` used to call the
real endpoint straight from its mount effect, so a 100%-coupon cart completed with no
confirmation at all. Fix: `startPreview()` now always runs `mode: 'preview'` first (a genuinely
write-free call — no payments row, no coupon reservation, per the "PREVIEW BRANCH POINT" in
money-invariants.md) and only creates the real session once the preview total is confirmed
non-zero. A $0 preview instead lands on a new `confirm-free` stage — the same Subtotal/Coupon/
Service-fee-$0/Total breakdown, plus a primary "Confirm — no charge" button (disabled while
`submitting`) that's the ONLY thing allowed to call the real endpoint for a $0 cart. Coupon-apply
(`applyCoupon`) now routes through `startPreview` too, not straight to the real endpoint — this
closes a second instance of the same bug: applying a 100%-off code from the *already-mounted*
Stripe form used to hit the identical no-confirm auto-fulfill path.

New pure helper `checkoutMode(previewTotalCents): 'free-confirm' | 'stripe'` (`src/lib/pricing.ts`,
mirrors the server's own `subtotalCents === 0` free-order gate) — tested in
`tests/lib/checkout-mode.test.ts`.

**Preview mode can 409/400 too — parser had to move.** Capacity/session-required/session-survey-
required checks all run identically whether `isPreview` or not (only the capacity hold-refresh
WRITE is skipped in preview) — confirmed by reading `create-checkout-session/index.ts` directly.
`previewCartTotal` previously discarded these into a flat `{ok:false, error}` string (fine for
its original Cart-page "Estimated pricing" use, which treats any preview failure the same way).
Now that `CartCheckout.tsx` gates real checkout attempts behind preview, it needs the SAME
structured branching `createCheckoutSession`'s caller already had — extracted the shared parsing
into `parseCheckoutSessionError()` (`src/lib/supabase.ts`) used by both invokers, and added the
three optional error fields to `previewCartTotal`'s return type. The Cart page's existing preview
call site is unaffected (still just checks `ok`).

**M-12-02 — root cause was NOT free-path-specific.** Read through `onPaid` (`Cart.tsx`) →
`syncFromSupabase()` → `loadAll()`: registrations were moved off `loadAll`'s global hydration
onto the slice layer (Phase 3, data-layer.md) and `syncFromSupabase()` never refetches them.
`registrations-slice.ts`'s "mine" tier (`ensureMyRegistrationsLoaded`) only fetches once per
`personId` and has NO invalidate path — a payment's server-side `paid` flip, learned about only
via `CartCheckout`'s/`StripeCheckout`'s own polling (never through `writeRegistration`'s
optimistic local upsert), was therefore invisible until something changed `personId`, i.e. a
full page reload (which resets the module-level cache variables). **This gap is identical for
the Stripe path** — `StripeCheckout.tsx` is embedded (`ui_mode: 'embedded'`, no redirect/reload
on completion) and calls the exact same `onPaid` as the free path. UAT just happened to hit it
via the free flow, likely because the paid flow used in this round was memberships (not sliced)
rather than event entries. Fix applied to the ONE shared `onPaid` (`CartScope` in `Cart.tsx`) so
both paths benefit: added `invalidateMyRegistrations()` / `invalidateClubRegistrations(clubId)` /
`invalidateEventRegistrations(eventId)` exports to `registrations-slice.ts` (force-refetch,
bypassing the same-person no-op guard) and call the scope-appropriate one plus one per distinct
event referenced by the just-paid items' `refRegIds`, before/alongside the existing
`syncFromSupabase()` (which still legitimately covers invoices/carts — those stayed in
`loadAll`).

**Not touched:** `MembershipsCheckoutInner`'s `onPaid` (`Cart.tsx`) — membership-only checkout
never references registrations, so no invalidation needed there.

**Scope note for the controller:** this diff touches `src/components/CartCheckout.tsx`,
`src/pages/Cart.tsx`, and `src/lib/pricing.ts`, all in `money-invariants.md`'s path list, plus
`src/lib/supabase.ts` (the `create-checkout-session`/`previewCartTotal` client wrapper, not
itself listed but part of the same contract). Per CLAUDE.md's money/auth/RLS rule, this needs a
reviewer-tier adversarial read before merge to `main` — not done as part of this task (scoped to
implement + verify + commit on `fix/uat-round1`).

**Verification.** `npm run build` — succeeded (tsc -b + vite build), zero TypeScript errors, PWA
precache + dev-auth firewall check both clean. `npx eslint src/components/CartCheckout.tsx
src/pages/Cart.tsx src/lib/pricing.ts src/lib/supabase.ts src/lib/registrations-slice.ts
tests/lib/checkout-mode.test.ts` — zero errors/warnings. `npx vitest run` — 1188/1188 passed
across 75 files (+3 new `checkoutMode` cases in `tests/lib/checkout-mode.test.ts`; no regressions
in the existing `tests/components/registrations-slice.test.tsx` (11 tests, still pass) or
`tests/lib/cart-removal-classify.test.ts`/`cart-section-count.test.ts`). No Browser-pane
verification — `ucg-dev` wasn't driven headlessly for this task per the brief; the embedded-
Stripe/free-order flow, coupon interaction, and slice-cache invalidation were verified by reading
the exact call chains (`create-checkout-session/index.ts`'s preview branch point,
`slice-cache.ts`'s `invalidate`, `registrations-slice.ts`'s "mine" tier) rather than by clicking
through the app — flagged for a manual click-through pass (100%-coupon checkout, confirm button,
then check MyRegistrations/Club roster update without a reload) before this ships live.

## Z-06-01 (2026-08-22): compare-and-set score posting (Task A) + portrait-safe judge entry row (Task B)

**Task A — no silent score overwrite.** Two judges (one signed in, one anonymous via the
judge-access unlock) posting different scores for the same athlete/apparatus seconds apart used
to blindly overwrite each other: both write paths upsert the SAME deterministic `scores.id`
(`${eventId}|${regId}|${apparatus}`) with no version check at all.

**Migration** `20260822020000_score_compare_and_set.sql` (drafted on `fix/uat-round1`, **NOT YET
applied to staging or prod** — no `supabase` CLI commands were run per this task's brief). Adds
`scores.updated_at timestamptz not null default now()` (backfilled from `entered_at`, stamped on
every UPDATE by a new `scores_set_updated_at` BEFORE UPDATE trigger — deliberately BEFORE UPDATE
only, not BEFORE INSERT, so it doesn't hit the upsert-trigger trap in `supabase-migrations.md`:
Postgres only fires the trigger for the row actually being updated, not the attempted-then-
conflicting insert) and RPC `post_score(p_score jsonb, p_expected_updated_at timestamptz)` —
`SECURITY INVOKER`, not DEFINER, since it authorizes nothing itself: the two pre-existing write
policies (`scores_write`, role-gated; `event_host_scores_write`, `is_event_host(event_id)` from
`20260710020303_host_post_close_edit.sql` — this is what actually lets a host-club manager or
event-admin grantee score their own event, not `scores_write`) keep applying to a signed-in
caller exactly as they did for the old direct upsert. `judge-entry`'s service-role client bypasses
RLS at the ROLE level (service_role has BYPASSRLS) regardless of the function's own security mode,
so the anonymous path is unaffected by INVOKER vs DEFINER. `SELECT … FOR UPDATE` row-locks the
existing row (serializes two truly concurrent posts instead of racing); found-and-mismatched (or
found-with-`p_expected_updated_at IS NULL`, deliberately — "a row exists but I expected none" is
exactly the two-judges case) returns `{ok:false, conflict:true, current:<row>}` **without
writing**; otherwise upserts and returns `{ok:true, current:<row>}`. Execute revoked from
`public`/`anon`, granted to `authenticated`/`service_role`. Pre-push check once applied: confirm
`select proacl from pg_proc where proname = 'post_score'` shows no `anon`/PUBLIC grant on either
project, and that a quick `select post_score('{"id":"nonexistent"}'::jsonb, null)` as the
service role returns `{"ok":true,...}` while the SAME call over PostgREST as an anon key 403s.

**Client (signed-in path).** `pushScore` (`src/lib/supabase.ts`) is no longer a fire-and-forget
`remoteUpsert` — it's now `async (score, expectedUpdatedAt) => Promise<PostScoreResult>` calling
`supabase.rpc('post_score', …)` directly (bypassing the write-queue entirely, since a
compare-and-set result has to reach the caller synchronously, not get swallowed into a retry
queue). `writeScore` (`scores-slice.ts`) changed from a sync `boolean` return to
`Promise<WriteScoreResult>` (`{ok:true,current} | {ok:false,reason:'offline'|'conflict'|'error', …}`)
— its two call sites (`Judge.tsx`, `ScoreDetail.tsx`'s admin adjustment) both had to become
`await`-aware. `Score.updatedAt` is a new optional field, read-only (never in `scoreToRow`'s push
mapping — it's entirely server-controlled); `rowToScore` maps it via a type-assertion cast
identical to the existing `deductions2`/`e_score2` precedent, since **`database.types.ts` is
already stale for those two columns** (never regenerated after `20260719130000` added them — this
task didn't fix that pre-existing drift, just followed its established pattern one column
further; `post_score` itself WAS added to the `Functions` section since `.rpc()` call sites
elsewhere in this file do have entries there).

**Client (anonymous / judge-entry path) — advisor caught a real defect before commit: the
conflict never would have reached the phone UI.** `judge-entry`'s `submit` op returns the
conflict as an HTTP 409. supabase-js v2 routes ANY non-2xx `functions.invoke` response into
`error` with `data: null` — that's the entire reason `edgeErrorMessage(error)` exists
(`edge-functions.md`). My first draft of `judgeSubmitScore` checked `if (error) return {ok:false,
error: await edgeErrorMessage(error)}`, which discards the structured `{conflict, current}` body
entirely — `Judge.tsx`'s `if (res.conflict)` would always read `undefined` and fall through to
the generic "Could not post the score" toast, with NO Replace option, on every single anonymous
conflict. The signed-in path was fine (`.rpc()` returns 200 with the jsonb `{ok:false,...}` body,
so `data.ok === false` reads correctly inline) — this was a silent asymmetry between the two
paths despite the task explicitly asking for "the same `{conflict, current}` shape". **Fix:**
followed the codebase's own established pattern for structured non-2xx edge-function rejections
— `edgeErrorBody(error)` (already used by `parseCheckoutSessionError` for
`create-checkout-session`'s `capacity-exceeded`/`session-required`), which digs the JSON body out
of `error.context`. `judgeSubmitScore` now does `const {message, body} = await
edgeErrorBody(error); if (body?.conflict) return {ok:false, conflict:true, current:
body.current, error: message}`. Also added a human-readable `error` string to the edge
function's 409 body (the first draft had none, so even the fallback toast would have printed
nothing). Considered switching the conflict response to HTTP 200 with `ok:false` instead
(simpler client code) but kept 409 to match the rest of this function's (and
`create-checkout-session`'s) existing status-code conventions rather than introducing a second
shape.

`Judge.tsx`: `expectedUpdatedAt` state (set from `scoreFor(reg.id)?.updatedAt` in `openScoring`,
cleared in `close`) plus a `conflict` state driving a `Modal` (not `window.confirm`, per the ui
rule) with Replace/Keep-existing buttons — "A score of X is already posted for <athlete> on
<apparatus> — replace it with Y?". The submit logic was refactored from one `submit()` into
`postCurrent(expected)` (does the actual post/RPC call, opens the conflict dialog without closing
the entry panel on a conflict) + `submit = () => postCurrent(expectedUpdatedAt)` +
`replaceConflict` (re-posts the SAME judge-entered values with `expected =
conflict.current.updatedAt`) + `keepExisting` (`applyLocalScoreUpdate(conflict.current)` — shows
the winning row immediately rather than waiting on realtime — then closes the panel). Dismissing
the Modal any other way (✕/veil/Escape) is wired to `onClose={keepExisting}`, since there's no
"in-progress input" for `Modal`'s own dirty-check to protect (the modal has no form fields) — any
dismissal is treated as accepting the existing score.

`judge-entry-core.ts`: `JudgeSubmitPayload.expectedUpdatedAt?: unknown` (validated as a string ≤
64 chars or nullish — NOT parsed as a real timestamp; the RPC does the actual compare against the
DB row under a row lock, so this is shape validation only) threaded through to
`ValidatedJudgeScore.expectedUpdatedAt: string | null`. `judge-entry/index.ts`'s `submit` branch
now calls `post_score` via the service-role client instead of a bare `.upsert()`, mapping the
RPC's jsonb `current` back to the client's camelCase `Score` shape via a new local
`dbRowToClientScore` (mirrors `rowToScore`, duplicated rather than shared since this Edge
Function has no access to browser-side `src/lib` modules).

**Pure extraction + test:** `src/lib/scores-core.ts`'s `shouldConflict(existingUpdatedAt,
expectedUpdatedAt)` mirrors the SQL predicate for unit-testing the invariant without a database —
it is NOT a second enforcement point (the DB's row-locked check is the only place that's actually
race-safe under concurrency; this is documentation-and-tests only). `tests/scores-core.test.ts`,
4 cases matching the task's four scenarios exactly.

**Not touched / flagged, not fixed:**
- The one-time demo→Supabase bulk-seed tool (`pushAll`'s `Scores` step, `supabase.ts` ~line 3237)
  still does a plain `.upsert()` with no CAS — confirmed via `grep -rn "from('scores')"` across
  `src`+`supabase/functions` that this and the read-only `fetchScoreByIdRemote` are the ONLY other
  `scores` table touchpoints; no other writer bypasses the new compare-and-set path. Left as-is
  since a one-time admin bulk import has no concurrent-writer concern (and the trigger stamps
  `updated_at` for it regardless).
- `SELECT … FOR UPDATE` inside `post_score` is itself subject to the UPDATE policies' USING
  clauses (not just `public_read`'s permissive SELECT) — an authenticated caller with neither
  `scores_write` nor `event_host_scores_write` reach sees `FOUND = false` (RLS hides the row from
  their lock attempt) and falls into the INSERT branch, which then fails with a plain RLS error
  rather than a `conflict` response. Net authorization outcome is identical to the old direct
  upsert (still rejected), but worth a reviewer's eye since it means "no access" and "no existing
  row" are indistinguishable from inside this function for an unauthorized caller.
- `ScoreDetail.tsx`'s admin-adjustment path now ALSO goes through the same compare-and-set (using
  the loaded `score.updatedAt` as its expectation) as a side effect of `writeScore`'s signature
  change, but has no Replace/Keep dialog — a conflict there just toasts "reload the page and try
  again". The task scoped the dialog UX to the live judge-entry race specifically; this page's
  conflict case (an admin adjusting a score while a judge or another admin tab touches the same
  row) is rarer and lower-stakes, so a plain error was judged sufficient rather than building a
  second dialog.

**Task B — portrait phone score-entry row (Nate, S3).** The roster table's action button (Score/
Edit) sat off the right edge in portrait with no way to reach it. Root cause: the wrapping
`<div className="card" style={{overflow:'hidden'}}>` was CLIPPING the overflowing table instead
of scrolling it. Fix: inserted a `<div className="judge-roster-wrap">` (new CSS,
`overflow-x: auto`, matching the existing `.events-table-wrap`/`.reg-grid-wrap` pattern) between
the card and the `<table>`. No `gridTemplateColumns` inline style involved (this is a plain
`<table>`, not a CSS grid), so the "never set gridTemplateColumns inline" rule doesn't apply here.

**Verification caveat the controller should know before running `responsive-sweep`:** a plain
`scrollWidth ≤ clientWidth` check on the outer card would have passed BEFORE this fix too — the
card's own `overflow:hidden` was already suppressing the page-level overflow signal that sweep
usually catches (it hides the excess rather than showing it as scrollable width), which is
exactly why this bug shipped unnoticed. The sweep at 375px needs to specifically confirm the
Score/Edit button in the roster table's last column is reachable and tappable (scroll the
`.judge-roster-wrap` container horizontally, or confirm the button is within the initial
viewport at typical name/club-name lengths) — not just check for absent page-level horizontal
scroll.

**Functions to deploy:** `judge-entry` (new `expectedUpdatedAt` handling + `post_score` RPC call
— requires the migration applied FIRST, since the function will error on every submit if
`post_score` doesn't exist yet). No other functions touched.

**Verification.** `npm run build` — succeeded, zero TypeScript errors, PWA precache + dev-auth
firewall check both clean. `npx eslint src/pages/Judge.tsx src/pages/ScoreDetail.tsx
src/lib/scores-slice.ts src/lib/supabase.ts src/lib/types.ts src/lib/scores-core.ts
src/lib/database.types.ts supabase/functions/judge-entry/index.ts
supabase/functions/_shared/judge-entry-core.ts tests/scores-core.test.ts
tests/judge-entry-core.test.ts` — zero errors/warnings. `npx vitest run` — 1196/1196 passed across
76 files (+8 from this ticket: 4 new `shouldConflict` cases in `tests/scores-core.test.ts`, 4 new
`expectedUpdatedAt` validation cases in `tests/judge-entry-core.test.ts`). No Browser-pane
verification for Task B (controller-only per the brief, see the caveat above) or for Task A's
live conflict flow (the SQL is never executed by `npm run build`/eslint/vitest at all — the
migration is drafted and unapplied, so the RPC itself, and the anonymous 409→`edgeErrorBody`
round-trip, are unverified against a real database; both were re-read line-by-line after the
advisor's review instead).

## Z-06-01 (Nate, results, S1, 2026-08-22): stable event_session ids + Results Unassigned fallback

**Symptom.** Public Results said "1 score is posted but not assigned to a session" while the
host dashboard showed that athlete assigned to a real session. Framed in the triage doc as
"looks like a relapse/variant of the 2026-07-31 fix" — it is, but via a different mechanism than
that fix addressed.

**Root cause, fully verified (not inferred).** `pushEvent`/`pushEventSessions`
(`src/lib/supabase.ts`) wrote `event_sessions` via `remoteReplace` — a client-side DELETE of
every session row for the event, followed by re-INSERTing the current list. Schema:
`registrations.session_id references event_sessions(id) on delete set null` (same for
`scores.session_id`). Postgres fires that FK action on the DELETE statement itself, regardless
of what a later INSERT in the same op does — so reinserting a session with the IDENTICAL id
right afterward does **not** undo the null it already wrote to every referencing row. That means
**every** sessions-editor save nulled every registration's session, not just ones that changed
session count/order — a pure rename or cap-value edit triggered it too. The client's own
optimistic `db.events` state still showed the pre-edit session assignment (only a registrations
slice refetch would reveal the DB's now-null value), which is why the host dashboard looked
right while the public page — reading the registrations slice — saw a `sessionId` that resolved
to nothing.

Independently, and compounding it: `EventWizard.tsx`'s session-editor save minted each session's
id from `editEvent?.sessions[i]?.id ?? \`${eventId}-s${i+1}\`` — matching the ORIGINAL event's
session by the draft's CURRENT array index, not by identity. Reordering, inserting a session
before an existing one, or removing one from the middle reassigns ids across the remaining
sessions (and, worse, can silently attach one session's squads/athlete placements to a
DIFFERENT session that happens to now sit at the same index) — a second, independent way to
sever the id a registration was already pointing at.

**Fix, three layers (task brief's own framing, all implemented as specified):**

1. **Stable ids end-to-end.**
   - `SessionDraft` (`EventWizard.tsx`) gained an optional `id?: string`. `sessionsTodrafts`
     now takes an explicit `keepIds` flag (= `isEdit`) rather than always carrying the source
     session's id over: a real EDIT keeps every id verbatim, but a CREATE seeded from a
     `template` (FlipFest/Nationals) strips ids even if `seedEvt.sessions` were ever populated
     with them. Neither existing template does that today — `flipfestTemplate` is a camp (always
     session-less) and `nationalsTemplate` has no `sessions` field at all, so this branch is
     currently unreachable in practice — but it closes a real hazard rather than an incidental
     one: `event_sessions.id` is the table's PRIMARY KEY, so a template id that happened to
     match some OTHER existing event's session would `remoteUpsert` right onto that event's row,
     silently stealing/rewriting its `event_id`. A brand-new draft (default-session template,
     "+ Add session" button, a discipline just toggled on) always has no `id`.
   - Id assignment at save time is extracted to a pure, unit-tested
     `assignSessionIds(eventId, draftIds, previousIds)` (`events-core.ts`, next to
     `diffSessions`) rather than an inline closure: an existing draft's id is reused as-is; a
     fresh one is minted only for `undefined` slots. `previousIds` (`editEvent.sessions`' ids —
     NOT just the surviving drafts) seeds the collision set specifically so a mint can't recycle
     the id of a session removed in this same save — remove session s2 and add one new session
     in the same edit, and without this the mint would happily hand the new session id `s2` right
     back, which `diffSessions` would then read as "unchanged" and UPSERT-in-place instead of
     deleting, silently re-attaching anything still pointing at the old s2 to a session it never
     competed in. (Caught by the reviewer-tier pass, not the initial implementation — see the
     dedicated test below.) Squads are now looked up by matching a session's assigned id against
     `editEvent.sessions`, not by array position — the same reorder bug applied to squad/athlete
     placement, not just the session id.
   - `pushEvent`'s edit-mode caller in `finishSave` now passes `editEvent?.sessions ?? []` as an
     explicit "previous sessions" snapshot (captured in the closure before `mutate()` reassigns
     the in-place `db.events[idx]`) — needed so the write path below can tell "unchanged" from
     "removed."
2. **Upsert + prune instead of replace.** Extracted `diffSessions(existing, next) => { upsert,
   deleteIds }` as a pure function in `src/lib/events-core.ts` (existing home for pure
   event-logic, already used by `EventWizard.tsx`/`supabase.ts`). `pushEvent`/`pushEventSessions`
   both now call a shared `pushEventSessionRows(m, previousSessions)` that upserts every session
   in `m.sessions` and DELETEs only the ids `diffSessions` says are gone — an untouched session's
   row is never DELETEd at the DB level, so `on delete set null` can never fire for it.
   `previousSessions` defaults to `m.sessions` itself for every OTHER `pushEvent` caller
   (`NationalsConfigEditor`, three call sites in `Events.tsx`, `Sanction.tsx`, and
   `pushEventSessions`'s own callers in `SquadBuilder`) — none of those ever add/remove a
   session, so that default makes the diff a no-op (upsert everything, delete nothing) without
   any of those call sites needing to know this function exists. Squads themselves are left on
   `remoteReplace` (unchanged) — `applyDefault`/`copyToOthers` intentionally rebuild a session's
   whole squad set from scratch every time, so a full replace there is correct, not a bug; only
   `event_sessions` had the "reinserting the same id doesn't undo the delete's FK action" trap.
3. **Editor-side guard + Results-side defense in depth.**
   - `EventWizard.tsx` now reads `useEventRegistrations(editEvent?.id)` and blocks removing a
     session (the per-session "Remove" button, and `toggleDiscipline`'s whole-discipline
     removal) when it still has live (non-refunded) registrations — toasts "N athletes are
     registered for this session — move them first" instead of silently deleting (which, via the
     FK, would have nulled those registrations' sessions). Also guards on `isEdit &&
     wizardRegsStatus !== 'ready'` (loading, per the data-layer rule against treating "loading"
     as "empty") — the `isEdit` half of that condition matters on its own: on a brand-new event
     `useEventRegistrations(undefined)` never fetches, so its status sits at `'loading'` forever,
     and without the `isEdit` guard Remove would be permanently blocked on every CREATE. (Also
     caught in review — the `!draft.id` early-return above it happens to make this unreachable
     today given `keepIds`/`isEdit` above, but the explicit guard doesn't depend on that staying
     true.)
   - `src/lib/scoring.ts`: `resolveRegSessionId(reg, scoresForReg, validSessionIds)` — the
     registration's own `sessionId` wins IF it still names a session in the event's CURRENT
     `sessions` array; otherwise falls back to any of that registration's own scores whose
     `sessionId` still names a real one; otherwise `null`. `sessionResults` accepts a new
     sentinel `UNASSIGNED_SESSION_ID` for `sessionId` and, when passed, returns exactly the
     registrations/scores that resolve to `null` (and have at least one score — an unassigned
     reg with zero scores has nothing to show). `unplacedScoreCount` gained a required third
     parameter (`sessionIds: string[]`, the event's current session ids) and now uses the same
     resolution instead of a bare `!!r.sessionId` truthiness check — the truthiness check is
     exactly what let this bug hide silently: a registration whose `sessionId` pointed at a
     deleted session still read as "placed" under the old check.
   - `Results.tsx`: the session `<select>` gets one more `<option>`, always last, labeled
     "Unassigned (N)", offered only when `unplaced > 0`; selecting it renders the same
     level-grouped table using `sessionResults(event, UNASSIGNED_SESSION_ID, …)`, with the
     existing `unplacedMsg(n)` copy shown as a caption directly under the selector instead of
     only appearing inside an empty-state placeholder. `apparatusRankings`/`teamScores`/`events`
     (apparatus list) now read `computed.discipline` rather than `session.discipline` throughout,
     since there's no single fixed session object for the Unassigned pseudo-tab — best-effort
     (whichever discipline the first resolved row has), which is acceptable for what is
     fundamentally a rare data-recovery view, not a normal results tab. `isUnassignedView` is
     gated on `unplaced > 0`, not just `sessionId === UNASSIGNED_SESSION_ID` — if the count drops
     to 0 while that tab is still selected (its `<option>` vanishes but React state doesn't reset
     itself), the view silently falls back to a real session instead of re-printing "0 scores are
     posted but not assigned," which would have been the exact false statement the 2026-07-31 fix
     exists to prevent. (Also caught in review.)

**Deliberately not changed (flagged, not fixed):**
- `squads.session_id references event_sessions(id) on delete cascade` — deleting a session
  cascades to delete its squads, which in turn nulls
  `registrations.squad_id` (also `on delete set null`). This is the SAME class of bug as the one
  just fixed, but for squad/holding-squad placement rather than session assignment, and it fires
  on `pushEvent`'s existing `remoteReplace('squads', …)` call for EVERY session on EVERY
  `pushEvent`, even ones that never touch that event's sessions or squads (e.g. toggling event
  status, editing `nationalsConfig`) — because that replace reinserts the identical squad ids
  every time. Out of scope for this ticket (Results/scoring never key off `squad_id`, so it
  doesn't affect score visibility), but worth a follow-up: the same `diffSessions`-style
  upsert+prune idiom would fix it, scoped per-session instead of per-event.
- Did not add a migration or touch RLS — `on delete set null` on both FKs already exists and is
  the correct behavior for a genuine removal; the fix is entirely about not triggering it
  spuriously, plus rendering honestly when it (or historical bad data) has already happened.
- The `sessionsTodrafts(sessions, keepIds)` template-id hazard above (a future template that
  populated `sessions[].id` colliding with another event's `event_sessions` PK) is closed as a
  live invariant now (`keepIds = isEdit`, always), not left as "no current template does this."

**SQL to find currently-orphaned registrations on prod** (for the controller to run against the
existing ZZTEST/live data before this fix was live — a registration whose `session_id` no longer
names a real session on its own event):

```sql
select r.id, r.event_id, r.session_id, r.athlete_id
from registrations r
left join event_sessions es
  on es.id = r.session_id and es.event_id = r.event_id
where r.session_id is not null
  and es.id is null;
```

Add `and not r.refunded` to exclude refunded rows (irrelevant to Results either way).
A parallel query against `scores.session_id` (`left join event_sessions on scores.session_id`)
finds scores with a stale write-time session stamp — expected to have some hits even on healthy
data, since `scores.session_id` is a snapshot that a registration's session change doesn't
propagate to (2026-07-31 finding) and isn't itself a defect.

**Reviewer-tier pass (before commit) caught three real defects in the first draft** — the mint
recycling a removed session's id in the same save (§1 above), `canRemoveSession`'s loading-check
permanently blocking Remove on CREATE, and the sticky Unassigned tab re-printing "0 scores…"
after `unplaced` drops to 0 — plus the template-id hazard now closed as a standing invariant
rather than an incidental one. All four are described inline above rather than as a separate
changelog; this file is the only record of them since none left a trace in the final diff's
"before" state.

**Verification (final, after the reviewer-tier fixes above).** `npm run build` — tsc + vite, zero
errors. `npx eslint src/lib/events-core.ts src/lib/supabase.ts src/components/EventWizard.tsx
src/lib/scoring.ts src/pages/Results.tsx tests/lib/unplaced-scores.test.ts` — zero
errors/warnings. `npx vitest run` — **1211/1211 passed** across 76 files. `tests/lib/
unplaced-scores.test.ts` alone: 23 tests (was 8 before this ticket) —
- `sessionResults`: 2 new cases (stale-reg/valid-score fallback; both-unresolved → Unassigned).
- `unplacedScoreCount`: 3 new cases (mirrors those two, plus the truthy-but-stale-session-id gap
  the old `!!r.sessionId` check missed).
- `diffSessions`: 5 cases (preserves ids across a rename and a reorder, detects a genuinely
  removed id, treats a new id as upsert-only, never deletes when `existing` is empty).
- `assignSessionIds`: 5 cases, including the remove-one-add-one-in-the-same-save regression with
  a paired **sanity check that fails without the fix** (drop `previousIds` from the seed and the
  same test asserts the recycle DOES happen) — proof the positive case has teeth, not just that
  it passes.

No Browser-pane verification — this is a data-layer/pure-logic fix with no new visual surface
beyond one extra `<option>` and one caption `<p>` in Results.tsx, both exercised by the existing
render path; the EventWizard session-editor UI itself (Remove-button toast, discipline-toggle
block) was not clicked through live in a browser, only read for correctness.

## A-11-01 / A-07-02 / A-06-01 / A-07-01 / A-01-01 (2026-08-22): admin MFA gate, invite/reset landing, New-Person invite, UCG wording

**A-11-01 - admin MFA hard gate.** Decided per triage Q4 (block admin pages only, prompt every
sign-in). `adminMfaGate` (`src/lib/mfa-core.ts`, pure) + `useAdminMfaSatisfied`
(`src/lib/mfa.ts`, reactive: `listFactors()` for verified TOTP + `aal.methods` for the passkey
exemption - CONSUMES `PASSKEY_AMR_METHOD`, does not reimplement it). `RequireAdmin` (`App.tsx`)
now renders a full-page "Set up two-factor authentication to continue" panel (same shape as its
existing "Admin access required" panel) whenever `caps.isAdmin && mfaSatisfied === false`, with a
primary link to `/me` and a secondary link Home. `/me` stays outside `RequireAdmin` so there is
always a way out. Deleted `AdminMfaNag` outright (not reduced to a banner) - once admin pages
hard-block, a reminder banner elsewhere adds no enforcement value, only noise. Both sign-out call
sites (`Layout.tsx`, `MfaChallenge.tsx`) now call `clearLegacyMfaNagDismissal()` to scrub any
leftover `sessionStorage['ucg-mfa-nag-dismissed']` from before this change (moot going forward
since nothing writes that key anymore, but cheap insurance).

Deviation from the advisor-caught draft: the first pass would have hung on `PageFallback` forever
on a `listFactors()` error (`if (cancelled || error) return;` left `hasTotp` at `null`
permanently). Fixed to resolve `error` to `hasTotp = false` - falls through to the (escapable)
block panel instead of an infinite spinner. Also confirmed against the installed `auth-js` source
that `data.totp` from `listFactors()` already excludes unverified factors (bucketed by type only
when `factor.status === 'verified'`), so no extra filtering was needed - documented in the code
comment rather than assumed.

**A-07-02 / A-06-01 - invite/reset landing.** This was NOT a dashboard-config issue as first
suspected from reading `_getSessionFromURL` synchronously extracting `window.location.href` - see
the full trace now in `.claude/rules/auth-and-mfa.md` -> "HashRouter vs Supabase implicit flow".
Short version: Supabase's own `window.location.hash = ''` (after its `_getUser` network call)
fires a real `hashchange` that bounces HashRouter to `/`, and the OLD `SetPasswordRedirect` had
already deleted its own `?setpw=1` query marker as cleanup by that point, so its effect
early-returned and never re-navigated back to `/set-password` - stranding the user on a
signed-out-looking Home page. Fixed by capturing the marker once at module load in `auth.ts`
(`initialSetPwKind()` / `hasInitialLinkError()`, mirroring the existing
`initialUrlHasAuthCallback` idiom), immune to every later rewrite.

Split the marker into `?setpw=invite` (`invite-account`) vs `?setpw=reset` (Gate.tsx
forgot-password) - chosen over capturing the `onAuthStateChange` event type
(`PASSWORD_RECOVERY`/`SIGNED_IN`) because the event can fire before or after `SetPassword.tsx`
mounts depending on network timing, whereas the static URL marker has none of that race. A bare
legacy `?setpw=1` (any already-sent email still in flight) is treated as `'legacy'` and routed
like `'invite'`, matching prior behavior for those in-flight links. Post-success routing:
`'reset'` -> `/` (Home), `'invite'`/`'legacy'` -> `/membership` (matches the invite email's "you
will land on the membership page" copy - left the email content itself untouched).

`SetPassword.tsx`'s `!session` (expired-link) state now reads "This link has expired or was
already used" with a "Request a new link ->" button that navigates to `/me`, which - for a
signed-out visitor - renders `Gate`'s sign-in screen with its existing "Forgot my password?"
action; there is no separate standalone sign-in route to link to more directly.

Also fixed in passing: `SetPasswordRedirect`'s own `history.replaceState(null, ...)` call was
passing `null` as the state arg, which wipes whatever React Router had stored in
`history.state` - changed to pass `window.history.state` through. (Ended up unused by the final
design since the invite/reset marker lives in the URL, not router state, but it is a correctness
fix regardless and cheap to keep.)

**Not fixed here, flagged for dashboard/ops if it recurs:** if the Supabase dashboard's redirect
allow-list ever drops the custom `redirectTo`, the `?setpw=...` marker never reaches the app and
none of the above helps - separately, email link-scanners (Outlook/Gmail Safe Links) prefetching
a one-time invite link before the real click is a second, legitimate way to hit the expired-link
state. Neither is a code defect; both documented in the rule file.

**A-07-01 (Nate) - "+ New Person" optional invite.** Added a "Send account invite now" checkbox
to `PersonForm`'s New-Person dialog only (`!person`), default ON, effectively gated on an email
being present via the pure `shouldSendInviteOnCreate({isNew, email, checked})`
(`src/lib/person-form-core.ts`, tested). New `onCreated?: (person, sendInvite) => void` prop fires
once, only on a fresh creation. `AdminMembers.tsx` wires it to the EXISTING `createAccountInvite`
path (~line 452) - **note this is the signup-link flow** (an `accountInvites` row + a generic
`sendEmail` "create your account" link), **not** the `invite-account` edge function's branded
set-password email that `Club.tsx`'s manager-side "add athlete" uses. The task named
`createAccountInvite` explicitly as the path to wire, so this is intentional, but it means "+ New
Person -> invite" and "Club.tsx -> add athlete" send visually different emails today - worth a
follow-up if that inconsistency ever surfaces in UAT.

TS note for the next person touching `PersonForm.save()`: the created-person reference must be
typed `Athlete | undefined` (not narrowed to `null`/`never`) since it is only assigned inside the
`mutate()` closure and read after - `let createdPerson: Athlete | undefined;` avoids a TS
control-flow false negative that `npm run build` would otherwise catch.

**A-01-01 - UCG wording.** Fixed: `src/pages/WaiverSign.tsx:77` heading ("NAIGC waiver" -> "UCG
waiver"); `supabase/functions/request-guardian-waiver/index.ts:94,100` (body copy + subject line,
same substitution). `supabase/functions/send-membership-welcome/index.ts:194-195`: no UCG
equivalent exists in the codebase/brand spec for NAIGC's `/upcoming-events/`, `/email-sign-up/`,
or Instagram handle, so per the task's fallback rule, both `naigc.org` links now point to
`https://www.unitedgymnastics.org` (site root) and the copy was reworded from "sign up for our
[announcement] email list ... NAIGC information ... follow our [Instagram] ... NAIGC members" to
"visit [unitedgymnastics.org] and follow our social media to stay up-to-date on important UCG
information ... connect with UCG members" - dropped the specific Instagram link entirely since no
UCG handle is known anywhere in the repo. Left untouched per the task's explicit exclusions: the
`julia.sharpe+<region>-team@naigc.org` addresses (lines 59-65, contact-address infrastructure,
same category as the `info@naigc.org`/`nate.sharpe@naigc.org` exclusion even though not
byte-for-byte named), scoring rule-set names, and `supabase/templates/*`.

**Item 5 finding (signup-confirmation "wrong website" - Julia).** Grepped
`supabase/templates/*.html`, `supabase/config.toml` (`site_url`/`additional_redirect_urls`), every
`APP_PUBLIC_URL` fallback across `supabase/functions/**`, and `_shared/email-layout.ts`. **All of
it already points at the correct domains** - `https://www.unitedgymnastics.org` in every template
footer and the shared layout, `https://nssharpe.github.io/ucg-platform/` (+ wildcards) as
`site_url`/redirect allow-list, `https://nssharpe.github.io/ucg-platform` as every function's
`APP_PUBLIC_URL` fallback. No wrong-site URL found in-repo. `confirmation.html` was last touched
in the "unitedgymnastics.org footer" rebrand commit; git history does not show conclusive evidence
of a `supabase config push` since. **Most likely explanation: prod has not received a `config
push` since these templates were fixed** (or Julia saw a cached/already-received email from
before that push) - this is a deployment gap, not a code defect. Per the task and
`config-push-dryrun` skill, left the push itself to the controller.

**Deploy list:** `request-guardian-waiver`, `send-membership-welcome`, `invite-account` (redirect
marker changed from `?setpw=1` to `?setpw=invite`).

**Verification.** `npm run build` - tsc + vite, zero errors. `npx eslint` on every touched file
(`src/App.tsx src/lib/auth.ts src/lib/mfa.ts src/lib/mfa-core.ts src/lib/person-form-core.ts
src/components/PersonForm.tsx src/pages/admin/AdminMembers.tsx src/pages/SetPassword.tsx
src/pages/Gate.tsx src/components/Layout.tsx src/pages/MfaChallenge.tsx src/pages/WaiverSign.tsx
supabase/functions/invite-account/index.ts supabase/functions/request-guardian-waiver/index.ts
supabase/functions/send-membership-welcome/index.ts tests/lib/mfa-core.test.ts
tests/lib/person-form-core.test.ts`) - zero errors/warnings. `npx vitest run` - **1220/1220
passed** across 78 files (9 new: 4 `adminMfaGate` cases in `tests/lib/mfa-core.test.ts`, 5
`shouldSendInviteOnCreate` cases in `tests/lib/person-form-core.test.ts`).

No Browser-pane verification this round - every change here is either pure logic (both new test
files), an auth-flow ordering fix that needs a real Supabase invite/reset email round-trip to
observe live (cannot be simulated in the local preview without a real email link), or a small
form addition (`PersonForm` checkbox) using existing `checkrow`/`btn` classes with no new color
pairing, so the contrast/responsive rules are not in play. Flagging the admin-MFA gate and the
invite/reset landing as the two highest-value things to click through live against staging before
the next UAT round, since neither got an end-to-end browser pass here.
