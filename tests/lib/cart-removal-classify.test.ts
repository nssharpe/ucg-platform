import { describe, it, expect } from 'vitest';
import { classifyCartRemoval } from '../../src/lib/pricing';
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

  it('is remove-only for a membership line', () => {
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
});
