import { describe, it, expect } from 'vitest';
import {
  unlockAttemptKey, isUnlockRateLimited, unlockWindowStart,
  UNLOCK_FAILURE_LIMIT, UNLOCK_WINDOW_MINUTES,
} from '../supabase/functions/_shared/judge-entry-core';

// Cover for the 2026-07-31 review finding §3.3: judge-entry's 6-digit unlock had
// no real rate limit — only a per-request sleep(300), which concurrency erases.
// 40 simultaneous invalid codes were measured all returning 401, none throttled.

const headers = (v?: string | null) => ({ get: (n: string) => (n === 'x-forwarded-for' ? v ?? null : null) });

describe('unlockAttemptKey', () => {
  it('takes the first hop of x-forwarded-for', () => {
    // Later hops are appended by proxies we control; the first is the client.
    expect(unlockAttemptKey(headers('203.0.113.7, 70.41.3.18, 150.172.238.178'))).toBe('203.0.113.7');
  });

  it('trims whitespace', () => {
    expect(unlockAttemptKey(headers('  203.0.113.7  , 70.41.3.18'))).toBe('203.0.113.7');
  });

  it('handles a single-hop header', () => {
    expect(unlockAttemptKey(headers('203.0.113.7'))).toBe('203.0.113.7');
  });

  it('falls back to a shared bucket when the header is absent', () => {
    expect(unlockAttemptKey(headers(null))).toBe('unidentified');
  });

  it('falls back when the header is empty or blank', () => {
    expect(unlockAttemptKey(headers(''))).toBe('unidentified');
    expect(unlockAttemptKey(headers('   '))).toBe('unidentified');
    expect(unlockAttemptKey(headers(',,,'))).toBe('unidentified');
  });

  it('rejects an absurdly long value rather than storing it', () => {
    // A caller controls this header; without a cap it is a free write channel
    // into the attempts table.
    expect(unlockAttemptKey(headers('x'.repeat(500)))).toBe('unidentified');
  });
});

describe('isUnlockRateLimited', () => {
  it('allows attempts below the limit', () => {
    expect(isUnlockRateLimited(0)).toBe(false);
    expect(isUnlockRateLimited(UNLOCK_FAILURE_LIMIT - 1)).toBe(false);
  });

  it('blocks at and above the limit', () => {
    expect(isUnlockRateLimited(UNLOCK_FAILURE_LIMIT)).toBe(true);
    expect(isUnlockRateLimited(UNLOCK_FAILURE_LIMIT + 100)).toBe(true);
  });

  it('leaves real fumbling room — a judge has one code to mistype', () => {
    expect(UNLOCK_FAILURE_LIMIT).toBeGreaterThanOrEqual(10);
    // ...while staying far below anything useful for brute force: even at the
    // limit every window, exhausting 1e6 codes takes millions of minutes.
    const perWindow = UNLOCK_FAILURE_LIMIT / UNLOCK_WINDOW_MINUTES;
    expect(perWindow).toBeLessThan(10); // < 10 guesses/minute per caller
  });
});

describe('unlockWindowStart', () => {
  it('returns the ISO cutoff one window before now', () => {
    const now = Date.parse('2026-07-31T18:00:00.000Z');
    expect(unlockWindowStart(now)).toBe('2026-07-31T17:55:00.000Z');
  });

  it('moves with the clock, so the window rolls rather than resetting', () => {
    const a = unlockWindowStart(Date.parse('2026-07-31T18:00:00.000Z'));
    const b = unlockWindowStart(Date.parse('2026-07-31T18:01:00.000Z'));
    expect(new Date(b).getTime()).toBeGreaterThan(new Date(a).getTime());
  });

  it('a lockout expires on its own after the window', () => {
    // No admin intervention needed — the practical guarantee for a judge who
    // gets locked out mid-meet.
    const lockedAt = Date.parse('2026-07-31T18:00:00.000Z');
    const cutoffLater = unlockWindowStart(lockedAt + UNLOCK_WINDOW_MINUTES * 60_000 + 1);
    expect(new Date(cutoffLater).getTime()).toBeGreaterThan(lockedAt);
  });
});
