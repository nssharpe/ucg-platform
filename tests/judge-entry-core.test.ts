import { describe, it, expect } from 'vitest';
import {
  validateJudgeSubmit, isValidAccessCode, isValidAccessToken,
  type JudgeRegistrationLite,
} from '../supabase/functions/_shared/judge-entry-core';

const eventId = 'evt-1';

function reg(overrides: Partial<JudgeRegistrationLite> = {}): JudgeRegistrationLite {
  return {
    id: 'reg-1', eventId, sessionId: 'sess-1', apparatus: ['vault', 'bars'], refunded: false,
    ...overrides,
  };
}

describe('validateJudgeSubmit', () => {
  it('accepts a valid score and recomputes the id server-side', () => {
    const result = validateJudgeSubmit(eventId, {
      regId: 'reg-1', apparatus: 'vault', sv: 4.2, deductions: 0.5, eScore: null, final: 3.7,
      source: 'manual',
    }, reg());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.score.id).toBe('evt-1|reg-1|vault');
      expect(result.score.eventId).toBe(eventId);
      expect(result.score.regId).toBe('reg-1');
      expect(result.score.sessionId).toBe('sess-1');
      expect(result.score.sv).toBe(4.2);
      expect(result.score.deductions).toBe(0.5);
      expect(result.score.final).toBe(3.7);
    }
  });

  it('ignores any client-supplied id — always derives it from eventId/regId/apparatus', () => {
    const result = validateJudgeSubmit(eventId, {
      // @ts-expect-error — id is not part of JudgeSubmitPayload; simulate a forged extra field
      id: 'evt-1|someone-elses-reg|floor',
      regId: 'reg-1', apparatus: 'vault', sv: 4.2, deductions: 0.5, final: 3.7,
    }, reg());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.score.id).toBe('evt-1|reg-1|vault');
  });

  it('rejects a registration that belongs to a different event', () => {
    const result = validateJudgeSubmit(eventId, {
      regId: 'reg-1', apparatus: 'vault', sv: 4.2, deductions: 0.5, final: 3.7,
    }, reg({ eventId: 'evt-OTHER' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/does not belong to this event/);
  });

  it('rejects a refunded registration', () => {
    const result = validateJudgeSubmit(eventId, {
      regId: 'reg-1', apparatus: 'vault', sv: 4.2, deductions: 0.5, final: 3.7,
    }, reg({ refunded: true }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/refunded/);
  });

  it('rejects a missing registration (not found server-side)', () => {
    const result = validateJudgeSubmit(eventId, {
      regId: 'reg-ghost', apparatus: 'vault', sv: 4.2, deductions: 0.5, final: 3.7,
    }, null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not found/);
  });

  it('rejects an apparatus the athlete is not registered for', () => {
    const result = validateJudgeSubmit(eventId, {
      regId: 'reg-1', apparatus: 'floor', sv: 4.2, deductions: 0.5, final: 3.7,
    }, reg());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not registered for that apparatus/);
  });

  it.each([
    ['negative sv', { sv: -1 }],
    ['non-finite sv', { sv: Infinity }],
    ['sv over the sanity cap', { sv: 950 }],
    ['NaN deductions', { deductions: Number.NaN }],
    ['negative final', { final: -0.01 }],
    ['non-numeric eScore', { eScore: '9.5' as unknown as number }],
  ])('rejects out-of-bounds numeric field: %s', (_label, patch) => {
    const result = validateJudgeSubmit(eventId, {
      regId: 'reg-1', apparatus: 'vault', sv: 4.2, deductions: 0.5, final: 3.7, ...patch,
    }, reg());
    expect(result.ok).toBe(false);
  });

  it('allows null score fields (a score in progress)', () => {
    const result = validateJudgeSubmit(eventId, {
      regId: 'reg-1', apparatus: 'vault', sv: null, deductions: null, eScore: null, final: null,
    }, reg());
    expect(result.ok).toBe(true);
  });

  it('rejects a missing regId or apparatus', () => {
    expect(validateJudgeSubmit(eventId, { regId: '', apparatus: 'vault' }, reg()).ok).toBe(false);
    expect(validateJudgeSubmit(eventId, { regId: 'reg-1', apparatus: '' }, reg()).ok).toBe(false);
  });

  it('accepts and passes through second-judge-panel fields (deductions2/eScore2)', () => {
    const result = validateJudgeSubmit(eventId, {
      regId: 'reg-1', apparatus: 'vault', sv: 4.2, deductions: 0.5, deductions2: 0.7, final: 3.55,
    }, reg());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.score.deductions2).toBe(0.7);
      expect(result.score.eScore2).toBeNull();
    }
  });

  it('allows null deductions2/eScore2 (panels:1, or judge 2 not entered yet)', () => {
    const result = validateJudgeSubmit(eventId, {
      regId: 'reg-1', apparatus: 'vault', sv: 4.2, deductions: 0.5, final: 3.7,
    }, reg());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.score.deductions2).toBeNull();
      expect(result.score.eScore2).toBeNull();
    }
  });

  it.each([
    ['negative deductions2', { deductions2: -1 }],
    ['non-finite eScore2', { eScore2: Infinity }],
    ['eScore2 over the sanity cap', { eScore2: 950 }],
  ])('rejects out-of-bounds second-judge-panel field: %s', (_label, patch) => {
    const result = validateJudgeSubmit(eventId, {
      regId: 'reg-1', apparatus: 'vault', sv: 4.2, deductions: 0.5, final: 3.7, ...patch,
    }, reg());
    expect(result.ok).toBe(false);
  });

  it('accepts and passes through expectedUpdatedAt (compare-and-set, UAT Z-06-01)', () => {
    const result = validateJudgeSubmit(eventId, {
      regId: 'reg-1', apparatus: 'vault', sv: 4.2, deductions: 0.5, final: 3.7,
      expectedUpdatedAt: '2026-08-22T10:00:00.000Z',
    }, reg());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.score.expectedUpdatedAt).toBe('2026-08-22T10:00:00.000Z');
  });

  it('defaults expectedUpdatedAt to null when absent or explicitly null', () => {
    const withoutIt = validateJudgeSubmit(eventId, {
      regId: 'reg-1', apparatus: 'vault', sv: 4.2, deductions: 0.5, final: 3.7,
    }, reg());
    expect(withoutIt.ok).toBe(true);
    if (withoutIt.ok) expect(withoutIt.score.expectedUpdatedAt).toBeNull();

    const explicitNull = validateJudgeSubmit(eventId, {
      regId: 'reg-1', apparatus: 'vault', sv: 4.2, deductions: 0.5, final: 3.7,
      expectedUpdatedAt: null,
    }, reg());
    expect(explicitNull.ok).toBe(true);
    if (explicitNull.ok) expect(explicitNull.score.expectedUpdatedAt).toBeNull();
  });

  it('rejects a non-string expectedUpdatedAt', () => {
    const result = validateJudgeSubmit(eventId, {
      regId: 'reg-1', apparatus: 'vault', sv: 4.2, deductions: 0.5, final: 3.7,
      expectedUpdatedAt: 1755856800000 as unknown as string,
    }, reg());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/expected-update timestamp/);
  });

  it('rejects an oversized expectedUpdatedAt', () => {
    const result = validateJudgeSubmit(eventId, {
      regId: 'reg-1', apparatus: 'vault', sv: 4.2, deductions: 0.5, final: 3.7,
      expectedUpdatedAt: 'x'.repeat(65),
    }, reg());
    expect(result.ok).toBe(false);
  });

  it('rejects oversized free-form fields (anonymous storage-bloat guard)', () => {
    const base = { regId: 'reg-1', apparatus: 'vault', sv: 4.2, deductions: 0.5, final: 3.7 };
    expect(validateJudgeSubmit(eventId, { ...base, source: 'x'.repeat(41) }, reg()).ok).toBe(false);
    expect(validateJudgeSubmit(eventId, { ...base, calc: 'x'.repeat(41) }, reg()).ok).toBe(false);
    expect(validateJudgeSubmit(eventId, { ...base, calcState: { blob: 'x'.repeat(20_001) } }, reg()).ok).toBe(false);
    // A realistic calcState stays accepted.
    expect(validateJudgeSubmit(eventId, { ...base, calcState: { v: 2, entries: [1, 2, 3] } }, reg()).ok).toBe(true);
  });
});

describe('isValidAccessCode', () => {
  it('accepts exactly 6 digits', () => {
    expect(isValidAccessCode('123456')).toBe(true);
  });
  it('rejects anything else', () => {
    expect(isValidAccessCode('12345')).toBe(false);
    expect(isValidAccessCode('1234567')).toBe(false);
    expect(isValidAccessCode('12a456')).toBe(false);
    expect(isValidAccessCode(123456)).toBe(false);
    expect(isValidAccessCode(undefined)).toBe(false);
  });
});

describe('isValidAccessToken', () => {
  it('accepts a long hex string', () => {
    expect(isValidAccessToken('a1b2c3d4e5f6a1b2c3d4e5f6')).toBe(true);
  });
  it('rejects short or non-hex input', () => {
    expect(isValidAccessToken('short')).toBe(false);
    expect(isValidAccessToken('zzzzzzzzzzzzzzzzzzzzzzzz')).toBe(false);
    expect(isValidAccessToken(undefined)).toBe(false);
  });
});
