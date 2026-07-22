import { describe, it, expect } from 'vitest';
import {
  flipfestTemplate,
  nationalsTemplate,
  flipfestDateWindow,
  nationalsDateWindow,
  findUcgEvent,
  buildNationalsSessions,
} from '../../src/lib/ucg-event-templates';
import type { Club, DB, Event, Season } from '../../src/lib/types';

function club(overrides: Partial<Club> & Pick<Club, 'id' | 'name'>): Club {
  return {
    shortName: overrides.name, state: 'Tennessee', region: 'Southeast',
    managerIds: [], email: 'club@example.com', allowClubPay: false, access: 'open' as Club['access'],
    ...overrides,
  };
}

function dbWith(clubs: Club[], events: Event[] = []): DB {
  return { clubs, events } as DB;
}

// Season "2026–27": Jul 1 2026 → Jun 30 2027 — FlipFest lands in Aug 2026
// (season.startsOn's year), Nationals in Apr 2027 (season.endsOn's year).
const SEASON: Season = {
  id: 's27', name: '2026–27', startsOn: '2026-07-01', endsOn: '2027-06-30',
  athleteFee: 50, coachFee: 50, clubFee: 109, active: true,
};

describe('flipfestDateWindow / nationalsDateWindow', () => {
  it('FlipFest window is a Mon–Fri inside August of the given year', () => {
    const { startDate, endDate } = flipfestDateWindow(2026);
    expect(startDate.slice(0, 4)).toBe('2026');
    expect(startDate.slice(5, 7)).toBe('08');
    expect(new Date(startDate + 'T12:00').getUTCDay()).toBe(1); // Monday
    expect(new Date(endDate + 'T12:00').getUTCDay()).toBe(5); // Friday
    expect(endDate > startDate).toBe(true);
  });

  it('Nationals window is a Fri–Sun inside April of the given year', () => {
    const { startDate, endDate } = nationalsDateWindow(2027);
    expect(startDate.slice(0, 4)).toBe('2027');
    expect(startDate.slice(5, 7)).toBe('04');
    expect(new Date(startDate + 'T12:00').getUTCDay()).toBe(5); // Friday
    expect(new Date(endDate + 'T12:00').getUTCDay()).toBe(0); // Sunday
    expect(endDate > startDate).toBe(true);
  });
});

describe('flipfestTemplate', () => {
  it('names/tz/kind/eventType/ucgHosted correctness, dates inside the season window', () => {
    const db = dbWith([]);
    const t = flipfestTemplate(SEASON, db);
    expect(t.name).toBe('FlipFest 2026');
    expect(t.eventType).toBe('camp');
    expect(t.kind).toBe('standard');
    expect(t.ucgHosted).toBe('flipfest');
    expect(t.timezone).toBe('America/Los_Angeles');
    expect(t.venue).toBe('FlipFest');
    expect(t.streetAddress).toBe('272 Lake Frances Rd');
    expect(t.city).toBe('Crossville');
    expect(t.state).toBe('TN');
    expect(t.startDate! >= SEASON.startsOn && t.endDate! <= SEASON.endsOn).toBe(true);
    expect(t.campConfig?.overnightSurvey).toBe(true);
    expect(t.campConfig?.surveyMandatory).toEqual({ bedtime: true, noiseLevel: true, cabinGenderPref: true, roommateRequest: true });
    expect(t.tshirtAddon?.sizes).toEqual(['S', 'M', 'L', 'XL']);
    expect(t.disciplines).toEqual(['MAG', 'WAG', 'TNT']);
    expect(t.entryFee).toBe(200);
  });

  it('omits hostClubId when no league-host club exists', () => {
    const db = dbWith([club({ id: 'c1', name: 'Regular Club' })]);
    expect(flipfestTemplate(SEASON, db).hostClubId).toBeUndefined();
  });

  it('omits hostClubId when several league-host clubs exist', () => {
    const db = dbWith([
      club({ id: 'c1', name: 'A', isLeagueHost: true }),
      club({ id: 'c2', name: 'B', isLeagueHost: true }),
    ]);
    expect(flipfestTemplate(SEASON, db).hostClubId).toBeUndefined();
  });

  it('sets hostClubId when exactly one league-host club exists', () => {
    const db = dbWith([
      club({ id: 'c1', name: 'A' }),
      club({ id: 'c2', name: 'UCG - Main', isLeagueHost: true }),
    ]);
    expect(flipfestTemplate(SEASON, db).hostClubId).toBe('c2');
  });
});

describe('nationalsTemplate', () => {
  it('names/tz/kind/eventType/ucgHosted/disciplines correctness, dates inside the season window', () => {
    const db = dbWith([]);
    const t = nationalsTemplate(SEASON, db);
    expect(t.name).toBe('UCG Nationals 2027');
    expect(t.kind).toBe('nationals');
    expect(t.eventType).toBe('competition');
    expect(t.ucgHosted).toBe('nationals');
    expect(t.timezone).toBe('America/Los_Angeles');
    expect(t.disciplines).toEqual(['MAG', 'WAG', 'TNT']);
    expect(t.startDate! >= SEASON.startsOn && t.endDate! <= SEASON.endsOn).toBe(true);
  });

  it('sets hostClubId only when exactly one league-host club exists', () => {
    expect(nationalsTemplate(SEASON, dbWith([])).hostClubId).toBeUndefined();
    const db = dbWith([club({ id: 'c1', name: 'UCG - Main', isLeagueHost: true })]);
    expect(nationalsTemplate(SEASON, db).hostClubId).toBe('c1');
  });
});

describe('findUcgEvent', () => {
  const baseEvent: Omit<Event, 'id' | 'ucgHosted' | 'startDate'> = {
    slug: 'x', name: 'X', hostClubId: 'c1', city: 'Nashville', state: 'TN', timezone: 'America/Los_Angeles',
    endDate: '2026-08-21', status: 'live', regOpens: '2026-01-01T00:00:00Z', regCloses: '2026-08-01T00:00:00Z',
    entryFee: 0, secondDisciplineFee: 0, disciplines: [], sessions: [],
  };

  it('finds the event with matching ucgHosted whose startDate falls in the season window', () => {
    const ev: Event = { ...baseEvent, id: 'e1', ucgHosted: 'flipfest', startDate: '2026-08-17' };
    const db = dbWith([], [ev]);
    expect(findUcgEvent(db, SEASON, 'flipfest')?.id).toBe('e1');
    expect(findUcgEvent(db, SEASON, 'nationals')).toBeUndefined();
  });

  it('ignores an event outside the season window even with matching ucgHosted', () => {
    const ev: Event = { ...baseEvent, id: 'e1', ucgHosted: 'flipfest', startDate: '2025-08-17' };
    const db = dbWith([], [ev]);
    expect(findUcgEvent(db, SEASON, 'flipfest')).toBeUndefined();
  });

  it('returns undefined when no events exist', () => {
    expect(findUcgEvent(dbWith([], []), SEASON, 'nationals')).toBeUndefined();
  });
});

describe('buildNationalsSessions', () => {
  const slots = [
    { name: 'Session 1', date: '2027-04-16', time: '08:00' },
    { name: 'Session 2', date: '2027-04-16', time: '14:00' },
  ];
  const gyms = [
    { name: 'Orange', discipline: 'MAG' as const, levelIds: ['mag-dev', 'mag-int', 'mag-adv'] },
    { name: 'Red', discipline: 'WAG' as const, levelIds: ['wag-diamond'] },
    { name: 'Purple', discipline: 'TNT' as const, levelIds: ['tnt-new', 'tnt-int', 'tnt-high'] },
  ];

  it('cross-products slots × gyms — one session per pair', () => {
    const out = buildNationalsSessions(slots, gyms, 'evt-1');
    expect(out).toHaveLength(slots.length * gyms.length);
  });

  it('names sessions "{slot} — {gym} ({discipline label})", T&T abbreviated', () => {
    const out = buildNationalsSessions(slots, gyms, 'evt-1');
    expect(out[0].name).toBe('Session 1 — Orange (MAG)');
    expect(out[1].name).toBe('Session 1 — Red (WAG)');
    expect(out[2].name).toBe('Session 1 — Purple (T&T)');
    expect(out[3].name).toBe('Session 2 — Orange (MAG)');
  });

  it('propagates each gym\'s discipline, levelIds, and the slot\'s date/time', () => {
    const out = buildNationalsSessions(slots, gyms, 'evt-1');
    const orangeSession2 = out.find((s) => s.name === 'Session 2 — Orange (MAG)')!;
    expect(orangeSession2.discipline).toBe('MAG');
    expect(orangeSession2.levelIds).toEqual(['mag-dev', 'mag-int', 'mag-adv']);
    expect(orangeSession2.date).toBe('2027-04-16');
    expect(orangeSession2.time).toBe('14:00');
    expect(orangeSession2.squads).toEqual([]);
  });

  it('sets phase to "prelim" on every generated session', () => {
    const out = buildNationalsSessions(slots, gyms, 'evt-1');
    expect(out.every((s) => s.phase === 'prelim')).toBe(true);
  });

  it('assigns unique sequential ids scoped to the event id', () => {
    const out = buildNationalsSessions(slots, gyms, 'evt-1');
    expect(out.map((s) => s.id)).toEqual(['evt-1-s1', 'evt-1-s2', 'evt-1-s3', 'evt-1-s4', 'evt-1-s5', 'evt-1-s6']);
  });

  it('returns an empty array when there are no slots or no gyms', () => {
    expect(buildNationalsSessions([], gyms, 'evt-1')).toEqual([]);
    expect(buildNationalsSessions(slots, [], 'evt-1')).toEqual([]);
  });
});
