# UAT round-1 implementation notes (deviations from the triage plan)

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
