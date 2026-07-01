import { describe, it, expect } from 'vitest';
import { processingFee } from '../src/lib/pricing';

// processingFee works in CENTS (Stripe's unit), by design: 3% of the subtotal
// (rounded UP to the nearest cent, never to-nearest — so the collected fee
// never falls a cent short of Stripe's actual deducted fee) plus a flat
// 30-cent component. Values below are computed from ceil(subtotal * 0.03) + 30.
describe('processingFee (Stripe service fee, cents)', () => {
  it('is the flat 30 cents on a zero subtotal', () => {
    expect(processingFee(0)).toBe(30); // ceil(0) + 30
  });

  it('exact case: $100.00 → ceil(300) + 30 = 330', () => {
    expect(processingFee(10000)).toBe(330);
  });

  it('rounding case: 333 → ceil(9.99)=10 + 30 = 40', () => {
    expect(processingFee(333)).toBe(40);
  });

  it('rounds 3% UP to the nearest cent, even just above a whole cent', () => {
    // 350 * 0.03 = 10.5 → ceil = 11
    expect(processingFee(350)).toBe(11 + 30);
    // 349 * 0.03 = 10.47 → ceil = 11 (never rounds down and undercharges)
    expect(processingFee(349)).toBe(11 + 30);
  });

  it('large value: $1,234.56 → ceil(3703.68)=3704 + 30 = 3734', () => {
    expect(processingFee(123456)).toBe(3734);
  });
});
