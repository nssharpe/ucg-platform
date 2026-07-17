// Shared cart-item removal logic that keeps the underlying `registrations`
// row(s) / membership payment-hold in sync (unified-cart-b2 Task A; extended
// 2026-07-02 for H5/H6/M7/L2 — see docs/plans/2026-07-02-cart-state-fixes.md
// and Part 2 of docs/specs/2026-07-02-security-review-findings.md). Deleting a
// meet-entry cart item used to just drop the cart_items row, leaving a
// mutated/orphaned registration behind — this module fixes that by branching
// on `classifyCartRemoval` (src/lib/pricing.ts) and doing the right thing:
//   - a brand-new unpaid entry line → delete the registration(s) entirely
//   - a 'change' line with a captured snapshot → restore the registration(s)
//   - a 'change' line with no snapshot (legacy row) → remove the cart item
//     only, and tell the caller a revert wasn't possible
//   - a member-pushed membership line → clear the club-payment hold it set
//   - anything else → remove the cart item only (unchanged behavior)
// H5 fix: a registration can be referenced by MORE THAN ONE cart line (e.g.
// an entry line and a stacked change line on the same reg). `resolveRegRemoval`
// (pricing.ts) computes, per reg id, whether it's safe to delete/revert or
// must be left alone because another line in the SAME cart scope still
// references it — see that function's doc comment for the exact decision
// table. Chosen semantics (documented per the plan): SKIP + toast which ids
// were kept, rather than cascading the removal into the other line(s).
// The actual DB writes reuse the existing push*/delete* helpers in
// lib/supabase.ts and the same `pushCart(ownerKey, itemsWithoutThisOne,
// isClub)` replace-semantics idiom already used at every cart delete site.
import { mutate } from './store';
import { deleteMembership, deleteRegistration, pushCart, pushRegistration } from './supabase';
import { classifyCartRemoval, resolveRegRemoval } from './pricing';
import { paidRegistrationClub } from './capabilities-core';
import type { CartItem, DB } from './types';

export type CartRemovalResult = {
  /** What actually happened to the underlying registration(s)/membership, for
   *  the caller to toast honestly. 'blocked-offline': the offline read-only
   *  gate refused the mutation — NOTHING was removed or changed; callers must
   *  not show any success/removal feedback (mutate itself already toasted). */
  action: 'delete-registration' | 'revert-registration' | 'no-snapshot-remove-only' | 'clear-membership-hold' | 'remove-only' | 'blocked-offline';
  /** H5: registration ids that were left untouched because another cart line
   *  in the same scope still references them (only set for
   *  delete-registration/revert-registration; empty otherwise). */
  keptRegIds: string[];
};

/**
 * Remove `item` from the cart owned by `ownerKey` (a clubId when `isClub`,
 * else a personId), syncing the underlying registration(s)/membership it
 * referenced per `classifyCartRemoval`. Always removes the cart_items row
 * itself. Returns which sync action was taken (+ any reg ids kept because
 * another line still needs them) so the caller can show an accurate toast.
 */
export function removeCartItemWithSync(ownerKey: string, isClub: boolean, item: CartItem): CartRemovalResult {
  const action = classifyCartRemoval(item);
  let keptRegIds: string[] = [];

  const applied = mutate((d) => {
    const cart = d.carts[ownerKey] ?? [];
    const next = cart.filter((i) => i.id !== item.id);

    if (action === 'delete-registration' || action === 'revert-registration') {
      // "Same cart scope" = every OTHER line still in this owner's cart.
      const otherRefRegIds = new Set(next.flatMap((i) => i.refRegIds ?? []));
      const existingRegIds = new Set(d.registrations.map((r) => r.id));
      const { toDelete, toRevert, kept } = resolveRegRemoval(item, { otherRefRegIds, existingRegIds });
      keptRegIds = kept;

      if (toDelete.length) {
        const ids = new Set(toDelete);
        d.registrations = d.registrations.filter((r) => !ids.has(r.id));
        for (const id of ids) deleteRegistration(id);
      }
      for (const prior of toRevert) {
        // H5 "never resurrect": resolveRegRemoval already filtered out ids
        // no longer present in d.registrations, so this is always an
        // in-place update of a still-live row, never a re-insert.
        const idx = d.registrations.findIndex((r) => r.id === prior.id);
        if (idx >= 0) {
          d.registrations[idx] = prior;
          pushRegistration(prior);
        }
      }
    } else if (action === 'clear-membership-hold') {
      // H6: this line was created by Membership.complete('club'), which INSERTED
      // a membership row (status 'pending-club-payment', or 'pending-waiver' for
      // a minor) with clubCartPending:true. Removing the line without paying is
      // a CANCELLATION, so the row the push created must be DELETED.
      //
      // Why delete rather than "clear the hold": membershipHolds() derives
      // `active` PURELY from the holds (`active = !waiverHold && !paymentHold`,
      // capabilities-core.ts) — it does NOT require status==='active'. So for a
      // signed-waiver adult, merely clearing clubCartPending (and flipping
      // status off 'pending-club-payment') would make membershipHolds report
      // ACTIVE — a free, never-paid membership. Deleting is the only correct
      // undo. Guard on clubCartPending===true so a since-PAID membership (its
      // line somehow still present) is never nuked — then it's just a stray
      // line, remove-only. Match keys the webhook uses (person, season, type).
      const person = d.people.find((p) => p.id === item.refUserId);
      const m = person?.memberships.find((x) => x.seasonId === item.refSeasonId && x.type === item.refType);
      if (person && m && m.clubCartPending === true) {
        person.memberships = person.memberships.filter(
          (x) => !(x.seasonId === item.refSeasonId && x.type === item.refType),
        );
        deleteMembership(person.id, item.refSeasonId!, item.refType!);
      }
    }
    // 'no-snapshot-remove-only' and 'remove-only': no registration/membership-side change.

    d.carts[ownerKey] = next;
    pushCart(ownerKey, next, isClub);
  });

  // Offline read-only gate refused the whole mutation: honest "nothing
  // happened" result so callers don't toast a removal that never occurred.
  if (!applied) return { action: 'blocked-offline', keptRegIds: [] };
  return { action, keptRegIds };
}

// ---- Cross-club cart cleanup (3d) -------------------------------------------
// Shared by Club.tsx's EventRegGrid (registrations view) and the unified /cart
// page's managed-club sections (Cart.tsx) — moved here so both call sites use
// the exact same logic without a page-to-page import (which would trip
// react-refresh's "only export components" rule).

/** Resolve the eventId a club-cart meet-entry line is for: prefer the linked
 *  registration(s) (`refRegIds`), else fall back to the "<event name> entry —"
 *  label parse. */
function cartItemEventId(db: DB, item: CartItem): string | null {
  if (item.refRegIds && item.refRegIds.length > 0) {
    const reg = db.registrations.find((r) => item.refRegIds!.includes(r.id));
    if (reg) return reg.eventId;
  }
  const m = item.label.match(/^(.+?) entry —/);
  if (m) return db.events.find((mt) => mt.name === m[1])?.id ?? null;
  return null;
}

/** The club-cart meet-entry lines for `clubId` whose athlete has SINCE become
 *  PAID-registered under a DIFFERENT club for that event (pending line is moot).
 *  Excludes THIS club so a legitimate same-club pending line is never flagged. */
function staleCrossClubCartItems(db: DB, clubId: string): CartItem[] {
  const cart = db.carts[clubId] ?? [];
  return cart.filter((i) => {
    if (i.kind !== 'meet-entry' || !i.refUserId) return false;
    const eventId = cartItemEventId(db, i);
    if (!eventId) return false;
    return paidRegistrationClub(db.registrations, {
      athleteId: i.refUserId, eventId, excludeClubId: clubId,
    }) !== null;
  });
}

/** Remove the stale cross-club cart lines for `clubId` and toast the manager
 *  once per removed athlete. Idempotent: after removal the next pass finds
 *  nothing, so it never re-toasts. Call from a mount effect. No-op when clean.
 *  Used by both the club registrations view and the unified /cart page's
 *  managed-club sections.
 *
 *  M8 fix (2026-07-02): each stale line is routed through
 *  `removeCartItemWithSync` instead of a bare cart-array filter, so THIS
 *  club's now-moot pending registration(s) get deleted (or reverted, for a
 *  stacked change line) rather than orphaned in the grid — the exact same
 *  sync behavior a manual ✕ removal gets. Still a single toast per athlete. */
export function cleanupCrossClubCart(
  db: DB,
  clubId: string,
  toast: (msg: string, opts?: { variant?: 'info' | 'error' }) => void,
): void {
  const removable = staleCrossClubCartItems(db, clubId);
  if (removable.length === 0) return;
  for (const i of removable) {
    const athlete = db.people.find((p) => p.id === i.refUserId);
    const name = athlete ? `${athlete.firstName} ${athlete.lastName}` : 'An athlete';
    const eventId = cartItemEventId(db, i);
    const otherClubId = eventId && i.refUserId
      ? paidRegistrationClub(db.registrations, { athleteId: i.refUserId, eventId, excludeClubId: clubId })
      : null;
    const otherShort = otherClubId
      ? db.clubs.find((c) => c.id === otherClubId)?.shortName ?? 'another club'
      : 'another club';
    const { action } = removeCartItemWithSync(clubId, true, i);
    // Offline read-only gate: nothing was removed (and every further item
    // would hit the same gate) — stop without toasting a removal.
    if (action === 'blocked-offline') return;
    toast(`${name} was removed from the cart — they're now registered with ${otherShort}.`, { variant: 'info' });
  }
}
