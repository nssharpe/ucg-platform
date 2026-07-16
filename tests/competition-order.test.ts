import { describe, it, expect } from 'vitest';
import {
  sectionCap, splitIntoSections, flattenSections, sectionsValid, moveInSections, reconcileSections,
} from '../src/lib/competition-order';

describe('sectionCap', () => {
  it('is 12 for WAG and 15 for MAG', () => {
    expect(sectionCap('WAG')).toBe(12);
    expect(sectionCap('MAG')).toBe(15);
  });
});

describe('splitIntoSections', () => {
  it('returns [] for an empty list', () => {
    expect(splitIntoSections([], 12)).toEqual([]);
  });

  it('chunks exactly at the cap boundary (WAG, 12)', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `r${i}`);
    expect(splitIntoSections(ids, 12)).toEqual([ids]);
  });

  it('splits into two sections one over the cap boundary (WAG, 13)', () => {
    const ids = Array.from({ length: 13 }, (_, i) => `r${i}`);
    const sections = splitIntoSections(ids, 12);
    expect(sections).toHaveLength(2);
    expect(sections[0]).toHaveLength(12);
    expect(sections[1]).toEqual(['r12']);
  });

  it('chunks exactly at the cap boundary (MAG, 15)', () => {
    const ids = Array.from({ length: 15 }, (_, i) => `r${i}`);
    expect(splitIntoSections(ids, 15)).toEqual([ids]);
  });

  it('splits into two sections one over the cap boundary (MAG, 16)', () => {
    const ids = Array.from({ length: 16 }, (_, i) => `r${i}`);
    const sections = splitIntoSections(ids, 15);
    expect(sections).toHaveLength(2);
    expect(sections[0]).toHaveLength(15);
    expect(sections[1]).toEqual(['r15']);
  });

  it('preserves order within and across sections', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    expect(splitIntoSections(ids, 2)).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
  });
});

describe('flattenSections', () => {
  it('returns [] for no sections', () => {
    expect(flattenSections([])).toEqual([]);
  });

  it('concatenates sections back into one flat ordered list', () => {
    expect(flattenSections([['a', 'b'], ['c'], ['d', 'e']])).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('round-trips with splitIntoSections', () => {
    const ids = Array.from({ length: 27 }, (_, i) => `r${i}`);
    expect(flattenSections(splitIntoSections(ids, 12))).toEqual(ids);
  });
});

describe('sectionsValid', () => {
  it('is true for an empty sections array', () => {
    expect(sectionsValid([], 12)).toBe(true);
  });

  it('is true when every section is at or under the cap with no duplicates', () => {
    expect(sectionsValid([['a', 'b'], ['c', 'd', 'e']], 12)).toBe(true);
    expect(sectionsValid([Array.from({ length: 12 }, (_, i) => `r${i}`)], 12)).toBe(true);
  });

  it('is false when a section exceeds the cap by one', () => {
    expect(sectionsValid([Array.from({ length: 13 }, (_, i) => `r${i}`)], 12)).toBe(false);
  });

  it('is false when a registration id is duplicated across sections', () => {
    expect(sectionsValid([['a', 'b'], ['b', 'c']], 12)).toBe(false);
  });

  it('is false when a registration id is duplicated within one section', () => {
    expect(sectionsValid([['a', 'a']], 12)).toBe(false);
  });
});

describe('moveInSections', () => {
  it('moves an id from one section to another at a target index', () => {
    const sections = [['a', 'b'], ['c', 'd']];
    const result = moveInSections(sections, 'b', 1, 0);
    expect(result).toEqual([['a'], ['b', 'c', 'd']]);
  });

  it('reorders within the same section', () => {
    const sections = [['a', 'b', 'c']];
    const result = moveInSections(sections, 'c', 0, 0);
    expect(result).toEqual([['c', 'a', 'b']]);
  });

  it('inserts an id not previously present', () => {
    const sections = [['a', 'b']];
    const result = moveInSections(sections, 'z', 0, 1);
    expect(result).toEqual([['a', 'z', 'b']]);
  });

  it('creates a section when sections is empty', () => {
    expect(moveInSections([], 'a', 0, 0)).toEqual([['a']]);
  });

  it('clamps an out-of-range toSection to the last section', () => {
    const sections = [['a'], ['b']];
    const result = moveInSections(sections, 'a', 5, 0);
    expect(result).toEqual([[], ['a', 'b']]);
  });

  it('clamps a negative toSection to the first section', () => {
    const sections = [['a'], ['b']];
    const result = moveInSections(sections, 'b', -3, 0);
    expect(result).toEqual([['b', 'a'], []]);
  });

  it('clamps an out-of-range toIndex to the end of the target section', () => {
    const sections = [['a', 'b']];
    const result = moveInSections(sections, 'c', 0, 999);
    // c is new (not present anywhere), inserted at clamped end.
    // Note: 'c' isn't in the input, so nothing is removed first.
    expect(result).toEqual([['a', 'b', 'c']]);
  });

  it('does not mutate the input sections array', () => {
    const sections = [['a', 'b'], ['c']];
    const snapshot = sections.map((s) => [...s]);
    moveInSections(sections, 'a', 1, 0);
    expect(sections).toEqual(snapshot);
  });
});

describe('reconcileSections (B2 UI: persisted order vs. current eligible set)', () => {
  it('seeds fresh via splitIntoSections when there is no persisted row', () => {
    expect(reconcileSections(undefined, ['a', 'b', 'c'], 2)).toEqual([['a', 'b'], ['c']]);
  });

  it('seeds a single empty section when there is no persisted row and no eligible ids', () => {
    expect(reconcileSections(undefined, [], 12)).toEqual([[]]);
  });

  it('seeds fresh when the persisted row is an empty array', () => {
    expect(reconcileSections([], ['a', 'b'], 2)).toEqual([['a', 'b']]);
  });

  it('keeps the persisted order unchanged when the eligible set is identical', () => {
    const existing = [['a', 'b'], ['c']];
    expect(reconcileSections(existing, ['a', 'b', 'c'], 2)).toEqual(existing);
  });

  it('drops a registration id no longer eligible (e.g. refunded)', () => {
    const existing = [['a', 'b'], ['c']];
    expect(reconcileSections(existing, ['a', 'c'], 2)).toEqual([['a'], ['c']]);
  });

  it('appends a newly-eligible id to the last section when there is room', () => {
    const existing = [['a', 'b'], ['c']];
    expect(reconcileSections(existing, ['a', 'b', 'c', 'd'], 2)).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('spills a newly-eligible id into a fresh section once the last section is at cap', () => {
    const existing = [['a', 'b'], ['c', 'd']];
    expect(reconcileSections(existing, ['a', 'b', 'c', 'd', 'e'], 2)).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
  });

  it('handles simultaneous drop and add (athlete swapped out, new one swapped in)', () => {
    const existing = [['a', 'b'], ['c']];
    // 'b' is no longer eligible; 'z' is newly eligible.
    expect(reconcileSections(existing, ['a', 'c', 'z'], 2)).toEqual([['a'], ['c', 'z']]);
  });

  it('never drops a newly-eligible id — appends past cap rather than losing it', () => {
    const existing = [Array.from({ length: 12 }, (_, i) => `r${i}`)];
    const eligible = [...existing[0], 'new1'];
    const result = reconcileSections(existing, eligible, 12);
    expect(result.flat().sort()).toEqual([...eligible].sort());
  });

  it('is a no-op returning [[]] when both persisted and eligible are empty', () => {
    expect(reconcileSections([[]], [], 12)).toEqual([[]]);
  });
});
