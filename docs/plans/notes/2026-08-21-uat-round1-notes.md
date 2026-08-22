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
