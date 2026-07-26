// Pure "estimated price" selector for the registration editor (S5, UI/UX
// review 2026-07-04). Orchestrates the EXISTING pure fee helpers in
// pricing.ts — it does not compute any fee amounts itself, only routes to the
// right helper/case and formats the resulting label. No React/store/Supabase
// imports; unit-tested in tests/lib/reg-estimate.test.ts.
//
// Every number here is an ESTIMATE — the server (create-checkout-session,
// `mode: 'preview'`) always reprices authoritatively at checkout. Every
// label produced by `registrationEstimateLabel` says so explicitly.
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
  /** `changeIsEligible(before, after)` result, already computed by the
   *  caller from its own before/after `RegChangeState` — only consulted when
   *  `isEditingExisting` is true. */
  eligible: boolean;
  /** How many disciplines/rows are newly enabled with apparatus selected —
   *  only consulted for a brand-new registration (`!isEditingExisting`).
   *  Camps are a single flat-fee row regardless of the equipment list, so
   *  callers must pass 1 for a camp new-registration, never a discipline
   *  count. */
  newDisciplineCount: number;
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
  newDisciplineCount,
}: RegEstimateInput): RegEstimate {
  // Same guard `registrationEntryFee`/`registrationChangeFee`/
  // `newRegistrationEntryTotal` each apply internally — never treat an empty
  // `event.hostClubId` (UCG-hosted, no host club resolved) as matching an
  // equally-empty `competingClubId`.
  const isHostClub = !!event.hostClubId && competingClubId === event.hostClubId;
  if (isHostClub) return { kind: 'host-free' };

  if (!isEditingExisting) {
    const amountDollars = newRegistrationEntryTotal(event, {
      competingClubId,
      priorDisciplineCount: 0,
      newDisciplineCount,
    });
    return { kind: 'new-entry', amountDollars };
  }

  if (!eligible) return { kind: 'no-charge' };

  const amountDollars = registrationChangeFee(event, { competingClubId });
  return { kind: 'change-fee', amountDollars };
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
