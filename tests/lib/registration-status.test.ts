import { describe, it, expect } from 'vitest';
import { registrationGroupPaymentStatus, regGroupPaymentStatusInfo, regPaymentStatusInfo } from '../../src/lib/registration-status';

describe('registrationGroupPaymentStatus', () => {
  it('paid && !updatedPending -> paid', () => {
    expect(registrationGroupPaymentStatus([{ paid: true, updatedPending: false }])).toBe('paid');
  });

  it('paid with updatedPending undefined -> paid', () => {
    expect(registrationGroupPaymentStatus([{ paid: true }])).toBe('paid');
  });

  it('!paid -> pending-purchase', () => {
    expect(registrationGroupPaymentStatus([{ paid: false, updatedPending: false }])).toBe('pending-purchase');
  });

  it('paid undefined (brand-new reg, no field yet) -> pending-purchase', () => {
    expect(registrationGroupPaymentStatus([{}])).toBe('pending-purchase');
  });

  it('updatedPending -> change-pending, even if paid is also false', () => {
    expect(registrationGroupPaymentStatus([{ paid: false, updatedPending: true }])).toBe('change-pending');
  });

  it('updatedPending takes priority over a mixed group', () => {
    expect(registrationGroupPaymentStatus([
      { paid: true, updatedPending: false },
      { paid: false, updatedPending: true },
    ])).toBe('change-pending');
  });

  it('mixed paid/unpaid rows with no updatedPending -> pending-purchase', () => {
    expect(registrationGroupPaymentStatus([
      { paid: true, updatedPending: false },
      { paid: false, updatedPending: false },
    ])).toBe('pending-purchase');
  });

  it('host-club $0 registration created paid:true -> paid', () => {
    expect(registrationGroupPaymentStatus([{ paid: true, updatedPending: false }])).toBe('paid');
  });
});

describe('regPaymentStatusInfo / regGroupPaymentStatusInfo', () => {
  it('paid -> label "Paid", tone ok', () => {
    expect(regPaymentStatusInfo('paid')).toEqual({ status: 'paid', label: 'Paid', tone: 'ok' });
  });

  it('pending-purchase -> label + tone warn', () => {
    expect(regPaymentStatusInfo('pending-purchase')).toEqual({
      status: 'pending-purchase', label: 'Pending purchase — in your cart', tone: 'warn',
    });
  });

  it('change-pending -> label + tone warn', () => {
    expect(regPaymentStatusInfo('change-pending')).toEqual({
      status: 'change-pending', label: 'Change pending purchase', tone: 'warn',
    });
  });

  it('regGroupPaymentStatusInfo derives straight from rows', () => {
    expect(regGroupPaymentStatusInfo([{ paid: false, updatedPending: true }])).toEqual({
      status: 'change-pending', label: 'Change pending purchase', tone: 'warn',
    });
  });
});
