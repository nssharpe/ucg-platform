import { describe, it, expect } from 'vitest';
import {
  requiredSessionRequests, sessionRequestAnswered, missingSessionRequests,
  missingNationalsSurveyEvents,
  type SessionRequestReg, type ExistingSessionRequest,
  type SessionRequestGateEvent, type SessionRequestGateReg, type SessionRequestGatePerson,
  type ExistingSessionRequestRow,
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

describe('missingNationalsSurveyEvents (A3 checkout-gate mirror)', () => {
  const events: SessionRequestGateEvent[] = [
    { id: 'ev-nat', name: 'Nationals 2026', kind: 'nationals' },
    { id: 'ev-std', name: 'Standard Meet', kind: 'standard' },
  ];

  it('does not gate a non-nationals event even with no surveys at all', () => {
    const regs: SessionRequestGateReg[] = [
      { athleteId: 'a1', clubId: 'club-1', eventId: 'ev-std', discipline: 'WAG', levelId: 'lvl-3' },
    ];
    const people: SessionRequestGatePerson[] = [{ id: 'a1', mainClubId: 'club-1' }];
    expect(missingNationalsSurveyEvents(events, regs, people, [])).toEqual([]);
  });

  it('flags a nationals event when a club-affiliated athlete has no matching club survey', () => {
    const regs: SessionRequestGateReg[] = [
      { athleteId: 'a1', clubId: 'club-1', eventId: 'ev-nat', discipline: 'WAG', levelId: 'lvl-3' },
    ];
    const people: SessionRequestGatePerson[] = [{ id: 'a1', mainClubId: 'club-1' }];
    expect(missingNationalsSurveyEvents(events, regs, people, [])).toEqual([{ eventId: 'ev-nat', eventName: 'Nationals 2026' }]);
  });

  it('does not flag once the club survey for that exact level is answered', () => {
    const regs: SessionRequestGateReg[] = [
      { athleteId: 'a1', clubId: 'club-1', eventId: 'ev-nat', discipline: 'WAG', levelId: 'lvl-3' },
    ];
    const people: SessionRequestGatePerson[] = [{ id: 'a1', mainClubId: 'club-1' }];
    const existing: ExistingSessionRequestRow[] = [
      { eventId: 'ev-nat', clubId: 'club-1', discipline: 'WAG', levelId: 'lvl-3', answers: { arrival: 'Thursday' } },
    ];
    expect(missingNationalsSurveyEvents(events, regs, people, existing)).toEqual([]);
  });

  it('routes an independent athlete (mainClubId null) to the person-scoped survey, not the club one', () => {
    const regs: SessionRequestGateReg[] = [
      { athleteId: 'indie-1', clubId: 'club-1', eventId: 'ev-nat', discipline: 'MAG', levelId: 'lvl-a' },
    ];
    const people: SessionRequestGatePerson[] = [{ id: 'indie-1', mainClubId: null }];
    // A club survey exists but doesn't matter — this athlete needs their OWN
    // person-scoped survey answered, and doesn't have one.
    const existingClubOnly: ExistingSessionRequestRow[] = [
      { eventId: 'ev-nat', clubId: 'club-1', discipline: 'MAG', levelId: null, answers: { arrival: 'Friday' } },
    ];
    expect(missingNationalsSurveyEvents(events, regs, people, existingClubOnly))
      .toEqual([{ eventId: 'ev-nat', eventName: 'Nationals 2026' }]);

    const existingPerson: ExistingSessionRequestRow[] = [
      { eventId: 'ev-nat', personId: 'indie-1', discipline: 'MAG', levelId: null, answers: { arrival: 'Friday' } },
    ];
    expect(missingNationalsSurveyEvents(events, regs, people, existingPerson)).toEqual([]);
  });

  it('treats an athlete missing from `people` as club-scoped (fail-closed default, mirrors the server)', () => {
    const regs: SessionRequestGateReg[] = [
      { athleteId: 'unknown-1', clubId: 'club-1', eventId: 'ev-nat', discipline: 'TNT', levelId: 'lvl-z' },
    ];
    expect(missingNationalsSurveyEvents(events, regs, [], [])).toEqual([{ eventId: 'ev-nat', eventName: 'Nationals 2026' }]);
    const existing: ExistingSessionRequestRow[] = [
      { eventId: 'ev-nat', clubId: 'club-1', discipline: 'TNT', levelId: null, answers: { arrival: 'Tuesday' } },
    ];
    expect(missingNationalsSurveyEvents(events, regs, [], existing)).toEqual([]);
  });

  it('ignores a refunded incoming reg entirely', () => {
    const regs: SessionRequestGateReg[] = [
      { athleteId: 'a1', clubId: 'club-1', eventId: 'ev-nat', discipline: 'WAG', levelId: 'lvl-9', refunded: true },
    ];
    const people: SessionRequestGatePerson[] = [{ id: 'a1', mainClubId: 'club-1' }];
    expect(missingNationalsSurveyEvents(events, regs, people, [])).toEqual([]);
  });
});
