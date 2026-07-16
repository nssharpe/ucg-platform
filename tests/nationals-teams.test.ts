import { describe, it, expect } from 'vitest';
import { TEAM_MIN_PER_APPARATUS, eligibleTeams, isAllAround } from '../src/lib/nationals-teams';
import type { Athlete, Registration } from '../src/lib/types';

// --- Fixtures ---------------------------------------------------------------

function reg(overrides: Partial<Registration> = {}): Registration {
  return {
    id: 'r1',
    eventId: 'ev1',
    athleteId: 'a1',
    clubId: 'club-a',
    discipline: 'WAG',
    levelId: 'L5',
    apparatus: ['VT', 'UB', 'BB', 'FX'],
    sessionId: null,
    ...overrides,
  };
}

function athlete(overrides: Partial<Athlete> = {}): Athlete {
  return {
    id: 'a1',
    kind: 'athlete',
    roles: { athlete: true, coach: false },
    firstName: 'First',
    lastName: 'Last',
    email: 'a@example.com',
    dob: '2000-01-01',
    gender: 'Female',
    gradYear: 1900,
    studentStatus: 'Non-Student',
    shirt: 'M',
    country: 'US',
    state: 'CA',
    phone: '',
    mainClubId: 'club-a',
    altClubIds: [],
    levels: {},
    emergency: { contact: '', relation: '', phone: '' },
    dietary: [],
    dietaryNotes: '',
    memberships: [],
    achievements: [],
    ...overrides,
  };
}

// --- TEAM_MIN_PER_APPARATUS --------------------------------------------------

describe('TEAM_MIN_PER_APPARATUS', () => {
  it('is 3', () => {
    expect(TEAM_MIN_PER_APPARATUS).toBe(3);
  });
});

// --- isAllAround --------------------------------------------------------------

describe('isAllAround', () => {
  it('is true when every WAG apparatus code is present', () => {
    expect(isAllAround(reg({ apparatus: ['VT', 'UB', 'BB', 'FX'] }), 'WAG')).toBe(true);
  });

  it('is true regardless of apparatus order', () => {
    expect(isAllAround(reg({ apparatus: ['FX', 'VT', 'BB', 'UB'] }), 'WAG')).toBe(true);
  });

  it('is false when missing an apparatus', () => {
    expect(isAllAround(reg({ apparatus: ['VT', 'UB', 'BB'] }), 'WAG')).toBe(false);
  });

  it('is false for T&T (3 of 3 apparatus is all-around for TNT itself, not WAG)', () => {
    expect(isAllAround(reg({ apparatus: ['TR', 'DM', 'TU'] }), 'WAG')).toBe(false);
  });

  it('is true for T&T all-around against the TNT discipline', () => {
    expect(isAllAround(reg({ apparatus: ['TR', 'DM', 'TU'] }), 'TNT')).toBe(true);
  });
});

// --- eligibleTeams ------------------------------------------------------------

describe('eligibleTeams', () => {
  it('returns nothing for an empty registration list', () => {
    expect(eligibleTeams([], new Map())).toEqual([]);
  });

  it('groups regs by club + discipline + level + category', () => {
    const people = new Map([['a1', athlete({ id: 'a1' })]]);
    const regs = [reg({ id: 'r1', athleteId: 'a1', apparatus: ['VT'] })];
    const teams = eligibleTeams(regs, people);
    expect(teams).toHaveLength(1);
    expect(teams[0]).toMatchObject({ clubId: 'club-a', discipline: 'WAG', levelId: 'L5', category: 'Community Women+' });
  });

  it('separates teams by placement category even at the same club/discipline/level', () => {
    const people = new Map([
      ['a1', athlete({ id: 'a1', gender: 'Female' })],
      ['a2', athlete({ id: 'a2', gender: 'Male' })],
    ]);
    const regs = [
      reg({ id: 'r1', athleteId: 'a1', apparatus: ['VT'] }),
      reg({ id: 'r2', athleteId: 'a2', apparatus: ['VT'] }),
    ];
    const teams = eligibleTeams(regs, people);
    expect(teams).toHaveLength(2);
    const categories = teams.map((t) => t.category).sort();
    expect(categories).toEqual(['Community Men+', 'Community Women+']);
  });

  it('honors the student flag for Collegiate categories', () => {
    const people = new Map([['a1', athlete({ id: 'a1', gender: 'Female', studentStatus: 'Student' })]]);
    const regs = [reg({ id: 'r1', athleteId: 'a1', apparatus: ['VT'] })];
    const teams = eligibleTeams(regs, people);
    expect(teams[0].category).toBe('Collegiate Women+');
  });

  it('honors an explicit per-discipline placement override over gender', () => {
    const people = new Map([['a1', athlete({ id: 'a1', gender: 'Female', placement: { WAG: 'men+' } })]]);
    const regs = [reg({ id: 'r1', athleteId: 'a1', apparatus: ['VT'] })];
    const teams = eligibleTeams(regs, people);
    expect(teams[0].category).toBe('Community Men+');
  });

  it('marks an apparatus eligible once 3 athletes are registered for it', () => {
    const people = new Map([
      ['a1', athlete({ id: 'a1' })],
      ['a2', athlete({ id: 'a2' })],
      ['a3', athlete({ id: 'a3' })],
    ]);
    const regs = [
      reg({ id: 'r1', athleteId: 'a1', apparatus: ['VT'] }),
      reg({ id: 'r2', athleteId: 'a2', apparatus: ['VT'] }),
      reg({ id: 'r3', athleteId: 'a3', apparatus: ['VT'] }),
    ];
    const teams = eligibleTeams(regs, people);
    expect(teams[0].apparatusRegIds.VT).toEqual(['r1', 'r2', 'r3']);
    expect(teams[0].eligibleApparatus).toEqual(['VT']);
  });

  it('does NOT mark an apparatus eligible with only 2 registrants', () => {
    const people = new Map([
      ['a1', athlete({ id: 'a1' })],
      ['a2', athlete({ id: 'a2' })],
    ]);
    const regs = [
      reg({ id: 'r1', athleteId: 'a1', apparatus: ['VT'] }),
      reg({ id: 'r2', athleteId: 'a2', apparatus: ['VT'] }),
    ];
    const teams = eligibleTeams(regs, people);
    expect(teams[0].eligibleApparatus).toEqual([]);
  });

  it('tracks eligibility independently per apparatus', () => {
    const people = new Map([
      ['a1', athlete({ id: 'a1' })],
      ['a2', athlete({ id: 'a2' })],
      ['a3', athlete({ id: 'a3' })],
    ]);
    const regs = [
      reg({ id: 'r1', athleteId: 'a1', apparatus: ['VT', 'UB'] }),
      reg({ id: 'r2', athleteId: 'a2', apparatus: ['VT', 'UB'] }),
      reg({ id: 'r3', athleteId: 'a3', apparatus: ['VT'] }),
    ];
    const teams = eligibleTeams(regs, people);
    expect(teams[0].eligibleApparatus).toEqual(['VT']);
    expect(teams[0].apparatusRegIds.UB).toEqual(['r1', 'r2']);
  });

  it('excludes refunded registrations', () => {
    const people = new Map([
      ['a1', athlete({ id: 'a1' })],
      ['a2', athlete({ id: 'a2' })],
      ['a3', athlete({ id: 'a3' })],
    ]);
    const regs = [
      reg({ id: 'r1', athleteId: 'a1', apparatus: ['VT'] }),
      reg({ id: 'r2', athleteId: 'a2', apparatus: ['VT'] }),
      reg({ id: 'r3', athleteId: 'a3', apparatus: ['VT'], refunded: true }),
    ];
    const teams = eligibleTeams(regs, people);
    expect(teams[0].apparatusRegIds.VT).toEqual(['r1', 'r2']);
    expect(teams[0].eligibleApparatus).toEqual([]);
  });

  it('excludes waitlisted registrations', () => {
    const people = new Map([
      ['a1', athlete({ id: 'a1' })],
      ['a2', athlete({ id: 'a2' })],
      ['a3', athlete({ id: 'a3' })],
    ]);
    const regs = [
      reg({ id: 'r1', athleteId: 'a1', apparatus: ['VT'] }),
      reg({ id: 'r2', athleteId: 'a2', apparatus: ['VT'] }),
      reg({ id: 'r3', athleteId: 'a3', apparatus: ['VT'], waitlisted: true }),
    ];
    const teams = eligibleTeams(regs, people);
    expect(teams[0].apparatusRegIds.VT).toEqual(['r1', 'r2']);
    expect(teams[0].eligibleApparatus).toEqual([]);
  });

  it('skips a registration whose athlete cannot be found', () => {
    const regs = [reg({ id: 'r1', athleteId: 'ghost', apparatus: ['VT'] })];
    expect(eligibleTeams(regs, new Map())).toEqual([]);
  });
});
