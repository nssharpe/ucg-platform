import { describe, it, expect } from 'vitest';
import {
  currentSeason,
  isFutureSeason,
  purchasableSeasons,
  eventCreationBlocked,
  nextSeasonNagState,
} from '../src/lib/season-lifecycle';
import type { DB, Season } from '../src/lib/types';

function season(overrides: Partial<Season> & Pick<Season, 'id' | 'startsOn' | 'endsOn'>): Season {
  return {
    name: overrides.id,
    athleteFee: 50,
    coachFee: 50,
    clubFee: 109,
    active: true,
    ...overrides,
  };
}

// Only `.seasons` is read by any function under test — the rest of DB is
// irrelevant, so an empty-ish stub cast is fine here.
function dbWith(seasons: Season[]): DB {
  return { seasons } as DB;
}

// "Today" for most of these tests sits inside S2526's window.
const S2526 = season({ id: 's26', startsOn: '2025-07-01', endsOn: '2026-06-30' });

describe('currentSeason', () => {
  it('returns the season whose window contains today', () => {
    expect(currentSeason(dbWith([S2526]), '2026-03-15')?.id).toBe('s26');
  });

  it('falls back to the most recent season with startsOn <= today when no window matches', () => {
    const past = season({ id: 'past', startsOn: '2020-07-01', endsOn: '2021-06-30' });
    const older = season({ id: 'older', startsOn: '2018-07-01', endsOn: '2019-06-30' });
    // Gap: today (2027-01-01) is after S2526 ends and before nothing else starts.
    expect(currentSeason(dbWith([older, past, S2526]), '2027-01-01')?.id).toBe('s26');
  });

  it('returns null when nothing qualifies (no seasons, or all seasons are future)', () => {
    expect(currentSeason(dbWith([]), '2026-03-15')).toBe(null);
    const future = season({ id: 'future', startsOn: '2030-07-01', endsOn: '2031-06-30' });
    expect(currentSeason(dbWith([future]), '2026-03-15')).toBe(null);
  });
});

describe('isFutureSeason', () => {
  it('true when the season starts after the current season ends', () => {
    const next = season({ id: 's27', startsOn: '2026-07-01', endsOn: '2027-06-30' });
    expect(isFutureSeason(dbWith([S2526, next]), next, '2026-03-15')).toBe(true);
    expect(isFutureSeason(dbWith([S2526, next]), S2526, '2026-03-15')).toBe(false);
  });

  it('falls back to comparing directly against today with no current season', () => {
    const s = season({ id: 'x', startsOn: '2026-07-01', endsOn: '2027-06-30' });
    expect(isFutureSeason(dbWith([s]), s, '2026-03-15')).toBe(true);
    const past = season({ id: 'y', startsOn: '2020-07-01', endsOn: '2021-06-30' });
    expect(isFutureSeason(dbWith([past]), past, '2026-03-15')).toBe(false);
  });
});

describe('purchasableSeasons', () => {
  it('current-by-date is always purchasable; past is never; future needs `active`', () => {
    const past = season({ id: 'past', startsOn: '2024-07-01', endsOn: '2025-06-30', active: true });
    const nextInactive = season({ id: 'next', startsOn: '2026-07-01', endsOn: '2027-06-30', active: false });
    const db = dbWith([past, S2526, nextInactive]);
    expect(purchasableSeasons(db, '2026-03-15').map((s) => s.id)).toEqual(['s26']);
  });

  it('includes an `active` future season', () => {
    const nextActive = season({ id: 'next', startsOn: '2026-07-01', endsOn: '2027-06-30', active: true });
    const db = dbWith([S2526, nextActive]);
    expect(purchasableSeasons(db, '2026-03-15').map((s) => s.id)).toEqual(['s26', 'next']);
  });

  it('past season is NEVER purchasable, even when flagged `active`', () => {
    const past = season({ id: 'past', startsOn: '2020-07-01', endsOn: '2021-06-30', active: true });
    expect(purchasableSeasons(dbWith([past, S2526]), '2026-03-15').map((s) => s.id)).toEqual(['s26']);
  });

  it('current-by-date season is purchasable even when `active` is false', () => {
    const current = season({ id: 's26', startsOn: '2025-07-01', endsOn: '2026-06-30', active: false });
    expect(purchasableSeasons(dbWith([current]), '2026-03-15').map((s) => s.id)).toEqual(['s26']);
  });
});

describe('eventCreationBlocked', () => {
  it('never blocks the current season', () => {
    expect(eventCreationBlocked(dbWith([S2526]), '2026-03-15').blocked).toBe(false);
  });

  it('allows a future season regardless of `active`', () => {
    const nextInactive = season({ id: 'next', startsOn: '2026-07-01', endsOn: '2027-06-30', active: false });
    expect(eventCreationBlocked(dbWith([S2526, nextInactive]), '2026-08-01').blocked).toBe(false);
  });

  it('blocks (does not fall back to current) when no season window matches the date at all', () => {
    const r = eventCreationBlocked(dbWith([S2526]), '2030-01-15');
    expect(r.blocked).toBe(true);
    expect(r.reason).toContain('No season has been set up for 2030');
  });

  it('blocks with no start date', () => {
    expect(eventCreationBlocked(dbWith([S2526]), '').blocked).toBe(true);
  });
});

describe('nextSeasonNagState', () => {
  const noNextSeason = dbWith([S2526]);
  const withNextSeason = dbWith([S2526, season({ id: 'next', startsOn: '2026-07-01', endsOn: '2027-06-30' })]);

  it('none before June 1', () => {
    expect(nextSeasonNagState(noNextSeason, '2026-05-31')).toBe('none');
  });

  it('june1 tier from June 1 (inclusive) through June 15', () => {
    expect(nextSeasonNagState(noNextSeason, '2026-06-01')).toBe('june1');
    expect(nextSeasonNagState(noNextSeason, '2026-06-15')).toBe('june1');
  });

  it('june16 tier from June 16 through June 23', () => {
    expect(nextSeasonNagState(noNextSeason, '2026-06-16')).toBe('june16');
    expect(nextSeasonNagState(noNextSeason, '2026-06-23')).toBe('june16');
  });

  it('daily tier from June 24 through June 30', () => {
    expect(nextSeasonNagState(noNextSeason, '2026-06-24')).toBe('daily');
    expect(nextSeasonNagState(noNextSeason, '2026-06-30')).toBe('daily');
  });

  it('daily continues on and after July 1 while the row still does not exist', () => {
    expect(nextSeasonNagState(noNextSeason, '2026-07-01')).toBe('daily');
    expect(nextSeasonNagState(noNextSeason, '2026-07-02')).toBe('daily');
    expect(nextSeasonNagState(noNextSeason, '2026-09-15')).toBe('daily');
  });

  it('none at every tier once the season row exists', () => {
    expect(nextSeasonNagState(withNextSeason, '2026-06-01')).toBe('none');
    expect(nextSeasonNagState(withNextSeason, '2026-06-24')).toBe('none');
    expect(nextSeasonNagState(withNextSeason, '2026-07-05')).toBe('none');
  });

  it('none when it is still before June 1 even with no row yet', () => {
    expect(nextSeasonNagState(noNextSeason, '2026-05-01')).toBe('none');
  });
});
