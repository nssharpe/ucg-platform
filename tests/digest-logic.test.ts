import { describe, it, expect } from 'vitest';
import { digestDateKey, isDigestFireWindow, digestWindowStart, isStuckPayment } from '../supabase/functions/_shared/digest-logic';

describe('digestDateKey', () => {
  it('extracts the UTC calendar date from an ISO instant', () => {
    expect(digestDateKey('2026-07-17T13:05:00.000Z')).toBe('2026-07-17');
  });

  it('differs across a UTC day boundary', () => {
    expect(digestDateKey('2026-07-17T23:59:59.999Z')).toBe('2026-07-17');
    expect(digestDateKey('2026-07-18T00:00:00.000Z')).toBe('2026-07-18');
  });
});

describe('isDigestFireWindow', () => {
  it('is false before 13:00 UTC', () => {
    expect(isDigestFireWindow('2026-07-17T00:00:00Z')).toBe(false);
    expect(isDigestFireWindow('2026-07-17T12:59:59.999Z')).toBe(false);
  });

  it('is true exactly at 13:00 UTC', () => {
    expect(isDigestFireWindow('2026-07-17T13:00:00Z')).toBe(true);
  });

  it('is true anywhere after 13:00 UTC', () => {
    expect(isDigestFireWindow('2026-07-17T23:59:59.999Z')).toBe(true);
  });

  it('is false for an invalid instant', () => {
    expect(isDigestFireWindow('not-a-date')).toBe(false);
  });
});

describe('digestWindowStart', () => {
  it('uses the previous digest send time when present', () => {
    expect(digestWindowStart('2026-07-17T13:00:00Z', '2026-07-16T13:02:00Z')).toBe('2026-07-16T13:02:00Z');
  });

  it('falls back to 24h before now when there is no previous send', () => {
    expect(digestWindowStart('2026-07-17T13:00:00.000Z', null)).toBe('2026-07-16T13:00:00.000Z');
  });

  it('falls back to 24h before now when the previous send time is undefined', () => {
    expect(digestWindowStart('2026-07-17T13:00:00.000Z', undefined)).toBe('2026-07-16T13:00:00.000Z');
  });

  it('falls back to 24h before now when the previous send time is invalid', () => {
    expect(digestWindowStart('2026-07-17T13:00:00.000Z', 'not-a-date')).toBe('2026-07-16T13:00:00.000Z');
  });
});

describe('isStuckPayment', () => {
  const now = '2026-07-17T13:00:00Z';

  it('is false for a non-pending payment regardless of age', () => {
    expect(isStuckPayment(now, '2026-07-17T00:00:00Z', 'paid')).toBe(false);
    expect(isStuckPayment(now, '2026-07-17T00:00:00Z', 'failed')).toBe(false);
  });

  it('is false for a pending payment created less than 1h ago', () => {
    expect(isStuckPayment(now, '2026-07-17T12:30:00Z', 'pending')).toBe(false);
  });

  it('is false for a pending payment created exactly 1h ago', () => {
    expect(isStuckPayment(now, '2026-07-17T12:00:00Z', 'pending')).toBe(false);
  });

  it('is true for a pending payment created more than 1h ago', () => {
    expect(isStuckPayment(now, '2026-07-17T11:59:59.999Z', 'pending')).toBe(true);
  });

  it('is true for a pending payment created long ago', () => {
    expect(isStuckPayment(now, '2026-07-01T00:00:00Z', 'pending')).toBe(true);
  });

  it('is false when inputs are not valid dates', () => {
    expect(isStuckPayment('not-a-date', '2026-07-17T00:00:00Z', 'pending')).toBe(false);
    expect(isStuckPayment(now, 'not-a-date', 'pending')).toBe(false);
  });
});
