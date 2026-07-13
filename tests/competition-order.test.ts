import { describe, it, expect } from 'vitest';
import {
  sectionCap, splitIntoSections, flattenSections, sectionsValid, moveInSections,
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
