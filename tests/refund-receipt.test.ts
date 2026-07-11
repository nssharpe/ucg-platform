import { describe, expect, it } from 'vitest';
import { refundReceiptNumber } from '../src/lib/receipt';

describe('refundReceiptNumber', () => {
  it('derives a stable, traceable receipt number from the request id', () => {
    expect(refundReceiptNumber('rr-abc123')).toBe('RF-rr-abc123');
  });

  it('is a pure function of its input (no hidden state/time dependency)', () => {
    const a = refundReceiptNumber('rr-1');
    const b = refundReceiptNumber('rr-1');
    expect(a).toBe(b);
  });
});
