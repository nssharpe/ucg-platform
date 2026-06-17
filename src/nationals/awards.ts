import type {
  AthleteResult,
  Category,
  DisciplineDef,
  NationalsEngineConfig,
  TeamResult,
} from './types';
import { CATEGORIES } from './types';

export interface AwardEntry {
  place: number;
  name: string; // "First L."
  fullFirst: string;
  fullLast: string;
  club: string;
  score: number;
}

export interface AwardTable {
  scope: string; // event abbr | 'AA' | 'Team'
  level: string;
  category: Category | 'Mixed';
  /** True when the medals come from finals results (a finals level). */
  fromFinals: boolean;
  entries: AwardEntry[];
}

function shortName(first: string, last: string): string {
  return `${first} ${last ? last[0] + '.' : ''}`.trim();
}

/**
 * Assemble awards across all levels: for non-finals levels pull prelim
 * placements, for finals levels pull finals placements; per (event/AA, level,
 * category) and per team. Ports `Artistic.create_awards_presentation` +
 * `create_team_awards_presentation`. Mixed-team awards always come from prelims.
 */
export function assembleArtisticAwards(
  def: DisciplineDef,
  config: NationalsEngineConfig,
  prelims: { results: AthleteResult[]; teams: TeamResult[] },
  finals: { results: AthleteResult[]; teams: TeamResult[] },
): AwardTable[] {
  const tables: AwardTable[] = [];
  const scopes = [...def.events, ...(def.hasAA ? ['AA'] : [])];

  const pickEvent = (r: AthleteResult, scope: string) => (scope === 'AA' ? r.aa : r.events[scope]);

  const levelSets: { levels: string[]; fromFinals: boolean }[] = [
    { levels: config.nonFinalsLevels, fromFinals: false },
    { levels: config.finalsLevels, fromFinals: true },
  ];

  for (const scope of scopes) {
    for (const { levels, fromFinals } of levelSets) {
      const src = fromFinals ? finals.results : prelims.results;
      for (const level of levels) {
        for (const category of CATEGORIES) {
          const entries: AwardEntry[] = [];
          for (const r of src) {
            if (r.level !== level || r.category !== category) continue;
            const ep = pickEvent(r, scope);
            if (!ep || ep.place == null || ep.qual !== 'Y') continue;
            entries.push({
              place: ep.place,
              name: shortName(r.entry.first, r.entry.last),
              fullFirst: r.entry.first,
              fullLast: r.entry.last,
              club: r.entry.club,
              score: ep.score,
            });
          }
          if (entries.length) {
            entries.sort((a, b) => a.place - b.place);
            tables.push({ scope, level, category, fromFinals, entries });
          }
        }
      }
    }
  }

  if (def.hasTeam) {
    for (const { levels, fromFinals } of levelSets) {
      const src = fromFinals ? finals.teams : prelims.teams;
      for (const level of levels) {
        for (const category of [...CATEGORIES, 'Mixed'] as (Category | 'Mixed')[]) {
          // Mixed team awards always come from prelims (no finals mixed teams).
          const teams = (category === 'Mixed' ? prelims.teams : src).filter(
            (t) => t.level === level && t.category === category && t.qual === 'Y' && t.place != null,
          );
          if (!teams.length) continue;
          teams.sort((a, b) => (a.place ?? 0) - (b.place ?? 0));
          tables.push({
            scope: 'Team',
            level,
            category,
            fromFinals: category === 'Mixed' ? false : fromFinals,
            entries: teams.map((t) => ({
              place: t.place!,
              name: t.club,
              fullFirst: t.club,
              fullLast: '',
              club: t.club,
              score: t.score,
            })),
          });
        }
      }
    }
  }

  return tables;
}
