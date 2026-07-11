import { describe, it, expect } from 'vitest';
import { normalizeExternalUrl } from '../src/lib/url';

describe('normalizeExternalUrl', () => {
  it('returns empty string for empty input', () => {
    expect(normalizeExternalUrl('')).toBe('');
    expect(normalizeExternalUrl('   ')).toBe('');
  });

  it('leaves an already-scheme-qualified URL alone', () => {
    expect(normalizeExternalUrl('https://www.hilton.com/booking')).toBe('https://www.hilton.com/booking');
    expect(normalizeExternalUrl('http://example.com')).toBe('http://example.com');
  });

  it('prepends https:// when no scheme is present', () => {
    expect(normalizeExternalUrl('www.hilton.com/some-block')).toBe('https://www.hilton.com/some-block');
    expect(normalizeExternalUrl('hilton.com')).toBe('https://hilton.com');
  });

  it('is case-insensitive when detecting an existing scheme', () => {
    expect(normalizeExternalUrl('HTTP://example.com')).toBe('HTTP://example.com');
    expect(normalizeExternalUrl('HTTPS://example.com')).toBe('HTTPS://example.com');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeExternalUrl('  www.hilton.com  ')).toBe('https://www.hilton.com');
    expect(normalizeExternalUrl('  https://example.com  ')).toBe('https://example.com');
  });

  it('handles a bare scheme with no host without mangling it further', () => {
    expect(normalizeExternalUrl('https://')).toBe('https://');
  });
});
