import { describe, it, expect } from 'vitest';
import { computeTnt, buildTntCutoffs } from '../../src/nationals/tnt';
import { TNT } from '../../src/nationals/types';
import { loadFixture, TNT_COLS, tntRowToEntry, place } from './helpers';

interface Mismatch {
  who: string;
  field: string;
  expected: unknown;
  got: unknown;
}

function checkTnt(name: string): Mismatch[] {
  const fx = loadFixture(name);
  const cutoffs = buildTntCutoffs(fx.config!);
  const entries = (fx.input ?? []).map((r, i) => tntRowToEntry(r, i));
  const results = computeTnt(entries, TNT, cutoffs);
  // Match expected rows positionally to results (same input order, no sorting in our output).
  const mism: Mismatch[] = [];
  const byKey = new Map<string, (typeof results)[number]>();
  for (const r of results) byKey.set(`${r.entry.email}|${r.entry.first}|${r.entry.last}`, r);
  const seen = new Map<string, number>();
  for (const exp of fx.expected) {
    const k = `${String(exp.Athlete_Email ?? '').trim()}|${String(exp.FirstName ?? '').trim()}|${String(exp.LastName ?? '').trim()}`;
    const occ = seen.get(k) ?? 0;
    seen.set(k, occ + 1);
    const matches = results.filter((r) => `${r.entry.email}|${r.entry.first}|${r.entry.last}` === k);
    const r = matches[occ] ?? byKey.get(k);
    const who = `${exp.FirstName} ${exp.LastName}`;
    if (!r) {
      mism.push({ who, field: 'MISSING', expected: k, got: null });
      continue;
    }
    for (const ev of TNT.events) {
      const c = TNT_COLS[ev];
      const ep = r.events[ev];
      if (place(exp[c.place]) !== ep.place)
        mism.push({ who, field: `${ev} place`, expected: exp[c.place], got: ep.place });
      if ((exp[c.qual] ?? null) !== (ep.qual ?? null))
        mism.push({ who, field: `${ev} qual`, expected: exp[c.qual], got: ep.qual });
    }
  }
  return mism;
}

describe('nationals TNT prelims parity', () => {
  for (const name of ['2024_prelims_tnt.json', '2025_prelims_tnt.json']) {
    it(`reproduces ${name}`, () => {
      const mism = checkTnt(name);
      if (mism.length) console.log(name, 'mismatches:', mism.slice(0, 25));
      expect(mism, `${mism.length} mismatches`).toHaveLength(0);
    });
  }
});
