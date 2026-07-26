/**
 * navHistory.ts
 * Lightweight in-app back-navigation hook for HashRouter.
 *
 * Maintains a module-level stack of visited locations so the stack persists
 * across Layout re-renders. Each entry stores the pathname and a human-readable
 * label derived from the route table.
 */

import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { DB } from './types';

export interface HistoryEntry {
  pathname: string;
  label: string;
}

// Module-level stack — survives React re-renders, cleared on hard reload.
const stack: HistoryEntry[] = [];

/** Derive a human-readable label from a pathname. */
export function labelFor(pathname: string): string {
  if (pathname === '/') return 'Home';
  if (pathname === '/results') return 'Live Results';
  if (pathname === '/events') return 'Events';
  if (pathname === '/meets') return 'Events'; // legacy path (redirects to /events)
  if (pathname === '/me') return 'Profile';
  if (pathname === '/membership') return 'Membership';
  if (pathname === '/admin/members') return 'Members';
  if (pathname === '/admin/clubs') return 'Clubs';
  if (pathname === '/admin/league') return 'League Controls';
  if (pathname === '/admin/communicate') return 'Communicate';
  if (/^\/club\/[^/]+\/roster$/.test(pathname)) return 'Club Roster';
  if (/^\/club\/[^/]+\/registrations$/.test(pathname)) return 'Club Registrations';
  if (/^\/club\/[^/]+$/.test(pathname)) return 'Club Roster';
  if (/^\/club\/[^/]+\/cart$/.test(pathname)) return 'Club Cart & Receipts';
  if (/^\/events\//.test(pathname)) return 'Event';
  if (/^\/meets\//.test(pathname)) return 'Event'; // legacy path (redirects to /events/)
  if (/^\/members\//.test(pathname)) return 'Member';
  if (/^\/clubs\//.test(pathname)) return 'Club';
  if (/^\/results\/[^/]+$/.test(pathname)) return 'Results'; // overridden by resolveLabel below when the event is known
  // Generic fallback: capitalise path segments
  return pathname
    .replace(/^\//, '')
    .split('/')
    .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
    .join(' / ');
}

/**
 * Like `labelFor`, but resolves a real entity title for detail routes where
 * one is available, instead of the generic fallback (which otherwise shows
 * the raw slug, e.g. "Results / Test-meet"). Mirrors the slug-lookup pattern
 * every event detail page already uses (`db.events.find(e => e.slug ===
 * slug)`) — currently just `/results/:slug` → the event's display name.
 * Falls back to `labelFor` for every other route.
 */
export function resolveLabel(pathname: string, db: DB): string {
  const resultsMatch = /^\/results\/([^/]+)$/.exec(pathname);
  if (resultsMatch) {
    const event = db.events.find((e) => e.slug === resultsMatch[1]);
    if (event) return event.name;
  }
  return labelFor(pathname);
}

/**
 * Call once inside Layout (or any component that mounts on every page).
 * Records each distinct navigation into the stack, deduplicating consecutive
 * visits to the same pathname. Takes `db` so `resolveLabel` can look up a
 * real entity title for detail routes — deliberately excluded from the deps
 * array (matches the precedent in Results.tsx's realtime-subscription
 * effect): only the pathname change should trigger a new stack push, and the
 * `db` closed over here is whatever the calling Layout render currently has,
 * which is fresh at the moment of navigation. Re-running on every store
 * mutation would be wasteful and is guarded against anyway (a same-pathname
 * push is a no-op).
 */
export function useNavHistory(db: DB): void {
  const loc = useLocation();
  useEffect(() => {
    const current = loc.pathname;
    // Avoid duplicate consecutive entries (e.g. search-param changes)
    const top = stack[stack.length - 1];
    if (!top || top.pathname !== current) {
      stack.push({ pathname: current, label: resolveLabel(current, db) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.pathname]);
}

/**
 * Returns the previous history entry (the one before the current page),
 * or null if there is no prior in-app navigation.
 */
export function usePrevEntry(): HistoryEntry | null {
  const loc = useLocation();
  // The stack may have the current page at the top; look back one more step.
  const topPath = stack[stack.length - 1]?.pathname;
  const offset = topPath === loc.pathname ? 2 : 1;
  return stack[stack.length - offset] ?? null;
}

/**
 * Navigates back one step in the in-app history stack and pops it.
 * Returns a function you can attach to an onClick handler.
 */
export function useGoBack(): (() => void) | null {
  const navigate = useNavigate();
  const prev = usePrevEntry();
  if (!prev) return null;
  return () => {
    // Pop current entry off the stack so repeated back-presses keep working.
    stack.pop();
    navigate(prev.pathname);
  };
}
