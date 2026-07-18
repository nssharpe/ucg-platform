import { describe, it, expect } from 'vitest';
import { shouldRefetchOnFocus, REFRESH_THRESHOLD_MS, type ShouldRefetchInput } from '../src/lib/focus-refresh';

const NOW = 1_000_000;

function baseInput(overrides: Partial<ShouldRefetchInput> = {}): ShouldRefetchInput {
  return {
    hiddenAtMs: NOW - REFRESH_THRESHOLD_MS - 1,
    nowMs: NOW,
    lastSyncMs: NOW - REFRESH_THRESHOLD_MS - 1,
    queueIdle: true,
    online: true,
    configured: true,
    ...overrides,
  };
}

describe('shouldRefetchOnFocus', () => {
  it('returns false when the away period was too short', () => {
    const input = baseInput({ hiddenAtMs: NOW - 10_000 });
    expect(shouldRefetchOnFocus(input)).toBe(false);
  });

  it('returns true after a long enough away period and a stale last sync', () => {
    const input = baseInput({
      hiddenAtMs: NOW - REFRESH_THRESHOLD_MS - 5_000,
      lastSyncMs: NOW - REFRESH_THRESHOLD_MS - 5_000,
    });
    expect(shouldRefetchOnFocus(input)).toBe(true);
  });

  it('returns false when the away period is long but the last sync was recent', () => {
    const input = baseInput({
      hiddenAtMs: NOW - REFRESH_THRESHOLD_MS - 5_000,
      lastSyncMs: NOW - 1_000,
    });
    expect(shouldRefetchOnFocus(input)).toBe(false);
  });

  it('returns false when the write-queue is busy', () => {
    const input = baseInput({ queueIdle: false });
    expect(shouldRefetchOnFocus(input)).toBe(false);
  });

  it('returns false when offline', () => {
    const input = baseInput({ online: false });
    expect(shouldRefetchOnFocus(input)).toBe(false);
  });

  it('returns false when Supabase is not configured', () => {
    const input = baseInput({ configured: false });
    expect(shouldRefetchOnFocus(input)).toBe(false);
  });

  it('returns false with no recorded away time (never went away)', () => {
    const input = baseInput({ hiddenAtMs: null });
    expect(shouldRefetchOnFocus(input)).toBe(false);
  });

  it('treats never-synced (lastSyncMs null) as stale enough to refetch', () => {
    const input = baseInput({
      hiddenAtMs: NOW - REFRESH_THRESHOLD_MS - 5_000,
      lastSyncMs: null,
    });
    expect(shouldRefetchOnFocus(input)).toBe(true);
  });

  it('handles the online-event path: a long offline stretch followed by reconnect triggers a refetch', () => {
    // Simulates window 'offline' marking the away time, then window 'online'
    // firing the check once connectivity (and the drained write-queue) is
    // back — same pure decision, just exercised via the offline/online axis
    // rather than tab visibility.
    const wentOfflineAt = NOW - REFRESH_THRESHOLD_MS - 30_000;
    const input = baseInput({
      hiddenAtMs: wentOfflineAt,
      lastSyncMs: wentOfflineAt,
      online: true, // reconnected by the time the 'online' handler runs the check
      queueIdle: true,
    });
    expect(shouldRefetchOnFocus(input)).toBe(true);
  });

  it('online-event path: still offline at check time never refetches', () => {
    const input = baseInput({ online: false });
    expect(shouldRefetchOnFocus(input)).toBe(false);
  });
});
