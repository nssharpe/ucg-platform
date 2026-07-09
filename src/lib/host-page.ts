import type { HostRosterRow } from './supabase';

/** Per-club participation count within one level group. */
export interface HostLevelClubSummary {
  clubId: string;
  clubName: string;
  athleteCount: number;
}

/** One level's registration summary for the host viewing page (event-mgmt v2
 *  §C): which clubs are participating at this level, and how many athletes
 *  are entered per apparatus across the whole level (not per club — the spec
 *  wording is "per level, participating clubs + athletes per apparatus"). */
export interface HostLevelSummary {
  levelId: string;
  levelName: string;
  clubs: HostLevelClubSummary[];
  apparatusCounts: Record<string, number>;
}

/** Resolve a level id to a display name; falls back to the raw id when the
 *  level isn't found (e.g. a retired level, or `levels` not yet loaded). */
export type LevelNameResolver = (levelId: string) => string;

/** Build the { id -> name } lookup `summarizeRoster` expects, from the app's
 *  `Level[]` (src/lib/types.ts) — kept generic (name-only shape) so this file
 *  stays free of any non-pure import. */
export function levelNameResolver(levels: { id: string; name: string }[]): LevelNameResolver {
  const byId = new Map(levels.map((l) => [l.id, l.name]));
  return (levelId: string) => byId.get(levelId) ?? levelId;
}

/** Pure summary of an event's registration roster, grouped per level (per
 *  §C: "per level, participating clubs + athletes per apparatus"). Rows with
 *  no `levelId` are grouped under `''` (displayed by the caller as
 *  "Unassigned level"). Deterministic ordering: levels by level id, clubs by
 *  name, apparatus by first-seen order. */
export function summarizeRoster(rows: HostRosterRow[], resolveLevelName: LevelNameResolver = (id) => id): HostLevelSummary[] {
  const levelOrder: string[] = [];
  const byLevel = new Map<string, HostRosterRow[]>();
  for (const row of rows) {
    const levelId = row.levelId ?? '';
    if (!byLevel.has(levelId)) { byLevel.set(levelId, []); levelOrder.push(levelId); }
    byLevel.get(levelId)!.push(row);
  }

  return levelOrder.map((levelId) => {
    const levelRows = byLevel.get(levelId)!;

    // Clubs participating at this level, with a distinct-athlete count each.
    const clubAthletes = new Map<string, { clubName: string; athletes: Set<string> }>();
    for (const row of levelRows) {
      const clubId = row.clubId ?? '';
      const entry = clubAthletes.get(clubId) ?? { clubName: row.clubName ?? 'Unknown club', athletes: new Set<string>() };
      entry.athletes.add(row.athleteId);
      clubAthletes.set(clubId, entry);
    }
    const clubs: HostLevelClubSummary[] = [...clubAthletes.entries()]
      .map(([clubId, { clubName, athletes }]) => ({ clubId, clubName, athleteCount: athletes.size }))
      .sort((a, b) => a.clubName.localeCompare(b.clubName));

    // Athletes entered per apparatus, across the whole level (distinct
    // athlete per apparatus code — a synchro pair each carries the code, so
    // both partners count, matching the "athletes per apparatus" wording).
    const apparatusAthletes = new Map<string, Set<string>>();
    for (const row of levelRows) {
      for (const code of row.apparatus) {
        if (!apparatusAthletes.has(code)) apparatusAthletes.set(code, new Set());
        apparatusAthletes.get(code)!.add(row.athleteId);
      }
    }
    const apparatusCounts: Record<string, number> = {};
    for (const [code, athletes] of apparatusAthletes) apparatusCounts[code] = athletes.size;

    return { levelId, levelName: levelId ? resolveLevelName(levelId) : 'Unassigned level', clubs, apparatusCounts };
  }).sort((a, b) => a.levelName.localeCompare(b.levelName));
}
