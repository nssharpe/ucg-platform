// Pure payment-status selector for a registration (or a group of a single
// event's registration rows) — S6, UI/UX review 2026-07-04. Derives STRICTLY
// from the registration's own `paid`/`updatedPending` fields (CLAUDE.md
// "Registration paid-state") — never a `refRegIds`-scanning heuristic, which
// belongs to checkout/webhook fulfillment only. No React/store/Supabase
// imports; unit-tested in tests/lib/registration-status.test.ts.
import type { InvoiceItem, Registration } from './types';

export type RegPaymentStatus = 'paid' | 'pending-purchase' | 'change-pending';

export interface RegPaymentStatusInfo {
  status: RegPaymentStatus;
  /** User-facing label, safe to render standalone (badge or plain text). */
  label: string;
  /** Matches the existing `.badge.ok`/`.badge.warn` classes (both already
   *  AA-verified against their fills — see index.css). */
  tone: 'ok' | 'warn';
}

/**
 * Aggregate payment status for a SET of registration rows belonging to the
 * same event (a registration card may hold one row per discipline). Priority:
 * any row `updatedPending` ⇒ "change-pending" (an edit re-pended a previously
 * paid row — that always deserves the more specific message, even if other
 * rows in the group are still simply unpaid); else any row `!paid` ⇒
 * "pending-purchase"; else (every row paid, none updated-pending) ⇒ "paid".
 * Host-club $0 registrations are created `paid: true`, so they correctly fall
 * into the "paid" case with no special-casing needed here.
 */
export function registrationGroupPaymentStatus(
  regs: Pick<Registration, 'paid' | 'updatedPending'>[],
): RegPaymentStatus {
  if (regs.some((r) => r.updatedPending)) return 'change-pending';
  if (regs.some((r) => !r.paid)) return 'pending-purchase';
  return 'paid';
}

const STATUS_INFO: Record<RegPaymentStatus, Omit<RegPaymentStatusInfo, 'status'>> = {
  paid: { label: 'Paid', tone: 'ok' },
  'pending-purchase': { label: 'Pending purchase — in your cart', tone: 'warn' },
  'change-pending': { label: 'Change pending purchase', tone: 'warn' },
};

/** Label + badge tone for a single `RegPaymentStatus`. */
export function regPaymentStatusInfo(status: RegPaymentStatus): RegPaymentStatusInfo {
  return { status, ...STATUS_INFO[status] };
}

/** Convenience: label + tone straight from a group of registration rows. */
export function regGroupPaymentStatusInfo(
  regs: Pick<Registration, 'paid' | 'updatedPending'>[],
): RegPaymentStatusInfo {
  return regPaymentStatusInfo(registrationGroupPaymentStatus(regs));
}

// --- Duplicate-slot predicate (UAT Z-02-01, S1) -----------------------------
// "No athlete can be charged twice for the same (event, discipline)." A
// "live slot" is one (eventId, athleteId, discipline) triple; at most one
// non-refunded registration should ever occupy it — enforced at the DB level
// by the partial unique index `registrations_live_slot_uniq`
// (`supabase/migrations/20260822010000_registrations_live_slot_uniq.sql`).
// `findPaidSibling` is the pure predicate mirrored server-side in
// `supabase/functions/_shared/registration-status.ts` — KEEP IN LOCKSTEP
// (only field casing differs: camelCase here, snake_case there).
export interface SlotRegLike {
  id: string;
  eventId: string;
  athleteId: string;
  discipline: string;
  refunded?: boolean;
  paid?: boolean;
}

/**
 * The other, already-PAID, non-refunded registration occupying `reg`'s exact
 * (event, athlete, discipline) slot, if any — `null` when `reg` has no live
 * paid sibling. Never matches `reg` against itself (same `id`), a refunded
 * sibling, a different discipline (so a legacy multi-row camp registration —
 * one row per discipline — never conflicts with itself), or an unpaid
 * sibling (an unpaid pending reg isn't a "you already paid this" conflict).
 */
export function findPaidSibling<T extends SlotRegLike>(reg: SlotRegLike, allRegs: readonly T[]): T | null {
  return allRegs.find((r) =>
    r.id !== reg.id &&
    r.eventId === reg.eventId &&
    r.athleteId === reg.athleteId &&
    r.discipline === reg.discipline &&
    !r.refunded &&
    r.paid === true,
  ) ?? null;
}

/**
 * Every refundable line for a registration: entry + extra-discipline fee
 * lines only (`kind='meet-entry'`), excluding change-fee lines outright
 * (money-invariants.md "Refunds" — never refundable, even when a change fee
 * is combined with an added discipline into one 'change'-tagged line,
 * M-10-01). Pulled out of `RefundRequestDialog.tsx` (a component file, which
 * can't export a plain function without tripping `react-refresh/only-export-
 * components`) so `MyRegistrations.tsx`'s refund-vs-withdraw decision (owners'
 * withdrawal spec 2026-08-23, rule 2: only a registration with refundable
 * paid cents keeps "Request a refund" — a $0 one gets Withdraw instead) can
 * share the exact same total instead of re-deriving it.
 */
export function registrationLines(allItems: InvoiceItem[], regId: string): InvoiceItem[] {
  return allItems.filter((it) => it.kind === 'meet-entry' && it.refLineType !== 'change' && (it.refRegIds ?? []).includes(regId));
}
