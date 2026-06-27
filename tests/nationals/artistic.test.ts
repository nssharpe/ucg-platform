import { describe, it, expect } from 'vitest';
import { computeArtistic } from '../../src/nationals/artistic';
import { buildConfig } from '../../src/nationals/config';
import type { AthleteResult } from '../../src/nationals/types';
import {
  loadFixture,
  DEFS,
  EVENT_COLS,
  entriesFrom,
  entryIdentity,
  identityKey,
  place,
  type Fixture,
} from './helpers';

interface Mismatch {
  who: string;
  field: string;
  expected: unknown;
  got: unknown;
}

/** For finals, derive the prelim-qualified team set from the matching prelims fixture. */
function prelimQualifiedTeams(name: string): Set<string> {
  const prelimsName = name.replace('_finals_', '_prelims_');
  const fx: Fixture = loadFixture(prelimsName);
  const def = DEFS[fx.meta.discipline];
  const { teams } = computeArtistic(entriesFrom(fx, def), def, buildConfig(fx.config!), { finals: false });
  const set = new Set<string>();
  for (const t of teams) if (t.category !== 'Mixed' && t.qual === 'Y') set.add(`${t.club}|${t.level}|${t.category}`);
  return set;
}

function checkArtistic(name: string, finals: boolean) {
  const fx: Fixture = loadFixture(name);
  const def = DEFS[fx.meta.discipline];
  const config = buildConfig(fx.config!);
  const entries = entriesFrom(fx, def);
  const qualifiedTeams = finals ? prelimQualifiedTeams(name) : undefined;
  const { results, teams } = computeArtistic(entries, def, config, { finals, qualifiedTeams });

  const byId = new Map<string, AthleteResult>();
  for (const r of results) byId.set(entryIdentity(r.entry), r);

  const mism: Mismatch[] = [];
  const seen = new Map<string, number>();
  for (const exp of fx.expected) {
    // Realign duplicate identities (same person across sessions) by occurrence.
    const k = identityKey(exp);
    const occ = seen.get(k) ?? 0;
    seen.set(k, occ + 1);
    const matches = results.filter((r) => entryIdentity(r.entry) === k);
    const r = matches[occ] ?? byId.get(k);
    const who = `${exp.FirstName} ${exp.LastName} (${exp.CompLevel})`;
    if (!r) {
      mism.push({ who, field: 'MISSING', expected: k, got: null });
      continue;
    }
    if (exp['Placement Category'] !== r.category)
      mism.push({ who, field: 'category', expected: exp['Placement Category'], got: r.category });
    for (const ev of def.apparatus) {
      const c = EVENT_COLS[ev];
      const ep = r.apparatus[ev];
      if (place(exp[c.place]) !== ep.place)
        mism.push({ who, field: `${ev} place`, expected: exp[c.place], got: ep.place });
      if ((exp[c.qual] ?? null) !== (ep.qual ?? null))
        mism.push({ who, field: `${ev} qual`, expected: exp[c.qual], got: ep.qual });
    }
    if (def.hasAA) {
      if (place(exp['AA Place']) !== r.aa!.place)
        mism.push({ who, field: 'AA place', expected: exp['AA Place'], got: r.aa!.place });
      if ((exp['AA?'] ?? null) !== (r.aa!.qual ?? null))
        mism.push({ who, field: 'AA qual', expected: exp['AA?'], got: r.aa!.qual });
    }
    if ('Team?' in exp && (exp['Team?'] ?? null) !== (r.teamQual ?? null))
      mism.push({ who, field: 'Team?', expected: exp['Team?'], got: r.teamQual });
  }

  // Team results comparison.
  const teamMism: Mismatch[] = [];
  if (fx.expectedTeam) {
    const teamById = new Map<string, (typeof teams)[number]>();
    for (const t of teams) teamById.set(`${t.club}|${t.level}|${t.category}`, t);
    for (const exp of fx.expectedTeam) {
      const key = `${exp.Club_Name}|${exp.CompLevel}|${exp['Placement Category']}`;
      const t = teamById.get(key);
      const who = `TEAM ${key}`;
      if (!t) {
        teamMism.push({ who, field: 'MISSING', expected: key, got: null });
        continue;
      }
      if (place(exp['Team Place']) !== t.place)
        teamMism.push({ who, field: 'place', expected: exp['Team Place'], got: t.place });
      if ((exp['Team?'] ?? null) !== t.qual)
        teamMism.push({ who, field: 'qual', expected: exp['Team?'], got: t.qual });
    }
  }

  return { mism, teamMism, results, teams, fx };
}

const PRELIMS = ['2024_prelims_wag.json', '2024_prelims_mag.json', '2025_prelims_wag.json', '2025_prelims_mag.json'];
const FINALS = ['2024_finals_wag.json', '2024_finals_mag.json', '2025_finals_wag.json', '2025_finals_mag.json'];

describe('nationals artistic prelims parity', () => {
  for (const name of PRELIMS) {
    it(`reproduces ${name}`, () => {
      const { mism, teamMism } = checkArtistic(name, false);
      if (mism.length) console.log(name, 'individual mismatches:', mism.slice(0, 25));
      if (teamMism.length) console.log(name, 'team mismatches:', teamMism.slice(0, 25));
      expect(mism, `${mism.length} individual mismatches`).toHaveLength(0);
      expect(teamMism, `${teamMism.length} team mismatches`).toHaveLength(0);
    });
  }
});

describe('nationals artistic finals parity', () => {
  for (const name of FINALS) {
    it(`reproduces ${name}`, () => {
      const { mism, teamMism } = checkArtistic(name, true);
      if (mism.length) console.log(name, 'individual mismatches:', mism.slice(0, 25));
      if (teamMism.length) console.log(name, 'team mismatches:', teamMism.slice(0, 25));
      expect(mism, `${mism.length} individual mismatches`).toHaveLength(0);
      expect(teamMism, `${teamMism.length} team mismatches`).toHaveLength(0);
    });
  }
});
