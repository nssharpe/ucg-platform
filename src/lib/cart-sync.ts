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
import type { CartItem } from './types';

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
