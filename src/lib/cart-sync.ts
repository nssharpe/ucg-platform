// Shared cart-item removal logic that keeps the underlying `registrations`
// row(s) in sync (unified-cart-b2, Task A). Deleting a meet-entry cart item
// used to just drop the cart_items row, leaving a mutated/orphaned
// registration behind — this module fixes that by branching on
// `classifyCartRemoval` (src/lib/pricing.ts) and doing the right thing:
//   - a brand-new unpaid entry line → delete the registration(s) entirely
//   - a 'change' line with a captured snapshot → restore the registration(s)
//   - a 'change' line with no snapshot (legacy row) → remove the cart item
//     only, and tell the caller a revert wasn't possible
//   - anything else → remove the cart item only (unchanged behavior)
// The actual DB writes reuse the existing push*/delete* helpers in
// lib/supabase.ts and the same `pushCart(ownerKey, itemsWithoutThisOne,
// isClub)` replace-semantics idiom already used at every cart delete site.
import { mutate } from './store';
import { deleteRegistration, pushCart, pushRegistration } from './supabase';
import { classifyCartRemoval } from './pricing';
import { paidRegistrationClub } from './capabilities-core';
import type { CartItem, DB } from './types';

export type CartRemovalResult = {
  /** What actually happened to the underlying registration(s), for the caller
   *  to toast honestly. */
  action: 'delete-registration' | 'revert-registration' | 'no-snapshot-remove-only' | 'remove-only';
};

/**
 * Remove `item` from the cart owned by `ownerKey` (a clubId when `isClub`,
 * else a personId), syncing the underlying registration(s) it referenced per
 * `classifyCartRemoval`. Always removes the cart_items row itself. Returns
 * which sync action was taken so the caller can show an accurate toast.
 */
export function removeCartItemWithSync(ownerKey: string, isClub: boolean, item: CartItem): CartRemovalResult {
  const action = classifyCartRemoval(item);

  mutate((d) => {
    const cart = d.carts[ownerKey] ?? [];
    const next = cart.filter((i) => i.id !== item.id);

    if (action === 'delete-registration') {
      const ids = new Set(item.refRegIds ?? []);
      d.registrations = d.registrations.filter((r) => !ids.has(r.id));
      for (const id of ids) deleteRegistration(id);
    } else if (action === 'revert-registration') {
      const snapshot = item.priorRegSnapshot ?? [];
      for (const prior of snapshot) {
        const idx = d.registrations.findIndex((r) => r.id === prior.id);
        if (idx >= 0) d.registrations[idx] = prior;
        else d.registrations.push(prior);
        pushRegistration(prior);
      }
    }
    // 'no-snapshot-remove-only' and 'remove-only': no registration-side change.

    d.carts[ownerKey] = next;
    pushCart(ownerKey, next, isClub);
  });

  return { action };
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
 *  managed-club sections. */
export function cleanupCrossClubCart(
  db: DB,
  clubId: string,
  toast: (msg: string, opts?: { variant?: 'info' | 'error' }) => void,
): void {
  const removable = staleCrossClubCartItems(db, clubId);
  if (removable.length === 0) return;
  const removeIds = new Set(removable.map((i) => i.id));
  mutate((d) => {
    d.carts[clubId] = (d.carts[clubId] ?? []).filter((x) => !removeIds.has(x.id));
    pushCart(clubId, d.carts[clubId], true);
  });
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
    toast(`${name} was removed from the cart — they're now registered with ${otherShort}.`, { variant: 'info' });
  }
}
