// Pure "estimated price" selector for the registration editor (S5, UI/UX
// review 2026-07-04). Orchestrates the EXISTING pure fee helpers in
// pricing.ts — it does not compute any fee amounts itself, only routes to the
// right helper/case and formats the resulting label. No React/store/Supabase
// imports; unit-tested in tests/lib/reg-estimate.test.ts.
//
// Every number here is an ESTIMATE — the server (create-checkout-session,
// `mode: 'preview'`) always reprices authoritatively at checkout. Every
// label produced by `registrationEstimateLabel` says so explicitly.
//
// ── The branch order below MIRRORS the real charge path in Club.tsx's
// `saveRegs` (~lines 1319-1352) and MyRegistrations.tsx's equivalent. Keep
// them in lockstep; if the save path's precedence changes, change it here too.
// The save path computes:
//     changeFee  = changeFeeApplies && eligible ? registrationChangeFee(...) : 0
//     entryTotal = newRegistrationEntryTotal(... over newly-added regs ...)
// and then charges:
//     if (changeFee > 0)                           -> change-fee line, PLUS a
//                                                      SEPARATE entry line when
//                                                      a discipline was also
//                                                      ADDED (UAT M-10 x Z-04 —
//                                                      two lines, one estimate)
//     else if (!changeFeeApplies && entryTotal > 0) -> ENTRY-fee line
// The second branch is easy to miss and was missed in S5's first draft:
// **adding a discipline to an existing registration while the change-fee
// window is CLOSED is charged as an entry fee, not free.** Reporting "no
// charge" there understates the bill, which is the failure direction that
// actually harms trust.
//
// UAT M-10-01 (S1, confirmed by the requirements owner): adding a discipline
// to an ALREADY-PAID registration while the change-fee window is OPEN must
// charge the extra-discipline entry fee AND the change fee. The first branch
// above previously stopped at `changeFee` and silently dropped the
// entry-total for the added discipline whenever a change fee also applied.
//
// UAT M-10 x Z-04 (2026-08-22): this ESTIMATE stays a single combined TOTAL
// (entry portion + change fee summed) even though the real save path
// (Club.tsx/MyRegistrations.tsx `saveRegs`) now pushes that total as TWO
// separate cart lines (a pure change-fee line + a pure entry line) so each
// keeps its own refund eligibility — change-fee lines are never refundable.
// This selector only estimates "what will this cost", never a cart line
// shape, so composing `newRegistrationEntryTotal(...) + registrationChangeFee(...)`
// directly (rather than via the cart-line-flavored `addedDisciplineChangeTotal`
// helper) keeps the SAME number ($45 in the worked example) without implying
// a single-line shape that no longer exists on the client.
//
// ⚠ KNOWN DIVERGENCE from the save path (flagged 2026-08-22, not fixed here):
// the save path's `changedRegs` (`regsForChangeLine`, pricing.ts) only pushes
// a change line when the athlete's PRIOR regs were actually paid/updated_pending
// — editing an all-UNPAID existing registration inside the change-fee window
// now charges $0 there (a deliberate narrowing to stop a paid/pending reg
// getting smuggled onto the same line as a still-unpaid one). This selector
// has no paid-state input at all, so for that same all-unpaid case it still
// returns `{kind:'change-fee', amountDollars: changeFeeAmount + entryTotal()}`
// — a NON-ZERO estimate for what will actually be a free save. Fixing this
// needs a new `RegEstimateInput` field (e.g. `priorRegsArePaid`) threaded from
// `RegistrationEditor.tsx`'s caller; out of scope for the M-10 x Z-04 rework.
import { newRegistrationEntryTotal, registrationChangeFee, type RegFeeEvent } from './pricing';
import { fmtMoney } from './scoring';

export type RegEstimate =
  | { kind: 'host-free' }
  | { kind: 'new-entry'; amountDollars: number }
  | { kind: 'change-fee'; amountDollars: number }
  | { kind: 'no-charge' };

export interface RegEstimateInput {
  event: RegFeeEvent;
  /** The club the athlete would be competing FOR after this save. */
  competingClubId: string;
  /** True when editing an already-existing (non-refunded) registration;
   *  false for a brand-new registration. */
  isEditingExisting: boolean;
  /** Raw `changeIsEligible(before, after)` from the caller. Pass it RAW —
   *  do NOT pre-AND it with `changeFeeApplies`; this selector needs the two
   *  separately to reproduce the save path's precedence (see header). */
  eligible: boolean;
  /** Has the event's change-fee window opened (`now >= event.changeFee.startsAt`)?
   *  The save path gates the change fee on this, AND uses it to decide whether
   *  a newly-added discipline is billed as an entry fee instead. */
  changeFeeApplies: boolean;
  /** Disciplines being added RIGHT NOW — enabled, with apparatus selected, and
   *  having no existing non-refunded row. The analogue of `newOnlyRegs` in
   *  Club.tsx. For a brand-new camp registration this is 1 (camps are a single
   *  flat-fee row regardless of the equipment list), never a discipline count. */
  newDisciplineCount: number;
  /** Disciplines the athlete is ALREADY registered for at this event (existing
   *  non-refunded rows with apparatus) — so an added discipline prices at the
   *  SECOND-discipline rate rather than the base entry fee. 0 for a brand-new
   *  registration. */
  priorDisciplineCount: number;
  /** Late-registration anchor, when one applies — `lateFeeAnchor(...)`'s
   *  result, same input the save path feeds `newRegistrationEntryTotal`.
   *  Omitted ⇒ no surcharge, matching that helper's own default. */
  late?: { earliestCreatedAtISO: string };
}

/**
 * Which pricing case applies to the registration editor's current draft, and
 * (when a fee applies) its estimated dollar amount. Host-club competing
 * (fees $0 for entry, second-discipline, AND change fee — see pricing.ts)
 * takes priority over every other case, matching the existing $0/no-cart-line
 * behavior for the host club's own athletes.
 */
export function registrationEstimate({
  event,
  competingClubId,
  isEditingExisting,
  eligible,
  changeFeeApplies,
  newDisciplineCount,
  priorDisciplineCount,
  late,
}: RegEstimateInput): RegEstimate {
  // Same guard `registrationEntryFee`/`registrationChangeFee`/
  // `newRegistrationEntryTotal` each apply internally — never treat an empty
  // `event.hostClubId` (UCG-hosted, no host club resolved) as matching an
  // equally-empty `competingClubId`.
  const isHostClub = !!event.hostClubId && competingClubId === event.hostClubId;
  if (isHostClub) return { kind: 'host-free' };

  const entryTotal = () => newRegistrationEntryTotal(event, {
    competingClubId,
    priorDisciplineCount,
    newDisciplineCount,
    late,
  });

  // Brand-new registration: always the entry-fee path.
  if (!isEditingExisting) {
    return newDisciplineCount > 0
      ? { kind: 'new-entry', amountDollars: entryTotal() }
      : { kind: 'no-charge' };
  }

  // --- Editing an existing registration: mirror the save path's precedence ---
  const changeFeeAmount = eligible && changeFeeApplies
    ? registrationChangeFee(event, { competingClubId })
    : 0;
  if (changeFeeAmount > 0) {
    // UAT M-10-01: a discipline ADDED alongside the chargeable edit owes its
    // own extra-discipline entry fee ON TOP of the change fee — never the
    // change fee alone, which would undercharge exactly the C4-adjacent gap
    // this fixes. Entry portion + change fee, summed directly (this is a
    // TOTAL estimate, not a cart-line amount — see the header comment on why
    // this doesn't call `addedDisciplineChangeTotal`).
    const amountDollars = changeFeeAmount + entryTotal();
    return { kind: 'change-fee', amountDollars };
  }

  // Change-fee window not open (or the event has no change fee configured) but
  // disciplines are being added ⇒ the save path bills those as a NEW ENTRY.
  if (!changeFeeApplies && newDisciplineCount > 0) {
    const amountDollars = entryTotal();
    if (amountDollars > 0) return { kind: 'new-entry', amountDollars };
  }

  return { kind: 'no-charge' };
}

/** Human-readable, explicitly-"estimated" label for a `RegEstimate` — the one
 *  line shown above the Save/Cancel row. */
export function registrationEstimateLabel(estimate: RegEstimate): string {
  switch (estimate.kind) {
    case 'host-free':
      return 'Free — host club';
    case 'new-entry':
      return `Estimated entry fee: ${fmtMoney(estimate.amountDollars)} — added to your cart on save`;
    case 'change-fee':
      return `Change fee: ${fmtMoney(estimate.amountDollars)} will be added to your cart`;
    case 'no-charge':
      return 'No charge for this change';
  }
}
