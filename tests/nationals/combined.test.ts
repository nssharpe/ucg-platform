import { describe, it, expect } from 'vitest';
import { computeDecathlon, computeOmnithon } from '../../src/nationals/combined';
import { WAG, MAG } from '../../src/nationals/types';
import { loadFixture, entriesFrom, tntRowToEntry, place } from './helpers';

function wagMag(year: string) {
  const wag = entriesFrom(loadFixture(`${year}_prelims_wag.json`), WAG);
  const mag = entriesFrom(loadFixture(`${year}_prelims_mag.json`), MAG);
  return { wag, mag };
}

describe('nationals decathlon parity', () => {
  for (const year of ['2024', '2025']) {
    it(`reproduces ${year} decathlon`, () => {
      const { wag, mag } = wagMag(year);
      const got = computeDecathlon(wag, mag);
      const exp = loadFixture(`${year}_prelims_decathlon.json`).expected;
      const byKey = new Map(got.map((r) => [`${r.first}|${r.last}|${r.email}|${r.club}|${r.level}`, r]));
      const mism: unknown[] = [];
      for (const e of exp) {
        const key = `${String(e.FirstName).trim()}|${String(e.LastName).trim()}|${String(e.Athlete_Email).trim()}|${String(e.Club_Name).trim()}|${e.CompLevel}`;
        const r = byKey.get(key);
        if (!r) {
          mism.push({ who: key, field: 'MISSING' });
          continue;
        }
        if (place(e['Overall Place']) !== r.place) mism.push({ who: key, field: 'place', exp: e['Overall Place'], got: r.place });
        if (Math.abs(Number(e['Overall Score']) - r.overall) > 1e-9) mism.push({ who: key, field: 'score', exp: e['Overall Score'], got: r.overall });
        if ((e['Overall?'] ?? null) !== r.qual) mism.push({ who: key, field: 'qual', exp: e['Overall?'], got: r.qual });
      }
      if (mism.length) console.log(year, 'decathlon mismatches:', mism.slice(0, 20));
      expect(mism, `${mism.length} mismatches`).toHaveLength(0);
      // every placed expected row is reproduced (count parity)
      expect(got.length).toBe(exp.length);
    });
  }
});

describe('nationals omnithon parity (reference placeholder behavior)', () => {
  for (const year of ['2024', '2025']) {
    it(`reproduces ${year} omnithon`, () => {
      const { wag, mag } = wagMag(year);
      const tnt = (loadFixture(`${year}_prelims_tnt.json`).input ?? []).map((r, i) => tntRowToEntry(r, i));
      const got = computeOmnithon(wag, mag, tnt);
      const exp = loadFixture(`${year}_prelims_omnithon.json`).expected;
      const byKey = new Map(got.map((r) => [`${r.first}|${r.last}|${r.email}|${r.club}`, r]));
      const mism: unknown[] = [];
      for (const e of exp) {
        const key = `${String(e.FirstName).trim()}|${String(e.LastName).trim()}|${String(e.Athlete_Email).trim()}|${String(e.Club_Name).trim()}`;
        const r = byKey.get(key);
        if (!r) {
          mism.push({ who: key, field: 'MISSING' });
          continue;
        }
        if (Boolean(e['Overall Score']) !== r.eligible) mism.push({ who: key, field: 'eligible', exp: e['Overall Score'], got: r.eligible });
        if ((e['Overall?'] ?? null) !== r.qual) mism.push({ who: key, field: 'qual', exp: e['Overall?'], got: r.qual });
      }
      if (mism.length) console.log(year, 'omnithon mismatches:', mism.slice(0, 20));
      expect(mism, `${mism.length} mismatches`).toHaveLength(0);
      expect(got.length).toBe(exp.length);
    });
  }
});
