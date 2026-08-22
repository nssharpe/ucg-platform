import { describe, it, expect } from 'vitest';
import { checkoutMode } from '../../src/lib/pricing';

describe('checkoutMode (UAT M-12-01)', () => {
  it('routes a $0 preview total to the no-charge confirm step', () => {
    expect(checkoutMode(0)).toBe('free-confirm');
  });

  it('routes a negative preview total (should never happen server-side) to the confirm step defensively', () => {
    expect(checkoutMode(-1)).toBe('free-confirm');
  });

  it('routes any positive preview total to the normal Stripe path', () => {
    expect(checkoutMode(1)).toBe('stripe');
    expect(checkoutMode(3060)).toBe('stripe');
  });
});
