import { describe, it, expect } from 'vitest';
import {
  registrationEntryFee,
  registrationChangeFee,
  changeIsEligible,
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
    events: ['FX', 'PH'],
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

  it('change a T&T event level via eventLevels → eligible', () => {
    const before = state({
      disciplines: [disc({ discipline: 'TNT', events: ['TR', 'DMT'], eventLevels: { TR: 'L3', DMT: 'L3' } })],
    });
    const after = state({
      disciplines: [disc({ discipline: 'TNT', events: ['TR', 'DMT'], eventLevels: { TR: 'L4', DMT: 'L3' } })],
    });
    expect(changeIsEligible(before, after)).toBe(true);
  });

  it('add a NEW eventLevels key (event-level set where none before) → eligible', () => {
    const before = state({
      disciplines: [disc({ discipline: 'TNT', events: ['TR'], eventLevels: {} })],
    });
    const after = state({
      disciplines: [disc({ discipline: 'TNT', events: ['TR'], eventLevels: { TR: 'L4' } })],
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
    const after = state({ disciplines: [disc({ events: ['FX', 'PH', 'SR'] })] });
    expect(changeIsEligible(state(), after)).toBe(false);
  });

  it('remove an apparatus within an existing discipline → NOT eligible', () => {
    const after = state({ disciplines: [disc({ events: ['FX'] })] });
    expect(changeIsEligible(state(), after)).toBe(false);
  });

  it('combo: apparatus change + level change → eligible', () => {
    const after = state({ disciplines: [disc({ levelId: 'L6', events: ['FX'] })] });
    expect(changeIsEligible(state(), after)).toBe(true);
  });

  it('combo: apparatus add + discipline removed (no other eligible change) → NOT eligible', () => {
    const before = state({
      disciplines: [disc(), disc({ discipline: 'WAG', levelId: 'L4' })],
    });
    const after = state({ disciplines: [disc({ events: ['FX', 'PH', 'SR'] })] });
    expect(changeIsEligible(before, after)).toBe(false);
  });

  it('reordering events (same set/level) → NOT eligible', () => {
    const after = state({ disciplines: [disc({ events: ['PH', 'FX'] })] });
    expect(changeIsEligible(state(), after)).toBe(false);
  });
});
