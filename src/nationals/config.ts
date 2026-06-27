import { CATEGORIES, type Category, type CutoffMap, type NationalsEngineConfig } from './types';

/** Raw parsed config.ini: section -> key -> value. */
export type RawConfig = Record<string, Record<string, string>>;

/** Build an engine config from a reference-tool `config.ini` (already parsed
 *  into sections by the fixture extractor / platform adapter). */
export function buildConfig(raw: RawConfig): NationalsEngineConfig {
  const catMap = (scope: 'Events' | 'AA' | 'Team'): CutoffMap => {
    const m: CutoffMap = {};
    for (const c of CATEGORIES) {
      const sec = raw[`${scope} ${c}`];
      if (sec) {
        m[c] = Object.fromEntries(Object.entries(sec).map(([k, v]) => [k, parseInt(v, 10)]));
      }
    }
    return m;
  };
  const numMap = (sec: Record<string, string> | undefined, parse = parseInt): Record<string, number> =>
    sec ? Object.fromEntries(Object.entries(sec).map(([k, v]) => [k, parse(v, 10)])) : {};

  return {
    cutoffs: {
      apparatus: catMap('Events'),
      aa: catMap('AA'),
      team: catMap('Team'),
      teamMixed: numMap(raw['Team Mixed']),
    },
    finalsLevels: Object.keys(raw['Finals Levels'] ?? {}),
    nonFinalsLevels: Object.keys(raw['Non Finals Levels'] ?? {}),
    svCaps: numMap(raw['SV CAPS'], (v) => parseFloat(v) as unknown as number),
  };
}

/** Cutoff ("blue number") lookup; missing entries mean "nobody qualifies" (0). */
export function cutoffFor(
  config: NationalsEngineConfig,
  scope: 'apparatus' | 'aa' | 'team',
  level: string,
  category: Category | 'Mixed',
): number {
  if (scope === 'team' && category === 'Mixed') return config.cutoffs.teamMixed[level] ?? 0;
  const map = config.cutoffs[scope] as CutoffMap;
  return map[category as Category]?.[level] ?? 0;
}
