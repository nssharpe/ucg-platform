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
