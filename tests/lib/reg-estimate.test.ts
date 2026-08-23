import { describe, it, expect } from 'vitest';
import { registrationEstimate, registrationEstimateLabel } from '../../src/lib/reg-estimate';
import type { RegEstimateInput } from '../../src/lib/reg-estimate';
import type { RegFeeEvent } from '../../src/lib/pricing';

const event: RegFeeEvent = {
  hostClubId: 'host-club',
  entryFee: 40,
  secondDisciplineFee: 25,
  changeFee: { amount: 15, startsAt: '2026-01-01T00:00:00Z' },
};

/** Defaults for the common case, so each test states only what it varies.
 *  `changeFeeApplies: true` = the event's change-fee window has opened. */
const base: Omit<RegEstimateInput, 'event'> = {
  competingClubId: 'club-a',
  isEditingExisting: false,
  eligible: true,
  changeFeeApplies: true,
  newDisciplineCount: 1,
  priorDisciplineCount: 0,
};
const est = (over: Partial<RegEstimateInput> & { event?: RegFeeEvent } = {}) =>
  registrationEstimate({ event, ...base, ...over });

describe('registrationEstimate — new registration', () => {
  it('one discipline: estimated entry fee', () => {
    const e = est();
    expect(e).toEqual({ kind: 'new-entry', amountDollars: 40 });
    expect(registrationEstimateLabel(e)).toBe('Estimated entry fee: $40 — added to your cart on save');
  });

  it('two disciplines: base + second-discipline fee summed', () => {
    expect(est({ newDisciplineCount: 2 })).toEqual({ kind: 'new-entry', amountDollars: 65 });
  });

  it('nothing selected yet: no charge', () => {
    expect(est({ newDisciplineCount: 0 })).toEqual({ kind: 'no-charge' });
  });

  it('host club: free regardless of discipline count', () => {
    const e = est({ competingClubId: 'host-club', newDisciplineCount: 2 });
    expect(e).toEqual({ kind: 'host-free' });
    expect(registrationEstimateLabel(e)).toBe('Free — host club');
  });

  it('empty hostClubId never matches an equally-empty competingClubId', () => {
    expect(est({ event: { ...event, hostClubId: '' }, competingClubId: '' }).kind).toBe('new-entry');
  });

  it('camp: flat entry fee, no second-discipline fee', () => {
    const camp: RegFeeEvent = { hostClubId: 'host-club', entryFee: 75, secondDisciplineFee: 0 };
    expect(est({ event: camp })).toEqual({ kind: 'new-entry', amountDollars: 75 });
  });
});

describe('registrationEstimate — editing an existing registration', () => {
  it('eligible change inside the change-fee window: change fee', () => {
    const e = est({ isEditingExisting: true, newDisciplineCount: 0, priorDisciplineCount: 1 });
    expect(e).toEqual({ kind: 'change-fee', amountDollars: 15 });
    expect(registrationEstimateLabel(e)).toBe('Change fee: $15 will be added to your cart');
  });

  it('NOT eligible (e.g. apparatus tweak): no charge', () => {
    const e = est({ isEditingExisting: true, eligible: false, newDisciplineCount: 0, priorDisciplineCount: 1 });
    expect(e).toEqual({ kind: 'no-charge' });
    expect(registrationEstimateLabel(e)).toBe('No charge for this change');
  });

  it('host club wins over an eligible change', () => {
    expect(est({ competingClubId: 'host-club', isEditingExisting: true, newDisciplineCount: 0 }))
      .toEqual({ kind: 'host-free' });
  });

  // --- The regression this module's header is about (S5 controller review) ---
  // Club.tsx saveRegs: `else if (!changeFeeApplies && entryTotal > 0)` bills
  // newly-added disciplines as an ENTRY fee when the change-fee window is shut.
  it('window CLOSED + discipline added: ENTRY fee at the second-discipline rate, NOT "no charge"', () => {
    const e = est({
      isEditingExisting: true, changeFeeApplies: false,
      newDisciplineCount: 1, priorDisciplineCount: 1,
    });
    // priorDisciplineCount > 0 ⇒ the added one is a SECOND discipline ($25), not $40.
    expect(e).toEqual({ kind: 'new-entry', amountDollars: 25 });
  });

  it('window OPEN + discipline added: change fee PLUS the added discipline\'s entry total, not the change fee alone (UAT M-10-01)', () => {
    // Second-discipline fee (25, since priorDisciplineCount is 1) + change fee
    // (15) = 40 — previously this returned just the $15 change fee, silently
    // dropping the entry-total owed for the newly added discipline.
    expect(est({
      isEditingExisting: true, changeFeeApplies: true,
      newDisciplineCount: 1, priorDisciplineCount: 1,
    })).toEqual({ kind: 'change-fee', amountDollars: 40 });
  });

  it('UAT M-10-01 worked example: entryFee 60 / secondDisciplineFee 30 / changeFee 15, one paid discipline + one added → $45', () => {
    const uatEvent: RegFeeEvent = {
      hostClubId: 'host-club', entryFee: 60, secondDisciplineFee: 30,
      changeFee: { amount: 15, startsAt: '2026-01-01T00:00:00Z' },
    };
    expect(est({
      event: uatEvent, isEditingExisting: true, changeFeeApplies: true,
      newDisciplineCount: 1, priorDisciplineCount: 1,
    })).toEqual({ kind: 'change-fee', amountDollars: 45 });
  });

  it('window OPEN + a pure edit (no discipline added): change fee alone, unchanged', () => {
    expect(est({
      isEditingExisting: true, changeFeeApplies: true,
      newDisciplineCount: 0, priorDisciplineCount: 1,
    })).toEqual({ kind: 'change-fee', amountDollars: 15 });
  });

  it('host-club athlete adding a discipline mid-edit: still free, never combined', () => {
    expect(est({
      competingClubId: 'host-club', isEditingExisting: true, changeFeeApplies: true,
      newDisciplineCount: 1, priorDisciplineCount: 1,
    })).toEqual({ kind: 'host-free' });
  });

  it('window CLOSED + nothing added: no charge', () => {
    expect(est({
      isEditingExisting: true, changeFeeApplies: false,
      newDisciplineCount: 0, priorDisciplineCount: 1,
    })).toEqual({ kind: 'no-charge' });
  });

  it('window CLOSED + discipline added at the HOST club: still free', () => {
    expect(est({
      competingClubId: 'host-club', isEditingExisting: true, changeFeeApplies: false,
      newDisciplineCount: 1, priorDisciplineCount: 1,
    })).toEqual({ kind: 'host-free' });
  });

  it('event with no change fee configured, window flag on, discipline added: no double-charge path', () => {
    // changeFee undefined ⇒ registrationChangeFee is 0 ⇒ no change-fee line; and
    // `changeFeeApplies` true means the save path takes NEITHER branch.
    const noChange: RegFeeEvent = { hostClubId: 'host-club', entryFee: 40, secondDisciplineFee: 25 };
    expect(est({
      event: noChange, isEditingExisting: true, changeFeeApplies: true,
      newDisciplineCount: 1, priorDisciplineCount: 1,
    })).toEqual({ kind: 'no-charge' });
  });
});

describe('registrationEstimate — late-registration surcharge', () => {
  const lateEvent: RegFeeEvent = {
    ...event,
    lateReg: { startsAt: '2026-06-01T00:00:00Z', fee: 20 },
  };

  it('new registration inside the late window: surcharge included', () => {
    expect(est({
      event: lateEvent,
      late: { earliestCreatedAtISO: '2026-06-15T00:00:00Z' },
    })).toEqual({ kind: 'new-entry', amountDollars: 60 }); // 40 + 20
  });

  it('new registration before the late window: no surcharge', () => {
    expect(est({
      event: lateEvent,
      late: { earliestCreatedAtISO: '2026-05-01T00:00:00Z' },
    })).toEqual({ kind: 'new-entry', amountDollars: 40 });
  });

  it('no anchor supplied ⇒ no surcharge (matches newRegistrationEntryTotal default)', () => {
    expect(est({ event: lateEvent })).toEqual({ kind: 'new-entry', amountDollars: 40 });
  });

  it('added discipline inside the late window on an EDIT: surcharge rides along', () => {
    expect(est({
      event: lateEvent, isEditingExisting: true, changeFeeApplies: false,
      newDisciplineCount: 1, priorDisciplineCount: 1,
      late: { earliestCreatedAtISO: '2026-06-15T00:00:00Z' },
    })).toEqual({ kind: 'new-entry', amountDollars: 45 }); // 25 second-discipline + 20 late
  });
});
