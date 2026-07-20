// _shared/season-lifecycle.ts — pure season-lifecycle nag logic for
// scheduled-dispatch's `season-launch-nag` consumer (F6 2026-07-18, rewritten
// P3 2026-07-20). Re-implements (does NOT import — edge functions bundle only
// their own dir + this `_shared/` folder, not `src/`) the same algorithm as
// `src/lib/season-lifecycle.ts`'s `nextSeasonNagState`. Keep the two in
// LOCKSTEP the way the passkey/aal2 three-layer rule does — a mismatch here
// means the admin nag disagrees with what the app itself considers "set up".
//
// P3 (2026-07-20): "current" and "launched" are no longer stored flags — the
// app derives everything from dates. The rollover consumer (`rolloverTarget`)
// is GONE — there's no `current` flag left to flip. See
// docs/specs/2026-07-20-season-card-ucg-events-and-cleanups.md ("Launched" →
// date-derived lifecycle mapping).

/** Minimal season row slice this module needs (snake_case DB columns). */
export interface SeasonRow {
  id: string;
  name: string;
  starts_on: string;
  ends_on: string;
}

export type SeasonNagTier = 'none' | 'june1' | 'june16' | 'daily';

/** Mirrors src/lib/season-lifecycle.ts `nextSeasonNagState`. */
export function nextSeasonNagState(seasons: SeasonRow[], todayISO: string): SeasonNagTier {
  const d = (todayISO ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return 'none';
  const year = d.slice(0, 4);

  const thisYearJuly1 = `${year}-07-01`;
  const exists = seasons.some((s) => s.starts_on === thisYearJuly1);
  if (exists) return 'none';

  if (d >= thisYearJuly1) return 'daily';
  if (d >= `${year}-06-24`) return 'daily';
  if (d >= `${year}-06-16`) return 'june16';
  if (d >= `${year}-06-01`) return 'june1';
  return 'none';
}
