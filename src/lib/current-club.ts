// UAT round-1 (Z-01-02 + M-19-01 etc.): which managed club the "My Club" nav
// group / topbar Club Cart button link to. Before this, every such link
// hardcoded `caps.managedClubIds[0]` (Layout.tsx) — a manager of MULTIPLE
// clubs, or a league admin, had no way to point those links at any club but
// the first one alphabetically/creation-order. This module tracks "the club
// the viewer is currently looking at" as a small, per-browser UI preference
// (localStorage, NOT app data) — deliberately NOT threaded through the big
// `db`/`mutate()` store (data-layer.md's in-place-mutation trap and
// `PERSISTED_KEYS` allowlist are both about server-synced app data; this is
// neither, it's a local-only "last viewed" pointer, same class of thing as
// `sessionStorage['ucg-dev-role']` in dev-auth.ts).
//
// Every club-scoped page (ClubPage's roster/registrations views, the new
// ClubCart/ClubPurchaseHistory pages) calls `setCurrentClubId` on mount with
// whichever club it's showing, so browsing to ANY club (via the switcher, a
// direct link, etc.) keeps the nav's "My Club" links pointed at the club
// actually being viewed. `useCurrentClubId` is what Layout.tsx and the new
// pages read to resolve "which club" absent an explicit `:clubId` param.
import { useSyncExternalStore } from 'react';

const KEY = 'ucg-current-club-id';

type Listener = () => void;
const listeners = new Set<Listener>();
function emit(): void { listeners.forEach((l) => l()); }

function readStored(): string | null {
  try { return localStorage.getItem(KEY); } catch { return null; }
}

/** Persist the viewer's current club and notify subscribers. Safe to call
 *  with any club id — `currentClubId` below is what actually validates it
 *  against the viewer's managed-club list before anything reads it back. */
export function setCurrentClubId(clubId: string): void {
  try { localStorage.setItem(KEY, clubId); } catch { /* private-mode/quota: no-op */ }
  emit();
}

/** Pure: resolve "the current club" from the viewer's managed-club ids and
 *  whatever's stored — falls back to the first managed club (stable,
 *  deterministic) when nothing's stored, the stored id isn't (or is no
 *  longer) one of theirs, or they manage no clubs at all (`null`). Exported
 *  standalone (not just via the hook) so it's directly unit-testable. */
export function currentClubId(managedClubIds: string[], stored: string | null): string | null {
  if (managedClubIds.length === 0) return null;
  if (stored && managedClubIds.includes(stored)) return stored;
  return managedClubIds[0];
}

/** React binding: re-renders on any `setCurrentClubId` call (this tab) via
 *  `useSyncExternalStore` — a plain `localStorage` read has no reactivity of
 *  its own. CSR-only app, so no `getServerSnapshot` is needed. */
export function useCurrentClubId(managedClubIds: string[]): string | null {
  const stored = useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    readStored,
  );
  return currentClubId(managedClubIds, stored);
}
