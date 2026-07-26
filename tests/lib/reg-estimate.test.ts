import { describe, it, expect } from 'vitest';
import { registrationEstimate, registrationEstimateLabel } from '../../src/lib/reg-estimate';
import type { RegFeeEvent } from '../../src/lib/pricing';

const event: RegFeeEvent = {
  hostClubId: 'host-club',
  entryFee: 40,
  secondDisciplineFee: 25,
  changeFee: { amount: 15, startsAt: '2026-01-01T00:00:00Z' },
};

describe('registrationEstimate', () => {
  it('new registration, one discipline: estimated entry fee', () => {
    const est = registrationEstimate({
      event, competingClubId: 'club-a', isEditingExisting: false, eligible: true, newDisciplineCount: 1,
    });
    expect(est).toEqual({ kind: 'new-entry', amountDollars: 40 });
    expect(registrationEstimateLabel(est)).toBe('Estimated entry fee: $40 — added to your cart on save');
  });

  it('new registration, two disciplines: base + second-discipline fee summed', () => {
    const est = registrationEstimate({
      event, competingClubId: 'club-a', isEditingExisting: false, eligible: true, newDisciplineCount: 2,
    });
    expect(est).toEqual({ kind: 'new-entry', amountDollars: 65 });
  });

  it('host club new registration: free, regardless of discipline count', () => {
    const est = registrationEstimate({
      event, competingClubId: 'host-club', isEditingExisting: false, eligible: true, newDisciplineCount: 2,
    });
    expect(est).toEqual({ kind: 'host-free' });
    expect(registrationEstimateLabel(est)).toBe('Free — host club');
  });

  it('empty hostClubId never matches an equally-empty competingClubId', () => {
    const noHost: RegFeeEvent = { ...event, hostClubId: '' };
    const est = registrationEstimate({
      event: noHost, competingClubId: '', isEditingExisting: false, eligible: true, newDisciplineCount: 1,
    });
    expect(est.kind).toBe('new-entry');
  });

  it('editing a paid registration, eligible change: change fee', () => {
    const est = registrationEstimate({
      event, competingClubId: 'club-a', isEditingExisting: true, eligible: true, newDisciplineCount: 0,
    });
    expect(est).toEqual({ kind: 'change-fee', amountDollars: 15 });
    expect(registrationEstimateLabel(est)).toBe('Change fee: $15 will be added to your cart');
  });

  it('editing a paid registration, NOT eligible (e.g. apparatus tweak): no charge', () => {
    const est = registrationEstimate({
      event, competingClubId: 'club-a', isEditingExisting: true, eligible: false, newDisciplineCount: 0,
    });
    expect(est).toEqual({ kind: 'no-charge' });
    expect(registrationEstimateLabel(est)).toBe('No charge for this change');
  });

  it('host club editing an eligible change: still free (host club wins)', () => {
    const est = registrationEstimate({
      event, competingClubId: 'host-club', isEditingExisting: true, eligible: true, newDisciplineCount: 0,
    });
    expect(est).toEqual({ kind: 'host-free' });
  });

  it('camp new registration: flat entry fee via newDisciplineCount=1, no second-discipline fee applied', () => {
    const camp: RegFeeEvent = { hostClubId: 'host-club', entryFee: 75, secondDisciplineFee: 0 };
    const est = registrationEstimate({
      event: camp, competingClubId: 'club-a', isEditingExisting: false, eligible: true, newDisciplineCount: 1,
    });
    expect(est).toEqual({ kind: 'new-entry', amountDollars: 75 });
  });

  it('camp club-only switch on an existing (paid) registration: change fee applies when eligible', () => {
    const camp: RegFeeEvent = { hostClubId: 'host-club', entryFee: 75, secondDisciplineFee: 0, changeFee: { amount: 10, startsAt: '2026-01-01T00:00:00Z' } };
    const est = registrationEstimate({
      event: camp, competingClubId: 'club-b', isEditingExisting: true, eligible: true, newDisciplineCount: 0,
    });
    expect(est).toEqual({ kind: 'change-fee', amountDollars: 10 });
  });
});
