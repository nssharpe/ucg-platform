import { describe, it, expect } from 'vitest';
import {
  registrationGroupPaymentStatus, regGroupPaymentStatusInfo, regPaymentStatusInfo,
  findPaidSibling, type SlotRegLike,
} from '../../src/lib/registration-status';

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

// UAT Z-02-01 (S1): no athlete can be charged twice for the same
// (event, discipline). `findPaidSibling` is the pure predicate behind the
// create-checkout-session 409 and the fulfill.ts auto-refund guard.
describe('findPaidSibling', () => {
  const reg = (overrides: Partial<SlotRegLike>): SlotRegLike => ({
    id: 'reg-1', eventId: 'event-1', athleteId: 'athlete-1', discipline: 'MAG',
    ...overrides,
  });

  it('a paid sibling at the same slot -> conflict', () => {
    const target = reg({ id: 'reg-a', paid: false });
    const sibling = reg({ id: 'reg-b', paid: true, refunded: false });
    expect(findPaidSibling(target, [sibling])).toBe(sibling);
  });

  it('a refunded sibling -> no conflict (slot is free again)', () => {
    const target = reg({ id: 'reg-a', paid: false });
    const sibling = reg({ id: 'reg-b', paid: true, refunded: true });
    expect(findPaidSibling(target, [sibling])).toBeNull();
  });

  it('the same id -> no conflict (paying/re-checking your own reg)', () => {
    const target = reg({ id: 'reg-a', paid: true, refunded: false });
    expect(findPaidSibling(target, [target])).toBeNull();
  });

  it('a different discipline -> no conflict', () => {
    const target = reg({ id: 'reg-a', discipline: 'MAG', paid: false });
    const other = reg({ id: 'reg-b', discipline: 'WAG', paid: true, refunded: false });
    expect(findPaidSibling(target, [other])).toBeNull();
  });

  it('an unpaid sibling -> no conflict (not a "already paid" conflict)', () => {
    const target = reg({ id: 'reg-a', paid: false });
    const other = reg({ id: 'reg-b', paid: false, refunded: false });
    expect(findPaidSibling(target, [other])).toBeNull();
  });

  it('legacy multi-row camp registration (one row per discipline) -> no conflict', () => {
    // Editing a legacy multi-discipline camp registration touches multiple
    // rows for the SAME athlete+event but each a DIFFERENT discipline —
    // never a slot conflict with each other.
    const magRow = reg({ id: 'camp-mag', discipline: 'MAG', paid: true, refunded: false });
    const wagRow = reg({ id: 'camp-wag', discipline: 'WAG', paid: true, refunded: false });
    expect(findPaidSibling(magRow, [wagRow])).toBeNull();
    expect(findPaidSibling(wagRow, [magRow])).toBeNull();
  });

  it('a different event -> no conflict', () => {
    const target = reg({ id: 'reg-a', eventId: 'event-1', paid: false });
    const other = reg({ id: 'reg-b', eventId: 'event-2', paid: true, refunded: false });
    expect(findPaidSibling(target, [other])).toBeNull();
  });

  it('a different athlete -> no conflict', () => {
    const target = reg({ id: 'reg-a', athleteId: 'athlete-1', paid: false });
    const other = reg({ id: 'reg-b', athleteId: 'athlete-2', paid: true, refunded: false });
    expect(findPaidSibling(target, [other])).toBeNull();
  });
});
