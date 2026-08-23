// _shared/registration-status.ts — Deno mirror of the duplicate-slot
// predicate in src/lib/registration-status.ts (UAT Z-02-01, S1: "no athlete
// can be charged twice for the same (event, discipline)"). KEEP IN LOCKSTEP
// — the logic must answer identically on both sides; only field casing
// differs (snake_case DB rows here vs. camelCase app types there).
//
// "Live slot" = one (event_id, athlete_id, discipline) triple. At most one
// non-refunded registration should ever occupy a slot — enforced at the DB
// level by the partial unique index `registrations_live_slot_uniq`
// (migration `20260822010000_registrations_live_slot_uniq.sql`). This
// helper is the APPLICATION-level defense in depth on either side of that
// index: `create-checkout-session` calls it to refuse charging into an
// already-paid slot, and `_shared/fulfill.ts` calls it right before flipping
// `paid` to refuse completing a SECOND registration for a slot another
// payment already won (and refund itself instead).

export interface SlotRegLike {
  id: string;
  event_id: string;
  athlete_id: string;
  discipline: string;
  refunded: boolean | null;
  paid: boolean | null;
}

/**
 * The other, already-PAID, non-refunded registration occupying `reg`'s exact
 * (event, athlete, discipline) slot, if any — `null` when `reg` has no live
 * paid sibling. Never matches:
 *  - `reg` against itself (same `id`) — editing/paying your OWN reg again is
 *    not a conflict;
 *  - a refunded sibling — a refunded slot is free to re-occupy;
 *  - a different discipline — a legacy multi-row camp registration (one row
 *    per discipline, see registrations-and-camps.md) never conflicts with
 *    itself;
 *  - an unpaid sibling — an unpaid pending reg isn't a "you already paid
 *    this" conflict (that's the separate mid-checkout pending-hold check).
 */
export function findPaidSibling<T extends SlotRegLike>(reg: SlotRegLike, allRegs: readonly T[]): T | null {
  return allRegs.find((r) =>
    r.id !== reg.id &&
    r.event_id === reg.event_id &&
    r.athlete_id === reg.athlete_id &&
    r.discipline === reg.discipline &&
    !r.refunded &&
    r.paid === true,
  ) ?? null;
}
