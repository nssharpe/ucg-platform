import { describe, it, expect } from 'vitest';
import {
  FINALS_LINEUP_MAX, finalsLineupValid, moveInLineup, toggleInLineup,
} from '../src/lib/finals-lineup';

describe('FINALS_LINEUP_MAX', () => {
  it('is 4', () => {
    expect(FINALS_LINEUP_MAX).toBe(4);
  });
});

describe('finalsLineupValid', () => {
  it('is true for an empty list', () => {
    expect(finalsLineupValid([])).toBe(true);
  });

  it('is true at exactly the max (4)', () => {
    expect(finalsLineupValid(['a', 'b', 'c', 'd'])).toBe(true);
  });

  it('is false one over the max (5)', () => {
    expect(finalsLineupValid(['a', 'b', 'c', 'd', 'e'])).toBe(false);
  });

  it('honors a custom max', () => {
    expect(finalsLineupValid(['a', 'b'], 2)).toBe(true);
    expect(finalsLineupValid(['a', 'b', 'c'], 2)).toBe(false);
  });

  it('is false when a registration id is duplicated, even under the cap', () => {
    expect(finalsLineupValid(['a', 'a'])).toBe(false);
  });
});

describe('moveInLineup', () => {
  it('moves an entry from one index to another', () => {
    expect(moveInLineup(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('moves an entry earlier in the list', () => {
    expect(moveInLineup(['a', 'b', 'c', 'd'], 3, 0)).toEqual(['d', 'a', 'b', 'c']);
  });

  it('is a no-op moving an entry to its own position', () => {
    expect(moveInLineup(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'b', 'c']);
  });

  it('clamps an out-of-range "to" index to the end', () => {
    expect(moveInLineup(['a', 'b', 'c'], 0, 999)).toEqual(['b', 'c', 'a']);
  });

  it('clamps a negative "from" index to the start', () => {
    expect(moveInLineup(['a', 'b', 'c'], -5, 2)).toEqual(['b', 'c', 'a']);
  });

  it('returns [] unchanged for an empty list', () => {
    expect(moveInLineup([], 0, 1)).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const regIds = ['a', 'b', 'c'];
    const snapshot = [...regIds];
    moveInLineup(regIds, 0, 2);
    expect(regIds).toEqual(snapshot);
  });
});

describe('toggleInLineup', () => {
  it('adds a regId that is absent (under cap)', () => {
    expect(toggleInLineup(['a', 'b'], 'c')).toEqual(['a', 'b', 'c']);
  });

  it('removes a regId that is present', () => {
    expect(toggleInLineup(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
  });

  it('is a no-op (unchanged copy) adding past the max (4)', () => {
    const full = ['a', 'b', 'c', 'd'];
    expect(toggleInLineup(full, 'e')).toEqual(full);
  });

  it('still allows removal even when already at cap', () => {
    const full = ['a', 'b', 'c', 'd'];
    expect(toggleInLineup(full, 'b')).toEqual(['a', 'c', 'd']);
  });

  it('honors a custom max', () => {
    expect(toggleInLineup(['a'], 'b', 2)).toEqual(['a', 'b']);
    expect(toggleInLineup(['a', 'b'], 'c', 2)).toEqual(['a', 'b']);
  });

  it('does not mutate the input array', () => {
    const regIds = ['a', 'b'];
    const snapshot = [...regIds];
    toggleInLineup(regIds, 'c');
    expect(regIds).toEqual(snapshot);
    toggleInLineup(regIds, 'a');
    expect(regIds).toEqual(snapshot);
  });
});
