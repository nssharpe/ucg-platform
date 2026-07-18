// Pure season-lifecycle logic (F6, 2026-07-18) — no React/Supabase imports, so
// this is importable in a plain Node vitest environment (see
// tests/season-lifecycle.test.ts). Mirrored (NOT imported — edge functions
// can't import src/) by supabase/functions/_shared/season-lifecycle.ts; keep
// the two in lockstep the way the passkey/aal2 three-layer rule does.
import type { DB, Season } from './types';

/** A season is "launched" once an admin has finished its details and flipped
 *  it live — launched ⇒ its memberships are purchasable and events may be
 *  created in it. */
export function seasonIsLaunched(season: Season | null | undefined): boolean {
  return !!season?.launchedAt;
}

/** True when `season` starts strictly after the CURRENT season ends — i.e. it
 *  is a future season, not the current one and not a past one an admin left
 *  `active` for late signups. Returns false if there is no current season at
 *  all (can't determine "future" without a reference point). */
export function isFutureSeason(db: DB, season: Season): boolean {
  const current = db.seasons.find((s) => s.current);
  if (!current) return false;
  return season.startsOn > current.endsOn;
}

/** Seasons purchasable for a membership RIGHT NOW: the current season and any
 *  past-but-still-`active` season (unchanged existing behavior), PLUS a
 *  future season only once it's launched. A future season that isn't
 *  launched yet is never purchasable, regardless of its `active` flag. */
export function purchasableSeasons(db: DB): Season[] {
  return db.seasons.filter((s) => s.active && (!isFutureSeason(db, s) || seasonIsLaunched(s)));
}

export interface EventCreationBlockResult {
  blocked: boolean;
  reason?: string;
  seasonLabel?: string;
}

/** Gates event creation on the START DATE's season being launched. Reuses
 *  `seasonForDate`'s window-matching semantics EXCEPT for its current-season
 *  fallback: a date with no matching season window must BLOCK here (there's
 *  nothing for the event to belong to), not silently attach to whatever
 *  happens to be `current`. An event landing in the actual current season is
 *  never blocked (covers the common case even if, oddly, `current` isn't
 *  flagged `launchedAt` — the currently-running season is always usable). */
export function eventCreationBlocked(db: DB, startDateISO: string): EventCreationBlockResult {
  const d = (startDateISO ?? '').slice(0, 10);
  if (!d) return { blocked: true, reason: 'A start date is required before a season can be determined.' };

  const hit = db.seasons.find((s) => s.startsOn && s.endsOn && d >= s.startsOn && d <= s.endsOn);
  if (!hit) {
    const year = d.slice(0, 4);
    return { blocked: true, reason: `No season has been set up for ${year} yet — an admin must create and launch it before events in it can be created.` };
  }
  if (hit.current) return { blocked: false };
  if (seasonIsLaunched(hit)) return { blocked: false };
  return {
    blocked: true,
    seasonLabel: hit.name,
    reason: `The ${hit.name} season hasn't been set up yet — an admin must launch it before events in it can be created.`,
  };
}

export type SeasonNagTier = 'none' | 'june1' | 'june16' | 'daily';

/** Which admin-nag tier applies today, given whether THIS CALENDAR YEAR'S
 *  July 1 season is launched. Ramps June 1 → june1, June 16 → june16, June 24
 *  → daily, and stays 'daily' for every day on/after that July 1 until a
 *  season is launched for it (never auto-resolves; only a launch clears it).
 *  Already-launched ⇒ 'none' always. Scoped to a single fiscal-year cycle —
 *  by construction this only matters while it's genuinely unresolved, which
 *  in practice means an admin ignored months of escalating daily nags (plus
 *  the separate daily-digest); it does not chase a rollover failure across a
 *  SECOND calendar year boundary. */
export function nextSeasonNagState(db: DB, todayISO: string): SeasonNagTier {
  const d = (todayISO ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return 'none';
  const year = d.slice(0, 4);

  const thisYearJuly1 = `${year}-07-01`;
  const nextSeason = db.seasons.find((s) => s.startsOn === thisYearJuly1);
  if (nextSeason && seasonIsLaunched(nextSeason)) return 'none';

  if (d >= thisYearJuly1) return 'daily'; // on/after the boundary — rollover overdue
  if (d >= `${year}-06-24`) return 'daily';
  if (d >= `${year}-06-16`) return 'june16';
  if (d >= `${year}-06-01`) return 'june1';
  return 'none';
}

/** The season id `current` should flip to today, or null if nothing
 *  qualifies. Fail loud: NEVER invent a season — only a season that already
 *  exists, is launched, and whose [startsOn, endsOn] window contains today
 *  qualifies, and only when it isn't already `current`. */
export function rolloverTarget(db: DB, todayISO: string): string | null {
  const d = (todayISO ?? '').slice(0, 10);
  if (!d) return null;
  const hit = db.seasons.find((s) => s.startsOn && s.endsOn && d >= s.startsOn && d <= s.endsOn);
  if (!hit) return null;
  if (!seasonIsLaunched(hit)) return null;
  if (hit.current) return null;
  return hit.id;
}
