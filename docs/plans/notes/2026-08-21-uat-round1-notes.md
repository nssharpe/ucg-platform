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

## "Errors & Problems" admin page — persisted problem reports (new ask, 2026-08-22)

Product owners want user-submitted "Report a problem" submissions durable in an admin view
instead of living only in the routed email. Built a new admin page rather than a UAT fix.

**Migration `20260822030000_problem_reports.sql`.** New table `problem_reports` (uuid PK — like
`error_logs`, NOT the usual app-generated text id, because every row is inserted by the service
role from one Edge Function; there's no client-generated id to preserve). Columns exactly as
specced: reporter identity (`auth_user_id`/`reporter_person_id`/`reporter_email`/
`reporter_name`), `category` (`bug`/`question`/`unsure`, matches `report-problem`'s `ROUTES`),
`description`/`route`/`app_version`/`user_agent`/`recent_errors`/`attachment_count`, and
`status`/`resolved_at`/`resolved_by`/`resolution_note`. Index on `(status, created_at desc)`.
RLS: `is_admin()`-only SELECT + UPDATE, same idiom as `error_logs`' admin read policy; explicitly
**no INSERT policy** — the function inserts with the service role, which bypasses RLS, so a
client insert policy would grant nothing anyone needs. **Deviation:** the task said don't
hand-name migration files (`migration-push` skill), but this session is explicitly scoped off
`supabase` CLI commands, so there's no `supabase migration new` to run — hand-timestamped
`20260822030000` (after the existing `20260822020000_score_compare_and_set.sql`, itself also not
yet applied). **Controller: run `supabase migration list` before pushing either — reconcile,
don't assume no one else touched the remote.**

**`report-problem` (`supabase/functions/report-problem/index.ts`).** Inserts one `problem_reports`
row with the service-role client BEFORE the email send (so the row survives a Resend outage),
then sends the email exactly as before — the email is the alerting path, the table is the review
path. Insert failure doesn't block the email either way: checked via the resolved `{error}` (a
PostgREST insert error resolves, it doesn't reject — a `.catch`/`.then(ok, fail)` pair on the
promise would never fire), logged to `error_logs` with context `'report-problem'`, then the
function carries on to send. Added `id` to the existing `people` select (needed for
`reporter_person_id`, wasn't selected before) and read `user_agent` from the request header
server-side (`req.headers.get('user-agent')`) rather than adding a new client-sent field — keeps
the "reporter identity resolved server-side, never trusted from the payload" property intact
without touching the client submit path at all. Screenshots stay email-only; only
`attachment_count` is persisted.

**Admin page.** Route `#/admin/errors` now renders `src/pages/AdminErrors.tsx` (was
`src/pages/ErrorLog.tsx` directly) — nav label renamed "Error Log" → "Errors & Problems"
(`Layout.tsx:58`). Two tabs via the existing `Tabs` component: **Problem Reports** (default) and
**Error Log** (the pre-existing component, now a sub-view — moved its `<h1>`/page-sub up into the
new wrapper so there's only one page heading, and swapped its `<div className="card"
style={{overflow:'hidden'}}>` table wrapper for `overflowX:'auto'` on an inner div, since
`overflow:hidden` on a wide 4-column table just clips content instead of scrolling it — the new
Problem Reports table has 9 columns, so this was worth fixing on both tabs while touching the
file). Problem Reports tab: search box (description/reporter/route, client-side), status filter
(open/resolved/all — a SERVER-scoped refetch, not a client narrowing of an already-narrowed
fetch — see the doc comment on `fetchProblemReports`), category filter, a newest/oldest sort
toggle (client-side over the loaded page), category badges (`err`/`info`/`navy` tones for
bug/question/unsure) and status badges (`warn`/`ok` for open/resolved — all four are existing
`Badge` tones with pre-verified contrast, no new color pairing introduced), expandable rows for
the full description/user-agent/recent-errors/resolution note, and a Resolve (opens a modal with
an optional note) / Reopen (reopening clears `resolved_at`/`resolved_by` but keeps
`resolution_note` as history rather than erasing it — a deliberate choice, not tested elsewhere in
the codebase) button per row.

**Resolve/reopen empty-update guard.** `is_admin()` is aal2-gated (`auth-and-mfa.md`) — an admin
whose session hasn't stepped up to aal2 would have the UPDATE silently filtered to zero rows by
RLS, which PostgREST reports as SUCCESS with no error, not a 403. `updateProblemReportStatus`
chains `.select().maybeSingle()` after the update and treats a null result as a failure (toast,
no local state mutation) specifically to catch this — without it the UI would flip the status
badge optimistically while nothing changed server-side.

**Pagination.** `fetchErrorLogs` now takes `{limit?, before?}` (was a single `limit` positional
arg; the one call site in `ErrorLog.tsx` was updated) and `fetchProblemReports` takes
`{status?, limit?, before?}` — both keyset-paginated via `created_at < before`, default limit
200 unchanged. New pure module `src/lib/admin-errors-core.ts`: `filterProblemReports(rows,
{q, status, category})` (client-side search/filter over one already-fetched page) and
`nextPageCursor(rows)` (the oldest — i.e. LAST, under `created_at desc` ordering — row's
`createdAt`, or null for an empty page). Both tabs' "Load more" buttons derive `hasMore` from
`rows.length === PAGE_SIZE` rather than cursor presence, and append-and-dedupe the next page by
`id` rather than trusting the cursor to never overlap. **Known gap, documented in the pure
module's own comment, not fixed:** `created_at` isn't unique, so a burst of rows sharing the exact
cursor timestamp could in principle be skipped by the next page's strict `<` fetch — accepted
as-is (dedupe-by-id handles the overlap case; a same-millisecond skip is the residual risk and
rare enough for admin-paced data not to warrant a composite `(created_at, id)` cursor). 14 new
vitest cases in `tests/lib/admin-errors-core.test.ts`.

**A React lint fix worth flagging for the next person touching this pattern.**
`react-hooks/set-state-in-effect` flagged the obvious `useEffect(() => load(serverStatus),
[serverStatus])` shape because `load` called `setLoading(true)` synchronously before its
`fetchProblemReports(...).then(...)`. Fixed by moving the "start loading" signal to the actual
event that triggers a refetch (the status-`<select>`'s `onChange`, plus the component's initial
`useState(true)`) and leaving `load` itself to only call `setState` inside the `.then()` — the
effect's synchronous body no longer calls `setState` directly at all.

**RLS probe for the controller (run after `supabase db push` on staging, before prod).** Must use
a REAL non-admin JWT (anon key + a signed-in non-admin session) — a service-role client bypasses
RLS and would produce a false pass either way.

1. Non-admin read — expect `200 []` (a restrictive SELECT policy filters rows silently; this is
   NOT a 403, per the "RLS predicate vs grant revoke" rule in `supabase-migrations.md` — don't
   misread a clean empty array as a broken probe):
   ```
   curl -s "$STAGING_URL/rest/v1/problem_reports?select=id&limit=1" \
     -H "apikey: $STAGING_ANON_KEY" -H "Authorization: Bearer $NON_ADMIN_JWT"
   ```
2. Non-admin write (insert) — expect a `42501`/permission-denied style rejection (no INSERT policy
   at all, so this should fail closed regardless of role):
   ```
   curl -s -X POST "$STAGING_URL/rest/v1/problem_reports" \
     -H "apikey: $STAGING_ANON_KEY" -H "Authorization: Bearer $NON_ADMIN_JWT" \
     -H "Content-Type: application/json" -H "Prefer: return=representation" \
     -d '{"category":"bug","description":"probe"}'
   ```
3. Non-admin update — expect `200 []` (same silent-filter shape as the read: the UPDATE policy's
   `using (is_admin())` clause excludes every row from the update set for a non-admin, so
   PostgREST reports success with zero rows changed rather than an error):
   ```
   curl -s -X PATCH "$STAGING_URL/rest/v1/problem_reports?id=eq.<any-existing-id>" \
     -H "apikey: $STAGING_ANON_KEY" -H "Authorization: Bearer $NON_ADMIN_JWT" \
     -H "Content-Type: application/json" \
     -d '{"status":"open"}'
   ```
4. Admin positive control — sign in as the seeded admin, confirm the SAME read (step 1) returns
   the actual rows and the SAME update (step 3) returns the patched row, not `[]` — proves the
   `200 []` above is RLS filtering, not a broken table/query.

**Deploy list:** `report-problem` (adds the `problem_reports` insert + reads `user_agent` from
the request header). No other functions touched.

**Verification.** `npm run build` — tsc + vite, zero errors. `npx eslint` on every touched file
(`src/App.tsx src/components/Layout.tsx src/pages/AdminErrors.tsx src/pages/ErrorLog.tsx
src/lib/supabase.ts src/lib/admin-errors-core.ts tests/lib/admin-errors-core.test.ts
supabase/functions/report-problem/index.ts`) — zero errors/warnings (one `set-state-in-effect`
error caught and fixed, see above). `npx vitest run` — **1234/1234 passed** across 79 files (14
new: `tests/lib/admin-errors-core.test.ts`).

No Browser-pane verification this round (controller-only task, per the brief). Describing the UI
precisely instead: `#/admin/errors` (nav "Errors & Problems") opens on the Problem Reports tab —
search input, three `<select>` filters (status/category/sort) in a wrapping flex row, a card with
a horizontally-scrollable 9-column table (Created/Category/Reporter/Route/Build/Description/
Screenshots/Status/action), row click expands a detail panel (user agent, recent console errors,
resolution info), and a centered "Load more" button beneath the card when a full page (200 rows)
came back. The Error Log tab is visually unchanged except the same "Load more" button. Both tabs
reuse existing `.card`/`.tbl`/`.badge`/`.btn`/`.input` classes and the shared `Badge`/`Modal`
components — no new colors or contrast pairings were introduced, so the general contrast
requirement is satisfied by construction rather than by a fresh check. **Flagging for the
controller: the nav-label change ("Error Log" → "Errors & Problems") is exactly the kind of nav
change `ui-brand-and-layout.md` says needs a `responsive-sweep` pass (375/768/1280px, drawer
open/close, topbar wrap) — not done here since this session had no Browser pane. Do that, plus a
live click-through of the new page (both tabs, the Resolve/Reopen flow, and Load More), before
calling this UAT-closed.**

## Z-01-02 + M-01-04 + M-19-01 + M-20-01 + M-02-02 + M-03-01 + M-08-01 + M-01-02 + M-01-01 (2026-08-22): separate cart + purchase-history pages

**What changed.**
- **Routes:** `/club/:id/cart` is a REAL page now (`src/pages/ClubCart.tsx`, `ClubCartPage`) —
  was a bare `<Navigate to="/cart" replace>` redirect (`App.tsx`'s `ClubCartRedirect`, deleted).
  New `/club/:id/purchases` (`src/pages/ClubPurchaseHistory.tsx`, `ClubPurchaseHistoryPage`).
  `/cart` (`Cart.tsx`) is now PERSONAL-ONLY — the `managedClubs.map(ManagedClubSection)` loop
  that used to bundle every managed club's cart underneath the viewer's own personal cart is
  gone; `ManagedClubSection` itself is deleted (superseded by `ClubCart.tsx`, which inlines the
  same cross-club-cleanup effect + `CartScope`/`ReceiptsSection` composition, plus the new
  switcher/gate/removed-notices pieces below). `/me/purchases` (`PurchaseHistory.tsx`) is now
  filtered to `isPersonalInvoice` (excludes any invoice with a `clubId`, even one the viewer
  personally paid) instead of the old "athleteId===me OR any item.refUserId===me" filter with
  no club exclusion at all.
- **`src/lib/current-club.ts`** (new): `currentClubId(managed, stored)` (pure, tested) + a
  `useCurrentClubId`/`setCurrentClubId` pair backed by `localStorage` + a tiny pub-sub
  (`useSyncExternalStore`, mirroring `registrations-slice.ts`'s own slice idiom) — deliberately
  NOT threaded through the big `db`/`mutate()`/`PERSISTED_KEYS` machinery (data-layer.md): this
  is a per-browser UI preference, not server-synced app data, same class of thing as
  `sessionStorage['ucg-dev-role']`. `Layout.tsx`'s `navFor` now takes a `currentClub` param
  instead of hardcoding `caps.managedClubIds[0]`; `ClubPage` (Club.tsx), `ClubCartPage`, and
  `ClubPurchaseHistoryPage` all call `setCurrentClubId` on mount when the viewer manages (or is
  admin for) the club they're looking at, so the nav / topbar button follow wherever they
  actually are.
- **`src/lib/purchases.ts`** (new, pure, tested): `isPersonalInvoice(inv, personId)`,
  `payerLabel(inv, payments, people)`, `clubCartBadgeCount(carts, managedClubIds)`,
  `matchesClubPurchaseSearch(inv, query, payerName)`.
- **`src/components/InvoiceLineTable.tsx`** (new): the receipt detail table, extracted once and
  reused by Cart.tsx's `ReceiptsSection` modal (personal AND club), `PurchaseHistory.tsx`, and
  `ClubPurchaseHistory.tsx` — always renders the WHOLE invoice, never filtered to "just the
  viewer's own athlete." `PurchaseHistory.tsx`'s old modal DID filter that way
  (`detail.athleteId===personId ? detail.items : detail.items.filter(refUserId===personId)`) —
  harmless once the page is personal-only (the viewer IS the only athlete on those invoices) but
  it was the actual M-20-01 bug for a shared club invoice before this split (it hid other
  athletes' lines AND the `refUserId`-less discount/fee rows). Removed outright rather than kept
  dead; `ClubPurchaseHistory.tsx`'s detail modal is unfiltered from day one.
- **Nav (`Layout.tsx`):** My UCG gained "My Cart" (`/cart`, was topbar-only before); My Club's
  "Club Cart & Receipts" split into "Club Cart" + "Club Purchases", both pointed at
  `currentClub` instead of `managedClubIds[0]`, and the group only renders when a current club
  actually resolves. Topbar gained a second chip next to Cart: "Club Cart"/"Club Carts"
  (plural when `managedClubIds.length > 1 || isAdmin`) linking to `/club/${currentClub}/cart`,
  badge = `clubCartBadgeCount` across every managed club (independent of the personal badge).
  Only rendered when a current club exists — an admin who manages zero clubs directly sees no
  topbar chip (can still reach any club's cart via `Club.tsx`'s own links/switcher). Added
  `.topbar-cart-label` (index.css) collapsing both cart chips' text at the same <=600px
  breakpoint the profile name already collapses at, proactively, since a THIRD topbar chip at
  narrow widths is a real overflow risk this session couldn't verify without a Browser pane —
  flagged for the controller's responsive-sweep below.
- **`Club.tsx`:** added the `setCurrentClubId` sync effect (above); moved "Club cart & receipts
  ->" (unconditional, went to `/cart`) into the `canManage &&` block as two separate links
  ("Club cart ->" / "Club purchases ->", both to the real per-club routes) — a non-manager
  browsing another club's page no longer sees a link to a page they can't use (`ClubCartPage`/
  `ClubPurchaseHistoryPage` both gate their own content on `canManage` too, defense-in-depth,
  matching the existing Club.tsx `canManage` idiom for edit-only sections).
- **M-01-04 ("Jurassic's cart vanished"):** `cleanupCrossClubCart` (`cart-sync.ts`)'s toast now
  names the EVENT, not just the other club (`Removed <athlete> - already registered for <event>
  with <club>.`, was `<athlete> was removed from the cart - they're now registered with
  <club>.` with no event name) — a toast alone is transient/easy-to-miss, which is exactly the
  reported bug's mechanism. `ClubCartPage` additionally appends every such message to a
  persistent on-page "Some cart lines were removed automatically" banner (dismissible, not
  auto-hiding) by wrapping the toast callback passed into `cleanupCrossClubCart`, rather than
  changing that shared function's signature (it's also called from `Club.tsx`'s
  `EventRegGrid`, which keeps its toast-only behavior unchanged).
- **M-01-01 (fee/total on every card):** `CartCard` (Cart.tsx) now always shows Subtotal +
  Service fee + Total, not just inside the >=2-section "everything" bar. The per-card fee is
  `processingFee` (the exact mirrored pure formula the server applies, money-invariants.md) run
  on that card's OWN server-priced subtotal (`pricedSum` against the existing scope-wide
  `mode:'preview'` data, filtered implicitly since each card only sums its own items) — this
  is NOT a new client money computation, and it matches exactly what `CartCheckout`'s own
  per-card preview would show if the member clicks "Check out {title}" on just that card
  (checkout is already per-section). No new network call.
- **M-02-02/M-03-01 (open behavior + post-payment panel):** `CartInner`/`ClubCartPage`/
  `ClubPurchaseHistoryPage` all `window.scrollTo(0, 0)` on mount. `CartScope`'s `onPaid` now
  also sets a `paidNotice` flag; a "Payment complete" card (same markup as the pre-existing
  `MembershipsCheckoutInner` success panel, so no new contrast pair) renders at the top of
  BOTH the empty-cart and normal-cart return branches (paying off the last section in a
  multi-section cart leaves that exact scope's `cart.length === 0`, so both branches need it).
  "View receipt" scrolls to a `receiptsRef` div wrapping the page's `ReceiptsSection` (passed
  down from the parent, which is the only component that renders both) — a user-initiated
  click, not the autofocus-on-load anti-pattern M-02-02 flags. Receipts were already sorted
  newest-first (`ReceiptsSection`'s existing `.sort((a,b)=>b.createdAt.localeCompare(...))`) —
  no change needed there.
- **M-08-01 (stale hold timer):** `CartScope` gained a `visibilitychange`/`focus` effect that
  calls the EXISTING `invalidateClubRegistrations`/`invalidateMyRegistrations`
  (`registrations-slice.ts`, already built for UAT M-12-02) whenever the tab regains focus —
  no new polling/refetch mechanism, just an added trigger point for one that already existed.
- **M-01-02 (toast "View cart" action):** `ToastOptions` (`toast-bus.ts`) gained
  `action?: { label, to }`. `ui.tsx`'s `ToastProvider` renders it as an underlined button in
  `--ice-200` (the toast's own existing text color — already ~11.8:1 on the `--navy-800`
  background, so no new contrast pair) that navigates via `window.location.hash = to` rather
  than `<Link>`/`useNavigate`, because `ToastProvider` is mounted OUTSIDE `HashRouter` in
  `App.tsx` (its own imperative escape-hatch subscribers — the write-queue, the offline gate —
  need to be able to toast with no Router in scope at all). Wired at the three named call
  sites: `Club.tsx` `saveRegs` (-> `/club/${clubId}/cart`), `Events.tsx`'s `SelfRegModal` save
  (-> `/cart`; the very next line already `navigate('/cart')`s, so this is honest-but-redundant
  there, kept for consistency with the spec), `MyRegistrations.tsx` `saveRegs` (-> `/cart`).
  `Events.tsx`'s `SelfRegModalProps.toast` prop type had to widen from a hand-rolled
  `{ variant? }`-only shape (shared verbatim by ~10 other prop-typed `toast` callbacks in that
  file) to the real `ToastOptions` — only that one interface, not the other nine, since only
  this one needed the new field.
- **M-20-01 "Paid by":** `ReceiptsSection`'s club-scoped cards/modal and
  `ClubPurchaseHistory.tsx`'s cards/modal all show "Paid by `payerLabel(...)`" — omitted on
  personal receipts (the payer is self-evident there). Search/filter on the new Club Purchase
  History page matches the payer name too (`matchesClubPurchaseSearch`), not just
  number/item/amount like the plain `ReceiptsSection` search.
- Bonus fix noticed in passing: `MembershipsCheckoutInner`'s post-payment panel linked
  "Purchase history" to `/profile` (not a registered route — falls through to `NotFound`);
  changed to `/me/purchases`.

**Deviations from the brief.**
- **`payerLabel`'s signature is `(inv, payments, people)`, not the brief's literal
  `(inv, people)`.** An invoice alone cannot say who paid a CLUB invoice —
  `invoices.athlete_id` is always `null` there (`fulfillPayment`:
  `athlete_id: clubId ? null : personId`) — the payer is the `person_id` on the ONE `payments`
  row that fulfilled into it (`payment.invoice_id === inv.id`; one payment mints one dedicated
  invoice, confirmed by reading `_shared/fulfill.ts`'s `invoiceId = payment.invoice_id ??
  'inv-'+payment.id`). Documented in the function's own doc comment.
- **KNOWN RLS LIMIT, flagged not fixed:** `payments` is self-read-or-admin only
  (`payments_self_read`, `20260625231808`: `is_admin() or person_id = my_person_id()`). A
  non-admin club manager can only ever see the `personId` on payments THEY THEMSELVES made —
  for a club invoice paid by a DIFFERENT manager of the same club, that payment row simply
  never loads into this viewer's `db.payments`, so `payerLabel` falls through to "A club
  manager" rather than a guessed/wrong name. In practice this covers the common case fine (one
  primary manager who always does the checkout sees their own name on every club receipt); it
  under-resolves only for genuinely multi-manager clubs. Widening this would need a new RLS
  policy (e.g. `manages_club(...)` on `payments`) — money-adjacent, reviewer-tier territory
  (money-invariants.md), explicitly out of scope for this task (no `supabase` CLI commands, no
  migrations authored). `payerLabel` is unit-tested for both the resolved-name and
  RLS-invisible-fallback cases.
- **`ManagedClubSection` was DELETED, not deprecated-in-place** — nothing else referenced it
  (grepped after removal); keeping an unused, unexported function around would have been dead
  weight the linter might not even catch (top-level function declarations aren't always
  flagged). `CartScope`/`ReceiptsSection` are now `export`ed from `Cart.tsx` instead, and
  `ClubCart.tsx` imports them directly rather than re-deriving the composition.
- **`/club/:id/purchases` and `/club/:id/cart` are gated by `RequireAccount` at the router
  level only** (any signed-in account), with `canManage` (admin or `managedClubIds.includes`)
  checked INSIDE each page component — mirrors `Club.tsx`'s existing pattern for
  edit-only/manager-only sections on the roster/registrations pages (there is no
  `RequireClubManager` wrapper anywhere in this codebase to reuse). Did not add one for this
  task; a non-manager hitting either URL directly sees a "You don't manage this club" panel,
  not a silent redirect or blank page.

**Noticed but NOT touched / needs the controller's attention:**
- **No Browser pane this session** — every layout/nav/topbar change here (a new topbar chip, a
  restructured My Club nav group, per-card fee/total rows, the removed-notices banner, the
  Payment-complete panel) needs the `responsive-sweep` skill before this is called done, per
  `ui-brand-and-layout.md`. Routes to check: `/cart` (My Cart, incl. an empty cart and a
  multi-section cart to see the fee rows + everything-bar together), `/club/:id/cart` (both the
  empty state and a populated one; the club switcher when the signed-in dev persona manages
  >=2 clubs or is admin), `/club/:id/purchases` (search/filter row wrapping, the "Paid by" line),
  `/me/purchases` (confirm nothing regressed from the `isPersonalInvoice` filter change), and
  the topbar at 375/768/1280px specifically for the new second cart chip (`.topbar-cart-label`
  was added proactively at <=600px but never visually confirmed).
- **`index-*.js` main chunk grew from ~82 KB to ~495 KB** between the pre-task build and the
  post-task build (`npm run build` output) — `jspdf.es.min` no longer appears as its own
  separate chunk (it was ~399 KB standalone before). Both builds succeed with zero errors and
  the same "chunks larger than 500 kB" warning already existed pre-task (for `exceljs.min`), so
  this reads as a rolldown-vite auto-chunking heuristic shift (more lazy routes now import
  `receipt.ts`/jsPDF — `ClubPurchaseHistory.tsx` and `PurchaseHistory.tsx` both call
  `downloadReceipt`) rather than a functional bug, but it wasn't root-caused further — flagging
  in case bundle size becomes a real concern later.
- **Camp events' `event.name` matching in `groupCartItems`** and every other pre-existing
  cart-grouping/pricing helper were NOT touched by this task — only the page/route/nav
  structure around them changed.

**Verification.** `npm run build` — succeeded, zero TypeScript errors. `npx eslint
src/pages/Cart.tsx src/pages/ClubCart.tsx src/pages/ClubPurchaseHistory.tsx
src/pages/PurchaseHistory.tsx src/components/InvoiceLineTable.tsx src/components/Layout.tsx
src/components/ui.tsx src/lib/toast-bus.ts src/lib/current-club.ts src/lib/purchases.ts
src/lib/cart-sync.ts src/lib/navHistory.ts src/pages/Club.tsx src/pages/Events.tsx
src/pages/MyRegistrations.tsx src/App.tsx tests/lib/current-club.test.ts
tests/lib/purchases.test.ts` — zero errors/warnings. `npx vitest run` — 1256/1256 passed across
81 files (+22 from this task: 5 `currentClubId` cases in `tests/lib/current-club.test.ts`, 17
`isPersonalInvoice`/`payerLabel`/`clubCartBadgeCount`/`matchesClubPurchaseSearch` cases in
`tests/lib/purchases.test.ts`).

## M-01-03 (S3): Events-list register/edit entry points + owner-checklist reorder

**What changed.**
- New pure helper `eventRowActions({event, viewer, hasReg, isManager, isCamp})` (`src/lib/events-core.ts`)
  → `('self'|'club'|'edit')[]`, order = display order. `viewer.canRegister` gates 'self'/'edit'
  (flips to 'edit' when `hasReg`); `isManager && !isCamp` gates the independent 'club' action
  (a manager registers OTHER athletes, so it's unaffected by the viewer's own `hasReg`). Tests:
  `tests/lib/events-core.test.ts`, 8 new cases covering every combination including the camp
  suppression.
- `src/pages/Events.tsx` `Events()` (the list): new "Register" column, left of "Details" — stacked
  small buttons, rendered only when `!ev.listingOnly && eventIsInPhase(ev, 'reg-open')` (the exact
  gate the detail page's own registration card uses, not re-derived). "Register yourself" opens
  the existing `SelfRegModal` (now exported, keyed per-row by `selfRegEventId` state — one shared
  modal instance). "Register your club" navigates to `/club/${currentClubId}/registrations?event=${slug}`
  (`useCurrentClubId(caps.managedClubIds)` — current-club.ts, NOT `managedClubIds[0]`). "Edit
  registration" links to `/me/registrations?event=${slug}`. `hasReg` is read from `useMyRegistrations()`
  ("mine," Tier 2 — COMPLETENESS rule) filtered to `athleteId === myAthlete.id && eventId === ev.id
  && !refunded`.
- Discipline icons in the same list: wrapped each `<DisciplineIcon>` in `<span className="disc-icon">`;
  `src/index.css` hides `.disc-icon` inside the EXISTING `@media (max-width: 860px)` block (the
  `Layout.tsx`/sidebar breakpoint) rather than adding a new one — icons stay in the DOM (never
  removed), just hidden, freeing width for the new Register column's buttons. This is a DIFFERENT
  mechanism from the table's own `@container (max-width: 820px)` stack-to-cards reflow just above
  it in index.css — that one was already there and untouched.
- `src/pages/Events.tsx` `EventDetail`: moved the `OwnerAssignBlock`/`OwnerChecklistCard` block
  (event-owner assignment + checklist) from directly after the wizard-open block to AFTER the
  Competition-Order-Lock card — i.e. after Event Admins / Waitlist / Camp-survey-responses /
  Competition-Order-Lock, before the Nationals-summary/check-in-admin cards. Non-admin view
  (nothing in this whole `caps.isSanctioning`/`canManage` chain) is visually unchanged — it never
  rendered any of these cards to begin with.
- `src/pages/Club.tsx` `EventRegGrid`: reads `?event=<slug>` via `useSearchParams()` once, in the
  existing `eventId` state's lazy initializer (`useState(() => ...)`) — a preselected event that
  isn't currently open falls through to the normal default (`reg-open` first, else the first
  `openEvents` entry). This is the wiring the Events-list "Register your club" button targets.
- `src/pages/MyRegistrations.tsx`:
  - `?event=<slug>` deep link (from the Events-list "Edit registration" button) is read the same
    lazy-initializer way — NOT a `useEffect` that calls `setState` (tried first; ESLint's
    `react-hooks/set-state-in-effect` rule, documented as a hard trap in `ui-brand-and-layout.md`,
    rejected it). Sets the initial `tab` (upcoming/past by the event's `endDate`), `q` (the event's
    name — reuses the list's own existing search-filter, which both "filters" and effectively
    "scrolls" it into view since it becomes the only/top result) and `expanded` (auto-opens its
    card) once at mount.
  - New "Register for another event" section below the existing list: every event with
    `eventIsInPhase(ev,'reg-open')`, `!listingOnly`, not already registered for
    (`myRegs`-filtered), gated on `caps.canRegister` (same gate as the Events detail page's
    "Register yourself" button — a coach-only member sees nothing here, not a dead end). Sorted
    soonest-first. A search box appears only when the list exceeds 8 events. Each row's "Register"
    button opens the SAME `SelfRegModal` component (imported from `./Events`, now exported) — not
    a re-derived modal — via its own `registerEventId` state, independent of the deep-link state
    above. Empty states: "No other events are open for registration right now." (zero eligible
    events) vs. a "No events match" message (search yields nothing).
- `SelfRegModal` is now `export function` in `Events.tsx` (was module-private) so
  `MyRegistrations.tsx` can import and reuse it verbatim — cart/add-ons/camp-survey steps and all.

**Deviations / judgment calls.**
- The brief's `eventRowActions` signature includes an `event` field alongside `isCamp` — kept both
  in the type for documentation value (a caller with the full `Event` on hand doesn't need to
  separately compute `isCamp`), but the function body only reads `isCamp`; `event`'s type is
  `{ eventType?: Event['eventType'] }` and is otherwise unused. No lint issue (it's a destructured
  object field, not a bound variable).
- The existing EventDetail page's own "Register your club" button (pre-existing, in the
  Registration card) still targets `/club/${caps.managedClubIds[0]}` (bare, redirects to
  `/roster`) — left UNTOUCHED. It predates this task and isn't one of the two "new registration
  entry points" named in the brief; the NEW Events-list button instead targets
  `/club/${currentClubId}/registrations?event=...` directly (skips the roster-redirect hop and
  preselects the event) per the explicit instruction to use current-club.ts and wire the event
  picker. Flagging the inconsistency between the two buttons' targets in case Nate wants the
  detail-page one updated to match in a follow-up — not done here since it's out of this ticket's
  stated scope (Item A is additive: new column + new section + the explicit reorder, not an audit
  of the pre-existing button).
- `MyRegistrations.tsx`'s "Register for another event" list does NOT pre-filter on the
  club-membership gate (`clubHasActiveMembershipForEvent`) — an athlete whose only affiliated
  club lacks an active club membership for the event's season will still see the event listed,
  and only hit the (existing, unchanged) error toast inside `SelfRegModal.handleRegSave` on save.
  Chose not to duplicate that check in the list (it's club-selection-dependent — the modal doesn't
  even know which club is selected until it opens) rather than risk the list and the modal's gate
  drifting apart.

**Verification.** `npm run build` — succeeded; main `index-*.js` chunk stayed at 90.19 kB (gzip
26.26 kB) and `jspdf.es.min-*.js` stayed a separate 399.58 kB (gzip 129.72 kB) chunk — both
unaffected by this ticket (confirms the prior ticket's bundle-split fix held). `npx eslint
src/pages/Events.tsx src/pages/MyRegistrations.tsx src/pages/Club.tsx src/lib/events-core.ts
tests/lib/events-core.test.ts` — zero errors/warnings (one intermediate
react-hooks/set-state-in-effect error was caught and fixed — see the deep-link deviation above —
before this became the final diff). `npx vitest run` — 1264/1264 passed across 81 files (+8 from
this ticket's `eventRowActions` describe block in `tests/lib/events-core.test.ts`, on top of the
1256/81 baseline this notes file already recorded above).

**Noticed but NOT touched / needs the controller's attention (no Browser pane this session):**
routes to responsive-sweep before this is fully "done" per `ui-brand-and-layout.md`: `/events`
(the new Register column at 375px — stacked buttons + hidden discipline icons below 860px,
confirm the table's own `.events-table-wrap`/container-query reflow still has room), `/events/:slug`
(admin view — confirm the moved owner-checklist block renders correctly in its new position for a
sanctioning-team viewer), `/me/registrations` (the new "Register for another event" section at
375px, and the `?event=` deep-link landing state), `/club/:clubId/registrations` (the `?event=`
preselect via a direct URL, e.g. from clicking "Register your club" on the Events list).

## M-05-01 (S3): branded receipt/invoice PDFs

**What changed.**
- `src/assets/brand/mark.png` (new, 3597 bytes): the standalone navy figure mark
  (`mark.svg`) rasterized once via Playwright (headless Chromium screenshot of the
  inline SVG at 60x60px, transparent background) — jsPDF's `addImage` needs raster
  pixel data (base64/Uint8Array/HTMLImageElement); it has no SVG support without the
  separate `svg2pdf.js` plugin, which isn't installed. Sized to land under Vite's
  default `assetsInlineLimit` (4096 bytes) so a plain `import markPng from
  '../assets/brand/mark.png'` (no `?inline`/`?url` query — those aren't declared for
  bare asset paths in `vite/client.d.ts` and would have needed either a custom Vite
  plugin or an async fetch-and-convert step at PDF-generation time) auto-inlines it as
  a base64 data URI at build time — confirmed in the actual `npm run build` output
  (`data:image/png;base64` appears exactly once, in the `InvoiceLineTable` shared
  chunk that all three receipt-downloading pages already pull in) rather than emitting
  a separate `mark-*.png` asset file. This is the vector mark ARTWORK (already public,
  already committed as `.svg` in this same directory) — a different asset class from
  the licensed Greed Condensed/Suisse Intl webfont FILES, which still never ship in
  the repo (EULA) and stay untouched; jsPDF keeps using its built-in Helvetica only.
- `src/lib/receipt.ts` — full rewrite of the three `download*` functions' visual
  layout, built on shared internal helpers (`newDoc`, `drawHeader`, `drawBilledTo`,
  `drawLines`, `drawFooter`) so the three documents can't visually drift apart:
  - Header: logo top-left, "UNITED CLUB GYMNASTICS" + `unitedgymnastics.org` next to
    it, document title ALL CAPS bold navy top-right (`RECEIPT` when `inv.paidAt` is
    set / `INVOICE` when not, for `downloadReceipt`; always `INVOICE` for the
    pre-payment `downloadCartInvoice` estimate; always `REFUND RECEIPT` for
    `downloadRefundReceipt`) with invoice number/date/paid-status meta lines under it,
    then a navy header rule.
  - "Billed to" (+ "Paid by" for a club invoice, new optional 4th param
    `downloadReceipt(inv, forName, opts?: { paidBy?: string })` — `forName` stays the
    "billed to" name unchanged; `opts.paidBy` is additive so every existing call site
    except one compiles unchanged). "Prepared for" / "Refunded to" wording preserved
    for the other two documents (clearer than a generic "Billed to" for those cases).
  - A clean line-item table: `DESCRIPTION`/`AMOUNT` column headers under a navy rule,
    right-aligned amounts, muted-gray secondary rows (Subtotal/discount/fee) vs.
    near-black item rows, a heavier navy rule + bold navy Total row.
  - Footer: `Service fees are non-refundable. Questions: unitedgymnastics.org` (the
    exact site link `_shared/email-layout.ts`'s footer already renders — there is no
    separate contact EMAIL address anywhere in the codebase's emails/functions, only
    that site link, confirmed by grep) plus each document's existing disclaimer line
    (cart-estimate caveat / "Refunded to the original payment method.").
  - Colors: `NAVY` `#1E2B38` (headings/rules), a near-black `(26,26,26)` for item-row
    text, and a muted `(90,90,90)` gray for secondary/meta text — picked specifically
    to clear WCAG AA 4.5:1 on white (worked the sRGB contrast math: a gray value needs
    to be ≤~119 to hit 4.5:1 on white; the OLD code used untested grays as light as
    140, which is only ~3:1). No pale accent (bluegreen/purple/gold) used as text,
    per the rebrand spec's hard rule.
- New pure helper `receiptLines(inv): PdfLine[]` (`src/lib/receipt.ts`, no jsPDF
  import in its body) — extracted the item/discount/subtotal/total row-building logic
  that used to be inline in `downloadReceipt`'s drawing loop, so it's independently
  testable. `PdfLine = { label, amount, kind: 'item'|'subtotal'|'discount'|'fee'|'total' }`.
  Tests: `tests/receipt.test.ts`, 4 new cases (no-discount, with-discount, a refunded
  item shown at $0 rather than dropped, and the "coupon applied but discounted
  nothing" edge case) — this is the "pure layout helper" test called for in place of
  exercising jsPDF directly (confirmed via grep that no existing test constructs a
  real `jsPDF` instance; `tests/receipt.test.ts`/`tests/refund-receipt.test.ts` only
  ever exercised the jsPDF-free `invoice-math.ts` re-exports and `refundReceiptNumber`).
- `src/pages/ClubPurchaseHistory.tsx`'s `downloadReceipt` call site now passes
  `{ paidBy: payerOf(detail) }` (the page's existing `payerLabel`-backed resolver) —
  the only one of the three call sites with an actual "payer might not be the billed
  club" case; `Cart.tsx`/`PurchaseHistory.tsx` are personal-only (payer === billed-to
  always), left unchanged.

**A real bug found and fixed via an actual PDF render (not caught by any test).**
The pre-existing code (both the discount line in `downloadReceipt` and every negative
amount in `downloadRefundReceipt`) formatted a negative amount with a real Unicode
minus glyph (U+2212, "−"). jsPDF's standard Helvetica/WinAnsi font encoding does not
map that glyph correctly — rendered output showed a stray `"` character with the
digits spaced apart ("$ 1 0" instead of "$10"), i.e. this was ALREADY BROKEN before
this ticket touched the file, just never noticed because nothing had ever visually
rendered a discount/refund PDF and looked at it. There is no PDF-rendering test
harness in this repo, so this was caught by writing a throwaway render script
(`vi.mock` the logo import to a real base64 PNG, monkey-patch jsPDF's `save` —
jsPDF assigns `save` as an OWN instance property from `jsPDF.API` at construction
time, not on `.prototype`, which tripped up the first patch attempt — to write the
output buffer to a real `.pdf` file instead of triggering a browser download) and
reading the actual output. Fixed by switching to a plain ASCII hyphen-minus ("-"),
which IS in WinAnsi and renders correctly — verified by re-rendering. The script and
its output files were never committed (throwaway verification only, per the "don't
create files unless necessary" rule); the four sample documents rendered
(a paid receipt with a discount + "Paid by", an unpaid invoice, a cart estimate, and
a refund receipt) all confirmed correct branding: logo placement, header rule,
column-aligned amounts, and the fixed minus sign.

**Deviations / judgment calls.**
- "Questions: <the contact address used in the email footer>" resolved to the SITE
  LINK (`unitedgymnastics.org`), not an email address — `_shared/email-layout.ts`'s
  footer has never carried a contact email, only the site link + tagline (confirmed
  by reading the file directly, not from memory). `RESEND_FROM` (a personal
  `@naigc.org` address per older docs) was deliberately NOT used here — that's a
  send-from address, not a published "contact us" line, and putting a personal email
  on a public-facing PDF wasn't asked for.
- `downloadCartInvoice`'s signature is UNCHANGED (no `paidBy`/opts param) — every one
  of its call sites (`Cart.tsx`) is the personal-cart pre-payment estimate; there is
  no club-cart caller of it today (`ClubCart.tsx` doesn't import it), so there's
  nothing for a "Paid by" to resolve to yet. Left as-is rather than adding an unused
  optional param.
- `refundReceiptNumber`'s signature and the three `invoiceSubtotal`/`invoiceDiscount`/
  `invoiceTotal` re-exports are byte-for-byte unchanged, per the brief — only the
  jsPDF drawing code changed.

**Verification.** `npm run build` — succeeded; main `index-*.js` chunk stayed at
90.19 kB (gzip 26.28 kB) and `jspdf.es.min-*.js` stayed a separate 399.58 kB (gzip
129.72 kB) chunk — the new logo asset added zero bytes to either (it landed in the
shared `InvoiceLineTable` chunk instead, confirmed by grepping the built output for
`data:image/png;base64`, found exactly once). `npx eslint src/lib/receipt.ts
src/pages/ClubPurchaseHistory.tsx tests/receipt.test.ts` — zero errors/warnings.
`npx vitest run` — 1268/1268 passed across 81 files (+4 from this ticket's
`receiptLines` describe block in `tests/receipt.test.ts`, on top of the 1264/81
baseline the M-01-03 section above recorded). Manually re-rendered all three document
types (4 sample PDFs incl. a paid/unpaid receipt variant) via a throwaway,
never-committed script and read them back — see the minus-sign bug above.

## Athlete self-serve withdrawal (owners' spec 2026-08-23, branch `feat/athlete-withdrawal`)

**What shipped.** New edge function `withdraw-registration` (`supabase/functions/withdraw-registration/index.ts`,
`verify_jwt` stays true): an authenticated athlete withdraws THEMSELVES (no club-manager branch,
unlike `request-refund`) from an event. Resolves every one of their own non-refunded/
non-waitlisted/not-yet-withdrawn/non-refund-requested rows for the given `regId`'s (event, club) —
matching `request-refund`'s per-registration grouping, so a multi-discipline athlete withdraws
from the whole event in one call — then applies `withdrawalPlan` (new pure module
`src/lib/withdrawal.ts`, mirrored `supabase/functions/_shared/withdrawal.ts`, tested in
`tests/withdrawal.test.ts`): before the event's `lastDateToEdit` (or none set) → DELETE every
matched row (same shape as an on-time refund approval, scores cascade via FK); at/after it → KEEP
every row with `apparatus: []`/`apparatus_levels: null`/`partner_athlete_id: null` and stamp the
new `registrations.withdrawn_at` column (migration `20260824100000_registrations_withdrawn_at.sql`)
— deliberately never `refunded: true`, since no money moved. Idempotent: an already-removed regId
404s; already-withdrawn/refunded/refund-requested/waitlisted 409s/400s with a clear message. Both
the delete and the update are scoped by the SAME `refunded=false AND withdrawn_at IS NULL`
predicate as the group read, so a double-submit race resolves to "already withdrawn" instead of a
double-apply. Emails (best-effort): the athlete (`withdrawalEmailVariant` — 'plain' on a
refund-eligible event since a withdrawable reg there is by construction the $0 case, per rule 2;
'refund-contact' pointing at the host club's email on a non-eligible event; 'host-club' — same
body as 'plain', kept as a separate enum value per the brief's literal contract — when the athlete
competes for the host club) and the host (`events.director.email` first, falling back to the host
club's `clubs.email`, same resolution `_shared/fulfill.ts`'s cc-director uses).

Client: `withdrawRegistration()` invoker in `src/lib/supabase.ts` (mirrors `requestRefund`'s
shape). `WithdrawDialog.tsx` (new) — confirm dialog via the shared `Modal` primitive (no dedicated
`ConfirmDialog` component exists in this codebase; used `Modal` directly, same as
`RefundRequestDialog`), showing the late-withdrawal explanation when `now > lastDateToEdit`.
`MyRegistrations.tsx`: per-row decision — `canRequestRefund` now ALSO requires refundable paid
cents > 0 (rule 2: a $0 registration, e.g. a 100%-promo entry, no longer shows "Request a refund"
even on a refund-eligible event); `canWithdraw` is the fallback whenever refund isn't shown, minus
refunded/refundRequested/waitlisted/already-withdrawn rows. A withdrawn-but-kept row renders a
"Withdrawn" badge (parallel to the existing "Refunded" badge). The refundable-cents check reuses
`registrationLines` — pulled out of `RefundRequestDialog.tsx` into `src/lib/registration-status.ts`
(a component file can't export a plain function without tripping
`react-refresh/only-export-components`; also gives it a proper pure-module home) and now imported
by both call sites.

`Registration.withdrawnAt` added to `types.ts` (read-only, documented as such) and to
`REGISTRATION_COLUMNS_NO_SURVEY`/`rowToRegistration` in `supabase.ts` — deliberately EXCLUDED from
`registrationToRow`'s upsert mapping (like `camp_survey`, though for a different reason: not a
column-privilege revoke, but so an ordinary registration edit/save can never silently clear it back
to null). `database.types.ts` was NOT regenerated (no `supabase` CLI use this session, per brief) —
`withdrawn_at` is read via the same explicit-cast pattern already used for `waitlisted`/
`waitlist_group_id`/`hold_expires_at`, which are also absent from that generated file today.

**Deviations / judgment calls.**
- **"UCG-hosted" in the brief's rules 2/3/6 was read as `eventIsRefundEligible`'s flag**, not a
  literal `events.ucg_hosted` truthy check. The brief's own "Context" line ("only UCG-hosted events
  offer in-app refunds") doesn't match the actual eligibility function, which ALSO offers refunds
  for a regular event hosted by the `is_league_host`-flagged club — not just FlipFest/Nationals.
  Reusing `eventIsRefundEligible`'s exact boolean (mirrored server-side, same inline block
  `request-refund` already uses) keeps the withdraw-vs-refund decision in lockstep with whichever
  events actually show "Request a refund" today, rather than introducing a second, narrower
  "UCG-hosted" concept that would silently disagree with it. `withdrawalEmailVariant`'s param is
  still literally named `ucgHosted` to match the brief's stated function signature.
  **Flagging for Nate/Julia**: if "UCG-hosted" was meant more narrowly (only FlipFest/Nationals,
  excluding a regular event a league-host club runs), a one-line change swaps the fed boolean.
- **Ownership check omits a distinct "guardian account" branch.** The brief says "athlete
  themselves or their guardian account" — this codebase has no separate guardian-login concept for
  a registration's `athlete_id` (waivers have a `signer_role: 'self'|'guardian'` distinction, but
  that's about who SIGNS, not a second account that owns a minor's registrations). Implemented as
  a literal `caller.id === reg.athlete_id` check, identical to `request-refund`'s own `isSelf`
  branch minus its club-manager branch — there is no other ownership concept in the codebase to
  diverge from.
- **Waitlisted rows are excluded from Withdraw** (400 server-side, hidden client-side) — "Leave
  waitlist" already covers cancelling those, and a waitlisted row isn't a live slot to remove/
  scratch in the first place.
- **A pending refund request blocks withdrawal** (409) rather than silently proceeding — not
  explicit in the brief, but withdrawing out from under an in-review refund request would leave
  `refund_requests` pointing at a row that's been deleted or reshaped; simpler to require the
  refund request be resolved (approved/rejected) first.
- **Late-withdrawal roster/results rendering**: verified rather than assumed. A blanked
  (`apparatus: []`), non-refunded row is IDENTICAL in shape to the existing refunded-but-kept row
  minus the `refunded` flag — `Club.tsx`'s `hasActiveReg`/`priorDisciplineCount` and `Results.tsx`'s
  per-apparatus filters already key off `apparatus`/`refunded` in ways that render this acceptably
  (still "registered" for roster purposes per rule 5; contributes nothing to any apparatus ranking
  since `apparatus` is empty). No other surface needed a code change; `withdrawn_at` exists purely
  so a future surface COULD distinguish the two cases if that's ever asked for.
- **No `error_logs` audit row** — per the brief, withdrawals are tracked only via the email flow
  (both sides get a copy) and, for the late case, the persisted `withdrawn_at` timestamp itself.

**Verification.** `npm run build` — succeeded (no TS errors; `supabase/functions/**` is outside
`tsconfig.app.json`'s `include`, so it's checked by eslint + Deno's own type-checking at deploy
time, not `tsc`, same as every other edge function in this repo). `npx eslint` on every touched/
new file (`src/lib/withdrawal.ts src/lib/supabase.ts src/lib/types.ts
src/lib/registration-status.ts src/components/WithdrawDialog.tsx
src/components/RefundRequestDialog.tsx src/pages/MyRegistrations.tsx
supabase/functions/withdraw-registration/index.ts supabase/functions/_shared/withdrawal.ts
tests/withdrawal.test.ts`) — zero errors/warnings (one `react-refresh/only-export-components`
error surfaced mid-work from the first `registrationLines` export attempt, fixed by relocating the
function rather than suppressing the rule). `npx vitest run` — 1276/1276 passed across 82 files
(+8 from the new `tests/withdrawal.test.ts`, on top of the 1268/81 baseline the receipt-PDF section
above recorded).

**Not applied**: migration `20260824100000_registrations_withdrawn_at.sql` — drafted only, per the
brief's "do NOT run any supabase CLI command." `withdraw-registration` is not deployed. Both need a
`migration-push`-skill staging-then-prod pass and a `supabase functions deploy withdraw-registration`
before this feature is live.

## Capacity rework T2 — wizard per-discipline cap editor (2026-08-24)

Branch `feat/capacity-rework`, on top of T1 (`940e825` — the engine reshape: per-discipline
`none`/`discipline`/`perLevel` modes, `total` removed, `capOf` whole-number-only). T2 is the
`EventWizard.tsx` UI: new files `src/lib/capacity-draft.ts` (pure state<->config mapping,
unit-tested) and its edits inside `EventWizard.tsx`.

**What changed, by area:**
- **State** (`EventWizard.tsx` ~344-362): `capacityTotal`/`capacityPerDiscipline`/
  `capacityPerLevel` string-map states replaced by one `capacityDraft: CapacityDraft` (from
  `capacity-draft.ts`), seeded via `capacityDraftFromEvent(seedEvt?.capacity, DISCIPLINES)` for
  all three disciplines (not just the currently-selected ones) so toggling a discipline off/on
  doesn't drop what was typed for it. `legacyTotal`/`legacyCapNoticeDismissed` drive the
  migration notice, read straight off the RAW `seedEvt?.capacity?.total` (never normalized —
  `normalizeCapacity` drops it on purpose).
- **UI**: the "Max total participants" input is gone. Each of the event's disciplines gets its
  own card: a 3-way radio (No cap / One cap for the whole discipline / Per-level caps) driving
  either nothing, one `Field` input, or one input per level (levels = `db.levels` filtered to
  that discipline and intersected with `allCompetingLevelIds`, same resolution the old per-level
  grid used). Labels read "Cap (routines)" with hint "One athlete on 4 apparatus counts as 4." —
  both routed through two module-level constants (`CAPACITY_UNIT_LABEL`/`CAPACITY_UNIT_HINT`) so
  a later athletes-vs-routines decision from the owners is a one-line change. Legacy-total notice
  uses the `--warn-50`/`--warn-200` box style already established in `Home.tsx`'s "Needs
  attention" card (dark `--ink` text on a light warm fill — resolved values checked, no
  same-color-on-same-color risk).
- **By-session mode hides the per-discipline chooser** (task's explicit instruction — session
  `maxRoutines` caps are the only knob there): the capacity section renders a one-line explainer
  instead of the discipline cards. **By-discipline mode hides the session-template editor**
  instead (sessions still exist underneath for results/squads, and by-discipline per-level caps
  still read their levels from those sessions) — replaced with a one-line explainer pointing at
  the "By session" toggle. Session STATE and its auto-seeding (`toggleDiscipline` /
  `defaultSessions`, still called regardless of mode) were untouched — only the JSX exposing the
  session cards is now gated on `registrationMode === 'by-session'`.
- **Validation** (submit function, `!isCamp && registrationMode === 'by-discipline'` branch):
  gates on `wizardRegsStatus === 'ready'` when editing (same guard idiom as the existing
  `canRemoveSession`), then calls `validateCapacityDraft(capacityDraft, usage, levelName)`.
  `usage` is `capacityUsage(editEvent, wizardEventRegs, groupsById, Date.now())` — the
  ENFORCEMENT tally (paid + live cart holds + live promoted-waitlist holds), deliberately NOT
  `paidUsage()`, per the brief: validating against paid-only usage would let a save undercut a
  spot already promised by a live hold, which then 409s that athlete's own checkout later.
  `groupsById` comes from `db.waitlistGroups` (a Tier-3 table, always loaded via `loadAll`/
  `syncFromSupabase` even though it's never persisted to localStorage — confirmed in
  `data-layer.md`/`store.ts`, no new fetch needed). `wizardEventRegs`/`wizardRegsStatus` were
  already in scope (existing `useEventRegistrations(editEvent?.id)` call feeding
  `canRemoveSession`) — no new data-fetching added to the wizard.
- **Write-out**: camps always write `capacity: undefined` (camps have no discipline/level to
  scope a cap to). By-session mode writes nothing for `capacity` at all — the
  `...(editEvent ?? template ?? {})` spread at the top of the saved `Event` object already
  carries forward whatever `capacity` the event had, since the chooser that would edit it is
  hidden in that mode. By-discipline mode writes `capacity: capacityConfigFromDraft(capacityDraft)`,
  which can be `undefined` (every discipline "No cap") or `{perDiscipline: {...}}` in the new
  shape only — never a `total` key.

**Deviations / judgment calls (flagging for review):**
- **Discipline "No cap" writes by OMISSION, not an explicit `{mode:'none'}` object.**
  `normalizeCapacity` reads both identically (a discipline absent from the map, or present with
  `mode:'none'`, both resolve to no configured cap), so this was a free choice — omission keeps
  the persisted jsonb smaller and never writes a stale `{mode:'none'}` object for a discipline
  nobody touched this save.
- **By-session mode capacity is pass-through, not cleared.** The alternative (wiping
  `perDiscipline` the moment an admin flips to by-session) risked silently discarding
  already-configured discipline/level caps on an accidental radio click, with no UI to see or
  undo it. This means a by-session event CAN still carry old `perDiscipline` caps enforced
  server-side alongside its session `maxRoutines` caps (T1's engine already treats these two
  dimensions independently — this predates T2 and isn't a new coupling). If the owners want
  by-session mode to force-clear discipline caps instead, that's a one-line change
  (`{ capacity: undefined }` instead of `{}`) in the write-out ternary.
  **Flagging for Nate/Julia**: is pass-through the right call, or should switching to by-session
  force-clear any existing per-discipline/per-level caps?
- **Per-discipline mode requires a value; per-level mode requires at least one filled level.**
  Selecting "One cap for the whole discipline" or "Per-level caps" and leaving every input blank
  is rejected at save time ("Enter a whole-number cap... or choose No cap" / "Enter at least one
  level cap... or choose No cap") rather than silently treated as equivalent to "No cap" — chosen
  so a mode selection is never a silent no-op that looks configured in the UI but enforces
  nothing.
- **Legacy-total notice is a plain `useState` dismiss (session-scoped), not persisted.** The task
  called it "one-time dismissible"; since the wizard is a modal/page instance freshly mounted
  each time it's opened, "one-time" was read as "goes away once you've seen and dismissed it in
  this edit session," not "never show again even next time you reopen this event's wizard" — the
  underlying legacy `total` value is still sitting in the stored jsonb until the admin actually
  re-enters caps below and saves (which overwrites `capacity` with the new shape and removes
  `total` for good), so re-showing it on a future open of the same still-unmigrated event seemed
  more correct than a localStorage flag that could outlive the thing it's warning about.

**Verification.** `npm run build` — succeeded, no TS errors. `npx eslint src/components/EventWizard.tsx
src/lib/capacity-draft.ts` — zero errors/warnings. `npx vitest run` — 1301/1301 passed across 83
files (+16 from the new `tests/capacity-draft.test.ts`: round-trip through `normalizeCapacity`,
legacy-shape mapping incl. the perLevel-wins-over-bare-number rule, 0/negative/fractional
rejection, missing-value-when-mode-selected rejection, and below-usage refusal with the exact
`{discipline, levelId?, used, message}` data for both discipline- and level-scoped caps).

**Not verified this session (controller's responsive sweep, per the brief):** the new
per-discipline capacity cards and the by-session/by-discipline collapse at 375/768/1280px,
contrast of the legacy-cap notice box in dark mode (`index.css` has no dark-mode override block
at all currently — worth confirming this app doesn't support a dark theme before treating that as
a gap), and an actual click-through of switching `registrationMode` back and forth to confirm the
draft/session state truly survives the round trip (unit tests cover the pure mapping only, not
the wizard's React state wiring).

## T3 — host/admin capacity progress summary (2026-08-24)

New pure module `src/lib/capacity-progress.ts` (`disciplineProgress`, `sessionProgress`,
`aaApparatusCount`) + new component `src/components/CapacityProgressCard.tsx`, wired into
`Events.tsx` right after `WaitlistCard`, same `canManage` gate, plus `event.eventType !== 'camp'`
and `hasCapacityConfig(event, event.sessions)` (competitions only, and only when there's actually
something to show progress against).

**Deviations from the brief, and why:**
- **Function signatures differ from the brief's literal `disciplineProgress(event, sessions, regs,
  groups, now)`.** `disciplineProgress` doesn't take `sessions` at all (by-discipline math never
  touches sessions) and takes `levels: Level[]` instead, so per-level rows can carry a real
  display name (`levels.find(l => l.id === levelId)?.name ?? levelId`) rather than a raw levelId
  — a pure function can't otherwise know level names, and `capacity.ts`'s own precedent ("pure
  modules take rows as parameters") made an extra plain-data parameter the natural fix rather than
  inventing a name lookup at the call site. `groups` is `groupsById: Record<string, WaitlistGroup>`
  (not an array) to match `capacityUsage`/`checkCapacity`'s own signature exactly — every existing
  caller in the codebase (`EventWizard.tsx`, `CapacityConflictDialog.tsx`,
  `RegistrationEditor.tsx`) already builds and passes it that shape.
- **`capOf`/`hasAnyCap` in `capacity.ts` are now `export`ed** (were private) so
  `capacity-progress.ts` validates caps with the exact same predicate as enforcement, rather than
  a hand-duplicated copy that could drift. No behavior change to either function.
- **The waitlist queue is read via `fetchEventWaitlist` (the same RLS-safe source
  `WaitlistCard` already uses), never a raw `db.waitlistGroups` read.** `waitlist_groups`' RLS
  (`20260711135842`) only exposes a group to its own club/person plus admins — a host-club
  manager (not also an admin) viewing THIS card would get an incomplete `db.waitlistGroups`,
  silently undercounting other clubs' promoted-hold routines in the "+H in carts/holds" sub-line
  and the by-session waitlist badge/overlay count. This is exactly the bug class `WaitlistCard`'s
  own doc comment already calls out; reusing its data source (`fetchEventWaitlist` →
  `queueRowToWaitlistGroup` adapter → `groupsById`) was cheaper and more correct than shipping a
  host-facing card with a known RLS-shaped undercount.
- **The AA-apparatus divisor excludes TNT's `SY` via an explicit exclusion set
  (`NON_AA_APPARATUS`), not a separate "AA apparatus list" data source.** `APPARATUS.TNT` has 4
  entries (TR/DM/TU/SY) but the brief's own worked numbers want 3 — SY (Synchro Trampoline) is a
  partnered team event within TNT, not an individual all-around event, mirroring
  `RegistrationEditor.tsx`'s existing "SY is an event within TNT, not its own discipline" comment.
  SY routines still count toward `paidRoutines`/the cap itself — only the *divisor* excludes them
  (tested: `TNT divisor 3: SY routines count toward the cap but not the AA divisor`).
- **The "assumes all-around" hint is shown ONCE per by-discipline section, not once per
  discipline block.** The brief said "include a small hint" per bar/discipline; with up to 3
  disciplines × several levels each, repeating identical boilerplate that many times seemed like
  worse UX than one hint at the top of the whole by-discipline view — the wording is generic
  enough ("totals assume every remaining registrant competes all-around") that it doesn't need
  per-row context.
- **`--sunk` didn't exist as a real token** — it only appeared in `docs/uat/build-artifact.py` /
  `docs/uat/ucg-preflight.html` (a separate UAT-report generator's own CSS, not this app's design
  system). Added it to `src/index.css` (`#eef1f4`, matching the approved prototype's own `.bar`
  background) as a proper token — recessed track surface, fill-only, documented — rather than
  either inventing an unrelated name or reaching for an existing ice/line token that wasn't quite
  right (`--ice-100` reads too close to `--surface` white; `--line` is a 1px-border weight, not a
  bar-sized fill). Bar fill: `--navy-800` normally, `--coral-600` at/over 100% (both fills-only per
  the brand rule — no text is ever rendered on top of either).
- **Percentage semantics:** by-session bars show "`{100 - pctUsed}`% of routines available" as the
  headline number (matches the brief's literal "62% of routines available" example) with a muted
  "`{routinesLeft}` routines left of `{totalCap}` · includes carts/holds" sub-line; the bar itself
  fills by `pctUsed` (conventional "fuller bar = more used"), not by the available percentage.

**Verification.** `npm run build` — succeeded, no TS errors. `npx eslint src/lib/capacity-progress.ts
src/components/CapacityProgressCard.tsx src/pages/Events.tsx src/lib/capacity.ts
tests/capacity-progress.test.ts` — zero errors/warnings (one intermediate `react-hooks/purity`
error caught and fixed: `Date.now()` can't be called directly in a component's render body —
switched to the `useState(() => Date.now())` lazy-initializer idiom already used by
`Cart.tsx`'s `HoldCountdown` / `Finance.tsx`). `npx vitest run` — 1317/1317 passed across 84 files
(+14 new in `tests/capacity-progress.test.ts`: the worked WAG 30/21/6→"6 of 8" example,
partial-apparatus mixes, MAG÷6, TNT÷3 with SY counted toward the cap but not the divisor, no-cap
discipline omission, holds delta, by-session-mode discipline-row suppression, per-level rows incl.
per-apparatus level-override attribution, a refunded-but-kept reg never counting as paid, and
session-row canonical apparatus ordering / omission-when-uncapped / enforcement-tally usage).

**Not verified this session (controller's responsive sweep, per the brief):** the by-discipline
and by-session card layouts at 375/768/1280px. Also not done: an actual signed-in click-through
against a live event — the local dev server's `.env.local` points at **prod** Supabase
(`wkyerxlgricfphopocoz`), and the only two seeded events with real registrants (Miscellaneous
Open 2026, UCG Nationals 2027) have no capacity config today; setting one just to screenshot the
card would have meant mutating a live event's registration behavior, which seemed like the wrong
tradeoff for a UI-only verification step. Contrast was checked by direct token/hex comparison
instead (`--ink`/`--ink-soft` on `--surface` white are pre-existing pairings used everywhere in
this app; `--coral-700` for error/negative text matches `WaitlistCard`'s own `loadError` styling
verbatim; the two progress-bar fills, `--navy-800`/`--coral-600`, never have text rendered on top
of them, so their own text-contrast rating doesn't apply).

## D-09 (whats-next §3.5): PWA "new version available" refresh prompt

**Why.** `vite.config.ts`'s `VitePWA` used `registerType: 'autoUpdate'` with the plugin's
default injected register script, which activates a newly-installed service worker (and
reloads the tab) with no notice at all, and gives a long-lived tab no way to learn about a new
deploy short of a manual full reload. On 2026-08-25 this cost the event owners a testing
session: the live site was 3 builds ahead of what their installed PWA showed.

**What changed.**
- `vite.config.ts`: `registerType: 'prompt'` (was `'autoUpdate'`) — a new worker now installs
  and waits; nothing activates it automatically. Left `workbox.skipWaiting`/`clientsClaim`
  unset (they default false for `generateSW`, and the plugin only force-sets them true when
  `registerType === 'autoUpdate'` — confirmed by reading `resolveOptions` in
  `node_modules/vite-plugin-pwa/dist/index.js`, not just the docs).
- New `src/lib/pwa-update.ts`: registers via `import { registerSW } from 'virtual:pwa-register'`
  and calls it once. `onNeedRefresh` pushes a toast ("A new version is available." + a
  "Refresh now" action calling `updateSW(true)`, which tells the waiting worker to
  `skipWaiting`+`clients.claim` then reloads). `onRegisteredSW` sets a `setInterval` calling
  `registration.update()` every 60 minutes, plus a `visibilitychange` listener that calls it
  immediately whenever the tab/PWA becomes visible again. `onOfflineReady` is wired but
  deliberately a no-op — a "ready to work offline" toast on a member's very first visit would
  be noise, not news, for an app most people use online; the hook is left in place rather than
  omitted in case that changes. `onRegisterError` forwards to the existing `reportError` sink
  (the durable, admin-searchable error log) instead of a bare `console.error`.
- `src/main.tsx`: calls `initPwaUpdatePrompt()` once at boot, alongside the existing
  `initFocusRefresh()` call — same "runs once for the app's lifetime, not per-render" shape.
- `src/vite-env.d.ts`: added `/// <reference types="vite-plugin-pwa/client" />` so
  `virtual:pwa-register` type-checks.
- `src/lib/toast-bus.ts`: `ToastOptions['action']` widened from `{ label: string; to: string }`
  to `{ label: string; to: string } | { label: string; onClick: () => void }` — the refresh
  action needs to run a callback (`updateSW(true)`), not navigate to a route. Safe to pass a
  function through `pushToast`/`subscribeToast`: the bus is in-memory pub/sub (direct listener
  calls), never a serialized channel, so a closure survives the trip intact.
- `src/components/ui.tsx`: `ToastItem.action` now aliases `ToastOptions['action']`; the
  existing action-button `onClick` branches on `'onClick' in t.action` vs falling through to
  the pre-existing `window.location.hash = t.action.to` route-hop. Styling (the `--ice-200`
  link-on-navy text, bold+underline) is untouched — reused as-is, since the new action renders
  through the exact same button markup as the existing "View cart" action.
- **No `sticky`/`persist` extension needed.** Checked `toast-bus.ts`/`ui.tsx` first per the
  brief's suggestion — toasts already never auto-dismiss (a UAT-era change: "the older `persist`
  option is accepted but now a no-op," per the comment already in `ui.tsx`). The update toast
  gets this for free.
- **No injectRegister change needed.** `vite-plugin-pwa` auto-detects an import from
  `virtual:pwa-register` anywhere in the client bundle and resolves its own `injectRegister:
  'auto'` default to `false`/`null` (no injected script tag) once it sees that import —
  confirmed in the build output: `dist/index.html` has no injected register script, and a new
  `workbox-window.prod.es5-*.js` chunk appears (the plugin's client runtime, pulled in because
  `main.tsx` now imports the virtual module). No manual `injectRegister` override was added to
  `vite.config.ts`.
- Extracted no pure decision logic to a testable module — there isn't any here. The only
  "decision" is which SW lifecycle callback fires, which is owned entirely by the browser's
  Service Worker/Workbox implementation, not app code; a unit test would just be re-asserting
  that `registerSW`'s options object has the keys it has. `npx vitest run` stayed at
  1317/1317 (no new test file).

**Verification.** `npm run build` — succeeded; `dist/sw.js` generated, precache **88 entries
(3537.25 KiB)**; confirmed `dist/sw.js` only calls `self.skipWaiting()` in response to an
explicit `SKIP_WAITING` postMessage (the `updateSW(true)` path), never unconditionally. `npx
eslint src/lib/pwa-update.ts src/lib/toast-bus.ts src/components/ui.tsx src/main.tsx
src/vite-env.d.ts vite.config.ts` — zero errors/warnings. `npx vitest run` — 1317/1317 passed
across 84 files (unchanged from the pre-existing baseline this notes file already recorded
above — no pure logic to add tests for).

**Confirmed the "Refresh now" mechanism actually reloads, not just guessed from docs.** Read
`node_modules/vite-plugin-pwa/dist/client/build/register.js` (the template the plugin compiles
into the `virtual:pwa-register` module): in non-`autoUpdate` mode, `showSkipWaitingPrompt`
registers a `wb.addEventListener('controlling', …)` handler — that calls
`window.location.reload()` on an update — **before** calling `onNeedRefresh()`. So
`updateSW()` posting `SKIP_WAITING` (confirmed separately: `dist/sw.js` only calls
`self.skipWaiting()` inside that message handler, never unconditionally) triggers the waiting
worker to activate, which fires `controlling`, which reloads the tab — the reload is wired by
the plugin's own listener, not by the `true` argument to `updateSW()` (that argument is
accepted for API compatibility but is a no-op in the installed version, `1.3.0`). Fixed the
code comment in `pwa-update.ts` to describe this chain accurately instead of just asserting
"activates + reloads" without saying how.

**Also added, past what the brief asked for, after tracing the same template file:** Workbox
re-fires its `waiting` event (which drives `onNeedRefresh`) for every new worker that reaches
the waiting state — a tab left open across two deploys without acting on the first prompt would
otherwise stack two identical sticky toasts, since toasts never auto-dismiss. `pwa-update.ts`
now guards with a `refreshPrompted` flag so it only prompts once per page load. Also throttled
the `visibilitychange` → `registration.update()` check to once per 5 minutes
(`VISIBILITY_CHECK_MIN_GAP_MS`) — deliberately much shorter than `focus-refresh.ts`'s 60s
`REFRESH_THRESHOLD_MS` since that module guards a real Supabase resync and this guards one
small conditional-GET, but alt-tabbing shouldn't fire a network request on every flip either.

**Cannot be verified locally — flagging plainly.** The SW update dance (install → waiting →
prompt → activate → reload) needs two real deploys of the built app served over the actual
`/ucg-platform/` scope; `vite dev`/`vite preview` against a single build never exercises the
"a second, newer SW registration exists" path at all.

**Important pre-condition the controller must not skip:** every install running today predates
this change entirely (the old `autoUpdate` bundle has no `pwa-update.ts`, no toast, nothing to
prompt with) — it will pick up this deploy itself silently (auto-reload, old behavior, one last
time) rather than showing the new "A new version is available." toast. **The first
post-deploy check has to confirm the client is running THIS build** (sidebar build stamp,
`Layout.tsx:19`, should read this commit's short SHA) before testing the prompt path at all —
otherwise step 2 below tests from a stale install and "no toast appeared" gets misread as a bug
in this change rather than as an expected one-time transition. **Manual verification the
controller should do after this ships to `main` and deploys:** (1) load the live site, confirm
the build stamp matches this deploy and `navigator.serviceWorker.controller` is set — this
IS the prompt-capable build now; (2) push a trivial follow-up change and let it deploy; (3)
either wait up to 60 minutes or bring the already-open tab back into focus at least 5 minutes
after the last check (covers the `visibilitychange` path without waiting the full hour); (4)
confirm the "A new version is available." toast appears once and stays until dismissed or acted
on (reload the tab and refocus again to confirm it does NOT reappear a second time for the same
waiting worker); (5) click "Refresh now" and confirm the tab reloads onto the new build (compare
the build-stamp SHA before/after). Also worth a manual check that a checkout in progress is
untouched by an update becoming available in the background — the whole point of `'prompt'`
over `'autoUpdate'` is that nothing forces a reload out from under that flow.

**Not touched:** `docs/plans/2026-08-21-uat-round1-triage.md` — grepped for `D-09` and found no
reference; this ticket originates from `whats-next.md` §3 item 5, not from the UAT triage list,
so there was nothing there to update.

## UAT round 2 (2026-08-25): four related auth fixes (A-01-02, A-06-02, A-07-01, A-11-02)

Branch `fix/uat-round2-auth`, cut from `main` after the controller had already fixed the
Supabase dashboard redirect allow-list (a bare `**` glob doesn't match a URL carrying a query
string, so `?setpw=invite`/`?setpw=reset` was being silently stripped in prod). This ticket makes
the client robust to that class of failure recurring, plus three adjacent findings.

### A-06-02: marker-independent reset/invite discrimination + the stranded-page bug

**Root cause #1 (defensive — the allow-list bug itself).** `SetPassword.tsx` trusted the
`?setpw=...` query marker alone to pick reset-vs-invite. New pure helper
`resolveSetPasswordFlavor(marker, sawPasswordRecoveryEvent)` (`src/lib/set-password-core.ts`,
tested in `tests/lib/set-password-core.test.ts`, 9 cases) adds a second signal for when the
marker is MISSING: `auth.ts` now captures whether a Supabase `PASSWORD_RECOVERY`
`onAuthStateChange` event fired this page load (new module-level flag `sawPasswordRecoveryEvent`,
exposed via `hasSeenPasswordRecoveryEvent()`). **Precedence, corrected on advisor review before
merge:** an explicit marker ALWAYS wins over the event, in either direction — `'invite'`/`'legacy'`
→ `'invite'`; `'reset'` → `'reset'`; only when there's no marker at all does the event fill in
`'reset'`. A first draft let the event override an explicit marker (matching the brief's literal
wording), which broke a real path: `invite-account` falls back to a Supabase RECOVERY-type link
(still marked `?setpw=invite`) whenever the invitee's auth user already exists, so a genuine
`PASSWORD_RECOVERY` event fires for a link that is legitimately an invite — overriding the marker
there would have silently sent that person Home after an email that told them they'd land on
Membership. Caught by the advisor before commit; two tests were flipped to encode the corrected
precedence and one added (`reset marker unaffected by the event either way`). **The
no-signal-at-all default still changed from `'invite'`/membership to `'reset'`/Home** — that part
of the original design was correct and is what actually fixes Julia's point of confusion.

**Root cause #2 (a REAL bug, independent of the allow-list — this is the actual "flash then
stranded" mechanism).** Traced `SetPasswordRedirect` (`App.tsx`) line by line: it force-navigates
to `/set-password` whenever `initialSetPwKind()` is truthy and the route isn't already
`/set-password`. `initialSetPwKind()` reads a page-load-scoped module constant that **never
clears itself once used**. So the moment `SetPassword.tsx`'s post-`updateUser()`
`navigate('/membership')` (or `/`) landed on the new route, this SAME effect's dependency-array
re-run saw "not on `/set-password`, marker still truthy" and immediately re-navigated BACK to
`/set-password` with `replace: true` — remounting `SetPassword` fresh (blank `pw`/`pw2`, `done:
false`) a few hundred ms after the "✓ Password set — taking you to membership…" flash. This
reproduces on EVERY real invite/reset link regardless of the allow-list bug — it was simply never
noticed before because nobody watched the page for another ~1.2s after the success flash
appeared. It was never a race in `SetPassword.tsx`'s own timeout/navigate call (confirmed by
reading — that call always fires correctly); the bug was entirely in `SetPasswordRedirect`
re-navigating back one render later. **Fixed** with a `reachedRef` guard: once the effect has
legitimately landed on `/set-password`, it never force-navigates back to it again for the rest of
that page load.

Also added `SetPassword.tsx`'s `navigate(..., { replace: true })` on the post-success call (was a
plain push before) — belt-and-suspenders once `SetPasswordRedirect` no longer fights it, and
consistent with treating that navigation as a one-way exit.

`.claude/rules/auth-and-mfa.md`'s "HashRouter vs Supabase implicit flow" section updated in place
with both mechanisms.

### A-07-01: all invite paths send the branded invite-account email

`AdminMembers.tsx`'s per-person "Invite"/"Resend" row action and the "+ New person" checkbox
(`onCreated` → `createAccountInvite`) used a separate `sendInviteEmail` that called the generic
`sendEmail` edge function with a plain-text signup-link body — landing on a generic signup screen,
not a real set-password link. `src/lib/supabase.ts` already had an `inviteAccount()` wrapper for
the `invite-account` edge function (used by `Club.tsx`'s manager-side "add athlete") — no new
wrapper needed. Rewired `sendInviteEmail` (AdminMembers.tsx) to call `inviteAccount()` instead,
mapping `p.mainClubId ?? ''` → `clubId`, `p.kind` → `kind`.

**Deviation the brief anticipated but got backwards for AdminMembers specifically:** the
`invite-account` edge function required `clubId` unconditionally (400 without one), but
AdminMembers can invite an **Independent Athlete** (`mainClubId: null` — a real, common case per
`PersonForm.tsx`'s "No club" checkbox). Made `clubId` conditional in
`supabase/functions/invite-account/index.ts`: a club-manager caller (not admin) still MUST supply
one (it's the only thing their authorization check can run against); an admin caller may omit it
entirely. When updating an EXISTING unclaimed person row, `main_club_id` is only touched when a
`clubId` was actually supplied — omitting it (independent invite) never clears a club affiliation
the caller doesn't know about. Email copy/subject adapted to read naturally with `club: null`
(drops the "(short_name)" suffix and the "sent to club cart" clause).

**Kept, not removed:** `pushAccountInvite`/`db.accountInvites`/the `AccountInvite` type. Grepped
every reference — `person-data.ts`'s `collectPersonData` (GDPR export) and
`person-export.ts`'s "Account invites: N" line both read `db.accountInvites` for a person's data
export, so the table isn't dead. It's now bookkeeping only (pending-invite dedup + the
Invite/Resend button swap on the Members page) — the row it writes no longer carries its own
separate email; `sendInviteEmail`/`inviteAccount()` handles that entirely.

**Second bug caught on advisor review: email-only person resolution could hit the wrong row.**
`invite-account`'s existing person lookup was "oldest unclaimed row matching this email" — fine
for `Club.tsx`'s manager-side "add athlete" (no specific person in hand yet), wrong for
AdminMembers.tsx, which already has an exact `Athlete` row (`p`) and can pass its id.
Duplicate-email people are explicitly a real, supported case (the schema migration's own comment,
plus the fact this very page ships a "Merge duplicates…" tool) — email-only matching could
silently stamp `auth_user_id` onto a DIFFERENT row than the one the admin clicked "Invite" on,
leaving `p` still showing "No account" while the toast claims success. Fixed: `inviteAccount()`
(`src/lib/supabase.ts`) gained an optional `personId`; `AdminMembers.tsx`'s `sendInviteEmail`
passes `p.id`; `invite-account/index.ts` resolves the exact row by id when supplied, falling back
to the email lookup only when it's absent (Club.tsx's call site, unchanged).

**Third issue caught on review: `SignupLandingRedirect`'s guard could make the A-01-02 landing
fix silently inert.** First draft latched its `doneRef` at the moment `navigate('/me')` was
CALLED, not when the app actually arrived there. `auth-and-mfa.md`'s own documented mechanism
(auth-js's `window.location.hash = ''`, fired after its `_getUser` network round trip, bouncing
HashRouter back to `/`) can land AFTER this effect first runs — if that bounce arrived before the
guard's `navigate` call was ever observed to take effect, the effect would see `doneRef.current`
already true and never retry, landing back on Home with the fix having done nothing. Fixed to
match `SetPasswordRedirect`'s own shape exactly: the ref latches on OBSERVED ARRIVAL at `/me`
(`location.pathname === '/me'`), not on dispatch — `navigate()` updates `location.pathname` on
the very next render, well before the network-bound bounce could land, so the effect reliably
latches first; even in a race, latching on arrival rather than dispatch means a bounce back to
`/` before that observation just lets the effect fire `navigate('/me')` again instead of getting
permanently stuck.

**Fourth issue caught on review: an unguarded `Promise.all` could wedge every admin page behind
an infinite loader.** `useAdminMfaSatisfied`'s new `Promise.all([listFactors(), passkey.list()])`
had a `.then()` but no `.catch()` — if either call REJECTED (rather than resolving `{error}}`,
which auth-js's own methods normally do, but a network-level throw is possible), `hasTotp`/
`hasPasskeyCredential` would stay `null` forever, and the hook returning `null` forever makes
`RequireAdmin` render `<PageFallback/>` forever on every `/admin/*` route — directly contradicting
the surrounding comment's own stated invariant ("an indefinite spinner ... is not [escapable]").
Added a `.catch()` that resolves both to `false` (same as the existing `{error}` branches), so a
hard failure degrades to "show the block panel" (escapable — links to `/me` and Home), never to
an infinite loader.

**Functions to deploy:** `invite-account` (clubId now optional; personId now accepted).

### A-11-02: enrolling a passkey unlocks admin pages immediately

`useAdminMfaSatisfied` (`src/lib/mfa.ts`) computed `hasPasskey` off
`aal.methods.includes(PASSKEY_AMR_METHOD)` ONLY — the CURRENT session's sign-in method. Enrolling
a NEW passkey via `ProfilePasskeys.tsx` while still signed in with a password doesn't change how
that session authenticated, so the gate stayed blocked until sign-out/sign-in with the passkey —
exactly Julia's report.

**Fix, two parts:**
1. New pure `hasPasskeySatisfaction(hasPasskeyCredential, authMethods)` (`src/lib/mfa-core.ts`,
   tested — 4 new cases in `tests/lib/mfa-core.test.ts`): true if
   `supabase.auth.passkey.list()` (the SAME list `ProfilePasskeys.tsx` already renders) returns
   any credential, OR the session AMR exemption. `useAdminMfaSatisfied` now fetches
   `mfa.listFactors()` and `passkey.list()` in parallel and combines them through this function —
   still a pure CONSUMER of mfa-core.ts, never reimplementing the check.
2. New `notifyMfaEnrollmentChanged()` signal (`mfa.ts`, `useSyncExternalStore`-based, mirrors the
   listener-set idioms already in `auth.ts` — no polling): `ProfileMfa.tsx` calls it after TOTP
   verify/unenroll, `ProfilePasskeys.tsx` after passkey add/remove. `useAdminMfaSatisfied`
   subscribes and re-runs its fetch effect on every bump. This matters because `RequireAdmin`
   (and the hook inside it) only remounts on navigating AWAY from and back to an admin route —
   without the signal, enrolling in `/me` in a second tab while `/admin/*` stays open in the
   first would never pick up the change at all, remount or not.

### A-01-02: signup name reaches the person row; post-confirmation lands on Profile

Traced `link_or_create_person` (`supabase/migrations/20260601000005_account_foundation.sql`):
defaults an empty `p_first`/`p_last` to `'New'`/`'Member'` — that's the literal source of "New
Member" people. `Gate.tsx` already stashed the entered name in localStorage before calling
`signUp()`, and `auth.ts`'s `onAuthenticated()` already read it — so the mechanism worked when
sign-up and confirmation happen on the SAME device/browser. The gap: the confirmation link opened
on a DIFFERENT device/browser (a mail app that opens a different default browser, a different
device entirely, private browsing) never had the localStorage stash to begin with, so it silently
fell through to the RPC's "New"/"Member" default.

**Fix (no DB migration needed):** `Gate.tsx`'s `signUp()` call now ALSO passes
`options.data: { first_name, last_name, kind }` — Supabase stores this as `user_metadata` on the
auth user server-side, already present on the session's `user` object with zero extra round
trips. `auth.ts`'s `stashedName()`/`stashedKind()` now accept the `user` and fall back to
`user.user_metadata` when the localStorage stash is missing, before ever reaching the RPC's
`'New'/'Member'` default.

**Landing page:** a brand-new signup confirmation lands with `#access_token=...&type=signup` and
previously fell through to Home with zero special handling — but Gate.tsx's sign-up form never
collects dob/state/club/etc., so the profile is ALWAYS incomplete right after confirmation.
`initialAuthCallbackType()` (new export, `auth.ts`) captures the hash's `type=` param once at
module load (same once-only rationale as the existing `initialSetPwKind`); new
`SignupLandingRedirect` (`App.tsx`, mirrors `SetPasswordRedirect`'s "reached-once" `useRef` guard
shape, mounted as its sibling outside `<Routes>`) sends a `type === 'signup'` landing to `/me`
once instead of Home. Reset/invite links never carry `type=signup` (they use the app's own
`?setpw=...` marker via a custom `redirectTo`), so the two redirect components never compete.

### Verification

Two full passes: once after the initial implementation, once after the advisor review caught the
four issues documented above (precedence flip, `personId` targeting, `SignupLandingRedirect`'s
latch timing, the unguarded `Promise.all`) and they were fixed. Final numbers below are from the
second pass.

`npm run build` (`tsc -b && vite build`) — succeeded, zero TypeScript errors. `npx eslint
src/lib/auth.ts src/App.tsx src/pages/SetPassword.tsx src/lib/set-password-core.ts
src/pages/admin/AdminMembers.tsx src/pages/Gate.tsx src/lib/mfa-core.ts src/lib/mfa.ts
src/pages/ProfileMfa.tsx src/pages/ProfilePasskeys.tsx src/lib/supabase.ts
supabase/functions/invite-account/index.ts tests/lib/mfa-core.test.ts
tests/lib/set-password-core.test.ts` — zero errors/warnings. `npx vitest run` — 1329/1329 passed
across 85 files (+13 from this ticket: 5 in `tests/lib/mfa-core.test.ts`'s new
`hasPasskeySatisfaction` describe block, 8 in the new `tests/lib/set-password-core.test.ts`,
including the corrected precedence cases and the added "reset marker unaffected by the event
either way" case).

**Flows that need a live email round-trip and could NOT be verified here** (no live Supabase
project attached to this session; the controller/owners will re-test): A-06-02's actual invite
and reset email links end-to-end (marker survival post-allow-list-fix, the PASSWORD_RECOVERY
event firing, the no-longer-stranding redirect); A-07-01's AdminMembers "Invite"/"Resend"/"+ New
person" buttons actually sending the branded `invite-account` email (independent-athlete case
especially, since that's the new code path); A-11-02's passkey-enrollment-unlocks-admin-pages
behavior end-to-end (requires a real WebAuthn ceremony); A-01-02's cross-device signup
confirmation (requires two actual browsers/devices) and the `/me` landing after a real email
click. `invite-account` needs redeploying before A-07-01 works in prod (clubId is now optional
server-side; the currently-deployed function still 400s an omitted clubId).

## UAT round 2 (2026-08-25): checkout line-item amounts + Club Registrations tabs (M-02-03, M-01-05)

Branch `fix/uat-round2-ui`, cut from `main`. No migration. **`create-checkout-session` DOES need
redeploying** — a reviewer pass on the first draft (below) caught a real coupon-math bug in its
preview branch; see M-02-03.

### M-02-03 (S3): checkout summary line item with no amount

**Root cause:** `CartCheckout.tsx`'s item list (the one rendered above the Subtotal/Coupon/
Service fee/Total block) was a plain label-only render —
`items.map((i) => <li><span>{i.label}</span></li>)` — with no amount span at all, for ANY line,
ever. Confirmed via `git log -p` on the file: this was never a regression, the amount was simply
never wired up (`git log --all -p -- src/components/CartCheckout.tsx | grep 'i\.amount\|i\.label'`
shows only the bare `i.label` render across every version of the file). Julia's screenshot showing
"one line with no amount, subtotal/fee/total correct" is consistent with a cart that happened to
have one line item — the bug isn't line-kind-specific, it's the whole list.

The server side (`create-checkout-session`'s `PREVIEW BRANCH POINT` return, `index.ts:1076-1080`)
was already complete: `previewLines = items.map((i) => ({ itemId, label, amountCents }))` — one
entry per ORIGINAL cart item, including $0 host-club/already-covered lines, priced exactly as a
real checkout would charge. `CartPreviewLine` (`src/lib/supabase.ts`) already typed this
correctly. So no line kind was actually missing its per-line cents on the wire — the client just
never read them.

**Fix:** `CartCheckout.tsx` now threads the preview's `lines: CartPreviewLine[]` through to
render, instead of the `items` prop (client-only, display-only `.amount` — money-invariants.md
already forbids treating it as authoritative, and it was never even rendered). Wrinkle: the REAL
(non-preview) `createCheckoutSession` response carries no `lines` field of its own, only
aggregate `amountSubtotal`/`discountAmount`/`serviceFee` — by design, since only preview mode
returns a per-line breakdown. Since this component ALWAYS calls `mode:'preview'` first (UAT
M-12-01's `startPreview`) before ever calling the real endpoint, `startRealSession` now takes the
already-fetched `lines` as a parameter and carries it onto the resulting `checkout`/`free` stage
— same items, same coupon, same deterministic server-side pricing recompute, so it's exactly what
a preview taken at that instant would show. Added `lines: CartPreviewLine[]` to the `confirm-free`
/ `checkout` / `free` `Stage` variants; the actual item-list JSX now maps `stage.lines` (`itemId`,
`label`, `amountCents`) with `fmtMoney(amountCents / 100)` instead of `items`.

**Reviewer catch (this is the part that DOES need a function deploy):** the first draft above
took `previewLines[].amountCents` verbatim from the preview response's existing
`paidCentsByItem.get(i.id) ?? serverCentsByItem.get(i.id) ?? 0` — which is POST-discount (the
coupon-allocation loop mutates `lines[].cents` in place before `paidCentsByItem` is built from
it). But the summary block's `Subtotal` row renders `amountSubtotal` = `preDiscountSubtotalCents`
— PRE-discount — with the coupon shown as its own separate `−Coupon` row. So with a coupon
applied, Σ(rendered line amounts) = Subtotal − Discount, and the UI then shows the discount
subtracted a SECOND time visually: the lines no longer sum to the Subtotal figure directly above
them. The Total stayed correct throughout (it's computed from the three aggregate fields, never
from summing the lines) — this was purely a breakdown-legibility bug, but exactly the kind Julia's
ticket was about, and it was invisible before this fix simply because no line showed an amount at
all. Only reachable via the "Apply" promo-code path (the mount-time preview never carries a
coupon), which is exactly the path M-02-03 is about.

**Real fix:** `create-checkout-session`'s preview branch (`index.ts`, inside `if (isPreview)`) now
returns `serverCentsByItem.get(i.id) ?? 0` — the PRE-discount list price — instead of
`paidCentsByItem`'s post-discount cents. This matches the convention already established
elsewhere for `amount_cents`/`invoice_items.amount` (money-invariants.md: a coupon is its own
negative row, never baked into a line's own amount) and is what the receipt/invoice modals already
render. Verified this is a safe, non-breaking change for the ONE other consumer of this same field:
`Cart.tsx`'s own per-line `pricedAmount()` (the /cart page's own line list, separate from
`CartCheckout`) reads `preview.lines[itemId].amountCents` too, via a `previewCartTotal()` call that
**never passes a `couponCode`** (`Cart.tsx:327`) — so `serverCentsByItem === paidCentsByItem` for
every line on that call regardless of this change; `diffCartLinePrices` sees the same unaffected
values. `CartPreviewLine`'s doc comment (`src/lib/supabase.ts`) now states the pre-discount
convention explicitly. `CartCheckout.tsx`'s per-line render also now shows "Included" instead of
"$0.00" for a $0 line (host-club free entry, or the non-dearest type in a grouped membership
purchase) — a one-line addition once the amounts were rendering in the first place.

**This touches a money-invariants.md-scoped file** (`create-checkout-session`), so per CLAUDE.md
model routing this diff needs the controller's own reviewer-tier adversarial review before
merge/deploy — not delegable to this sonnet session. **`create-checkout-session` needs
redeploying to prod (and ideally verified on staging first)** before this fix is live; until then,
the coupon-applied breakdown-math bug above is still live in prod, and the client CHANGE alone
(already on this branch) would otherwise ship a per-line display that's wrong whenever a coupon is
applied — the two need to land together.

No new pure logic was introduced for this half of the fix (the discount-vs-list-price selection is
a one-line change to code inline in the edge function, mirroring an existing convention rather than
adding a new one) — coverage stays at build+eslint+full-suite pass; no edge-function-level test
harness exists in this repo to add a targeted unit test to.

### M-01-05 (D, approved): Club Registrations page → three tabs

`Club.tsx`'s `EventRegGrid` (`/club/:clubId/registrations`) used to stack every card in one long
scroll. Reused the existing `Tabs` component (`src/components/ui.tsx`, the same one
`AdminErrors.tsx` uses for its Problem Reports/Error Log tabs — plain button-based `.tabs`/`.tab`
classes, already `flex-wrap: wrap` in `index.css` so 375px wraps rather than overflowing; no new
CSS needed) rather than hand-rolling a new tab pattern.

Three tabs, `useState<'reg' | 'addons' | 'order'>('reg')`, default `'reg'`:
- **Athlete Registrations:** Registered, Ready to register, No athlete membership cards, in that
  order — unchanged content/gating.
- **Add-Ons:** `ClubAddonsCard`, still `key={event.id}` (unchanged — resets the in-progress draft
  on event switch).
- **Competition Order:** `CompetitionOrderCard`. Gated off entirely for camps
  (`event.eventType !== 'camp'` is one of three `showOrderTab` conditions), per the spec. **The
  camp half of this gate is currently unreachable dead code in practice** — `openEvents` (this
  same file, just above) already filters `eventType !== 'camp'` out of the picker entirely
  (registrations-and-camps.md: camps are individual self-registration only), so `event` can never
  actually resolve to a camp on this page today. Added anyway per the explicit spec line, as a
  belt-and-suspenders match to `clubMembershipBlocked`'s own carve-out comment just above it in the
  same file.

**Reviewer catch #1 — tab switch was blowing away in-progress drafts.** The first draft used
plain `{activeTab === 'x' && (<Card/>)}` conditional rendering, which UNMOUNTS a tab's content the
moment you leave it. `ClubAddonsCard` and `CompetitionOrderCard` each hold real local state (the
add-on unit picker's `draft`; the chosen competition-order `levelId`) — a manager who picks six
shirt sizes and banquet assignees, glances at another tab, and comes back would find
`initialClubAddonDraft()` again. Fixed by keeping all panes MOUNTED once shown at all and toggling
visibility with `style={{ display: activeTab === 'x' ? undefined : 'none' }}` instead — same
pattern applied to the Athlete Registrations pane too for consistency (its cards are stateless, so
this is a perf/simplicity choice there, not a correctness fix).

**Reviewer catch #2 — a tab button could point at an empty pane.** `ClubAddonsCard` already
self-gates to `null` when no add-on purchase window is open; `CompetitionOrderCard` self-gates to
`null` when the club has no non-refunded MAG/WAG registrations at this event (or the viewer isn't
a manager). The first draft still always showed both tab buttons regardless — a manager could
click into a genuinely blank pane. Fixed by computing `showAddonsTab`/`showOrderTab` in
`EventRegGrid` itself, mirroring each card's own gating condition (`anyAddonWindowOpen(event, now)`
for Add-Ons; a `MAG`/`WAG`/non-refunded/non-waitlisted `clubRegs` check mirroring
`CompetitionOrderCard`'s own `levels.length === 0` early-return, for Competition Order) and
omitting the tab button from `tabItems` entirely — not just hiding its content — when there's
nothing to show. `activeTab` clamps back to `'reg'` if the currently-selected tab's `show*Tab`
flips false out from under it (e.g. the manager leaves the page open across an add-on purchase
window closing).

**Deep links:** grepped every entry point into this page
(`grep -rn "club/.*registrations" src`) — the ONLY one that targets anything more specific than
the bare route is the Events-list "Register your club" / "Edit" flow's `?event=<slug>` query
param (`Events.tsx`), which preselects which EVENT shows, not a card. No hash/anchor/scroll target
exists into any specific card. Default tab `'reg'` already matches where that flow always landed
(the registration cards were always first on the page), so no extra routing logic was needed to
satisfy "deep links must land on the right tab."

**Blind spot flagged, not asked about beforehand (spec didn't name these):** three cards render
only for `event.kind === 'nationals'` and weren't in Julia's three-tab/five-card list —
`SessionRequestSurveyCard` (session-planning survey, gates checkout), `NationalsDashboard`
(read-only team/session planning summary), `EventCheckinCard` (nationals check-in), plus the
"Waitlist spots opened!" promoted-group banner (not nationals-specific). All four were placed in
the **Athlete Registrations** tab, in their original relative order, ahead of the Registered card
— they're all either registration-blocking or registration-adjacent for this club's athletes.
Flagging this call explicitly since it wasn't spec'd: if the intent was e.g. `NationalsDashboard`
belonging with Competition Order instead (it does surface "assigned sessions"), that's a one-tab
move.

**New pure logic:** `addonUnitSort` (`src/lib/pricing.ts`) — the Add-Ons tab's "Purchased
add-ons" list now sorts by type (tshirt, banquet, banner, leo — unknown types sort last) then
alphabetically by assignee name within a type, per spec. Only banquet units carry a real assignee
(`addonAssigneeId`); tshirt/banner units resolve to `''` for the comparator and group together.
Pure, no lookups of its own — `Club.tsx` resolves each item's `assigneeName` via the existing
`nameOf` helper before calling it. 5 new tests in `tests/pricing.test.ts`'s new
`describe('addonUnitSort ...')` block.

### Verification

Two passes: the initial implementation, then a reviewer pass (advisor tool) that caught the
coupon-math bug and the two tab-mounting issues documented above. Numbers below are from AFTER
those fixes.

`npm run build` (`tsc -b && vite build`) — succeeded, zero TypeScript errors.

`npx eslint src/components/CartCheckout.tsx src/pages/Club.tsx src/lib/pricing.ts src/lib/supabase.ts
tests/pricing.test.ts supabase/functions/create-checkout-session/index.ts` — zero
errors/warnings.

`npx vitest run` — 1334/1334 passed across 85 files (+5 from this ticket, all in
`tests/pricing.test.ts`'s new `addonUnitSort` describe block; `pricing.test.ts` itself now 141
tests).

**`create-checkout-session` needs a reviewer-tier adversarial review (money-invariants.md — not
delegable to this session) AND a deploy to prod before the M-02-03 fix is actually correct in
production** — right now only the client half of the fix is live on this branch; deploying the
client alone without the function change would make the coupon-applied line-math bug WORSE (a
customer would see per-line amounts that visibly don't sum to the Subtotal, where before they saw
no per-line amounts at all).

**Could not be verified here (no Browser pane available to this session):** the actual rendered
checkout summary against a live coupon (real cart, real Stripe test-mode session, a code that
discounts one of several lines) — the exact scenario the coupon-math bug lived in — and the tabs'
visual/responsive behavior at 375/768/1280px, including tab-bar wrapping and that a draft survives
a tab switch. Flagged for the controller's own responsive-sweep pass. Routes to check:
`/club/:clubId/registrations` (tabs — try a MAG/WAG event for all three tabs including switching
away from and back to Add-Ons mid-draft, a T&T-only event to confirm the Competition Order TAB
BUTTON itself is now absent rather than just its content, an event with no open add-on window to
confirm the same for Add-Ons, and ideally a nationals event to eyeball the blind-spot placement
above) and `/cart` + `/club/:id/cart` (both route through the same `CartScope`/`CartCheckout`, so
either surfaces the M-02-03 fix — a cart with a $0 host-club line is worth checking specifically
(should read "Included"), and — once `create-checkout-session` is redeployed — a cart with a
partial-discount coupon applied, to confirm the line amounts now sum to the Subtotal row above
them).

### M-01-05 spec-mismatch fix (2026-08-25, branch `fix/addons-tab-visibility`, off merged main)

Controller review of the merged M-01-05 work found one more gap: `showAddonsTab = canManage &&
anyAddonWindowOpen(event, now)` hid the Add-Ons tab entirely once every purchase window closed —
but Julia's spec explicitly includes the ALREADY-PURCHASED units view (sorted by type then
assignee), which a manager still needs after an event's windows close (e.g. to see what the club
bought for "Miscellaneous Open 2026" after Sep 4).

Extracted `ClubAddonsCard`'s existing "Purchased add-ons" derivation into a new pure
`clubPurchasedAddonUnits(invoices, clubId, eventId)` (`src/lib/pricing.ts`) rather than inventing
a second one — `EventRegGrid`'s `showAddonsTab` now also passes when this returns a non-empty
array. `db.invoices` is boot-scoped (not a fetch-on-mount slice), so `EventRegGrid` could call it
directly with no extra fetch.

**Found a second instance of the same bug while wiring this up:** `ClubAddonsCard`'s OWN early
return (`if (!canManage || (!tshirtOpen && !banquetOpen && !bannerOpen)) return null;`) had the
identical flaw — even with the tab now visible, the card itself would still render nothing once
every window closed, since its bail-out never considered purchased units either. Moved the
`purchasedItems` computation above that early return (it doesn't need `nameOf`/`effectivePeople`,
only the later sort does) and added `&& purchasedItems.length === 0` to the bail condition. The
purchase/add affordances (`SizedAddonPicker`, the banner text field, "Add to cart") are each
already individually gated on their own `tshirtOpen`/`banquetOpen`/`bannerOpen` flag inside the
render — untouched by this fix, so they still disappear correctly once their window closes; only
the card's outer visibility changed.

**Minor residual, not fixed:** the card's static intro copy ("Purchase t-shirts, banquet tickets,
and a club banner for this event.") still shows even in the window-closed/purchased-only state,
where it reads a little oddly since nothing is purchasable anymore. Left as-is — out of scope for
this fix, flagging for a future pass if it bothers anyone in practice.

Verification: `npm run build` (zero TS errors), `npx eslint src/pages/Club.tsx src/lib/pricing.ts
tests/pricing.test.ts` (zero errors/warnings), `npx vitest run` — 1340/1340 passed across 85 files
(+6 new `clubPurchasedAddonUnits` cases in `tests/pricing.test.ts`).

### Sanction voting quorum fix (2026-08-26, branch `fix/sanction-quorum`, off `main`)

**The bug (UAT round 2).** `Sanction.tsx` hardcoded `FALLBACK_TEAM_SIZE = 5` (with a live TODO)
and floored the team size at that constant, so `tallyVotes`'s early-approval threshold
(`ceil(2/3·teamSize)`) demanded 4 approvals against the real 2-person Sanctioning Team —
mathematically unreachable, blocking early approval outright. Separately, `capabilities-core.ts`'s
`isSanctioning = isAdmin || roles.includes('sanctioning')` and `sanction_votes_write`'s
`role in ('admin','sanctioning')` let ALL 4 admins vote, not just the 2 actual Sanctioning Team
members.

**Owners' decisions implemented exactly:** team size = the live count of
`user_roles.role = 'sanctioning'`, never a hardcoded fallback; only the `'sanctioning'` role may
vote (admins keep full visibility, not vote authority — an admin who also holds `'sanctioning'`
votes normally); unanimity at small team sizes (`ceil(2/3·2) = 2`) is intentional, no special case.

**`user_roles` RLS check (required by the brief):** `roles_self_read`
(`20260601000002_rls.sql`) is `user_id = auth.uid() or is_admin()` — a non-admin sanctioning
member can only read THEIR OWN role row, not count every sanctioning row. So a plain client-side
count isn't possible; added the SECURITY DEFINER RPC `sanctioning_team_size()` (same fail-closed
shape as `next_invoice_number`/`list_sanctioning_team`: `is_admin() or auth_has_role('sanctioning')`
gate, `set search_path = public, pg_temp`, PUBLIC/anon execute revoked, `authenticated` granted).

**Files changed:**
- `src/lib/sanction.ts` — `tallyVotes(votes, teamSize: number | null, nowISO, deadlineISO)`:
  `teamSize: null` (RPC unavailable) disables early approval entirely without guessing a number;
  the at/after-deadline majority path is unaffected. Also adds three pure helpers for the
  deadline-editor scope addition below: `deadlineEditable(status, canVoteSanction)`,
  `deadlineToLocalInputValue`/`localInputValueToDeadlineISO` (real UTC-instant to
  browser-local `datetime-local` conversion).
- `src/lib/capabilities-core.ts` — new `canVoteSanction: boolean` capability
  (`roles.includes('sanctioning')`, admin alone does NOT grant it). `isSanctioning` is UNCHANGED
  (still `isAdmin || roles.includes('sanctioning')` — visibility only: queue/detail/tally).
- `src/lib/supabase.ts` — `sanctioningTeamSize(): Promise<number | null>`, wraps the new RPC;
  returns `null` (never a guessed number) on error/unconfigured.
- `src/pages/Sanction.tsx` — deletes `FALLBACK_TEAM_SIZE` and the `distinctVoters` floor;
  `SanctionVotePage` fetches team size once per request view via a plain `useState`/`useEffect`
  (no new store slice, per the brief). Vote controls (radio group + Cast/Update button) gated on
  `caps.canVoteSanction`; an admin-without-sanctioning sees "Voting is limited to the Sanctioning
  Team." instead. Tally card shows "team size unavailable — early approval disabled" when
  `teamSize === null`. New "Voting Deadline" card (scope addition, see below).
- `supabase/functions/scheduled-dispatch/index.ts` — `resolveSanctioningTeam`'s query narrowed
  from `role in ('sanctioning','admin')` to `role = 'sanctioning'` only, applied to ALL THREE
  reminder stages it feeds (3d/1d "you haven't voted" + "voting closed, finalize") — an admin
  without the sanctioning role can neither cast a vote nor finalize one (finalization is only a
  side effect of (re)casting a vote in `Sanction.tsx`'s `castVote`), so nagging them was never
  actionable for either kind of reminder, not just the 3d/1d one.
- `supabase/functions/notify-sanction/index.ts` — comment-only clarification; the 'submitted'/
  'approved'/'rejected' recipient audiences are UNCHANGED per the brief (informational, admins may
  legitimately stay on them).
- New migration `supabase/migrations/20260826000000_sanction_voting_lockdown.sql` (see below).
- `supabase/README.md` — migration table row added.
- Tests: `tests/sanction.test.ts` (teamSize-2/3 cases, `teamSize: null` cases,
  `deadlineEditable`, the deadline to local-input conversion incl. a timezone-independent
  round-trip), `tests/lib/capabilities-core.test.ts` (`canVoteSanction` admin-only/
  sanctioning/admin+sanctioning/neither).

**Deviation worth flagging:** the brief said the notification-recipient fix was scoped to "the
`scheduled-dispatch` voting-reminder" (singular). That function actually sends THREE stages off
the same `teamRecipients` list — 3d, 1d, and "voting closed, finalize." I narrowed all three, not
just 3d/1d, because the "closed" nudge is exactly as unactionable for an admin-only recipient as
the 3d/1d nag: `Sanction.tsx` has no separate "finalize" control — the only way a decided-at-
deadline tally gets written is a sanctioning voter (re)casting their own vote, which an admin
without that role literally cannot do. Sending it to an admin who can't act on it seemed clearly
wrong given the explicit "an admin who can't vote must not be nagged to vote" principle, but
flagging the interpretation call in case the controller wants notify-sanction-style admin-
inclusive behavior there instead.

### Scope addition: Sanctioning Team deadline editor (same session, owners approved 2026-08-26)

Added mid-task by the controller: a Sanctioning Team member can move a request's voting deadline
from the vote page (unblocks a stuck vote by moving the deadline into the past).

- Gated on `canVoteSanction` (not `isSanctioning`) and `status === 'voting'` via the new pure
  `deadlineEditable(status, canVoteSanction)` — an admin-only viewer or a decided request gets a
  read-only value, never the Edit button.
- **RLS finding (per the brief's "check first"):** `sanction_requests_rw`
  (`20260618200000_event_management.sql`) is already a single `for all` policy admitting
  `role in ('admin','sanctioning')` with NO status restriction — a plain sanctioning caller can
  ALREADY update `deadline_at` (or any other column) on any row. **No RLS change was needed** for
  this feature; documented this finding in the new migration's header comment and in
  `supabase/README.md` rather than silently narrowing a pre-existing broad policy that governs
  more than just this one field (out of scope for this fix).
- `deadline_at` is a REAL UTC instant (`addDays(nowISO, 7)` via `toISOString()`), NOT the
  naive-local wall-clock convention `regOpens`/`finalsLineupDeadlineAt` use elsewhere in the app
  (see `toDatetimeLocalValue`'s doc comment in `events-core.ts`) — so the `datetime-local` input
  needed a REAL zone conversion (`deadlineToLocalInputValue`/`localInputValueToDeadlineISO`), not
  a truncation. Labeled with the viewer's actual browser IANA zone
  (`Intl.DateTimeFormat().resolvedOptions().timeZone`), matching the brief's "viewer's local
  timezone" instruction — this is deliberately DIFFERENT from the rest of the app's
  `(event's derived timezone)` labeling convention (`EventWizard.tsx`'s `regOpens`/
  `finalsLineupDeadlineAt` fields), which is correct there only because those fields are
  naive-local-to-the-EVENT, not real instants.
- Setting a past deadline is allowed and not validated away; an inline warning shows when the
  draft value is in the past ("the vote will be decided by a simple majority of votes already
  cast").
- Save writes `deadline_at` via a whole-row `mutate()` + `pushSanctionRequest(...)`, mirroring
  every other write in this file (`castVote`/`resolveRequest`). No extra state needed for the
  tally to pick up the new deadline: `tally` is computed directly in the render body off
  `request.deadlineAt` (never memoized), and `mutate()`'s listener notification (`useDB`'s
  `useSyncExternalStore`) forces the re-render.
- Failure surfacing: relies on the existing write-queue's `classifyWriteError` + boot-wired error
  toast (same as every other `push*` call in this file, none of which manually catch either) —
  did not add a bespoke try/catch since that would diverge from the established pattern here.

**A purity lint catch worth noting for future sessions:** `react-hooks/purity` flags a bare
`Date.now()` call directly in a render body ("Cannot call impure function during render") but did
NOT flag the pre-existing `const nowISO = new Date().toISOString();` a few lines above it — the
rule appears to specifically pattern-match `Date.now`/`Math.random`-style well-known impure
globals rather than catching `new Date()` generally. Fixed by reusing the already-computed
`nowISO` (`Date.parse(nowISO)`) instead of a second `Date.now()` call, rather than hoisting a new
one to module scope.

**Migration `20260826000000_sanction_voting_lockdown.sql` — NOT YET applied to staging or prod**
(this session was scoped off all `supabase` CLI use; the controller pushes staging-first then
prod per `.claude/skills/migration-push`). Contents: `sanctioning_team_size()` RPC (as above) +
replaces `sanction_votes_write` to require `role = 'sanctioning'` only (keeps
`voter_user_id = auth.uid()` in both USING/WITH CHECK); `sanction_votes_read` is UNCHANGED.

**Post-push probe SQL for the controller** (adapt the `migration-push` skill's non-admin
write-path probe convention — run as a seeded non-admin, then as a seeded sanctioning-only
non-admin; every probe row should be cleaned up after):

```sql
-- 1. sanctioning_team_size() returns the real count and is admin/sanctioning-gated.
--    As an anon/no-role authenticated caller: expect a raised exception (42501/P0001-style).
select sanctioning_team_size();
--    As a caller holding ONLY 'sanctioning' (not admin): expect a real integer >= 1, no error.

-- 2. sanction_votes_write: a caller holding ONLY 'admin' (not 'sanctioning') must be REFUSED
--    an insert on an existing voting-status request (expect 42501 / 0 rows affected):
insert into sanction_votes (id, request_id, voter_user_id, vote, voted_at)
values ('probe-admin-vote', '<a real voting-status request id>', auth.uid(), 'approve', now());
-- (run as the admin-only test session; then delete if it somehow succeeded)

-- 3. sanction_votes_write: a caller holding 'sanctioning' (admin or not) must be ALLOWED to
--    insert/update their OWN vote row on the same request (expect success):
insert into sanction_votes (id, request_id, voter_user_id, vote, voted_at)
values ('probe-sanctioning-vote', '<same request id>', auth.uid(), 'approve', now())
on conflict (id) do update set vote = excluded.vote, voted_at = excluded.voted_at;
delete from sanction_votes where id = 'probe-sanctioning-vote'; -- cleanup

-- 4. Deadline-editor RLS (confirms the PRE-EXISTING sanction_requests_rw policy already covers
--    this -- no migration change was made for it, this is a confirmation probe only):
--    As a caller holding ONLY 'sanctioning' (not admin), on a request they didn't submit and
--    don't host -- expect SUCCESS (the broad for-all policy predates this fix):
update sanction_requests set deadline_at = now() + interval '1 day'
where id = '<a voting-status request id not requested/hosted by this caller>';
-- (revert deadline_at to its prior value afterward if this was a real request, not a probe row)
```

**Deploy list:** `scheduled-dispatch` (recipient-resolution change) and `notify-sanction`
(comment-only, but harmless to redeploy in the same batch if convenient — no behavior change).
`Sanction.tsx`/`capabilities-core.ts`/`supabase.ts`/`sanction.ts` are client-only, shipped via the
normal `main`-push deploy, no edge-function redeploy needed for them.

**Verification (final run, all touched + newly-added files):**
- `npm run build` — exit 0, zero TS errors (confirmed twice: once before, once after the
  react-hooks/purity fix below).
- `npx eslint src/lib/sanction.ts src/lib/capabilities-core.ts src/lib/capabilities.ts
  src/lib/supabase.ts src/pages/Sanction.tsx supabase/functions/notify-sanction/index.ts
  supabase/functions/scheduled-dispatch/index.ts tests/sanction.test.ts
  tests/lib/capabilities-core.test.ts` — exit 0, zero errors/warnings.
- `npx vitest run` — 1361/1361 passed across 85 files (base before this branch was 1334 per the
  M-01-05 entry above, which had already landed on `main`; net new from this ticket is 27 tests
  across `tests/sanction.test.ts` and `tests/lib/capabilities-core.test.ts`).

**Could not be verified here (no Browser pane driven for this task):** the actual rendered
Sanction vote page — the muted "Voting is limited to the Sanctioning Team" copy, the "team size
unavailable" tally state, and the new Voting Deadline card's Edit/Save/Cancel flow and past-
deadline warning — against a live signed-in sanctioning-only session and a live admin-only
session. Flagged for a responsive/visual sweep once deployed to staging with real
`user_roles` rows for both personas.

## UAT G-02-01, S2 (2026-08-27): independent registration blocked, illegal client membership write, double-selling

Branch `fix/independent-registration`. Three related fixes for an INDEPENDENT athlete
(`person.main_club_id = null`) who bought an athlete membership, was then blocked from
registering, hit an 8x write-queue retry storm in `error_logs`, and was able to buy the same
membership twice (two Stripe charges for one membership row).

### A. Club gate skips independents

`clubHasActiveMembershipForEvent` (`src/lib/capabilities-core.ts:118`) treated a null/empty
`clubId` the same as "club with no active membership" — so an independent athlete (no competing
club to gate on) was blocked by the same "your club needs an active membership" toast meant for
an unpaid CLUB. Fixed: a null/empty `clubId` now short-circuits to `true` (gate satisfied) before
delegating to `clubHasActiveMembership`, with a comment explaining why. This does not touch
`Capabilities.canRegister`, which still enforces the athlete's own individual membership.

Audited every call site (grepped `clubHasActiveMembershipForEvent`/`clubHasActiveMembership`/
"needs an active" across `src/`):
- `src/pages/Events.tsx:2374` (self-registration, `SelfRegModal`) — `selectedClubId` defaults to
  `''` for an independent (no `myClubs`), so this is the actual G-02 entry point; inherits the
  capabilities-core fix automatically, no local change needed.
- `src/pages/Events.tsx:1559` (`addAthlete`, HOST adding an athlete by email) — this one
  pre-checked `!found.clubId` itself and produced a separate "that athlete has no club" toast
  before even calling the gate helper, so it needed its own fix (removed the pre-check; the reg
  is already created with `clubId: found.clubId ?? ''` at line ~1572, so an independent's reg now
  goes through cleanly). Note: this is a behavior change on the HOST ROSTER surface too — a host
  can now add an independent athlete by email, not just self-registration.
- `src/pages/Club.tsx:1257` (`clubMembershipBlocked`, club-manager registering roster athletes) —
  `clubId` here is always the manager's own real club (from route params), never null. Left
  unchanged.
- `src/pages/Sanction.tsx:259` — this is a club's HOSTING gate (`clubHasActiveMembership`
  directly, not the `...ForEvent` wrapper), unrelated to registration. Left unchanged.
- **Server:** grepped `club_memberships` across `supabase/functions/**` — the only hits are in
  `create-checkout-session/index.ts` (pricing a `club-membership` purchase line itself, i.e. is
  the club's OWN membership already active so it prices at $0) and `_shared/fulfill.ts`. There is
  no server-side mirror of the registration club-gate — by the time a cart line exists the
  registration row already exists (created client-side, gate enforced there), so nothing
  server-side needed a matching fix. Stated here explicitly so this is not re-derived later.

### B. Client illegal membership-status write + write-queue misclassification

**The write.** Enumerated every non-service-role `pushMembership` call site: `Membership.tsx`
`complete()` (member-facing, NOT behind `RequireAdmin`), and `Profile.tsx`'s
`AdminMembershipControls.activate()`/`confirmRevoke()` plus `AdminMembers.tsx`'s merge-duplicate
flow (all three gated by `adminView`/`/admin/*` routes, i.e. behind `RequireAdmin`). Only
`Membership.tsx complete('comp')` (the "Admin Payment Override" button, gated client-side on
`caps.isAdmin` only — no aal2 check, and reachable outside any `RequireAdmin` route) could ever
write `status:'active'` from a non-privileged session. Traced the DB's `is_admin()` (migrations
`20260717140238`/`20260718093940`) and confirmed it correctly exempts passkey-signed-in and
no-factor admins, and the app-wide `MfaChallenge` interstitial forces aal2 step-up for any
TOTP-enrolled admin before they can do anything — so a genuinely privileged admin's write should
normally succeed. Root cause is not fully attributable from static code alone; the most plausible
mechanism given Nate's own documented policy of temporary admin grants in STAGING `user_roles` for
testing gated UI is that the test account used for this UAT scenario also held a leftover or
mis-scoped `admin` role, so `caps.isAdmin` rendered the override button while the underlying write
was independently and correctly refused by `guard_membership_writes`.

Regardless of exact attribution, fixed the class of bug: `complete()`'s `comp` branch no longer
applies `status:'active'` to local state optimistically. It still pushes the intended row (a
genuinely privileged admin's write is legal and the guard trigger already allows it), then polls
the SERVER's own row (`waitForCompGrant`, bounded 4 tries / 500ms) and only advances to `done`
plus the success toast once the fetched row actually shows the intended status — `active` for an
adult, `pending-waiver` for a minor (the guard allows non-privileged writes of that status too, so
a minor's comp grant is not wrongly flagged "not confirmed"). A rejected write now surfaces an
honest error toast instead of a false "granted" toast followed by a stale local nag. The `club`
branch (status `pending-club-payment`) is legal for any caller under the guard and was left
applying optimistically as before — no correctness issue there.

Files: `src/pages/Membership.tsx` (`complete()`, new `waitForCompGrant` helper, new `granting`
state disabling the override button mid-confirmation).

**The write-queue retry storm.** `guard_membership_writes` (`RAISE EXCEPTION` with no `USING
ERRCODE`) surfaces as generic SQLSTATE `P0001`. `classifyWriteError` (`src/lib/write-queue.ts`)
had no branch for it, `PostgrestError` never carries an HTTP `status`/`statusCode` field (so the
status-based branch cannot catch it either), and neither the RLS nor constraint message regex
matches the guard's wording ("non-privileged caller cannot set status=active") — so it defaulted
to `transient` and burned the full `maxAuto` budget (8 attempts, backoff 500ms doubling to a 30s
cap, roughly 61.5s of delay plus the 8th round trip, close to the reported "8x over ~70s") before
giving up. Fixed: `code === 'P0001'` now classifies as `permanent` — this marks every raised-
exception trigger refusal permanent, not just this one guard; that is correct (a raised exception
is by definition not retry-fixable), but it is a behavior change beyond this specific bug, noted
here explicitly. Added a matching `humanizeWriteError` branch (reuses the existing "you don't have
permission to make this change" wording). The existing `onPermanentFailure` wiring in
`supabase.ts` (drain-then-`syncFromSupabase()` rollback plus toast) already does the "log once,
drop, surface a toast" the task asked for — verified it fires correctly for this class rather than
adding a second rollback path. Added `classifyWriteError`/`humanizeWriteError` unit tests for the
P0001 case (`tests/write-queue.test.ts`).

### C. No double-selling a membership

Two Stripe charges for one membership row happened because `priceForTypesDollars`/`priceForTypes`
only credit an EXISTING `status:'active'` row toward price — if a second checkout session is
created before the first payment's webhook has fulfilled (flipped the row active), the second
session sees no credit and prices full fare again. This is the membership analog of the
registration-side "One live slot" duplicate-payment race (money-invariants.md, UAT Z-02) — same
root shape, not fixed by this task (task C only asked for the "already active" guard, not a
pending-payment-race guard); flagged as a residual gap, same as Z-02's own documented residual
TOCTOU (two payments fulfilling at the exact same instant).

Added `membershipAlreadyActive(rows, personId, seasonId, type)` — pure, canonical copy in
`src/lib/pricing.ts` (unit-tested, `tests/pricing.test.ts`), mirrored in
`supabase/functions/_shared/stripe.ts` (edge functions bundle only their own dir plus `_shared/`,
not `src/`, so it is re-implemented rather than imported — same pattern as every other pricing
mirror in that file). Both treat a legacy row with no `type` as `athlete`, mirroring
`membershipTypeOf`'s legacy-null rule (`capabilities-core.ts`) — the server's existing
`priceForTypesDollars` does not do this (a pre-existing, separate, out-of-scope gap noted for
awareness, not fixed here).

Wired into `create-checkout-session/index.ts`'s membership-group pricing loop, ABOVE the "PREVIEW
BRANCH POINT" (it is a validation, not a write — same positioning as every other capacity/session/
survey check) so `mode:'preview'` 409s identically to a real checkout. Returns
`{ ok:false, error:'You already have an active <season> <type> membership.' }` with HTTP 409.
Verified this reaches the client verbatim with no new structured-error plumbing needed:
`parseCheckoutSessionError`/`edgeErrorBody` (`src/lib/supabase.ts`) already fall through to
`body.error` for any rejection without a special `code`, and `CartCheckout.tsx`'s
`handleRejection` already forwards a plain `r.error` to `onError` for both `previewCartTotal` and
`createCheckoutSession` — no capacity/session/survey-style special case needed.

Client-side "mirror" (the purchase UI showing "already active" instead of a buy button):
`Membership.tsx`'s existing `purchasableTypes` filter already excludes any type with a local
`status === 'active'` row, and `allOwned`/`step === 'done'` already short-circuits the whole flow
— this already worked; the reason he could re-buy was the stale local state from bug B (the first
purchase's real activation should have synced via `MembershipsCheckoutInner.onPaid`'s
`syncFromSupabase()`, but see the residual TOCTOU above — if the second session was created before
the first webhook fulfilled, local state legitimately had not caught up yet either). The server
guard above is the real backstop; no additional client wiring added.

### Deploy

`create-checkout-session` needs redeploying (`supabase functions deploy create-checkout-session
--project-ref wkyerxlgricfphopocoz`, staging first via `--project-ref xogpiksqtkayxwmczlbx`) for
part C to take effect — not done as part of this session (instructed not to run the `supabase`
CLI). Parts A/B are pure client-side and ship on the normal `main` deploy.

### Verification

`npm run build` — clean (`tsc -b && vite build`, PWA precache regenerated, dev-auth firewall check
passed). `npx eslint` on every touched file including
`supabase/functions/create-checkout-session/index.ts` and `supabase/functions/_shared/stripe.ts`
— zero errors/warnings. `npx vitest run` — 85 files / 1369 tests, all green (includes the new
`membershipAlreadyActive` describe block and the two new `classifyWriteError`/`humanizeWriteError`
P0001 cases).

Files touched: `src/lib/capabilities-core.ts`, `src/pages/Events.tsx`, `src/pages/Membership.tsx`,
`src/lib/write-queue.ts`, `tests/write-queue.test.ts`, `src/lib/pricing.ts`,
`tests/pricing.test.ts`, `supabase/functions/_shared/stripe.ts`,
`supabase/functions/create-checkout-session/index.ts`.

## Sanction email/UX batch (UAT round 3, E-01-01/E-01-02, 2026-08-27)

Owners' findings, all six implemented on `fix/sanction-round3`.

### 1/2/3. `notify-sanction` audience + confirmation rewrite

Full rewrite of `supabase/functions/notify-sanction/index.ts`. Prior header comment (lines 2-5)
explicitly said the 'submitted' audience "stays admin-inclusive/informational by design" —
that decision is now REVERSED per the owners' explicit round-3 instruction; rewrote the comment
rather than leaving it to contradict the code.

- **'submitted'** now emails `role = 'sanctioning'` ONLY (dropped `'admin'` from the
  `user_roles` filter) — matches `sanction_votes_write`'s existing sanctioning-only voter set.
  **Also** now emails the requester a submission confirmation (event name, kind, host club name
  — a new `clubs` lookup, dates from the payload, "votes within 7 days," and a link to `/#/sanction`
  — NOT `/#/sanctioning/:id`, since that page hard-gates on `isSanctioning` and a club-manager
  requester isn't on the team and would just see "access required").
- **'approved'** now ALSO emails the Sanctioning Team a short notice, independent of the
  requester's own approval email.
- **The team-send and requester-send are fully independent** in both branches — advisor review
  caught that the ORIGINAL code's early returns (`if (ids.length === 0) return ...`, `if
  (!EMAIL_RE.test(email)) return ...`) sat ABOVE the rest of the function, so a naive "add a
  second recipient" edit would have let an empty/broken team silently swallow the requester's
  email or vice versa. Restructured so each side resolves its own recipients, builds its own
  message(s), sends, and catches its own failure — one side failing never blocks the other.
- Extracted the validate+dedupe-by-email loop (now needed twice per event: submitted-team and
  approved-team) into `supabase/functions/_shared/notify-recipients.ts`
  (`dedupeEmailRecipients`), pure/dependency-free like `judge-entry-core.ts`, unit-tested in
  `tests/notify-recipients.test.ts` (6 cases: valid build, malformed/missing email dropped,
  case-insensitive dedupe keeping first occurrence, whitespace trim, missing names, empty input).
- **Deploy note (not done this session — instructed not to run `supabase` CLI):**
  `notify-sanction` needs `supabase functions deploy notify-sanction --project-ref
  xogpiksqtkayxwmczlbx` (staging first), then `--project-ref wkyerxlgricfphopocoz` (prod).
  `verify_jwt` is unaffected (not one of the three `--no-verify-jwt` functions).
- **Known residual, recorded per advisor's note, not fixed here:** narrowing 'submitted' to
  `sanctioning`-only means zero users holding that role today receive NO submission notice at
  all (no admin fallback) — admins were the de facto backstop before. Owners were explicit about
  the narrowing; this is a deploy/staffing consideration (someone needs the `sanctioning` role
  assigned), not a code defect.

### 4. "Your sanction requests" (E-01-04)

Added to `src/pages/Sanction.tsx`'s `SanctionRequestForm` page (not a new route) — a
`YourSanctionRequests` card rendered ABOVE both the manager-access gate and the form, so it's
visible to anyone signed in with a request they can read even if they've since lost manager
access to every club. New pure selector `ownSanctionRequestsOf(requests, personId,
managedClubIds)` in `src/lib/sanction.ts`: filters to requests the person submitted OR that are
hosted by a club they manage, sorted newest-submitted-first. This filter is necessary even
though RLS (`sanction_requests_read`, `20260826000000`) already scopes a non-privileged caller's
`db.sanctionRequests` read to exactly this set — an admin/Sanctioning Team caller's read includes
EVERY request (that policy's admin/sanctioning branch), so without the client-side filter an
admin visiting `/sanction` would see the entire league's queue under "Your requests." 8 vitest
cases in `tests/sanction.test.ts` including one that specifically simulates an admin-shaped read
returning nothing owned.

Table: event name, submitted date, status badge (reusing the same tone mapping as
`SanctioningQueue`'s), deadline, and for `approved` rows with a `createdEventId`, a link to
`/events/:slug/host` (the correct host dashboard route — see #5).

**Post-submit flow (E-01-06's "dead end"):** `submit()` no longer calls `navigate('/')`. It sets
`justSubmitted` state, which swaps the (still-populated) form out for a success banner + "Submit
another request" button — closes the dead end AND stops a stray second click on the old Submit
button from creating a duplicate request (a real risk the plan's original "leave the form
visible" framing didn't account for; advisor flagged it). `window.scrollTo({top:0,
behavior:'smooth'})` fires alongside, since the Submit button sits at the bottom of a very long
form and the banner renders at the top.

### 5. Broken `/manage` link

`grep -rn "/manage" supabase/functions/` found exactly one bad occurrence: the 'approved' email's
`eventLink` in `notify-sanction/index.ts` (both the template literal and its adjacent comment).
Fixed to `/events/:slug/host`, confirmed against `App.tsx`'s real routes (both `/manage` and
`/host` exist — the bug was the wrong one being linked, not a missing route) and against
`EventHostPage`'s gate (`canManage = isEventHost(event.id) || isSanctioning`, and
`isEventHost` includes `managedClubIds.includes(event.hostClubId)`) — a sanction requester,
being the host club's manager, does get a working host dashboard at that link. No other
transactional email had the same mistake (`request-manager-access` links `/manager-access/:token`,
unrelated).

### 6. Scroll-to-top on route change

Confirmed by grep (`scrollTo|ScrollRestoration` across `App.tsx`/`Layout.tsx`/`main.tsx`) that no
route-level scroll-reset existed at all — only three pages (`Cart.tsx`, `ClubCart.tsx`,
`ClubPurchaseHistory.tsx`) had their own mount-time `window.scrollTo(0,0)`. Fixed globally with
one `useEffect(() => window.scrollTo(0,0), [loc.pathname])` in `Layout.tsx` (`loc` already
destructured from `useLocation()` there). Verified `.content`/`.main`/`.shell` carry no
`overflow` in `index.css`, so `window` is the real scroll container — `window.scrollTo` isn't a
no-op. Keyed on `pathname` only, not search/hash, so it doesn't fire on `?event=`-style
preselect deep-links (`Club.tsx`, `Judge.tsx`, `MyRegistrations.tsx`, `Membership.tsx`,
`Profile.tsx` — none of them `scrollIntoView`, they only preselect state) or on
`receiptsRef.scrollIntoView` (Cart.tsx, button-click-driven, not an effect) — no opt-out
mechanism was needed, so none was built. Runs as a plain `useEffect` (after paint), so the three
pages' own post-mount `scrollTo(0,0)` calls execute after this one and just repeat the same
value — verified they're not fighting it.

Verified live via dev server (`ucg-dev`, port 5173): scrolled to y=400, opened the mobile nav
drawer, tapped a nav link — `window.scrollY` was 0 immediately after the route change (plus the
drawer closed, matching pre-existing behavior).

### Responsive sweep (ui-brand-and-layout.md, required for the new "Your sanction requests" table)

Ran against the live dev server. `scrollWidth`/`clientWidth` at each width, WITH a synthetic
worst-case injection (a very long event name in the new table, plus the success banner) present
on the actual `/sanction` page:

- 375×812: 375 / 375
- 768×1024: 753 / 753
- 1280×800: 1265 / 1265
- 1440×900: 1425 / 1425

No horizontal overflow at any width. The new table wraps in its own `overflow-x:auto` div
(unlike `SanctioningQueue`'s existing tables, which don't) — confirmed structurally: with the
long-name row injected, the wrapper div stayed at 345px while the table itself measured 493px,
scrolling internally rather than pushing the page wide.

Mobile nav drawer (375px): hamburger opens (`.sidebar.open` + `.nav-overlay` both present),
Escape closes, link-tap navigates AND closes. Contrast: reused only pre-vetted tokens — the
banner's `border-left` uses `--teal-900` (documented "OK as text on white/light-blue," used here
as a border, an even lower bar) and its body text uses `--ink-soft`, already used throughout this
same page (`.page-sub`) — no new fg/bg pairing introduced.

**Found, NOT fixed (out of scope, pre-existing, unrelated to any file this task touched):**
`SanctioningQueue`'s "Decided" table (`src/pages/Sanction.tsx`) overflows badly at 375px —
measured `scrollWidth: 933` against `clientWidth: 375` with real seed data (two approved MIT
Gymnastics Club requests) on screen. Its tables aren't wrapped in `overflow-x:auto` the way the
new "Your sanction requests" table is. Flagging for a separate pass — not touched here since it's
outside this task's file list and would have grown the diff past a "small, surgical" scroll fix.

### Verification

`npm run build` — clean (`tsc -b && vite build`; PWA precache regenerated; dev-auth firewall
check passed, no `VITE_DEV_AUTH`/`initDevAuth` in `dist/assets`). `npx eslint` on every touched
file (`src/components/Layout.tsx`, `src/lib/sanction.ts`, `src/pages/Sanction.tsx`,
`supabase/functions/notify-sanction/index.ts`, `supabase/functions/_shared/notify-recipients.ts`,
`tests/sanction.test.ts`, `tests/notify-recipients.test.ts`) — zero errors/warnings. `npx vitest
run` — 86 files / 1381 tests, all green (12 new: 6 `dedupeEmailRecipients` cases + 6+
`ownSanctionRequestsOf` cases added to the existing `sanction.test.ts`).

Files touched: `supabase/functions/notify-sanction/index.ts`,
`supabase/functions/_shared/notify-recipients.ts` (new), `tests/notify-recipients.test.ts` (new),
`src/lib/sanction.ts`, `tests/sanction.test.ts`, `src/pages/Sanction.tsx`,
`src/components/Layout.tsx`.

**Post-review fix (advisor catch, before commit):** the first draft wrapped `ownRequests` in a
`useMemo` keyed on `[db.sanctionRequests, caps.personId, caps.managedClubIds]`. That's exactly
`data-layer.md`'s documented "in-place mutation trap" — `mutate()`'s `d.sanctionRequests.push(req)`
leaves the array REFERENCE unchanged, so the memo bails out and keeps showing the pre-submission
list even though `mutate()` does force a re-render (only masked in manual testing because a
first-time requester has `sanctionRequests` absent from the loaded row, so `loadAll` never sets
the key and the first push assigns a genuinely new array). Fixed by dropping the memo entirely —
`ownSanctionRequestsOf(...)` is now called directly in the render body, matching how `tally` a
few lines below it is already computed fresh every render for the same reason. Re-verified after
the fix: build/eslint/86 files/1381 tests all still clean.

## UAT G-01-01 / G-03-01 (2026-08-27): silent "no register button" on the event page + list,
## branch `fix/register-entry-messaging`

Owner-reported "silent failure": on an event with open registration, a viewer who can't register
(signed out, or signed in with no active athlete membership) saw NO register control and no
explanation — the register button just wasn't there. Two related findings, plus a small
pre-existing overflow flagged in passing.

### G-03: signed-out visitor, event DETAIL page

`EventDetail`'s Registration card (`src/pages/Events.tsx` ~509-567) had a fallback branch that
fired whenever `!caps.canRegister && caps.managedClubIds.length === 0` and the viewer had no
active COACH membership either: it rendered a bare `<Badge tone="warn">Registration open</Badge>`
with no CTA — true for BOTH a signed-out visitor and a signed-in visitor with zero memberships at
all. Split that branch on `caps.signedIn`:

- Signed out → `Badge tone="warn"` "Sign in to register for this event" + a `<Link to="/me">Sign
  in →</Link>` button. `/me` is the existing sign-in-gate idiom — `RequireAccount` renders
  `Gate.tsx`'s sign-in screen directly for a signed-out visitor (no redirect route), same as
  `Layout.tsx`'s existing "Browsing as a guest · sign in to register" and the topbar's guest "Sign
  in" link (`Layout.tsx:201,294`) — reused verbatim rather than inventing a new pattern.
- Signed in, no membership → a SHORT `Badge tone="warn"` "Membership required" + a plain
  `<p style={{fontSize:13, color:'var(--ink-soft)'}}>` "An active `<season>` athlete membership is
  required to register." + the same "Get athlete membership →" `/membership` link already used
  one branch up for the coach-membership case. **The full sentence deliberately does NOT live
  inside the `Badge`** — `.badge` is `white-space: nowrap` (`index.css`), so a sentence that long
  would refuse to wrap and overflow the card at 375px; caught by the advisor before commit, not by
  build/lint/test (none of which see rendered CSS). `<season>` is the EVENT's own season
  (`seasonForDate(db, event.startDate)` → `db.seasons` name), not "current" — matters for a
  future/purchasable season's event.

**Loading-flash guard (also an advisor catch, before commit).** Both new branches read
`caps.canRegister`/`caps.athleteMembership`, which depend on `db.people` having synced from
Supabase — NOT instant for a signed-in visitor on a browser with no cached snapshot (people IS a
`PERSISTED_KEYS` entry in `store.ts`, so a REPEAT visit has it instantly from localStorage, but a
first-ever sign-in on a fresh browser doesn't). Without a guard, that visitor would briefly see an
affirmatively WRONG "Membership required" even though they do hold one — worse than the silent
gap being fixed. Gated on `useRolesLoaded()` (`src/lib/auth.ts`, already imported in this file):
despite its name, it flips true only after `onAuthenticated`'s `await syncFromSupabase()`
resolves, which is exactly the same data these branches read, and `linkedUserId` resets every page
load so this covers every boot, not just first-ever sign-ins. Both `Events()` and `EventDetail()`
now call the hook; while `!rolesLoaded`, the detail-page fallback shows the OLD harmless
"Registration open" badge instead of the new specific messages, and the list-column hints
(`'sign-in'`/`'membership'`) render as nothing (see G-01 below) — i.e. falls back to the
pre-existing behavior rather than asserting something that might be wrong. The pre-existing
self/edit/club buttons on both surfaces are NOT newly gated — they already tolerated this same
window unguarded before this task, and un-guarding a wrong "no membership" claim was the actual
new risk, not the pre-existing "button not there yet" gap.

### G-01: same silent gap on the Events LIST `Register` column

Owner's design latitude, kept intentionally minimal: column header → `Register*`, one small muted
footnote below the table ("*Registration requires signing in with an active season
membership."), and per-row a subdued (not a `.btn`) `--ink-soft` link — "Sign in" (signed out) or
"Membership required" → `/membership` (signed in, no membership) — instead of a loud button.

Wired through `eventRowActions` (`src/lib/events-core.ts`) rather than an ad-hoc conditional in
the list render, per the file's existing "reuse the exact gate logic, don't re-derive" convention:

- `EventRowAction` union extended: `'self' | 'club' | 'edit' | 'sign-in' | 'membership'`.
- `EventRowActionsInput.viewer` gained `signedIn: boolean` alongside the existing `canRegister`
  (mirrors `Capabilities.canRegister === signedIn && athleteMembership?.status === 'active'` —
  the function never re-derives that itself, just consumes both fields).
- Logic: after computing `self`/`edit`/`club` exactly as before, if the array is STILL empty push
  `'sign-in'` (not signed in) or `'membership'` (signed in, nothing else applied) — so a row is
  never actionless. One consequence worth flagging: a manager of a CAMP who isn't personally
  eligible now gets a `'membership'` hint where before they got nothing, because camps suppress
  the `'club'` action entirely (individual self-reg only) and there's nothing else to show —
  matches the "never silently actionless" intent, covered by a new test case.
- `Events.tsx`'s list renderer: dropped the old `if (actions.length === 0) return null` (the
  array is never empty now), added `'sign-in'`/`'membership'` render branches as
  `fontSize:12.5, color:'var(--ink-soft)'` `<Link>`s (`/me`, `/membership`) — but ONLY when
  `useRolesLoaded()` is true (same rationale as the detail-page guard above); while loading, these
  two branches return `null`, i.e. the cell looks exactly like the old pre-fix empty state rather
  than asserting a hint that might be wrong. The real `self`/`edit`/`club` actions are unaffected
  by this guard.
- Footnote paragraph added below `events-table-wrap` but still inside the card, `fontSize:11.5,
  color:'var(--ink-soft)'`. `data-label` on the Register `<td>` also carries the asterisk
  (`Register*`) — below 820px the `<thead>` is hidden (existing `@container` responsive-card
  behavior) so the footnote's `*` would otherwise reference an invisible header.

Contrast: `--ink-soft` (`#5a6a78`) on `--surface` (`--white`) is the rule file's explicitly
documented standard muted pair — no new fg/bg combination introduced.

Column width at 375px: the `events-table` class already collapses to a stacked
`data-label`/flex-row card layout below 820px (`@container (max-width: 820px)` in `index.css`,
pre-existing) — the Register cell's content becomes a flex row (`justify-content:space-between`)
rather than a fixed-width table column, so the short hint text ("Sign in" / "Membership
required") doesn't widen anything. The EventDetail signed-in-no-membership `<p>` sits in a
`flexDirection:'column'` div with `minWidth:0, flexBasis:'100%'` (belt-and-braces so it can't
establish a wide min-content floor as a flex item of the outer `flexWrap:'wrap'` row).

**Not independently verified in a real browser this session (no Browser pane available) —
controller: please run the responsive sweep and check specifically:**
1. Events list `Register*` column at 375/768/1280px in all four viewer states (signed-out,
   signed-in no-membership, signed-in-eligible, manager) — confirm no horizontal overflow and the
   hint text sits correctly in the stacked-card layout below 820px.
2. EventDetail Registration card's two new branches (signed-out, signed-in-no-membership) at the
   same three widths — **the signed-in-no-membership state at 375px is the one measurement that
   most needs a real `scrollWidth` reading**, since that's the branch with the sentence moved out
   of the nowrap `Badge` into a `<p>`.
3. A FIRST sign-in on a browser with an empty/cleared `localStorage` (or `sessionStorage`'s
   `ucg-dev-signed-out` cleared then signed back in) landing on `/events` or `/events/:slug`: the
   sign-in/membership hint should stay ABSENT (or the detail page should show the old
   "Registration open" badge) until roles/people finish syncing, then flip to the correct message
   — not flash a wrong "Membership required" first.

### Small overflow fix (flagged 2026-08-27, in scope for this task)

`SanctioningQueue`'s "Decided" table (`src/pages/Sanction.tsx` ~803-852) — the one flagged but
NOT fixed in the "Sanction email/UX batch" entry above (`scrollWidth: 933` vs `clientWidth: 375`)
— now wraps in the same `<div style={{ overflowX: 'auto' }}>` idiom already used a few sections
up in the same file for "Your Sanction Requests." Pure wrap + reindent, no logic change.

### Verification

`npm run build` — clean (`tsc -b && vite build`; PWA precache regenerated; dev-auth firewall
check passed), re-run after the advisor-driven fixes above, still clean.

`npx eslint src/pages/Events.tsx src/lib/events-core.ts src/pages/Sanction.tsx
tests/lib/events-core.test.ts` — zero errors/warnings.

`npx vitest run` — 86 files / 1382 tests, all green (2 new `eventRowActions` cases for the
sign-in/membership hints; 7 existing cases updated for the new required `viewer.signedIn` field).
Re-run after the `rolesLoaded`/badge-overflow fixes — same 86/1382, still green (those fixes are
render-time guards over `caps`, not new pure logic, so no new unit cases apply to them; covered by
the controller's responsive-sweep asks above instead).

Files touched: `src/lib/events-core.ts`, `src/pages/Events.tsx`, `src/pages/Sanction.tsx`,
`tests/lib/events-core.test.ts`.

## UAT round 3 tail: M-12-03 (club-cart registration-grid staleness) + E-01 (branded waiver-link emails) — 2026-08-27

Branch `fix/uat-round3-tail`. Two small, unrelated fixes bundled per the controller's brief.

### M-12-03: club registrations page still shows "Pending Purchase" after a $0-coupon CLUB checkout

Investigated the three candidates in the brief and disproved two of them with direct evidence
before landing on the real gap:

- **NOT (1) "ClubCart.tsx's onPaid never got the M-12-02 wiring."** `git log` shows `7f72804`
  (the M-12-02 invalidation fix, adding `invalidateMyRegistrations`/`invalidateClubRegistrations`/
  `invalidateEventRegistrations` calls to `CartScope`'s ONE shared `onPaid`) landed BEFORE
  `a77f4e9` (the personal/club cart page split that created `ClubCart.tsx`). `ClubCart.tsx`'s
  `ClubCartPage` renders `<CartScope isClub ownerKey={club.id} .../>` from `Cart.tsx` — it
  doesn't define its own `onPaid` at all, so it inherited the fix from day one.
  `src/components/StripeCheckout.tsx` was also checked (a possible Stripe-return completion path)
  and ruled out: Stripe Embedded Checkout uses `redirect_on_completion: 'never'`
  (`supabase/functions/create-checkout-session/index.ts:1317`) with an in-page `onComplete`
  callback, not a `return_url` — there is no separate return-route completion path that could
  have missed invalidation wiring.
- **NOT (2)/(3) "wrong scope/club id" or "grid reads a tier `invalidateClubRegistrations`
  doesn't clear" as originally framed** — `Club.tsx`'s `EventRegGrid` (the "Pending
  purchase"/"Registered" badge, `src/pages/Club.tsx:2100-2136`, sourced from `allRegs =
  eventRegs.filter(...)` at line 1289, itself `useEventRegistrations(event?.id)` at line 1122)
  reads the **by-event** slice (`regsByEventSlice` in `registrations-slice.ts`), not the by-club
  one. `onPaid` (`Cart.tsx`) DOES call `invalidateEventRegistrations(eventId)` for every event it
  can derive, with the right `ownerKey`/clubId throughout.
- **The actual gap:** that event-id derivation (`Cart.tsx`'s old `onPaid`) walked
  `checkout.items[].refRegIds`, resolved each to a registration via `regs.find(...)`, and
  silently DROPPED any id not found (`if (reg) paidEventIds.add(...)`) — with no fallback. For a
  personal checkout this is harmless even when it misses: `onPaid` also unconditionally calls
  `invalidateMyRegistrations()`, and `MyRegistrations.tsx` reads that exact SAME "mine" tier
  directly, so a missed by-event id there never surfaces as staleness. For a CLUB checkout there
  is no equivalent safety net — `EventRegGrid` reads ONLY the by-event slice, so its freshness
  depended entirely on that one `regs`-based lookup succeeding, where `regs` there is the by-club
  slice (`useClubRegistrations(ownerKey).rows`) — note `removeItem` (`Cart.tsx:428`) guards on
  `regsReady` before trusting `regs`, but `onPaid` never did. A `regs` set that's momentarily
  incomplete at the exact instant checkout completes (not yet 'ready', or a row not yet locally
  upserted into that scope) makes the lookup miss and the event never gets invalidated —
  permanently stale until a hard reload resets every module-level slice cache, exactly Julia's
  repro and exactly the M-12-02 bug's original symptom recurring through a narrower door.
- **Not independently reproduced in a live browser this session** (no browser pane opened for
  this task; verification is build/eslint/vitest only, per the brief's protocol) — the fix below
  is the defensible root fix that closes this failure class regardless of the precise timing that
  trips it, rather than a narrow patch aimed at one hypothesized race.

**Fix:** `eventIdsForCartItems(items, events)` (new pure export, `src/lib/pricing.ts`) derives
event ids from cart items WITHOUT touching any registration slice — the same
`item.label.includes(event.name)` join `Cart.tsx`'s `groupCartItems` already uses to build the
per-event cart cards. `CartScope.onPaid` (`src/pages/Cart.tsx`) now unions this with the existing
`regs`-derived ids before calling `invalidateEventRegistrations` for each, so a club checkout's
by-event invalidation no longer depends solely on the by-club slice being complete at that exact
moment. The existing `regs`-based lookup is KEPT (not replaced) since it can, in principle, cover
an item whose label doesn't literally contain the event name — this is strictly additive/safer,
never fewer invalidations than before.

Money-invariants-scoped diff (`Cart.tsx`, `pricing.ts` are both in that rule's `paths`) — this
change touches ONLY which read-caches get invalidated after payment; it does not touch pricing,
coupon, or charge logic in any way, and is additive (can only cause extra, harmless re-fetches of
read-only data, never fewer than the pre-existing behavior). Flagging per CLAUDE.md's
model-routing rule that a reviewer-tier adversarial read is still owed before merge — not
performed as part of this task (single-agent execution, no separate reviewer available this
session).

New vitest: `tests/lib/event-ids-for-cart-items.test.ts` (5 cases, including the specific
"independent of an empty/incomplete regs set" case that is the whole point of the fix).

### E-01: waiver-request emails were unbranded

`Profile.tsx`'s adult/guardian waiver-link email composition (`~1406-1438`, the "Email waiver"
flow's `email()` handler) built bare `<p>` HTML and called the generic `send-email` function
directly, bypassing `_shared/email-layout.ts` entirely (Julia's E-01-01/_02/_03 screenshots).

Per `.claude/rules/edge-functions.md`, `renderEmail`'s real signature is `{ heading, bodyHtml,
cta?, footnoteHtml? }` — **no `title`, no `preheader`** (the brief's suggested shape named both;
verified against `supabase/functions/_shared/email-layout.ts` directly rather than trusting the
brief). Implemented accordingly:

- `supabase/functions/send-email/index.ts`: new optional `wrap?: { title: string; cta?: { text,
  href } }` payload field (`preheader` deliberately NOT added — the layout has no slot for it;
  adding the field without functionality would be inventing an API that lies about what it does).
  When present, `payload.html` is treated as inner body content and rendered via
  `renderEmail({ heading: wrap.title, bodyHtml: rawHtml, cta: wrap.cta })` before being sent; the
  "body required" validation runs against the RAW (pre-wrap) html/text so it still reflects what
  the caller actually supplied, not the always-non-empty wrapped shell. Every existing caller
  that omits `wrap` gets byte-for-byte the same `html` as before.
- `src/lib/supabase.ts`'s `sendEmail(subject, html, recipients, wrap?)` gained the same optional
  4th parameter (new `SendEmailWrap` type mirroring the edge function's `WrapOptions`), forwarded
  into the invoke body only when passed (`...(wrap ? { wrap } : {})`).
- `src/pages/Profile.tsx` (`~1406-1438`): both waiver-link email compositions now pass `wrap` —
  title `'Sign your waiver'` (adult/self) or `` `Waiver signature needed for ${athleteName}` ``
  (guardian/minor), `cta: { text: 'Review & sign your waiver' | 'Review & sign the waiver', href:
  link }`. The inline `<a href="{link}">Review & sign...</a>` paragraph was dropped from each
  `html` body since the CTA button now carries that link; the surrounding body paragraphs are
  otherwise unchanged.

**Other `sendEmail(` call sites — grepped, left unchanged as scoped:**
- `src/pages/Profile.tsx:895` (`EmailWaiverModal`'s admin-triggered "Action needed: sign your
  waiver" reminder email, a DIFFERENT waiver email than the one this task branded) — still bare
  `<p>` HTML, still unbranded. Same class of issue as E-01 but out of this task's named scope
  (brief said "the two waiver compositions" at ~1410-1435 specifically); worth a follow-up.
- `src/pages/admin/Communicate.tsx:145` — admin bulk/broadcast email. Intentionally free-form per
  `edge-functions.md`'s own documented exception for `send-email` ("the caller controls the full
  body") — correctly left alone.

**Needs deploying:** `send-email` (no CLI run this session — task scope excluded it; the
`supabase functions deploy send-email --project-ref wkyerxlgricfphopocoz` step is outstanding).
Not one of the three `--no-verify-jwt`-sensitive functions, so a plain deploy is safe.

### Verification

`npm run build` — clean (`tsc -b && vite build`; PWA precache regenerated; dev-auth firewall
check passed).

`npx eslint src/pages/Cart.tsx src/lib/pricing.ts src/lib/supabase.ts src/pages/Profile.tsx
supabase/functions/send-email/index.ts tests/lib/event-ids-for-cart-items.test.ts` — zero
errors/warnings.

`npx vitest run` — 87 files / 1387 tests, all green (5 new `eventIdsForCartItems` cases; no
regressions).

Files touched: `src/lib/pricing.ts`, `src/pages/Cart.tsx`, `src/lib/supabase.ts`,
`src/pages/Profile.tsx`, `supabase/functions/send-email/index.ts`,
`tests/lib/event-ids-for-cart-items.test.ts`.

## UAT G-05/G-06 (2026-08-27): removal never chargeable; zero-apparatus = attending-not-competing; Stripe inlay padding — branch `fix/removal-and-blanked-state`

Four owner findings from the same round. `changeIsEligible` (`pricing.ts`) ALREADY excluded a
pure discipline removal from being chargeable (its own doc comment + a passing test,
`'remove a discipline → NOT eligible on its own'`, predate this task) — so decision 1's fix isn't
in pricing.ts at all. The real bug is that one of the three client callers never wired that
predicate up in the first place.

### 1. Removal never chargeable — root cause was `Events.tsx`'s `SelfRegModal`, not pricing.ts

`persistRegs` (`src/pages/Events.tsx`, was `~2508`) computed
`changeFee = changeFeeApplies && alreadyHadRegs ? registrationChangeFee(...) : 0` — no
`changeIsEligible` gate at all, unlike `MyRegistrations.tsx`/`Club.tsx`'s `saveRegs`. Any edit —
pure apparatus tweak, pure removal, anything — charged a change fee whenever the change-fee window
was open and the athlete already had a reg. **Confirmed reachable, not just theoretical:** the
"Register yourself →" button (`Events.tsx:559-561`, `caps.canRegister` gate) has no
already-registered exclusion, so re-opening it for an event the athlete is already registered for
opens this exact code path with `alreadyHadRegs === true`. This is the likely mechanism behind the
owner's $15 charge for a pure removal (test money, wiped pre-launch per D-4 — no refund action
needed).

Fix: added the same `before`/`after` `RegChangeState` + `changeIsEligible` gate MyRegistrations/Club
already use (`beforeClubId = existingForAthlete[0]?.clubId ?? competingClubId`, mirroring
MyRegistrations' pattern). `updatedPending` is set on a prior-paid reg only inside the
`changeFee > 0` branch, so a removal-only or apparatus-only save no longer re-pends a paid reg
here either.

**Finishing the fix (advisor-flagged, not in the original brief but required for correctness):**
narrowing `changeFee` to fire only when eligible means the change-fee window no longer covers a
brand-new discipline added mid-edit via its `refRegIds` (the OLD code accidentally referenced
`regs.map(r=>r.id)` — every reg, including newly-added ones — on the change line; that was itself
the client producing a MIXED line, `money-invariants.md`'s "the client never produces a MIXED line
as of the M-10 rework"). So this pass also:
- Filters the change line's `refRegIds` through `regsForChangeLine(regs, priorById)` (same helper
  Club.tsx/MyRegistrations.tsx use) — PURE change line, only already-paid/updated-pending regs.
- Removed the `!alreadyHadRegs` gate on the entry-fee cart-line push (was
  `if (!alreadyHadRegs && entryTotal > 0)`, now `if (entryTotal > 0)`) and on the matching
  `cartLinkedIds` hold-stamp loop — otherwise a discipline added ALONGSIDE an edit to an existing
  registration would be priced (via `entryTotal`) and stamped `paid:false` but referenced by
  NO cart line at all (permanently unpayable), since it's deliberately excluded from the now-pure
  change line. This mirrors Club.tsx's own "H7" comment/fix, which Events.tsx never got.
- Fixed the success toast, which used to say "Change fee added to your cart" off the raw
  `changeFeeApplies` window flag rather than what was actually charged — a removal-only edit inside
  an open window used to falsely claim a change fee was added. Now keyed off `chargedChangeFee`/
  `chargedEntryTotal` (hoisted `let`s, set inside the `mutate()` closure), with a combined-total
  message when both a change fee and an entry fee apply (mirrors MyRegistrations' toast).

`MyRegistrations.tsx`'s `saveRegs` and `Club.tsx`'s `saveRegs` were re-verified, not changed: both
already build `before`/`after` from `changeIsEligible` correctly, already use `regsForChangeLine`
for the change line's `refRegIds`, and already only set `updatedPending:true` inside their
`changeFee > 0` branches — a removal-only save on either path pushes no cart line and never
re-pends a paid reg. Confirmed via the existing (and now extended) `changeIsEligible` vitest table
rather than by re-deriving the logic.

**New vitest (`tests/lib/pricing-registration.test.ts`, `changeIsEligible (3h)`):** two matrix
cases the existing table didn't cover — `'combo: discipline removed + level change on a KEPT
discipline → eligible (the level change)'` and `'combo: discipline removed + a DIFFERENT
discipline added → eligible (the add)'`. Both pass against the UNCHANGED `changeIsEligible` — they
document that a removal never adds a fee on top, but another change on the same edit still does.

### 2. Zero-apparatus discipline = "attending, not competing" (savable everywhere)

`RegistrationEditor.tsx`'s `handleSave` (non-camp branch) used to skip building a reg row entirely
when `!d.enabled || d.apparatus.length === 0` — a checked-but-empty discipline silently vanished
from the saved set, indistinguishable from unchecking it. And `anyEnabled` (gates the Save button)
required `apparatus.length > 0` on top of `enabled`, so a checked-but-empty discipline **disabled
Save outright** — there was no way to save this state at all before today.

Fixed, all in `RegistrationEditor.tsx`:
- `handleSave`'s loop now only skips on `!d.enabled` — a checked discipline is always saved, apparatus
  empty or not (`existing_?.id` reuse logic unchanged, so re-checking a previously-unchecked
  discipline still mints a fresh id and checking-with-zero-apparatus-then-adding-apparatus-later
  reuses the same row — no duplicate against `registrations_live_slot_uniq`).
- `anyEnabled` no longer requires `apparatus.length > 0` — Save is enabled the moment ANY discipline
  is checked.
- `draftToEntries`'s "after" branch no longer excludes zero-apparatus disciplines — they're now a
  real present entry for the `changeIsEligible`/`regChangeHasDiff` diff (matters for a discipline
  that's ALSO getting a level change while at zero apparatus — excluding it would have wrongly hidden
  that level change from `changeIsEligible`, since apparatus-count doesn't gate any of that
  predicate's own branches).
- `newDisciplineCount` (feeds the live price ESTIMATE only, not an actual charge — the three
  `saveRegs`/`persistRegs` paths compute their own new-discipline counts independently, none of
  which filtered on apparatus) no longer requires apparatus>0, so a brand-new zero-apparatus
  discipline's entry fee estimate isn't silently omitted.
- **Deliberately left unchanged** (per review, not required by this task and entangled with the
  late-fee anchor computed from the SAME filtered set): `priorDisciplineCount`
  (`RegistrationEditor.tsx` / `MyRegistrations.tsx` / `Club.tsx`, all `r.apparatus.length > 0`) —
  whether an existing zero-apparatus discipline should count toward "second discipline" pricing for
  a LATER addition is a real question but out of this task's four decisions; flagging as a
  follow-up rather than guessing.
- Added a single warning toast fired from `handleSave` (once, listing every affected discipline by
  name) when any saved row has empty apparatus: "`<disciplines>` saved with no apparatus selected —
  the host will list `<athlete>` as attending, not competing." — not per-checkbox-click.

Fixed the toast wording (decision 3, exact spec typo): "If you remove all selected events" →
"apparatus" in the existing "stay registered for at least 1 discipline" toast
(`RegistrationEditor.tsx`, `updateDisc`). Grepped the exact string
`"the meet host will know that you do not plan to compete"` first — one call site, no duplicates
to fix elsewhere.

**New vitest (component, `tests/components/registration-editor.test.tsx`):** new describe blocks —
Save stays enabled for a checked/zero-apparatus new registration; saving one produces a real
`apparatus: []` row and fires the warning toast exactly once with the right wording; clearing all
apparatus on an existing PAID reg (still checked) saves as a FREE edit (label stays "Save", not
"Add change to cart") and persists `apparatus: []` on the same row id (no delete/re-create); the
at-least-1-discipline toast now says "apparatus" and not the old "events" typo.

### 4. Honest presentation of a blanked/zero-apparatus row

`MyRegistrations.tsx`'s registration table (`regs.map` around line 774) rendered `r.apparatus.join
(', ')` straight into a `<td>` — a zero-apparatus row (this new legitimate state, OR the pre-existing
refunded-but-kept-listed state) just showed an empty cell (owner screenshot: "looks broken"). Now
renders a muted, italic "Attending — not competing" (`var(--ink-soft)`, the token this file already
uses throughout for secondary text on this same card background) whenever `apparatus.length === 0
&& !r.refunded` — explicitly excludes the refunded-but-kept case, which already has its own
"Refunded" badge in the status column and legitimately shows blank apparatus for an unrelated
reason (spec §H, not this decision).

Checked `Club.tsx`'s registered-athletes summary (`regSummary`, uses module-level `eventsText`):
it already degrades gracefully for a blank apparatus list — `if (events) parts.push(events)` simply
omits the segment rather than rendering a stray `" – "`, so it never looked visually "broken" the
way MyRegistrations' fixed-column table did. Still a one-liner to make it equally honest (a
zero-apparatus non-camp reg used to read identically to a camp reg's intentionally-blank segment):
added an `else if (r.levelId && !r.refunded)` branch that pushes `'attending, not competing'` when
there's a level (i.e. NOT a camp reg, which stores `levelId:''`) but no apparatus segment.

### 5. CartCheckout / StripeCheckout: Stripe inlay padding

`StripeCheckout.tsx`'s `'form'` phase (owner screenshot) wraps the live `EmbeddedCheckoutProvider`/
`EmbeddedCheckout` in `<div className="card card-pad">` — `.card-pad` is a uniform `padding: 20px`
(`index.css:366`), so the class alone should already give 20px on every side; added an explicit
`style={{ paddingBottom: 20 }}` on that same div as a defensive, unambiguous match to the top/side
token value, in case the embedded iframe's own dynamic-height JS was consuming the class-based
padding in a way that doesn't show up in static CSS inspection. **Flagging for the controller's own
visual check** (task brief explicitly excluded Browser-pane verification for this item, and I
couldn't reach a live Stripe test-mode session inside this run to confirm the before/after
pixel diff) — if the card still reads flush after this change, the actual fix likely needs to live
inside Stripe's `EmbeddedCheckoutProvider` `options`/appearance config rather than the wrapping
`div`'s CSS, since the iframe is cross-origin and its OWN internal bottom padding isn't something
our CSS can reach.

### Verification

`npm run build` — clean (`tsc -b && vite build`; PWA precache regenerated; dev-auth firewall check
passed).

`npx eslint src/pages/Events.tsx src/components/RegistrationEditor.tsx src/pages/MyRegistrations.tsx
src/pages/Club.tsx src/components/StripeCheckout.tsx tests/lib/pricing-registration.test.ts
tests/components/registration-editor.test.tsx` — zero errors/warnings.

`npx vitest run` — 87 files / 1395 tests, all green. Chargeability matrix cases live in
`tests/lib/pricing-registration.test.ts` → `describe('changeIsEligible (3h)')`: `'remove a
discipline → NOT eligible on its own'` (pre-existing), `'combo: discipline removed + level change on
a KEPT discipline → eligible (the level change)'` (new), `'combo: discipline removed + a DIFFERENT
discipline added → eligible (the add)'` (new). Zero-apparatus/toast-wording coverage in
`tests/components/registration-editor.test.tsx`'s two new `describe` blocks (4 new tests).

**Money-invariants-scoped diff** (`Events.tsx` touches `changeIsEligible`/`regsForChangeLine`
classification and cart-line shape, matching the pattern `money-invariants.md` documents for
Club.tsx/MyRegistrations.tsx) — per CLAUDE.md's model-routing rule, a reviewer-tier adversarial read
of `src/pages/Events.tsx`'s `persistRegs` is owed before merge/push, same as any money-adjacent
diff; not performed as part of this single-agent implementation pass.

Files touched: `src/pages/Events.tsx`, `src/components/RegistrationEditor.tsx`,
`src/pages/MyRegistrations.tsx`, `src/pages/Club.tsx`, `src/components/StripeCheckout.tsx`,
`tests/lib/pricing-registration.test.ts`, `tests/components/registration-editor.test.tsx`.

**Controller should verify live:** (1) an athlete already registered for an event, change-fee
window open, uses "Register yourself" to remove a discipline only — cart stays empty, no
`updated_pending` flip. (2) same athlete checks a discipline with zero apparatus and saves — Save
button stays enabled, row persists with an empty apparatus list, warning toast appears once. (3)
My Registrations list shows "Attending — not competing" (muted) for that row instead of a blank
cell. (4) Stripe Embedded Checkout inlay in Cart — confirm the bottom padding is now visibly
present against the card border; escalate to Stripe `appearance`/layout options if the CSS change
alone didn't fix it.

## E-02-01 / E-02-02 / E-03 (2026-08-27 owner screenshots): standardized confirmation email + $0 self-reg send

**Branch:** `fix/e02-confirmation-email` (cut from `main`, not merged by this pass).

**What changed.**
- `supabase/functions/_shared/registration-confirmation.ts` (new, pure, no Deno/Supabase
  imports — unit-tested under node like `camp-confirmation.ts`): `confirmationSubject(names)`
  (one distinct event → `"<name> Registration Confirmation"`; zero or multiple → the generic
  `"Your United Club Gymnastics receipt"`), `hostMessageCardHtml(bodyHtml)` (the "A message from
  your host" card — previously "A message from `${event.name}`"; owner's annotation was that the
  message is from the HOST, not the event), `registeredForLineHtml(names)` (the $0 path's "You're
  registered for `<event>`." lines). Shared by both confirmation paths so they render an
  identical-looking host card and use the identical subject rule.
- `supabase/functions/_shared/fulfill.ts` `emailReceipt` (~L594-770): (1) dropped the per-event
  `fromAlias`/`replyTo` override entirely — `conf.fromAlias`/`conf.replyTo` are no longer read at
  all, and the `sendOne` call no longer spreads `reply_to`/`fromName`; sender is now always the
  `RESEND_FROM` default (United Club Gymnastics) via `_shared/resend.ts`'s existing fallback. (2)
  Subject now `confirmationSubject(...)` over the distinct event names referenced by `items`
  (resolved via the already-loaded `evs` rows) instead of a hardcoded string. (3) Body reordered:
  "Thanks for your purchase." and "Here's your receipt for the items below." are now two separate
  `<p>`s with the host-message card (`eventSectionsHtml`, now built via `hostMessageCardHtml`)
  spliced BETWEEN them, so a host message reads before the receipt instead of after a single
  combined sentence. (4) The per-event confirmation-config try/catch no longer touches
  `replyTos`/`fromAliases` sets (removed) — only `ccSet` (director cc — unchanged) and
  `eventSectionsHtml` remain.
- `src/lib/types.ts` `Event.confirmationEmail`: `fromAlias`/`replyTo` kept OPTIONAL on the type
  (back-compat parsing of an old event row that still has them) but documented as retired —
  nothing writes or reads them anymore.
- `src/components/EventWizard.tsx`: removed the "From alias"/"Reply-to email" `<Field>`s (and
  their wrapping `grid cols-3` div — an empty grid would've left stray margin), the
  `confirmationFromAlias`/`confirmationReplyTo` state (including the `jzsharpe@gmail.com`
  UCG-hosted-create default), and their spread into the saved `confirmationEmail` object (now
  just `{ bodyHtml: confirmationBodyHtml }`). Helper text now reads "This email always sends from
  United Club Gymnastics. If the host wants to include contact info, put it in the custom message
  below." `isUcgHosted`/`isEdit` stay in heavy use elsewhere in the file (verified via grep before
  removing their only other use here), so no new unused-var lint errors.
- **New edge function `supabase/functions/send-registration-confirmation/index.ts`** (verify_jwt
  stays TRUE — not one of the three `--no-verify-jwt` functions): closes E-02-02 — a host-club $0
  registration is created `paid:true` with NO cart line (`registrationEntryFee` prices it $0 for
  the event's own host club), so it never goes through checkout and `emailReceipt` never fires for
  it. Takes `{ regIds }` or `{ eventId }` (the latter scoped server-side to the caller's OWN live
  regs for that event — never a league-wide lookup). Anti-abuse guard mirrors
  `withdraw-registration`'s shape exactly: resolves the caller's own `people` row from the JWT,
  loads the target registration(s), and 403s outright if ANY row's `athlete_id` isn't the
  caller's — **no club-manager branch at all**, matching the owner's rule verbatim ("a club
  manager registering via Club Registrations sends NONE"). Sends via the shared
  `registration-confirmation.ts` helpers: subject, host-message card(s), "You're registered for
  `<event>`." line(s), and a "View Registration Details" CTA to `/#/me/registrations` — no receipt
  table, no invoice number (nothing was purchased). Scope decision: does NOT cc the event
  director, unlike the paid path — the owner's enumerated content list for this email didn't
  include it; flagging in case that was an oversight rather than a deliberate omission.
- **Wired into `Events.tsx`'s `SelfRegModal.persistRegs`, `hostFree` branch only** (~L2468-2697,
  call added right after the `if (!applied) return;` gate, before the success toast) — this is the
  single self-registration modal (used from both the Events list "Register yourself" and My
  Registrations "Register for another event"), so both entry points are covered by one call site.
  `Club.tsx`'s manager-side `saveRegs` was NOT touched (owner's rule: managers get no email).
  Fire-and-forget with a `.catch()` — a send failure is logged to console but never surfaces as a
  registration failure, since the registration write already succeeded before this fires.
  **Semantic note for future readers:** `hostFree = !alreadyHadRegs && entryTotal === 0` is not
  literally "the athlete is in the host club" — it's "brand-new + $0", which is the correct
  discriminator for the actual bug (any $0 brand-new entry has no cart line, hence no receipt
  email), but don't "correct" this gate into a literal host-club-membership comparison later.

**The write-queue race this almost missed (caught by advisor review before implementation).**
`persistRegs`'s `pushRegistration(reg)` calls go through `remoteUpsert` → `writeQueue.enqueue`,
which is fire-and-forget (kicks the processor, doesn't await it) — NOT an awaited write. Invoking
`send-registration-confirmation` immediately after `mutate()` returns would race the queue:
the edge function (service role) could look up `regIds` before the row actually lands in Postgres,
404, and silently send no email — a bug that would reproduce rarely/never locally (queue drains
near-instantly against a local/fast connection) and intermittently in the field. **Fixed
client-side**, not with a server-side retry: `src/lib/supabase.ts` adds
`waitForWriteQueueDrain()` (same drain loop as `scheduleRollbackSync`'s private `waitForDrain` —
deliberately duplicated rather than shared, since that one sits on the sensitive permanent-failure
rollback path) and the new `sendRegistrationConfirmation(regIds)` invoker awaits it before calling
`supabase.functions.invoke`. The `Events.tsx` call site itself stays fire-and-forget (doesn't
await `sendRegistrationConfirmation`), so this wait never blocks the UI or the success toast/nav.

**Deploy list (NOT run by this pass — no `supabase` CLI invocations per the task's constraints):**
- `stripe-webhook` — **redeploy with `--no-verify-jwt`** (bundles `_shared/fulfill.ts`; a bare
  redeploy silently resets `verify_jwt=true` and the webhook goes dark with no logs — this is the
  exact trap that left a real charge unfulfilled 2026-07-02, see `edge-functions.md`).
- `create-checkout-session` — bundles `_shared/fulfill.ts` (the $0-total free-order path calls
  `fulfillPayment` directly).
- `reconcile-payments` — also bundles `_shared/fulfill.ts` (admin `refulfill`/free-order-refulfill
  ops call `fulfillPayment`); not one of the three `--no-verify-jwt` functions.
- `send-registration-confirmation` — new function, default `verify_jwt=true` (no
  `[functions]` block in `supabase/config.toml` to add).

**Verification.** `npm run build` — clean. `npx eslint src/components/EventWizard.tsx
src/pages/Events.tsx src/lib/supabase.ts src/lib/types.ts supabase/functions/_shared/fulfill.ts
supabase/functions/_shared/registration-confirmation.ts
supabase/functions/send-registration-confirmation/index.ts tests/registration-confirmation.test.ts`
— zero errors/warnings. `npx vitest run` — 88 files / 1408 tests, all green (10 new in
`tests/registration-confirmation.test.ts`: `confirmationSubject` zero/one/duplicate/blank/multiple
cases, `hostMessageCardHtml` blank-input and host-HTML-not-escaped cases, `registeredForLineHtml`
dedup + escaping).

**Money-invariants-scoped diff.** `_shared/fulfill.ts` is in `money-invariants.md`'s path list —
per CLAUDE.md's model-routing rule, a reviewer-tier adversarial review of this diff (particularly
the `emailReceipt` changes and the new edge function's auth guard) is owed before merge/push/apply.
**Not performed as part of this single-agent implementation pass** — this branch is committed but
NOT merged to `main`.

**Controller should verify live (or arrange for the reviewer-tier pass to check):** (1) a
single-event paid purchase's subject line names the event; a membership-only or multi-event cart
keeps the generic subject. (2) a host's confirmation body renders BELOW "Thanks for your
purchase." and above "Here's your receipt for the items below." (3) a host-club athlete using
"Register yourself" for a $0 entry receives an email with the host's custom message (if any) and a
working "View Registration Details" link — confirm it actually arrives (Resend dashboard/logs),
not just that the invoke call didn't throw. (4) a club manager registering the same athlete via
Club Registrations sends NO such email. (5) confirm no live event still has `fromAlias`/`replyTo`
set that anyone expects to still take effect (EventWizard no longer surfaces or writes them, but a
pre-existing value on an old row is now silently inert rather than erroring).

## E-01-03 (2026-09-06, Julia's Mac) — sanction decisions never persisted; requester summary/Details

**Symptom (Julia's sheet + screenshots):** ZZTEST_ApproveThis was approved (team + requester
emails arrived) but `#/sanction` kept showing VOTING with no Open-event button even after a hard
reload, and the requester's approval CTA went to `#/sanction` instead of the host dashboard.

**Root cause:** `resolveRequest` (approve AND reject) and `saveDeadline` all persisted through
`pushSanctionRequest` = `remoteUpsert('sanction_requests', …)`. The 8/26 lockdown split the old
`for all` policy and made `sanction_requests_insert` require `status = 'voting'`. For
`INSERT … ON CONFLICT DO UPDATE`, Postgres runs the INSERT policy's WITH CHECK on the proposed
row in `ExecInsert` before the arbiter-index conflict check ever reaches `ExecOnConflictUpdate`,
so a row carrying `status='approved'` is rejected 42501 regardless of the UPDATE policy. The
write queue treated that as permanent, toasted, and rolled the local state back to the server
copy (`voting`). `pushEvent` is a separate insert with a permissive policy, so the live event
was created — the two writes diverged. The deadline editor kept working only because it always
carries `status='voting'`. The migration's reviewer note ("`pushSanctionRequest` is called
requester-side exactly once") checked the requester path and missed the team's decision path.

**Fix:** `patchSanctionRequest(id, {status, decidedAt, createdEventId, sanctionId, deadlineAt})`
→ `remoteUpdate` (PATCH by id). `pushSanctionRequest` is now submit-only. No migration: the
split policies are correct as written; the client was using the wrong verb.

**Notifier ordering:** `notifySanction` now `await waitForWriteQueueDrain()` before invoking
(the `sendRegistrationConfirmation` pattern). Server side, `notify-sanction` re-reads `status`
and returns 409 when it doesn't equal the requested event — so a failed decision write can no
longer produce an "approved" email. `resolveRequest` surfaces a failed notify as an error toast.

**Requester surfaces:** new shared pure module `supabase/functions/_shared/sanction-summary.ts`
(`sanctionSummaryRows`/`groupSanctionSummary`, tests in `tests/sanction-summary.test.ts`) — same
labelled rows rendered by the new "Details" modal on Your Sanction Requests (`Sanction.tsx`) and
by the submitted email's summary table (level ids resolved from `levels`). Payout email/address
are deliberately not rendered. "Open event" relabelled "Host dashboard". Approval email/ toast
no longer say "draft"; CTA is "Open your host dashboard".

**Not done here:** `notify-sanction` deploy (no CLI token on Julia's Mac) and the one-row repair
of `sr-1788724866012` — both listed under Nate actions in the triage doc. The vote page's own
hand-rolled detail list was left as-is; it could be swapped to the shared rows later.
