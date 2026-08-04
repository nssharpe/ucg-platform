import { describe, it, expect } from 'vitest';
import { statusAfterSigning, welcomeEligible } from '../supabase/functions/_shared/membership-signing';
import { membershipHolds } from '../src/lib/capabilities-core';

// The regression these guard: `record-waiver-signature` split on `paid_via`,
// so a club that paid BEFORE the guardian signed got a payment hold re-asserted
// on an already-paid membership — and, because the "activate" arm carried
// `.neq('paid_via','club')`, that row could never reach 'active' at all.

describe('statusAfterSigning', () => {
  it('activates when nothing is owed', () => {
    expect(statusAfterSigning({ clubCartPending: false })).toBe('active');
  });

  it('holds for payment while a club cart line is still unpaid', () => {
    expect(statusAfterSigning({ clubCartPending: true })).toBe('pending-club-payment');
  });

  it('activates a club membership the club ALREADY paid for (the bug)', () => {
    // fulfill.ts writes exactly this on a club checkout with the waiver still
    // open: paid (club_cart_pending cleared) but waiting on the signature.
    expect(statusAfterSigning({ clubCartPending: false })).toBe('active');
  });

  it('activates when paid_via was never set — the old .neq() matched neither arm', () => {
    // `paid_via <> 'club'` is NULL, not true, for a NULL paid_via, so such a row
    // fell through both updates and stuck at pending-waiver forever. The decision
    // no longer reads paid_via at all, so there is nothing to fall through.
    expect(statusAfterSigning({ clubCartPending: false })).toBe('active');
  });
});

describe('statusAfterSigning agrees with the client-side membershipHolds', () => {
  // These two derive the same fact on opposite sides of the wire: this sets the
  // status, membershipHolds renders the badges off it. Drift between them means a
  // member sees a hold the data doesn't justify.
  const signedAt = '2026-08-04T12:00:00Z';

  it('a paid, signed membership shows NO holds after the transition', () => {
    const status = statusAfterSigning({ clubCartPending: false });
    const holds = membershipHolds({ status, waiverSignedAt: signedAt, clubCartPending: false });
    expect(holds).toEqual({ waiverHold: false, paymentHold: false, active: true });
  });

  it('an unpaid club membership still shows a payment hold, not a waiver hold', () => {
    const status = statusAfterSigning({ clubCartPending: true });
    const holds = membershipHolds({ status, waiverSignedAt: signedAt, clubCartPending: true });
    expect(holds.waiverHold).toBe(false);
    expect(holds.paymentHold).toBe(true);
    expect(holds.active).toBe(false);
  });

  it('OLD behavior would have reported a payment hold on a paid membership', () => {
    // Pin the actual defect: the pre-fix function stamped 'pending-club-payment'
    // on any paid_via='club' row, and membershipHolds reads that status directly.
    const holdsUnderOldStatus = membershipHolds({
      status: 'pending-club-payment', waiverSignedAt: signedAt, clubCartPending: false,
    });
    expect(holdsUnderOldStatus.paymentHold).toBe(true); // ← the stale hold
    // The fix removes it by never writing that status for a paid row.
    expect(membershipHolds({
      status: statusAfterSigning({ clubCartPending: false }),
      waiverSignedAt: signedAt, clubCartPending: false,
    }).paymentHold).toBe(false);
  });
});

describe('welcomeEligible', () => {
  it('excludes club-paid memberships, matching fulfill.ts', () => {
    expect(welcomeEligible({ paidVia: 'club' })).toBe(false);
  });

  it('allows card, comp, and unset', () => {
    expect(welcomeEligible({ paidVia: 'card' })).toBe(true);
    expect(welcomeEligible({ paidVia: 'comp' })).toBe(true);
    expect(welcomeEligible({ paidVia: null })).toBe(true);
  });
});
