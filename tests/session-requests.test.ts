import { describe, it, expect } from 'vitest';
import {
  requiredSessionRequests, sessionRequestAnswered, missingSessionRequests,
  type SessionRequestReg, type ExistingSessionRequest,
} from '../src/lib/pricing';

describe('requiredSessionRequests', () => {
  it('returns [] for a non-nationals event', () => {
    const regs: SessionRequestReg[] = [{ discipline: 'WAG', levelId: 'lvl-1' }];
    expect(requiredSessionRequests({ kind: 'standard' }, regs, 'club')).toEqual([]);
    expect(requiredSessionRequests({}, regs, 'club')).toEqual([]);
  });

  it('club scope: one key per distinct WAG level, plus combined MAG/TNT keys', () => {
    const regs: SessionRequestReg[] = [
      { discipline: 'WAG', levelId: 'lvl-3' },
      { discipline: 'WAG', levelId: 'lvl-3' }, // second athlete, same level — dedup expected
      { discipline: 'WAG', levelId: 'lvl-5' },
      { discipline: 'MAG', levelId: 'lvl-x' },
      { discipline: 'MAG', levelId: 'lvl-y' }, // MAG combined regardless of level
      { discipline: 'TNT', levelId: 'lvl-z' },
    ];
    const keys = requiredSessionRequests({ kind: 'nationals' }, regs, 'club');
    // Order-independent comparison
    expect(keys).toHaveLength(4);
    expect(keys).toContainEqual({ discipline: 'WAG', levelId: 'lvl-3' });
    expect(keys).toContainEqual({ discipline: 'WAG', levelId: 'lvl-5' });
    expect(keys).toContainEqual({ discipline: 'MAG', levelId: null });
    expect(keys).toContainEqual({ discipline: 'TNT', levelId: null });
  });

  it('club scope: only WAG regs produce no MAG/TNT keys', () => {
    const regs: SessionRequestReg[] = [{ discipline: 'WAG', levelId: 'lvl-1' }];
    const keys = requiredSessionRequests({ kind: 'nationals' }, regs, 'club');
    expect(keys).toEqual([{ discipline: 'WAG', levelId: 'lvl-1' }]);
  });

  it('club scope: no regs produces no keys', () => {
    expect(requiredSessionRequests({ kind: 'nationals' }, [], 'club')).toEqual([]);
  });

  it('person (independent) scope: one key per distinct discipline, level always null', () => {
    const regs: SessionRequestReg[] = [
      { discipline: 'MAG', levelId: 'lvl-a' },
      { discipline: 'TNT', levelId: 'lvl-b' },
      { discipline: 'MAG', levelId: 'lvl-a' }, // dup, should not double up
    ];
    const keys = requiredSessionRequests({ kind: 'nationals' }, regs, 'person');
    expect(keys).toHaveLength(2);
    expect(keys).toContainEqual({ discipline: 'MAG', levelId: null });
    expect(keys).toContainEqual({ discipline: 'TNT', levelId: null });
  });

  it('person scope: independent WAG registrations still collapse to one null-level key (no per-level split)', () => {
    const regs: SessionRequestReg[] = [
      { discipline: 'WAG', levelId: 'lvl-1' },
      { discipline: 'WAG', levelId: 'lvl-2' },
    ];
    const keys = requiredSessionRequests({ kind: 'nationals' }, regs, 'person');
    expect(keys).toEqual([{ discipline: 'WAG', levelId: null }]);
  });
});

describe('sessionRequestAnswered', () => {
  it('is false when arrival is missing or blank', () => {
    expect(sessionRequestAnswered({})).toBe(false);
    expect(sessionRequestAnswered({ arrival: '' })).toBe(false);
    expect(sessionRequestAnswered({ arrival: '   ' })).toBe(false);
  });

  it('is true once arrival is a non-empty string, regardless of other fields', () => {
    expect(sessionRequestAnswered({ arrival: 'Thursday morning' })).toBe(true);
    expect(sessionRequestAnswered({ arrival: 'Thursday', notes: '', preferredSessionIds: [] })).toBe(true);
  });
});

describe('missingSessionRequests', () => {
  const required = [
    { discipline: 'WAG' as const, levelId: 'lvl-3' },
    { discipline: 'MAG' as const, levelId: null },
  ];

  it('reports all required keys missing when there are no existing rows', () => {
    expect(missingSessionRequests(required, [])).toEqual(required);
  });

  it('excludes a required key covered by a matching ANSWERED existing row', () => {
    const existing: ExistingSessionRequest[] = [
      { discipline: 'WAG', levelId: 'lvl-3', answers: { arrival: 'Thursday' } },
    ];
    const missing = missingSessionRequests(required, existing);
    expect(missing).toEqual([{ discipline: 'MAG', levelId: null }]);
  });

  it('does NOT excuse a required key whose existing row is unanswered (draft with no arrival)', () => {
    const existing: ExistingSessionRequest[] = [
      { discipline: 'WAG', levelId: 'lvl-3', answers: { notes: 'started but not finished' } },
      { discipline: 'MAG', levelId: null, answers: { arrival: 'Friday' } },
    ];
    const missing = missingSessionRequests(required, existing);
    expect(missing).toEqual([{ discipline: 'WAG', levelId: 'lvl-3' }]);
  });

  it('returns [] once every required key has an answered match', () => {
    const existing: ExistingSessionRequest[] = [
      { discipline: 'WAG', levelId: 'lvl-3', answers: { arrival: 'Thursday' } },
      { discipline: 'MAG', levelId: null, answers: { arrival: 'Friday' } },
    ];
    expect(missingSessionRequests(required, existing)).toEqual([]);
  });
});
