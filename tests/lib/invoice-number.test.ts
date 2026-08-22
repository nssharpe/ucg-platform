import { describe, it, expect } from 'vitest';
import { formatInvoiceNumber } from '../../src/lib/invoice-number';

describe('formatInvoiceNumber', () => {
  it('zero-pads a small sequence to 4 digits', () => {
    expect(formatInvoiceNumber(2026, 1)).toBe('UCG-2026-0001');
  });

  it('pads a mid-range sequence', () => {
    expect(formatInvoiceNumber(2026, 56)).toBe('UCG-2026-0056');
  });

  it('does not truncate a sequence beyond 4 digits', () => {
    expect(formatInvoiceNumber(2026, 12345)).toBe('UCG-2026-12345');
  });

  it('formats a different year', () => {
    expect(formatInvoiceNumber(2027, 1)).toBe('UCG-2027-0001');
  });
});
