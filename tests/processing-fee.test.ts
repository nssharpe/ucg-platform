import { describe, it, expect } from 'vitest';
import { processingFee } from '../src/lib/pricing';

// processingFee works in CENTS (Stripe's unit), by design: 3% of the subtotal
// (rounded to the nearest cent) plus a flat 30-cent component. Values below are
// computed directly from round(subtotal * 0.03) + 30.
describe('processingFee (Stripe service fee, cents)', () => {
  it('is the flat 30 cents on a zero subtotal', () => {
    expect(processingFee(0)).toBe(30); // round(0) + 30
  });

  it('round case: $100.00 → round(300) + 30 = 330', () => {
    expect(processingFee(10000)).toBe(330);
  });

  it('rounding case: 333 → round(9.99)=10 + 30 = 40', () => {
    expect(processingFee(333)).toBe(40);
  });

  it('rounds 3% to the nearest cent (half rounds up)', () => {
    // 350 * 0.03 = 10.5 → round = 11 (Math.round rounds .5 up)
    expect(processingFee(350)).toBe(11 + 30);
    // 349 * 0.03 = 10.47 → round = 10
    expect(processingFee(349)).toBe(10 + 30);
  });

  it('large value: $1,234.56 → round(3703.68)=3704 + 30 = 3734', () => {
    expect(processingFee(123456)).toBe(3734);
  });
});
