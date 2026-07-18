import { describe, it, expect } from 'vitest';
import {
  seasonIsLaunched,
  isFutureSeason,
  purchasableSeasons,
  eventCreationBlocked,
  nextSeasonNagState,
  rolloverTarget,
} from '../src/lib/season-lifecycle';
import type { DB, Season } from '../src/lib/types';

function season(overrides: Partial<Season> & Pick<Season, 'id' | 'startsOn' | 'endsOn'>): Season {
  return {
    name: overrides.id,
    athleteFee: 50,
    coachFee: 50,
    clubFee: 109,
    active: true,
    current: false,
    launchedAt: null,
    ...overrides,
  };
}

// Only `.seasons` is read by any function under test — the rest of DB is
// irrelevant, so an empty-ish stub cast is fine here.
function dbWith(seasons: Season[]): DB {
  return { seasons } as DB;
}

const S2526 = season({ id: 's26', startsOn: '2025-07-01', endsOn: '2026-06-30', current: true, launchedAt: '2025-06-01T00:00:00Z' });

describe('seasonIsLaunched', () => {
  it('true only when launchedAt is set', () => {
    expect(seasonIsLaunched(season({ id: 'a', startsOn: '2025-07-01', endsOn: '2026-06-30', launchedAt: '2025-06-01T00:00:00Z' }))).toBe(true);
    expect(seasonIsLaunched(season({ id: 'a', startsOn: '2025-07-01', endsOn: '2026-06-30', launchedAt: null }))).toBe(false);
    expect(seasonIsLaunched(null)).toBe(false);
    expect(seasonIsLaunched(undefined)).toBe(false);
  });
});

describe('isFutureSeason', () => {
  it('true when the season starts after the current season ends', () => {
    const next = season({ id: 's27', startsOn: '2026-07-01', endsOn: '2027-06-30' });
    expect(isFutureSeason(dbWith([S2526, next]), next)).toBe(true);
    expect(isFutureSeason(dbWith([S2526, next]), S2526)).toBe(false);
  });

  it('false with no current season (no reference point)', () => {
    const s = season({ id: 'x', startsOn: '2026-07-01', endsOn: '2027-06-30' });
    expect(isFutureSeason(dbWith([s]), s)).toBe(false);
  });
});

describe('purchasableSeasons', () => {
  it('includes current + active non-future seasons, excludes unlaunched future ones', () => {
    const past = season({ id: 'past', startsOn: '2024-07-01', endsOn: '2025-06-30', active: true });
    const nextUnlaunched = season({ id: 'next', startsOn: '2026-07-01', endsOn: '2027-06-30', active: true, launchedAt: null });
    const db = dbWith([past, S2526, nextUnlaunched]);
    const ids = purchasableSeasons(db).map((s) => s.id);
    expect(ids).toEqual(['past', 's26']);
  });

  it('includes a launched future season', () => {
    const nextLaunched = season({ id: 'next', startsOn: '2026-07-01', endsOn: '2027-06-30', active: true, launchedAt: '2026-06-01T00:00:00Z' });
    const db = dbWith([S2526, nextLaunched]);
    expect(purchasableSeasons(db).map((s) => s.id)).toEqual(['s26', 'next']);
  });

  it('excludes an inactive season regardless of launch/future status', () => {
    const inactive = season({ id: 'off', startsOn: '2026-07-01', endsOn: '2027-06-30', active: false, launchedAt: '2026-06-01T00:00:00Z' });
    expect(purchasableSeasons(dbWith([S2526, inactive])).map((s) => s.id)).toEqual(['s26']);
  });
});

describe('eventCreationBlocked', () => {
  const nextLaunched = season({ id: 'next-launched', startsOn: '2026-07-01', endsOn: '2027-06-30', launchedAt: '2026-06-01T00:00:00Z' });
  const nextUnlaunched = season({ id: 'next-unlaunched', startsOn: '2026-07-01', endsOn: '2027-06-30', launchedAt: null });

  it('never blocks the current season', () => {
    expect(eventCreationBlocked(dbWith([S2526]), '2026-03-15').blocked).toBe(false);
  });

  it('allows a launched future season', () => {
    expect(eventCreationBlocked(dbWith([S2526, nextLaunched]), '2026-08-01').blocked).toBe(false);
  });

  it('blocks an unlaunched future season with the season label in the reason', () => {
    const r = eventCreationBlocked(dbWith([S2526, nextUnlaunched]), '2026-08-01');
    expect(r.blocked).toBe(true);
    expect(r.seasonLabel).toBe(nextUnlaunched.name);
    expect(r.reason).toContain("hasn't been set up yet");
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
  const unlaunchedNext = season({ id: 'next', startsOn: '2026-07-01', endsOn: '2027-06-30', launchedAt: null });
  const launchedNext = season({ id: 'next', startsOn: '2026-07-01', endsOn: '2027-06-30', launchedAt: '2026-05-20T00:00:00Z' });

  it('none before June 1', () => {
    expect(nextSeasonNagState(dbWith([S2526, unlaunchedNext]), '2026-05-31')).toBe('none');
  });

  it('june1 tier from June 1 (inclusive) through June 15', () => {
    expect(nextSeasonNagState(dbWith([S2526, unlaunchedNext]), '2026-06-01')).toBe('june1');
    expect(nextSeasonNagState(dbWith([S2526, unlaunchedNext]), '2026-06-15')).toBe('june1');
  });

  it('june16 tier from June 16 through June 23', () => {
    expect(nextSeasonNagState(dbWith([S2526, unlaunchedNext]), '2026-06-16')).toBe('june16');
    expect(nextSeasonNagState(dbWith([S2526, unlaunchedNext]), '2026-06-23')).toBe('june16');
  });

  it('daily tier from June 24 through June 30', () => {
    expect(nextSeasonNagState(dbWith([S2526, unlaunchedNext]), '2026-06-24')).toBe('daily');
    expect(nextSeasonNagState(dbWith([S2526, unlaunchedNext]), '2026-06-30')).toBe('daily');
  });

  it('daily continues on and after July 1 while still unlaunched', () => {
    expect(nextSeasonNagState(dbWith([S2526, unlaunchedNext]), '2026-07-01')).toBe('daily');
    expect(nextSeasonNagState(dbWith([S2526, unlaunchedNext]), '2026-07-02')).toBe('daily');
    expect(nextSeasonNagState(dbWith([S2526, unlaunchedNext]), '2026-09-15')).toBe('daily');
  });

  it('none at every tier once launched', () => {
    expect(nextSeasonNagState(dbWith([S2526, launchedNext]), '2026-06-01')).toBe('none');
    expect(nextSeasonNagState(dbWith([S2526, launchedNext]), '2026-06-24')).toBe('none');
    expect(nextSeasonNagState(dbWith([S2526, launchedNext]), '2026-07-05')).toBe('none');
  });

  it('none when the missing season row case is still before June 1', () => {
    expect(nextSeasonNagState(dbWith([S2526]), '2026-05-01')).toBe('none');
  });

  it('daily when the season row is entirely missing past the boundary', () => {
    expect(nextSeasonNagState(dbWith([S2526]), '2026-07-15')).toBe('daily');
  });
});

describe('rolloverTarget', () => {
  const launchedNext = season({ id: 'next', startsOn: '2026-07-01', endsOn: '2027-06-30', launchedAt: '2026-06-01T00:00:00Z' });
  const unlaunchedNext = season({ id: 'next', startsOn: '2026-07-01', endsOn: '2027-06-30', launchedAt: null });

  it('null before the window is reached', () => {
    expect(rolloverTarget(dbWith([S2526, launchedNext]), '2026-06-30')).toBe(null);
  });

  it('flips to the next season on July 1 once launched', () => {
    expect(rolloverTarget(dbWith([S2526, launchedNext]), '2026-07-01')).toBe('next');
  });

  it('null on/after July 1 when the next season is not launched (fail loud, never invent one)', () => {
    expect(rolloverTarget(dbWith([S2526, unlaunchedNext]), '2026-07-01')).toBe(null);
    expect(rolloverTarget(dbWith([S2526]), '2026-07-01')).toBe(null);
  });

  it('null once the target is already current', () => {
    const alreadyCurrent = season({ id: 'next', startsOn: '2026-07-01', endsOn: '2027-06-30', current: true, launchedAt: '2026-06-01T00:00:00Z' });
    expect(rolloverTarget(dbWith([alreadyCurrent]), '2026-07-01')).toBe(null);
  });
});
