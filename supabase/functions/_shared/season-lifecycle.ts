// _shared/season-lifecycle.ts — pure season-rollover/nag logic for
// scheduled-dispatch's `season-launch-nag` + rollover consumer (F6,
// 2026-07-18). Re-implements (does NOT import — edge functions bundle only
// their own dir + this `_shared/` folder, not `src/`) the same algorithm as
// `src/lib/season-lifecycle.ts`'s `nextSeasonNagState`/`rolloverTarget`. Keep
// the two in LOCKSTEP the way the passkey/aal2 three-layer rule does — a
// mismatch here means the admin nag and the actual rollover disagree about
// what's launched.

/** Minimal season row slice this module needs (snake_case DB columns). */
export interface SeasonRow {
  id: string;
  name: string;
  starts_on: string;
  ends_on: string;
  current: boolean;
  launched_at: string | null;
}

export type SeasonNagTier = 'none' | 'june1' | 'june16' | 'daily';

/** Mirrors src/lib/season-lifecycle.ts `nextSeasonNagState`. */
export function nextSeasonNagState(seasons: SeasonRow[], todayISO: string): SeasonNagTier {
  const d = (todayISO ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return 'none';
  const year = d.slice(0, 4);

  const thisYearJuly1 = `${year}-07-01`;
  const nextSeason = seasons.find((s) => s.starts_on === thisYearJuly1);
  if (nextSeason && !!nextSeason.launched_at) return 'none';

  if (d >= thisYearJuly1) return 'daily';
  if (d >= `${year}-06-24`) return 'daily';
  if (d >= `${year}-06-16`) return 'june16';
  if (d >= `${year}-06-01`) return 'june1';
  return 'none';
}

/** Mirrors src/lib/season-lifecycle.ts `rolloverTarget`. Fail loud: never
 *  invents a season — only flips to one that already exists, is launched,
 *  and whose window contains today, and only when it isn't already current. */
export function rolloverTarget(seasons: SeasonRow[], todayISO: string): string | null {
  const d = (todayISO ?? '').slice(0, 10);
  if (!d) return null;
  const hit = seasons.find((s) => s.starts_on && s.ends_on && d >= s.starts_on && d <= s.ends_on);
  if (!hit) return null;
  if (!hit.launched_at) return null;
  if (hit.current) return null;
  return hit.id;
}

/** The season row the nag tier is ABOUT (this calendar year's July 1 season,
 *  possibly absent) — used by the caller to build the email body/CTA. */
export function nagTargetSeason(seasons: SeasonRow[], todayISO: string): SeasonRow | null {
  const d = (todayISO ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const thisYearJuly1 = `${d.slice(0, 4)}-07-01`;
  return seasons.find((s) => s.starts_on === thisYearJuly1) ?? null;
}
