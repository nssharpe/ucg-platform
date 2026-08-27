import { describe, it, expect } from 'vitest';
import { deriveEventPhase, eventIsInPhase, canStillEditRegistration, toDatetimeLocalValue, eventIsRefundEligible, scoringConfigOf, DEFAULT_SCORING_CONFIG, eventRowActions, type EventPhaseInput } from '../../src/lib/events-core';

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

describe('canStillEditRegistration (B4.2)', () => {
  it('no lastDateToEdit ⇒ always editable, for anyone', () => {
    expect(canStillEditRegistration({ lastDateToEdit: null }, false)).toBe(true);
    expect(canStillEditRegistration({}, false)).toBe(true);
  });

  it('before the deadline, anyone can edit', () => {
    const ev = { lastDateToEdit: '2026-06-01T00:00:00' };
    expect(canStillEditRegistration(ev, false, new Date('2026-05-01'))).toBe(true);
  });

  it('exactly at the deadline, still editable (inclusive)', () => {
    const ev = { lastDateToEdit: '2026-06-01T00:00:00' };
    expect(canStillEditRegistration(ev, false, new Date('2026-06-01T00:00:00'))).toBe(true);
  });

  it('past the deadline, a plain member/other-club manager is locked out', () => {
    const ev = { lastDateToEdit: '2026-06-01T00:00:00' };
    expect(canStillEditRegistration(ev, false, new Date('2026-06-02'))).toBe(false);
  });

  it('past the deadline, an admin or the host club (bypasses=true) can still edit', () => {
    const ev = { lastDateToEdit: '2026-06-01T00:00:00' };
    expect(canStillEditRegistration(ev, true, new Date('2026-06-02'))).toBe(true);
  });
});

describe('toDatetimeLocalValue (event-edit datetime-local round-trip)', () => {
  it('strips a trailing Z and seconds from a stored timestamptz (the Bug A repro)', () => {
    // PostgREST returns reg_opens as e.g. "2026-02-01T12:00:00Z"; datetime-local
    // blanks any value it cannot parse, and a trailing Z makes it invalid.
    expect(toDatetimeLocalValue('2026-02-01T12:00:00Z')).toBe('2026-02-01T12:00');
  });

  it('strips a numeric offset too', () => {
    expect(toDatetimeLocalValue('2026-02-01T12:00:00+00:00')).toBe('2026-02-01T12:00');
  });

  it('handles a space-separated form (raw ::text)', () => {
    expect(toDatetimeLocalValue('2026-02-01 12:00:00+00')).toBe('2026-02-01T12:00');
  });

  it('passes an already-clean minute-precision value through unchanged', () => {
    expect(toDatetimeLocalValue('2026-02-01T12:00')).toBe('2026-02-01T12:00');
  });

  it('returns empty string for null/undefined/empty', () => {
    expect(toDatetimeLocalValue(null)).toBe('');
    expect(toDatetimeLocalValue(undefined)).toBe('');
    expect(toDatetimeLocalValue('')).toBe('');
  });
});

describe('eventIsRefundEligible (event-mgmt v2 Phase 3, spec §H)', () => {
  const clubs = [
    { id: 'club-league', isLeagueHost: true },
    { id: 'club-member', isLeagueHost: false },
    { id: 'club-unset', isLeagueHost: undefined },
  ];

  it('is eligible when the host club has isLeagueHost === true', () => {
    expect(eventIsRefundEligible({ hostClubId: 'club-league' }, clubs)).toBe(true);
  });

  it('is not eligible when the host club has isLeagueHost === false', () => {
    expect(eventIsRefundEligible({ hostClubId: 'club-member' }, clubs)).toBe(false);
  });

  it('is not eligible when the host club has no isLeagueHost value set', () => {
    expect(eventIsRefundEligible({ hostClubId: 'club-unset' }, clubs)).toBe(false);
  });

  it('is not eligible when the host club is not found at all', () => {
    expect(eventIsRefundEligible({ hostClubId: 'club-nonexistent' }, clubs)).toBe(false);
  });

  // PM feedback 2026-07-22: UCG-hosted events (FlipFest/Nationals) no longer
  // require a host club at all — they must stay refund-eligible regardless.
  it('is eligible for a UCG-hosted event with no host club (ucgHosted set, hostClubId empty)', () => {
    expect(eventIsRefundEligible({ hostClubId: '', ucgHosted: 'flipfest' }, clubs)).toBe(true);
  });

  it('is eligible for a UCG-hosted event even if its host club is not a league host', () => {
    expect(eventIsRefundEligible({ hostClubId: 'club-member', ucgHosted: 'nationals' }, clubs)).toBe(true);
  });

  it('non-UCG event with a non-league-host club stays ineligible (unchanged)', () => {
    expect(eventIsRefundEligible({ hostClubId: 'club-member' }, clubs)).toBe(false);
  });
});

describe('scoringConfigOf (per-event scoring config, 2026-07-19)', () => {
  it('defaults to 1 panel / calculator entry when the event has no scoringConfig', () => {
    expect(scoringConfigOf({})).toEqual(DEFAULT_SCORING_CONFIG);
    expect(scoringConfigOf(undefined)).toEqual(DEFAULT_SCORING_CONFIG);
    expect(scoringConfigOf(null)).toEqual(DEFAULT_SCORING_CONFIG);
  });

  it('returns the event-configured value when present', () => {
    expect(scoringConfigOf({ scoringConfig: { panels: 2, entryMode: 'simple' } }))
      .toEqual({ panels: 2, entryMode: 'simple' });
  });
});

describe('eventRowActions (UAT M-01-03, Events-list register/edit entry points)', () => {
  const args = (overrides: Partial<Parameters<typeof eventRowActions>[0]> = {}) => ({
    event: { eventType: 'competition' as const },
    viewer: { signedIn: true, canRegister: false },
    hasReg: false,
    isManager: false,
    isCamp: false,
    ...overrides,
  });

  it('signed out, not a manager ⇒ sign-in hint (UAT G-03)', () => {
    expect(eventRowActions(args({ viewer: { signedIn: false, canRegister: false } }))).toEqual(['sign-in']);
  });

  it('signed in, not eligible, not a manager ⇒ membership hint (UAT G-01)', () => {
    expect(eventRowActions(args())).toEqual(['membership']);
  });

  it('eligible athlete, no existing reg ⇒ self', () => {
    expect(eventRowActions(args({ viewer: { signedIn: true, canRegister: true } }))).toEqual(['self']);
  });

  it('eligible athlete who already has a reg ⇒ edit, not self', () => {
    expect(eventRowActions(args({ viewer: { signedIn: true, canRegister: true }, hasReg: true }))).toEqual(['edit']);
  });

  it('manager of a non-camp event (not personally eligible) ⇒ club only, no membership hint', () => {
    expect(eventRowActions(args({ isManager: true }))).toEqual(['club']);
  });

  it('manager of a CAMP, not personally eligible ⇒ membership hint (camps suppress club, so nothing else applies)', () => {
    expect(eventRowActions(args({ isManager: true, isCamp: true }))).toEqual(['membership']);
  });

  it('eligible athlete who is also a manager, non-camp, no reg ⇒ self then club', () => {
    expect(eventRowActions(args({ viewer: { signedIn: true, canRegister: true }, isManager: true })))
      .toEqual(['self', 'club']);
  });

  it('eligible athlete + manager, already registered, non-camp ⇒ edit then club', () => {
    expect(eventRowActions(args({ viewer: { signedIn: true, canRegister: true }, isManager: true, hasReg: true })))
      .toEqual(['edit', 'club']);
  });

  it('eligible athlete + manager of a camp, already registered ⇒ edit only (club suppressed)', () => {
    expect(eventRowActions(args({ viewer: { signedIn: true, canRegister: true }, isManager: true, hasReg: true, isCamp: true })))
      .toEqual(['edit']);
  });
});
