import { describe, it, expect } from 'vitest';
import { matchesEventCommFilters, dedupeContacts } from '../supabase/functions/_shared/event-comm';

describe('matchesEventCommFilters', () => {
  const base = { session_id: 's1', level_id: 'lvl1', discipline: 'MAG', refunded: false };

  it('matches everything when no facet filters are given', () => {
    expect(matchesEventCommFilters(base, {})).toBe(true);
  });

  it('excludes refunded registrations unconditionally', () => {
    expect(matchesEventCommFilters({ ...base, refunded: true }, {})).toBe(false);
  });

  it('filters by sessionIds', () => {
    expect(matchesEventCommFilters(base, { sessionIds: ['s1'] })).toBe(true);
    expect(matchesEventCommFilters(base, { sessionIds: ['s2'] })).toBe(false);
    expect(matchesEventCommFilters({ ...base, session_id: null }, { sessionIds: ['s1'] })).toBe(false);
  });

  it('filters by levelIds', () => {
    expect(matchesEventCommFilters(base, { levelIds: ['lvl1'] })).toBe(true);
    expect(matchesEventCommFilters(base, { levelIds: ['lvl2'] })).toBe(false);
  });

  it('filters by disciplines', () => {
    expect(matchesEventCommFilters(base, { disciplines: ['MAG'] })).toBe(true);
    expect(matchesEventCommFilters(base, { disciplines: ['WAG'] })).toBe(false);
  });

  it('requires ALL specified facets to match (AND, not OR)', () => {
    expect(matchesEventCommFilters(base, { sessionIds: ['s1'], disciplines: ['WAG'] })).toBe(false);
    expect(matchesEventCommFilters(base, { sessionIds: ['s1'], disciplines: ['MAG'] })).toBe(true);
  });

  it('an empty filter array imposes no constraint (same as absent)', () => {
    expect(matchesEventCommFilters(base, { sessionIds: [] })).toBe(true);
  });
});

describe('dedupeContacts', () => {
  it('drops candidates with no email or an invalid-looking email', () => {
    expect(dedupeContacts([{ email: null }, { email: '' }, { email: 'not-an-email' }, { email: '  ' }])).toEqual([]);
  });

  it('dedupes case-insensitively, keeping the first-seen name', () => {
    const result = dedupeContacts([
      { email: 'Coach@Club.org', name: 'First Seen' },
      { email: 'coach@club.org', name: 'Second Seen' },
    ]);
    expect(result).toEqual([{ email: 'Coach@Club.org', name: 'First Seen' }]);
  });

  it('trims whitespace and treats a blank name as undefined', () => {
    const result = dedupeContacts([{ email: '  a@b.com  ', name: '   ' }]);
    expect(result).toEqual([{ email: 'a@b.com', name: undefined }]);
  });

  it('preserves distinct emails in first-seen order', () => {
    const result = dedupeContacts([{ email: 'b@x.com' }, { email: 'a@x.com' }]);
    expect(result.map((r) => r.email)).toEqual(['b@x.com', 'a@x.com']);
  });
});
