import { describe, it, expect } from 'vitest';
import { deriveEventPhase, eventIsInPhase, type EventPhaseInput } from '../../src/lib/events-core';

function event(overrides: Partial<EventPhaseInput> = {}): EventPhaseInput {
  return {
    regOpens: '2026-01-01T00:00:00',
    regCloses: '2026-02-01T00:00:00',
    startDate: '2026-03-01',
    endDate: '2026-03-02',
    ...overrides,
  };
}

describe('deriveEventPhase (B4)', () => {
  it('before regOpens reads as reg-closed (not yet open, same gating as closed)', () => {
    expect(deriveEventPhase(event(), new Date('2025-12-01'))).toBe('reg-closed');
  });

  it('between regOpens and regCloses is reg-open', () => {
    expect(deriveEventPhase(event(), new Date('2026-01-15'))).toBe('reg-open');
  });

  it('exactly at regOpens is reg-open (inclusive)', () => {
    expect(deriveEventPhase(event(), new Date('2026-01-01T00:00:00'))).toBe('reg-open');
  });

  it('after regCloses but before startDate is reg-closed', () => {
    expect(deriveEventPhase(event(), new Date('2026-02-15'))).toBe('reg-closed');
  });

  it('exactly at regCloses is still reg-open (inclusive close boundary)', () => {
    expect(deriveEventPhase(event(), new Date('2026-02-01T00:00:00'))).toBe('reg-open');
  });

  it('on startDate is in-progress, even if regCloses is still in the future', () => {
    expect(deriveEventPhase(event({ regCloses: '2026-12-01T00:00:00' }), new Date('2026-03-01T08:00:00'))).toBe('in-progress');
  });

  it('on endDate (any time of day) is still in-progress', () => {
    expect(deriveEventPhase(event(), new Date('2026-03-02T23:00:00'))).toBe('in-progress');
  });

  it('the day after endDate is complete', () => {
    expect(deriveEventPhase(event(), new Date('2026-03-03T00:00:01'))).toBe('complete');
  });

  it('a single-day event: startDate === endDate', () => {
    const e = event({ startDate: '2026-03-01', endDate: '2026-03-01' });
    expect(deriveEventPhase(e, new Date('2026-03-01T12:00:00'))).toBe('in-progress');
    expect(deriveEventPhase(e, new Date('2026-03-02T00:00:01'))).toBe('complete');
  });
});

describe('eventIsInPhase', () => {
  it('a draft event is never in any phase, even if its dates say reg-open', () => {
    const e = { status: 'draft', ...event() };
    expect(eventIsInPhase(e, 'reg-open', new Date('2026-01-15'))).toBe(false);
    expect(eventIsInPhase(e, 'reg-closed', new Date('2026-01-15'))).toBe(false);
  });

  it('a live event matches its derived phase', () => {
    const e = { status: 'live', ...event() };
    expect(eventIsInPhase(e, 'reg-open', new Date('2026-01-15'))).toBe(true);
    expect(eventIsInPhase(e, 'in-progress', new Date('2026-01-15'))).toBe(false);
  });
});
