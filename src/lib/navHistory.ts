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
  if (pathname === '/meets') return 'Meets';
  if (pathname === '/me') return 'Profile';
  if (pathname === '/membership') return 'Membership';
  if (pathname === '/admin/members') return 'Members';
  if (pathname === '/admin/clubs') return 'Clubs';
  if (pathname === '/admin/league') return 'League Controls';
  if (pathname === '/admin/communicate') return 'Communicate';
  if (/^\/club\/[^/]+\/roster$/.test(pathname)) return 'Club Roster';
  if (/^\/club\/[^/]+\/registrations$/.test(pathname)) return 'Club Registrations';
  if (/^\/club\/[^/]+$/.test(pathname)) return 'Club Roster';
  if (/^\/club\/[^/]+\/cart$/.test(pathname)) return 'Club Cart & Invoices';
  if (/^\/meets\//.test(pathname)) return 'Meet';
  if (/^\/members\//.test(pathname)) return 'Member';
  if (/^\/clubs\//.test(pathname)) return 'Club';
  // Generic fallback: capitalise path segments
  return pathname
    .replace(/^\//, '')
    .split('/')
    .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
    .join(' / ');
}

/**
 * Call once inside Layout (or any component that mounts on every page).
 * Records each distinct navigation into the stack, deduplicating consecutive
 * visits to the same pathname.
 */
export function useNavHistory(): void {
  const loc = useLocation();
  useEffect(() => {
    const current = loc.pathname;
    // Avoid duplicate consecutive entries (e.g. search-param changes)
    const top = stack[stack.length - 1];
    if (!top || top.pathname !== current) {
      stack.push({ pathname: current, label: labelFor(current) });
    }
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
