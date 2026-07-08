import { describe, it, expect } from 'vitest';
import {
  registrationEntryFee,
  registrationChangeFee,
  changeIsEligible,
  regChangeHasDiff,
  newRegistrationEntryTotal,
  lateFeeApplies,
  lateFeeAnchor,
  type RegFeeEvent,
  type RegChangeState,
  type RegDisciplineEntry,
} from '../../src/lib/pricing';

// --- Fixtures ---------------------------------------------------------------

const event: RegFeeEvent = {
  hostClubId: 'host-club',
  entryFee: 40,
  secondDisciplineFee: 25,
  changeFee: { amount: 15, startsAt: '2026-01-01T00:00:00Z' },
};

function disc(overrides: Partial<RegDisciplineEntry> = {}): RegDisciplineEntry {
  return {
    discipline: 'MAG',
    levelId: 'L5',
    apparatus: ['FX', 'PH'],
    ...overrides,
  };
}

function state(overrides: Partial<RegChangeState> = {}): RegChangeState {
  return {
    clubId: 'club-a',
    athleteId: 'ath-1',
    disciplines: [disc()],
    ...overrides,
  };
}

// --- 3g: registration fees --------------------------------------------------

describe('registrationEntryFee (3g)', () => {
  it('charges base entry fee for a non-host club', () => {
    expect(registrationEntryFee(event, { competingClubId: 'club-a' })).toBe(40);
  });

  it('charges second-discipline fee for a non-host club second discipline', () => {
    expect(
      registrationEntryFee(event, { competingClubId: 'club-a', isSecondDiscipline: true }),
    ).toBe(25);
  });

  it('is $0 for the host club (base entry)', () => {
    expect(registrationEntryFee(event, { competingClubId: 'host-club' })).toBe(0);
  });

  it('is $0 for the host club even as a second discipline', () => {
    expect(
      registrationEntryFee(event, { competingClubId: 'host-club', isSecondDiscipline: true }),
    ).toBe(0);
  });

  it('defaults isSecondDiscipline to false', () => {
    expect(registrationEntryFee(event, { competingClubId: 'club-a' })).toBe(40);
  });
});

describe('registrationChangeFee (3g)', () => {
  it('charges the configured change fee for a non-host club', () => {
    expect(registrationChangeFee(event, { competingClubId: 'club-a' })).toBe(15);
  });

  it('is $0 for the host club', () => {
    expect(registrationChangeFee(event, { competingClubId: 'host-club' })).toBe(0);
  });

  it('is $0 when the event has no change fee configured (non-host)', () => {
    const noFee: RegFeeEvent = { ...event, changeFee: undefined };
    expect(registrationChangeFee(noFee, { competingClubId: 'club-a' })).toBe(0);
  });
});

// --- emv2 P0 Task 3: late-registration fee behavior --------------------------

const lateEvent: RegFeeEvent = {
  ...event,
  lateReg: { startsAt: '2026-06-01T00:00:00Z', fee: 10 },
};

describe('lateFeeApplies', () => {
  it('is false with no lateReg configured', () => {
    expect(lateFeeApplies({ lateReg: undefined }, '2026-06-01T00:00:00Z')).toBe(false);
  });

  it('is false before the window', () => {
    expect(lateFeeApplies(lateEvent, '2026-05-31T23:59:59Z')).toBe(false);
  });

  it('is true exactly at the startsAt boundary (>= applies)', () => {
    expect(lateFeeApplies(lateEvent, '2026-06-01T00:00:00Z')).toBe(true);
  });

  it('is true after the window', () => {
    expect(lateFeeApplies(lateEvent, '2026-07-01T00:00:00Z')).toBe(true);
  });
});

describe('lateFeeAnchor — surcharge attaches only to the line containing the earliest reg', () => {
  const NOW = '2026-06-15T12:00:00Z'; // inside lateEvent's window

  it('empty line ⇒ null', () => {
    expect(lateFeeAnchor([], [{ id: 'a', createdAt: '2026-06-02T00:00:00Z' }], NOW)).toBe(null);
  });

  it('no outside regs ⇒ anchor is the line earliest (missing createdAt sorts as now)', () => {
    expect(lateFeeAnchor([{ id: 'a' }], [], NOW)).toBe(NOW);
    expect(lateFeeAnchor([{ id: 'a', createdAt: '2026-06-02T00:00:00Z' }, { id: 'b' }], [], NOW))
      .toBe('2026-06-02T00:00:00Z');
  });

  it('repeat purchase: earliest reg already purchased outside the line ⇒ null (no re-surcharge)', () => {
    // Athlete registered discipline A late (paid entry + late fee), later adds B.
    const anchor = lateFeeAnchor(
      [{ id: 'b', createdAt: '2026-06-20T00:00:00Z' }],
      [{ id: 'a', createdAt: '2026-06-02T00:00:00Z' }],
      NOW,
    );
    expect(anchor).toBe(null);
  });

  it('two saves into one cart: surcharge exactly once (line 1 yes, line 2 no)', () => {
    const line1 = lateFeeAnchor([{ id: 'a', createdAt: '2026-06-10T00:00:00Z' }], [], NOW);
    expect(line1).toBe('2026-06-10T00:00:00Z');
    expect(lateFeeApplies(lateEvent, line1!)).toBe(true);
    const line2 = lateFeeAnchor(
      [{ id: 'b', createdAt: '2026-06-10T00:05:00Z' }],
      [{ id: 'a', createdAt: '2026-06-10T00:00:00Z' }],
      NOW,
    );
    expect(line2).toBe(null);
  });

  it('on-time original + late addition ⇒ line 2 gets null; line 1 anchor is pre-window (no fee either way)', () => {
    const line2 = lateFeeAnchor(
      [{ id: 'b', createdAt: '2026-06-20T00:00:00Z' }],
      [{ id: 'a', createdAt: '2026-05-01T00:00:00Z' }],
      NOW,
    );
    expect(line2).toBe(null);
    // And had the first line been priced, its anchor is pre-window ⇒ no fee.
    expect(lateFeeApplies(lateEvent, '2026-05-01T00:00:00Z')).toBe(false);
  });

  it('equal timestamps tie-break by reg id — exactly one line qualifies', () => {
    const t = '2026-06-10T00:00:00Z';
    const aLine = lateFeeAnchor([{ id: 'a', createdAt: t }], [{ id: 'b', createdAt: t }], NOW);
    const bLine = lateFeeAnchor([{ id: 'b', createdAt: t }], [{ id: 'a', createdAt: t }], NOW);
    expect(aLine).toBe(t);   // 'a' < 'b' ⇒ the line holding 'a' wins
    expect(bLine).toBe(null);
  });

  it('outside reg missing createdAt (unsynced local row) ⇒ null (fail toward not surcharging)', () => {
    expect(lateFeeAnchor([{ id: 'b', createdAt: '2026-06-20T00:00:00Z' }], [{ id: 'a' }], NOW)).toBe(null);
  });
});

describe('newRegistrationEntryTotal — late-registration surcharge (Task 3)', () => {
  it('no late param ⇒ unaffected (pre-Task-3 behavior preserved)', () => {
    expect(
      newRegistrationEntryTotal(lateEvent, {
        competingClubId: 'club-a', priorDisciplineCount: 0, newDisciplineCount: 1,
      }),
    ).toBe(40);
  });

  it('registered before the window ⇒ no surcharge', () => {
    expect(
      newRegistrationEntryTotal(lateEvent, {
        competingClubId: 'club-a', priorDisciplineCount: 0, newDisciplineCount: 1,
        late: { earliestCreatedAtISO: '2026-05-01T00:00:00Z' },
      }),
    ).toBe(40);
  });

  it('registered exactly at the startsAt boundary ⇒ surcharge applies (>=)', () => {
    expect(
      newRegistrationEntryTotal(lateEvent, {
        competingClubId: 'club-a', priorDisciplineCount: 0, newDisciplineCount: 1,
        late: { earliestCreatedAtISO: '2026-06-01T00:00:00Z' },
      }),
    ).toBe(50); // 40 entry + 10 late fee
  });

  it('registered after the window ⇒ surcharge applies', () => {
    expect(
      newRegistrationEntryTotal(lateEvent, {
        competingClubId: 'club-a', priorDisciplineCount: 0, newDisciplineCount: 1,
        late: { earliestCreatedAtISO: '2026-07-01T00:00:00Z' },
      }),
    ).toBe(50);
  });

  it('no lateReg configured on the event ⇒ never surcharged, even late', () => {
    expect(
      newRegistrationEntryTotal(event, {
        competingClubId: 'club-a', priorDisciplineCount: 0, newDisciplineCount: 1,
        late: { earliestCreatedAtISO: '2026-12-01T00:00:00Z' },
      }),
    ).toBe(40);
  });

  it('host club stays $0 even when registering late', () => {
    expect(
      newRegistrationEntryTotal(lateEvent, {
        competingClubId: 'host-club', priorDisciplineCount: 0, newDisciplineCount: 1,
        late: { earliestCreatedAtISO: '2026-07-01T00:00:00Z' },
      }),
    ).toBe(0);
  });

  it('second discipline added late, but ORIGINAL reg predates the window ⇒ NOT surcharged (once per athlete, anchored on earliest)', () => {
    // The athlete's earliest reg for this event was created before the window —
    // that's the anchor passed by the caller, even though this call is pricing
    // a second discipline being added right now (isSecond via priorDisciplineCount=1).
    expect(
      newRegistrationEntryTotal(lateEvent, {
        competingClubId: 'club-a', priorDisciplineCount: 1, newDisciplineCount: 1,
        late: { earliestCreatedAtISO: '2026-05-01T00:00:00Z' },
      }),
    ).toBe(25); // second-discipline fee only, no late fee
  });

  it('all disciplines registered together inside the late window ⇒ surcharge applied ONCE, not per-discipline', () => {
    const total = newRegistrationEntryTotal(lateEvent, {
      competingClubId: 'club-a', priorDisciplineCount: 0, newDisciplineCount: 2,
      late: { earliestCreatedAtISO: '2026-07-01T00:00:00Z' },
    });
    // 40 (first) + 25 (second) + 10 (late fee, once) = 75 — NOT 40+10 + 25+10.
    expect(total).toBe(75);
  });

  it('fee of 0 is a no-op even when the window applies', () => {
    const zeroFeeEvent: RegFeeEvent = { ...event, lateReg: { startsAt: '2026-06-01T00:00:00Z', fee: 0 } };
    expect(
      newRegistrationEntryTotal(zeroFeeEvent, {
        competingClubId: 'club-a', priorDisciplineCount: 0, newDisciplineCount: 1,
        late: { earliestCreatedAtISO: '2026-07-01T00:00:00Z' },
      }),
    ).toBe(40);
  });
});

describe('registrationEntryFee — late-registration surcharge (Task 3)', () => {
  it('adds the late fee to the base entry fee when registered inside the window', () => {
    expect(
      registrationEntryFee(lateEvent, {
        competingClubId: 'club-a',
        late: { earliestCreatedAtISO: '2026-07-01T00:00:00Z' },
      }),
    ).toBe(50);
  });

  it('adds the late fee to the second-discipline fee too', () => {
    expect(
      registrationEntryFee(lateEvent, {
        competingClubId: 'club-a', isSecondDiscipline: true,
        late: { earliestCreatedAtISO: '2026-07-01T00:00:00Z' },
      }),
    ).toBe(35); // 25 + 10
  });

  it('host club stays $0 even late', () => {
    expect(
      registrationEntryFee(lateEvent, {
        competingClubId: 'host-club',
        late: { earliestCreatedAtISO: '2026-07-01T00:00:00Z' },
      }),
    ).toBe(0);
  });
});

// --- 3h: change-fee eligibility ---------------------------------------------

describe('changeIsEligible (3h)', () => {
  it('no change at all → NOT eligible', () => {
    expect(changeIsEligible(state(), state())).toBe(false);
  });

  it('add a discipline → eligible', () => {
    const after = state({ disciplines: [disc(), disc({ discipline: 'WAG', levelId: 'L4' })] });
    expect(changeIsEligible(state(), after)).toBe(true);
  });

  it('remove a discipline → NOT eligible on its own', () => {
    const before = state({
      disciplines: [disc(), disc({ discipline: 'WAG', levelId: 'L4' })],
    });
    const after = state({ disciplines: [disc()] });
    expect(changeIsEligible(before, after)).toBe(false);
  });

  it('change discipline-level (MAG/WAG levelId) → eligible', () => {
    const after = state({ disciplines: [disc({ levelId: 'L6' })] });
    expect(changeIsEligible(state(), after)).toBe(true);
  });

  it('change a T&T event level via apparatusLevels → eligible', () => {
    const before = state({
      disciplines: [disc({ discipline: 'TNT', apparatus: ['TR', 'DMT'], apparatusLevels: { TR: 'L3', DMT: 'L3' } })],
    });
    const after = state({
      disciplines: [disc({ discipline: 'TNT', apparatus: ['TR', 'DMT'], apparatusLevels: { TR: 'L4', DMT: 'L3' } })],
    });
    expect(changeIsEligible(before, after)).toBe(true);
  });

  it('add a NEW apparatusLevels key (event-level set where none before) → eligible', () => {
    const before = state({
      disciplines: [disc({ discipline: 'TNT', apparatus: ['TR'], apparatusLevels: {} })],
    });
    const after = state({
      disciplines: [disc({ discipline: 'TNT', apparatus: ['TR'], apparatusLevels: { TR: 'L4' } })],
    });
    expect(changeIsEligible(before, after)).toBe(true);
  });

  it('change club → eligible', () => {
    expect(changeIsEligible(state(), state({ clubId: 'club-b' }))).toBe(true);
  });

  it('swap athlete → eligible', () => {
    expect(changeIsEligible(state(), state({ athleteId: 'ath-2' }))).toBe(true);
  });

  it('add an apparatus within an existing discipline → NOT eligible', () => {
    const after = state({ disciplines: [disc({ apparatus: ['FX', 'PH', 'SR'] })] });
    expect(changeIsEligible(state(), after)).toBe(false);
  });

  it('remove an apparatus within an existing discipline → NOT eligible', () => {
    const after = state({ disciplines: [disc({ apparatus: ['FX'] })] });
    expect(changeIsEligible(state(), after)).toBe(false);
  });

  it('combo: apparatus change + level change → eligible', () => {
    const after = state({ disciplines: [disc({ levelId: 'L6', apparatus: ['FX'] })] });
    expect(changeIsEligible(state(), after)).toBe(true);
  });

  it('combo: apparatus add + discipline removed (no other eligible change) → NOT eligible', () => {
    const before = state({
      disciplines: [disc(), disc({ discipline: 'WAG', levelId: 'L4' })],
    });
    const after = state({ disciplines: [disc({ apparatus: ['FX', 'PH', 'SR'] })] });
    expect(changeIsEligible(before, after)).toBe(false);
  });

  it('reordering events (same set/level) → NOT eligible', () => {
    const after = state({ disciplines: [disc({ apparatus: ['PH', 'FX'] })] });
    expect(changeIsEligible(state(), after)).toBe(false);
  });
});

// --- B8: regChangeHasDiff (gates the free "Save" button) --------------------

describe('regChangeHasDiff (B8)', () => {
  it('no change at all → no diff', () => {
    expect(regChangeHasDiff(state(), state())).toBe(false);
  });

  it('reordering apparatus (same set/level) → no diff', () => {
    const after = state({ disciplines: [disc({ apparatus: ['PH', 'FX'] })] });
    expect(regChangeHasDiff(state(), after)).toBe(false);
  });

  it('add an apparatus within an existing discipline → diff (free save)', () => {
    const after = state({ disciplines: [disc({ apparatus: ['FX', 'PH', 'SR'] })] });
    expect(regChangeHasDiff(state(), after)).toBe(true);
  });

  it('remove an apparatus within an existing discipline → diff (free save)', () => {
    const after = state({ disciplines: [disc({ apparatus: ['FX'] })] });
    expect(regChangeHasDiff(state(), after)).toBe(true);
  });

  it('remove a discipline entirely → diff (free save)', () => {
    const before = state({
      disciplines: [disc(), disc({ discipline: 'WAG', levelId: 'L4' })],
    });
    const after = state({ disciplines: [disc()] });
    expect(regChangeHasDiff(before, after)).toBe(true);
  });

  it('add a discipline → diff', () => {
    const after = state({ disciplines: [disc(), disc({ discipline: 'WAG', levelId: 'L4' })] });
    expect(regChangeHasDiff(state(), after)).toBe(true);
  });

  it('change level → diff', () => {
    const after = state({ disciplines: [disc({ levelId: 'L6' })] });
    expect(regChangeHasDiff(state(), after)).toBe(true);
  });

  it('change club → diff', () => {
    expect(regChangeHasDiff(state(), state({ clubId: 'club-b' }))).toBe(true);
  });

  it('swap athlete → diff', () => {
    expect(regChangeHasDiff(state(), state({ athleteId: 'ath-2' }))).toBe(true);
  });

  it('every case eligible per changeIsEligible also has a diff (hasChange is a superset)', () => {
    const cases: [RegChangeState, RegChangeState][] = [
      [state(), state({ disciplines: [disc(), disc({ discipline: 'WAG', levelId: 'L4' })] })],
      [state(), state({ disciplines: [disc({ levelId: 'L6' })] })],
      [state(), state({ clubId: 'club-b' })],
      [state(), state({ athleteId: 'ath-2' })],
    ];
    for (const [before, after] of cases) {
      expect(changeIsEligible(before, after)).toBe(true);
      expect(regChangeHasDiff(before, after)).toBe(true);
    }
  });
});
