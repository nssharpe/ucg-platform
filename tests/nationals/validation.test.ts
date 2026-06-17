import { describe, it, expect } from 'vitest';
import {
  validateArtistic,
  validateTeamFinals,
  validateQualCheck,
  validateSyncro,
  type PrelimQualLookup,
} from '../../src/nationals/validation';
import { computeArtistic } from '../../src/nationals/artistic';
import { buildConfig } from '../../src/nationals/config';
import { WAG, MAG, TNT, type QualFlag } from '../../src/nationals/types';
import { loadFixture, entriesFrom, tntRowToEntry } from './helpers';

const NAME: Record<string, string> = { VT: 'Vault', UB: 'Bars', BB: 'Beam', FX: 'Floor', PH: 'PH', SR: 'Rings', PB: 'PB', HB: 'HB', AA: 'AA' };
const SCORE_COL: Record<string, string> = { VT: 'VT_Score', UB: 'UB_Score', BB: 'BM_Score', FX: 'FX_Score', PH: 'PH_Score', SR: 'SR_Score', PB: 'PB_Score', HB: 'HB_Score', AA: 'AA_Score' };

/** Multiset comparison of canonical string tuples. */
function expectSameSet(got: string[], expected: string[], label: string) {
  const g = [...got].sort();
  const e = [...expected].sort();
  expect(g, `${label}: got ${g.length} vs expected ${e.length}\nGOT: ${JSON.stringify(g)}\nEXP: ${JSON.stringify(e)}`).toEqual(e);
}

const num = (v: unknown) => Number(v);

function buildPrelimQual(year: string, def: typeof WAG | typeof MAG): PrelimQualLookup {
  const fx = loadFixture(`${year}_prelims_${def.abbr}.json`);
  const { results } = computeArtistic(entriesFrom(fx, def), def, buildConfig(fx.config!), { finals: false });
  const map: PrelimQualLookup = new Map();
  for (const r of results) {
    const rec: Record<string, QualFlag> = {};
    for (const ev of def.events) rec[ev] = r.events[ev].qual!;
    if (r.aa) rec.AA = r.aa.qual!;
    map.set(`${r.entry.first}|${r.entry.last}|${r.entry.club}|${r.level}`, rec);
  }
  return map;
}

function prelimQualifiedTeams(year: string, def: typeof WAG | typeof MAG): Set<string> {
  const fx = loadFixture(`${year}_prelims_${def.abbr}.json`);
  const { teams } = computeArtistic(entriesFrom(fx, def), def, buildConfig(fx.config!), { finals: false });
  const set = new Set<string>();
  for (const t of teams) if (t.category !== 'Mixed' && t.qual === 'Y') set.add(`${t.club}|${t.level}|${t.category}`);
  return set;
}

describe('nationals validation parity — prelims', () => {
  for (const year of ['2024', '2025']) {
    it(`reproduces ${year} prelims validation`, () => {
      const vfx = loadFixture(`${year}_prelims_validation.json`);
      const sheets = vfx.expected as unknown as Record<string, Record<string, unknown>[]>;

      for (const def of [WAG, MAG]) {
        const fx = loadFixture(`${year}_prelims_${def.abbr}.json`);
        const v = validateArtistic(entriesFrom(fx, def), def, buildConfig(fx.config!), false);
        expectSameSet(
          v.aa.map((f) => `${f.first}|${f.last}|${f.session}|${f.sfAA}|${f.calcAA}`),
          sheets[`${def.abbr} aa`].map((r) => `${r.FirstName}|${r.LastName}|${r.Session}|${num(r['SF AA'])}|${num(r['Calculated AA'])}`),
          `${def.abbr} aa`,
        );
        expectSameSet(
          v.svCap.map((f) => `${f.first}|${f.last}|${f.session}|${NAME[f.event]}|${f.score}`),
          sheets[`${def.abbr} sv cap`].map((r) => `${r.FirstName}|${r.LastName}|${r.Session}|${r.Event}|${num(r.Score)}`),
          `${def.abbr} sv cap`,
        );
        expectSameSet(
          v.prelimsIncluded.map((f) => `${f.first}|${f.last}|${f.session}|${NAME[f.event]}`),
          sheets[`${def.abbr} prelims included`].map((r) => `${r.FirstName}|${r.LastName}|${r.Session}|${r.Event}`),
          `${def.abbr} prelims included`,
        );
        expectSameSet(
          v.decimal.map((f) => `${f.first}|${f.last}|${f.session}|${SCORE_COL[f.event]}|${f.score}`),
          sheets[`${def.abbr} decimal`].map((r) => `${r.FirstName}|${r.LastName}|${r.Session}|${r.Event}|${num(r.Score)}`),
          `${def.abbr} decimal`,
        );
      }

      // TNT syncro
      const tnt = (loadFixture(`${year}_prelims_tnt.json`).input ?? []).map((r, i) => tntRowToEntry(r, i));
      const s = validateSyncro(tnt);
      expectSameSet(
        s.missing.map((f) => `${f.partner1}|${f.partner2}|${f.session}`),
        sheets['syncro missing'].map((r) => `${r['Partner 1'] ?? ''}|${r['Partner 2'] ?? ''}|${r.Session}`),
        'syncro missing',
      );
      expectSameSet(
        s.levels.map((f) => `${f.partner1}|${f.partner2}|${f.level1}|${f.level2}`),
        sheets['syncro levels'].map((r) => `${r['Partner 1']}|${r['Partner 2']}|${r['Level 1']}|${r['Level 2']}`),
        'syncro levels',
      );
      expectSameSet(
        s.scores.map((f) => `${f.partner1}|${f.partner2}|${f.score1}|${f.score2}`),
        sheets['syncro scores'].map((r) => `${r['Partner 1']}|${r['Partner 2']}|${num(r['Score 1'])}|${num(r['Score 2'])}`),
        'syncro scores',
      );
    });
  }
});

describe('nationals validation parity — finals', () => {
  for (const year of ['2024', '2025']) {
    it(`reproduces ${year} finals validation`, () => {
      const vfx = loadFixture(`${year}_finals_validation.json`);
      const sheets = vfx.expected as unknown as Record<string, Record<string, unknown>[]>;

      for (const def of [WAG, MAG]) {
        const fx = loadFixture(`${year}_finals_${def.abbr}.json`);
        const entries = entriesFrom(fx, def);
        const v = validateArtistic(entries, def, buildConfig(fx.config!), true);
        expectSameSet(
          v.aa.map((f) => `${f.first}|${f.last}|${f.session}|${f.sfAA}|${f.calcAA}`),
          sheets[`${def.abbr} aa`].map((r) => `${r.FirstName}|${r.LastName}|${r.Session}|${num(r['SF AA'])}|${num(r['Calculated AA'])}`),
          `${def.abbr} aa`,
        );
        expectSameSet(
          v.svCap.map((f) => `${f.first}|${f.last}|${f.session}|${NAME[f.event]}|${f.score}`),
          sheets[`${def.abbr} sv cap`].map((r) => `${r.FirstName}|${r.LastName}|${r.Session}|${r.Event}|${num(r.Score)}`),
          `${def.abbr} sv cap`,
        );

        // Team completeness
        const teamFindings = validateTeamFinals(entries, def, prelimQualifiedTeams(year, def));
        const gotTeam = teamFindings.map((f) => `${f.club}|${f.level}|${f.category}|${def.events.map((ev) => `${ev}:${f.validity[ev]}`).join(',')}`);
        const expTeam = sheets[`${def.abbr} finals included`].map(
          (r) => `${r.Club_Name}|${r.CompLevel}|${r['Placement Category']}|${def.events.map((ev) => `${ev}:${r[`${ev} Valid`]}`).join(',')}`,
        );
        expectSameSet(gotTeam, expTeam, `${def.abbr} finals included`);

        // Qual check
        const qc = validateQualCheck(entries, def, buildPrelimQual(year, def));
        const gotQc = qc.map((f) => `${f.first}|${f.last}|${f.club}|${f.level}|${NAME[f.event]}|${f.prelimsQual}|${f.finalsPlaceEligible ? 1 : 0}|${f.problem}`);
        const expQc = sheets[`${def.abbr} qual check`].map(
          (r) => `${r.FirstName}|${r.LastName}|${r.Club_Name}|${r.CompLevel}|${r.Event}|${r['Prelims Qual']}|${num(r['Finals Place Eligible'])}|${r.Problem}`,
        );
        expectSameSet(gotQc, expQc, `${def.abbr} qual check`);
      }
    });
  }
});
