import { describe, it, expect } from 'vitest';
import { classifyCartRemoval, resolveRegRemoval } from '../../src/lib/pricing';
import type { CartItem, Registration } from '../../src/lib/types';

// Minimal but valid Registration fixture for snapshot fields.
function reg(overrides: Partial<Registration> = {}): Registration {
  return {
    id: 'r1', eventId: 'e1', athleteId: 'a1', clubId: 'c1', discipline: 'MAG',
    levelId: 'L5', apparatus: ['FX', 'PH'], sessionId: null,
    ...overrides,
  };
}

function item(overrides: Partial<CartItem> = {}): CartItem {
  return {
    id: 'ci1', label: 'test item', amount: 15, kind: 'meet-entry',
    refRegIds: ['r1'],
    ...overrides,
  };
}

describe('classifyCartRemoval', () => {
  it('deletes the registration for a brand-new unpaid entry line', () => {
    expect(classifyCartRemoval(item({ refLineType: 'entry' }))).toBe('delete-registration');
  });

  it('treats a legacy meet-entry line with no refLineType as a delete-registration (pre-refLineType rows)', () => {
    expect(classifyCartRemoval(item({ refLineType: undefined }))).toBe('delete-registration');
  });

  it('reverts the registration for a change line with a captured snapshot', () => {
    expect(classifyCartRemoval(item({ refLineType: 'change', priorRegSnapshot: [reg()] }))).toBe('revert-registration');
  });

  it('falls back to remove-only for a change line with no snapshot (legacy row)', () => {
    expect(classifyCartRemoval(item({ refLineType: 'change', priorRegSnapshot: undefined }))).toBe('no-snapshot-remove-only');
  });

  it('falls back to remove-only for a change line with an empty snapshot array', () => {
    expect(classifyCartRemoval(item({ refLineType: 'change', priorRegSnapshot: [] }))).toBe('no-snapshot-remove-only');
  });

  it('is remove-only for a membership line with no refUserId/refSeasonId/refType (e.g. a club buying its own membership)', () => {
    expect(classifyCartRemoval(item({ kind: 'membership', refRegIds: undefined, refLineType: undefined }))).toBe('remove-only');
  });

  it('is remove-only for an addon line (tshirt/banner)', () => {
    expect(classifyCartRemoval(item({ kind: 'addon', refLineType: 'tshirt', refRegIds: undefined }))).toBe('remove-only');
  });

  it('is remove-only for a meet-entry line with no refRegIds to act on', () => {
    expect(classifyCartRemoval(item({ kind: 'meet-entry', refLineType: 'entry', refRegIds: undefined }))).toBe('remove-only');
  });

  it('is remove-only for a meet-entry line with an empty refRegIds array', () => {
    expect(classifyCartRemoval(item({ kind: 'meet-entry', refLineType: 'change', refRegIds: [] }))).toBe('remove-only');
  });

  // ---- H6: membership-line removal clears the club-payment hold -------------

  describe('membership lines (H6)', () => {
    it('is clear-membership-hold for a member-pushed athlete/coach membership line', () => {
      expect(classifyCartRemoval(item({
        kind: 'membership', refRegIds: undefined, refLineType: undefined,
        refUserId: 'p1', refSeasonId: 's1', refType: 'athlete',
      }))).toBe('clear-membership-hold');
      expect(classifyCartRemoval(item({
        kind: 'membership', refRegIds: undefined, refLineType: undefined,
        refUserId: 'p1', refSeasonId: 's1', refType: 'coach',
      }))).toBe('clear-membership-hold');
    });

    it('is remove-only for a CLUB\'s own membership line (refType "club", no refUserId)', () => {
      expect(classifyCartRemoval(item({
        kind: 'membership', refRegIds: undefined, refLineType: undefined,
        refUserId: undefined, refSeasonId: 's1', refType: 'club',
      }))).toBe('remove-only');
    });

    it('is remove-only for a membership line missing refSeasonId or refType', () => {
      expect(classifyCartRemoval(item({
        kind: 'membership', refRegIds: undefined, refLineType: undefined,
        refUserId: 'p1', refSeasonId: undefined, refType: 'athlete',
      }))).toBe('remove-only');
      expect(classifyCartRemoval(item({
        kind: 'membership', refRegIds: undefined, refLineType: undefined,
        refUserId: 'p1', refSeasonId: 's1', refType: undefined,
      }))).toBe('remove-only');
    });
  });
});

// ---- resolveRegRemoval (H5: shared refRegIds across multiple cart lines) --

describe('resolveRegRemoval', () => {
  const ctx = (overrides: Partial<{ otherRefRegIds: Set<string>; existingRegIds: Set<string> }> = {}) => ({
    otherRefRegIds: new Set<string>(),
    existingRegIds: new Set<string>(['r1', 'r2']),
    ...overrides,
  });

  it('deletes every refRegId when nothing else references them', () => {
    const result = resolveRegRemoval(item({ refRegIds: ['r1', 'r2'] }), ctx());
    expect(result.toDelete.sort()).toEqual(['r1', 'r2']);
    expect(result.toRevert).toEqual([]);
    expect(result.kept).toEqual([]);
  });

  it('keeps (does not delete) a reg id still referenced by another cart line (shared refs)', () => {
    const result = resolveRegRemoval(
      item({ refRegIds: ['r1', 'r2'] }),
      ctx({ otherRefRegIds: new Set(['r2']) }),
    );
    expect(result.toDelete).toEqual(['r1']);
    expect(result.kept).toEqual(['r2']);
  });

  it('reverts a refRegId that has a snapshot entry and still exists locally', () => {
    const prior = reg({ id: 'r1', apparatus: ['FX'] });
    const result = resolveRegRemoval(
      item({ refRegIds: ['r1'], priorRegSnapshot: [prior] }),
      ctx(),
    );
    expect(result.toRevert).toEqual([prior]);
    expect(result.toDelete).toEqual([]);
  });

  it('deletes (does not revert) a refRegId with NO snapshot entry — created by the change itself', () => {
    // r2 has no snapshot entry: it's a discipline that was ADDED by this
    // change and never existed before, so there's nothing to revert it to.
    const prior = reg({ id: 'r1', apparatus: ['FX'] });
    const result = resolveRegRemoval(
      item({ refRegIds: ['r1', 'r2'], priorRegSnapshot: [prior] }),
      ctx(),
    );
    expect(result.toRevert).toEqual([prior]);
    expect(result.toDelete).toEqual(['r2']);
  });

  it('never resurrects a snapshot whose registration no longer exists locally (H5 "never resurrect" rule)', () => {
    const prior = reg({ id: 'r1', apparatus: ['FX'] });
    const result = resolveRegRemoval(
      item({ refRegIds: ['r1'], priorRegSnapshot: [prior] }),
      ctx({ existingRegIds: new Set() }), // r1 was deleted for real elsewhere
    );
    expect(result.toRevert).toEqual([]);
    expect(result.toDelete).toEqual([]);
    expect(result.kept).toEqual([]);
  });

  it('keeps a snapshot-covered id that is still referenced by another line instead of reverting it', () => {
    const prior = reg({ id: 'r1', apparatus: ['FX'] });
    const result = resolveRegRemoval(
      item({ refRegIds: ['r1'], priorRegSnapshot: [prior] }),
      ctx({ otherRefRegIds: new Set(['r1']) }),
    );
    expect(result.toRevert).toEqual([]);
    expect(result.toDelete).toEqual([]);
    expect(result.kept).toEqual(['r1']);
  });

  it('keeps a no-snapshot id that is still referenced by another line instead of deleting it', () => {
    const result = resolveRegRemoval(
      item({ refRegIds: ['r2'], priorRegSnapshot: [] }),
      ctx({ otherRefRegIds: new Set(['r2']) }),
    );
    expect(result.toDelete).toEqual([]);
    expect(result.kept).toEqual(['r2']);
  });

  it('returns nothing to do for an item with no refRegIds', () => {
    const result = resolveRegRemoval(item({ refRegIds: undefined }), ctx());
    expect(result).toEqual({ toDelete: [], toRevert: [], kept: [] });
  });
});
