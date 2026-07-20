// Pure season-lifecycle logic (F6 2026-07-18, rewritten P3 2026-07-20) — no
// React/Supabase imports, so this is importable in a plain Node vitest
// environment (see tests/season-lifecycle.test.ts). Mirrored (NOT imported —
// edge functions can't import src/) by
// supabase/functions/_shared/season-lifecycle.ts; keep the two in lockstep
// the way the passkey/aal2 three-layer rule does.
//
// P3 (2026-07-20): "current" and "launched" are no longer stored flags —
// everything derives from today's date against each season's
// [startsOn, endsOn] window. See docs/specs/2026-07-20-season-card-ucg-events-and-cleanups.md
// ("Launched" → date-derived lifecycle mapping) for the full old->new mapping.
import type { DB, Season } from './types';

function todayOr(todayISO?: string): string {
  return (todayISO ?? new Date().toISOString()).slice(0, 10);
}

/** The season whose [startsOn, endsOn] window contains `todayISO`. Falls back
 *  to the most recent season with `startsOn <= todayISO` when no window
 *  matches (e.g. a gap between seasons); returns null if nothing qualifies
 *  (no seasons at all, or every season starts in the future). */
export function currentSeason(db: DB, todayISO?: string): Season | null {
  const d = todayOr(todayISO);
  const windowHit = db.seasons.find((s) => s.startsOn && s.endsOn && d >= s.startsOn && d <= s.endsOn);
  if (windowHit) return windowHit;
  let best: Season | null = null;
  for (const s of db.seasons) {
    if (s.startsOn && s.startsOn <= d && (!best || s.startsOn > best.startsOn)) best = s;
  }
  return best;
}

/** True when `season` starts strictly after the CURRENT season ends — i.e. it
 *  is a future season, not the current one and not a past one an admin left
 *  `active` for late signups. When there's no current season at all, falls
 *  back to comparing directly against `todayISO`. */
export function isFutureSeason(db: DB, season: Season, todayISO?: string): boolean {
  const cur = currentSeason(db, todayISO);
  if (cur) return season.startsOn > cur.endsOn;
  return season.startsOn > todayOr(todayISO);
}

/** Seasons purchasable for a membership RIGHT NOW: the current-by-date season
 *  (its window contains today) is ALWAYS purchasable; a future season is
 *  purchasable only when flagged `active`; a past season (its window has
 *  already ended) is NEVER purchasable, regardless of `active` — Nate/Julia's
 *  2026-07-20 decision retiring the old "launched" gate. */
export function purchasableSeasons(db: DB, todayISO?: string): Season[] {
  const d = todayOr(todayISO);
  return db.seasons.filter((s) => {
    const currentByDate = !!(s.startsOn && s.endsOn && d >= s.startsOn && d <= s.endsOn);
    if (currentByDate) return true;
    return s.active && isFutureSeason(db, s, todayISO);
  });
}

export interface EventCreationBlockResult {
  blocked: boolean;
  reason?: string;
  seasonLabel?: string;
}

/** Gates event creation on the start date falling in ANY existing season
 *  window — FlipFest/Nationals instances are created right after the season
 *  row itself, so there's no separate "launched" gate anymore. A date with no
 *  matching season window still blocks (there's nothing for the event to
 *  belong to). */
export function eventCreationBlocked(db: DB, startDateISO: string): EventCreationBlockResult {
  const d = (startDateISO ?? '').slice(0, 10);
  if (!d) return { blocked: true, reason: 'A start date is required before a season can be determined.' };

  const hit = db.seasons.find((s) => s.startsOn && s.endsOn && d >= s.startsOn && d <= s.endsOn);
  if (!hit) {
    const year = d.slice(0, 4);
    return { blocked: true, reason: `No season has been set up for ${year} yet — an admin must create it before events in it can be created.` };
  }
  return { blocked: false };
}

export type SeasonNagTier = 'none' | 'june1' | 'june16' | 'daily';

/** Which admin-nag tier applies today, given whether a season row exists
 *  covering THIS CALENDAR YEAR'S July 1 (the upcoming/just-started season).
 *  Ramps June 1 → june1, June 16 → june16, June 24 → daily, and stays 'daily'
 *  for every day on/after that July 1 until such a season row is created
 *  (never auto-resolves; only creating the row clears it — via "Copy → next
 *  year" in League Controls → Seasons & fees). Already-existing ⇒ 'none'
 *  always. Scoped to a single fiscal-year cycle — by construction this only
 *  matters while it's genuinely unresolved, which in practice means an admin
 *  ignored months of escalating daily nags (plus the separate daily-digest);
 *  it does not chase a missed-season-creation across a SECOND calendar year
 *  boundary. */
export function nextSeasonNagState(db: DB, todayISO: string): SeasonNagTier {
  const d = (todayISO ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return 'none';
  const year = d.slice(0, 4);

  const thisYearJuly1 = `${year}-07-01`;
  const exists = db.seasons.some((s) => s.startsOn === thisYearJuly1);
  if (exists) return 'none';

  if (d >= thisYearJuly1) return 'daily'; // on/after the boundary — creation overdue
  if (d >= `${year}-06-24`) return 'daily';
  if (d >= `${year}-06-16`) return 'june16';
  if (d >= `${year}-06-01`) return 'june1';
  return 'none';
}
