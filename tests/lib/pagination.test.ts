import { describe, it, expect } from 'vitest';
import { sortKeysForTable, hasMorePages, PAGE_SIZE } from '../../src/lib/pagination';

describe('sortKeysForTable', () => {
  it('defaults ordinary tables to id', () => {
    expect(sortKeysForTable('people')).toEqual(['id']);
    expect(sortKeysForTable('registrations')).toEqual(['id']);
    expect(sortKeysForTable('scores')).toEqual(['id']);
    expect(sortKeysForTable('some_future_table_not_yet_seen')).toEqual(['id']);
  });

  it('resolves the composite/non-id key for club_managers', () => {
    expect(sortKeysForTable('club_managers')).toEqual(['club_id', 'person_id']);
  });

  it('resolves the composite/non-id key for person_alt_clubs', () => {
    expect(sortKeysForTable('person_alt_clubs')).toEqual(['person_id', 'club_id']);
  });

  it('resolves app_settings to its key column', () => {
    expect(sortKeysForTable('app_settings')).toEqual(['key']);
  });

  it('resolves coupons to its code column', () => {
    expect(sortKeysForTable('coupons')).toEqual(['code']);
  });

  it('always returns a non-empty key set (never silently unordered)', () => {
    for (const table of ['people', 'club_managers', 'person_alt_clubs', 'app_settings', 'coupons']) {
      expect(sortKeysForTable(table).length).toBeGreaterThan(0);
    }
  });
});

describe('hasMorePages', () => {
  it('says there may be more when a page comes back full', () => {
    expect(hasMorePages(1000, 1000)).toBe(true);
  });

  it('says there is nothing more when a page comes back short', () => {
    expect(hasMorePages(999, 1000)).toBe(false);
    expect(hasMorePages(0, 1000)).toBe(false);
  });

  it('defaults its pageSize param to the module PAGE_SIZE constant', () => {
    expect(hasMorePages(PAGE_SIZE)).toBe(true);
    expect(hasMorePages(PAGE_SIZE - 1)).toBe(false);
  });
});
