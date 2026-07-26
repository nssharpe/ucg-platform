import { describe, it, expect } from 'vitest';
import { cartSectionCount } from '../../src/lib/pricing';

describe('cartSectionCount (H5: redundant cart CTA collapse)', () => {
  it('counts zero for an empty cart scope', () => {
    expect(cartSectionCount({ membership: [], events: [], other: [] })).toBe(0);
  });

  it('counts one for a memberships-only scope', () => {
    expect(cartSectionCount({ membership: [{}], events: [], other: [] })).toBe(1);
  });

  it('counts one for a single-event scope', () => {
    expect(cartSectionCount({ membership: [], events: [{ items: [{}] }], other: [] })).toBe(1);
  });

  it('counts one for an other-only scope', () => {
    expect(cartSectionCount({ membership: [], events: [], other: [{}] })).toBe(1);
  });

  it('counts two for memberships + one event', () => {
    expect(cartSectionCount({ membership: [{}], events: [{ items: [{}] }], other: [] })).toBe(2);
  });

  it('counts one per distinct event, plus memberships and other', () => {
    expect(cartSectionCount({
      membership: [{}],
      events: [{ items: [{}] }, { items: [{}, {}] }],
      other: [{}],
    })).toBe(4);
  });
});
