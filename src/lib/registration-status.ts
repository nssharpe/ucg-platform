// Pure payment-status selector for a registration (or a group of a single
// event's registration rows) — S6, UI/UX review 2026-07-04. Derives STRICTLY
// from the registration's own `paid`/`updatedPending` fields (CLAUDE.md
// "Registration paid-state") — never a `refRegIds`-scanning heuristic, which
// belongs to checkout/webhook fulfillment only. No React/store/Supabase
// imports; unit-tested in tests/lib/registration-status.test.ts.
import type { Registration } from './types';

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
