import { describe, it, expect } from 'vitest';
import { dedupeEmailRecipients } from '../supabase/functions/_shared/notify-recipients';

describe('dedupeEmailRecipients', () => {
  it('builds a "First Last" name and keeps a valid email', () => {
    const out = dedupeEmailRecipients([{ first_name: 'Jo', last_name: 'Lee', email: 'jo@example.com' }]);
    expect(out).toEqual([{ name: 'Jo Lee', email: 'jo@example.com' }]);
  });

  it('drops rows with a missing or malformed email', () => {
    const out = dedupeEmailRecipients([
      { first_name: 'A', last_name: 'B', email: null },
      { first_name: 'C', last_name: 'D', email: '' },
      { first_name: 'E', last_name: 'F', email: 'not-an-email' },
      { first_name: 'G', last_name: 'H', email: 'g@example.com' },
    ]);
    expect(out).toEqual([{ name: 'G H', email: 'g@example.com' }]);
  });

  it('dedupes case-insensitively, keeping the first occurrence', () => {
    const out = dedupeEmailRecipients([
      { first_name: 'Jo', last_name: 'Lee', email: 'Jo@Example.com' },
      { first_name: 'Jo', last_name: 'Lee', email: 'jo@example.com' },
    ]);
    expect(out).toEqual([{ name: 'Jo Lee', email: 'Jo@Example.com' }]);
  });

  it('trims whitespace around an email', () => {
    const out = dedupeEmailRecipients([{ first_name: 'Jo', last_name: 'Lee', email: '  jo@example.com  ' }]);
    expect(out).toEqual([{ name: 'Jo Lee', email: 'jo@example.com' }]);
  });

  it('handles missing names gracefully', () => {
    const out = dedupeEmailRecipients([{ first_name: null, last_name: null, email: 'anon@example.com' }]);
    expect(out).toEqual([{ name: '', email: 'anon@example.com' }]);
  });

  it('returns an empty array for an empty input', () => {
    expect(dedupeEmailRecipients([])).toEqual([]);
  });
});
