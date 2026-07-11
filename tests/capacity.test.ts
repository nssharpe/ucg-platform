import { describe, it, expect } from 'vitest';
import {
  regRoutines,
  isOccupying,
  capacityUsage,
  hasCapacityConfig,
  checkCapacity,
  splitFit,
  holdStamp,
  CART_HOLD_MINUTES,
  PROMOTION_HOLD_HOURS,
} from '../src/lib/capacity';
import type { Event, EventSession, Registration, WaitlistGroup } from '../src/lib/types';

const NOW = new Date('2026-08-01T12:00:00Z').getTime();
const FUTURE = new Date('2026-08-01T13:00:00Z').toISOString(); // +1h
const PAST = new Date('2026-08-01T11:00:00Z').toISOString(); // -1h

const baseEvent = (overrides: Partial<Event> = {}): Event => ({
  id: 'evt1',
  slug: 'evt1',
  name: 'Test Event',
  hostClubId: 'club1',
  city: 'Anytown',
  state: 'ST',
  timezone: 'America/New_York',
  startDate: '2026-08-15',
  endDate: '2026-08-16',
  status: 'live',
  regOpens: '2026-07-01',
  regCloses: '2026-08-10',
  entryFee: 50,
  secondDisciplineFee: 25,
  disciplines: ['WAG'],
  sessions: [],
  ...overrides,
});

const baseReg = (overrides: Partial<Registration> = {}): Registration => ({
  id: 'r1',
  eventId: 'evt1',
  athleteId: 'a1',
  clubId: 'club1',
  discipline: 'WAG',
  levelId: 'lvl-silver',
  apparatus: ['VT', 'UB', 'BB', 'FX'],
  sessionId: null,
  paid: true,
  ...overrides,
});

const noGroups: Record<string, WaitlistGroup> = {};

describe('regRoutines', () => {
  it('AA gymnast (4 apparatus) = 4 routines all at levelId', () => {
    const reg = baseReg();
    const routines = regRoutines(reg);
    expect(routines).toHaveLength(4);
    expect(routines.every((r) => r.levelId === 'lvl-silver')).toBe(true);
  });

  it('apparatusLevels attribution overrides levelId per apparatus', () => {
    const reg = baseReg({
      apparatus: ['VT', 'FX'],
      levelId: 'lvl-silver',
      apparatusLevels: { FX: 'lvl-gold' },
    });
    const routines = regRoutines(reg);
    expect(routines).toEqual([
      { apparatus: 'VT', levelId: 'lvl-silver' },
      { apparatus: 'FX', levelId: 'lvl-gold' },
    ]);
  });

  it('empty apparatus array contributes zero routines', () => {
    const reg = baseReg({ apparatus: [] });
    expect(regRoutines(reg)).toEqual([]);
  });
});

describe('isOccupying', () => {
  it('paid reg occupies', () => {
    expect(isOccupying(baseReg({ paid: true }), noGroups, NOW)).toBe(true);
  });

  it('updatedPending reg occupies (already held a spot once)', () => {
    expect(isOccupying(baseReg({ paid: false, updatedPending: true }), noGroups, NOW)).toBe(true);
  });

  it('unpaid reg with a live hold occupies', () => {
    const reg = baseReg({ paid: false, holdExpiresAt: FUTURE });
    expect(isOccupying(reg, noGroups, NOW)).toBe(true);
  });

  it('unpaid reg with an expired hold does not occupy', () => {
    const reg = baseReg({ paid: false, holdExpiresAt: PAST });
    expect(isOccupying(reg, noGroups, NOW)).toBe(false);
  });

  it('unpaid reg with no hold does not occupy', () => {
    const reg = baseReg({ paid: false, holdExpiresAt: null });
    expect(isOccupying(reg, noGroups, NOW)).toBe(false);
  });

  it('refunded reg never occupies, even if paid', () => {
    const reg = baseReg({ paid: true, refunded: true });
    expect(isOccupying(reg, noGroups, NOW)).toBe(false);
  });

  it('refunded + keepListed reg never occupies', () => {
    const reg = baseReg({ paid: true, refunded: true, keepListed: true });
    expect(isOccupying(reg, noGroups, NOW)).toBe(false);
  });

  it('plain waitlisted reg (waiting group) does not occupy', () => {
    const groups: Record<string, WaitlistGroup> = {
      g1: { id: 'g1', eventId: 'evt1', discipline: 'WAG', status: 'waiting', queuedAt: PAST },
    };
    const reg = baseReg({ paid: false, waitlisted: true, waitlistGroupId: 'g1' });
    expect(isOccupying(reg, groups, NOW)).toBe(false);
  });

  it('waitlisted reg whose group is notified with a LIVE hold occupies', () => {
    const groups: Record<string, WaitlistGroup> = {
      g1: {
        id: 'g1', eventId: 'evt1', discipline: 'WAG', status: 'notified',
        queuedAt: PAST, notifiedAt: PAST, holdExpiresAt: FUTURE,
      },
    };
    const reg = baseReg({ paid: false, waitlisted: true, waitlistGroupId: 'g1' });
    expect(isOccupying(reg, groups, NOW)).toBe(true);
  });

  it('waitlisted reg whose group is notified but the hold LAPSED does not occupy', () => {
    const groups: Record<string, WaitlistGroup> = {
      g1: {
        id: 'g1', eventId: 'evt1', discipline: 'WAG', status: 'notified',
        queuedAt: PAST, notifiedAt: PAST, holdExpiresAt: PAST,
      },
    };
    const reg = baseReg({ paid: false, waitlisted: true, waitlistGroupId: 'g1' });
    expect(isOccupying(reg, groups, NOW)).toBe(false);
  });

  it('waitlisted reg with expired/cancelled group does not occupy', () => {
    const groups: Record<string, WaitlistGroup> = {
      g1: { id: 'g1', eventId: 'evt1', discipline: 'WAG', status: 'expired', queuedAt: PAST },
      g2: { id: 'g2', eventId: 'evt1', discipline: 'WAG', status: 'cancelled', queuedAt: PAST },
    };
    expect(isOccupying(baseReg({ waitlisted: true, waitlistGroupId: 'g1', paid: false }), groups, NOW)).toBe(false);
    expect(isOccupying(baseReg({ waitlisted: true, waitlistGroupId: 'g2', paid: false }), groups, NOW)).toBe(false);
  });
});

describe('capacityUsage', () => {
  it('counts athletes once and routines per apparatus across disciplines', () => {
    const event = baseEvent({ disciplines: ['WAG', 'TNT'] });
    const regs: Registration[] = [
      baseReg({ id: 'r1', athleteId: 'a1', discipline: 'WAG', apparatus: ['VT', 'UB', 'BB', 'FX'] }),
      baseReg({ id: 'r2', athleteId: 'a1', discipline: 'TNT', levelId: 'lvl-tnt', apparatus: ['TRA'] }),
    ];
    const usage = capacityUsage(event, regs, noGroups, NOW);
    expect(usage.totalAthletes).toBe(1); // same athlete, multiple disciplines
    expect(usage.perLevel['lvl-silver']).toBe(4);
    expect(usage.perDiscipline.WAG).toBe(4);
    expect(usage.perDiscipline.TNT).toBe(1);
  });

  it('empty-apparatus reg counts as 1 athlete, 0 routines', () => {
    const event = baseEvent();
    const regs = [baseReg({ id: 'r1', apparatus: [] })];
    const usage = capacityUsage(event, regs, noGroups, NOW);
    expect(usage.totalAthletes).toBe(1);
    expect(Object.keys(usage.perLevel)).toHaveLength(0);
  });

  it('tallies per-session per-apparatus routine counts', () => {
    const event = baseEvent();
    const regs = [
      baseReg({ id: 'r1', sessionId: 's1', apparatus: ['VT', 'UB'] }),
      baseReg({ id: 'r2', athleteId: 'a2', sessionId: 's1', apparatus: ['VT'] }),
      baseReg({ id: 'r3', athleteId: 'a3', sessionId: 's2', apparatus: ['VT'] }),
    ];
    const usage = capacityUsage(event, regs, noGroups, NOW);
    expect(usage.perSession.s1.VT).toBe(2);
    expect(usage.perSession.s1.UB).toBe(1);
    expect(usage.perSession.s2.VT).toBe(1);
  });

  it('does not count non-occupying regs', () => {
    const event = baseEvent();
    const regs = [baseReg({ id: 'r1', paid: false, holdExpiresAt: PAST })];
    const usage = capacityUsage(event, regs, noGroups, NOW);
    expect(usage.totalAthletes).toBe(0);
  });
});

describe('hasCapacityConfig', () => {
  it('false when no caps set anywhere', () => {
    const event = baseEvent();
    expect(hasCapacityConfig(event, [])).toBe(false);
  });

  it('true when event.capacity.total set', () => {
    const event = baseEvent({ capacity: { total: 100 } });
    expect(hasCapacityConfig(event, [])).toBe(true);
  });

  it('true when a session has maxRoutines', () => {
    const event = baseEvent();
    const session: EventSession = {
      id: 's1', name: 'Session 1', discipline: 'WAG', date: '2026-08-15', time: '09:00',
      levelIds: ['lvl-silver'], squads: [], maxRoutines: { VT: 10 },
    };
    expect(hasCapacityConfig(event, [session])).toBe(true);
  });

  // jsonb from Postgres can carry explicit nulls (a config UI clearing a
  // field) — null-only configs must read as NOT configured.
  it('false when every cap value is an explicit null', () => {
    const event = baseEvent({
      capacity: {
        total: null,
        perLevel: { 'lvl-silver': null },
        perDiscipline: { WAG: null },
      } as unknown as Event['capacity'],
    });
    const session: EventSession = {
      id: 's1', name: 'Session 1', discipline: 'WAG', date: '2026-08-15', time: '09:00',
      levelIds: ['lvl-silver'], squads: [],
      maxRoutines: { VT: null } as unknown as Record<string, number>,
    };
    expect(hasCapacityConfig(event, [session])).toBe(false);
  });

  it('true when a real cap sits alongside null values', () => {
    const event = baseEvent({
      capacity: { total: null, perLevel: { 'lvl-gold': 3 } } as unknown as Event['capacity'],
    });
    expect(hasCapacityConfig(event, [])).toBe(true);
  });
});

describe('holdStamp', () => {
  it('undefined when the event has no capacity configuration at all', () => {
    const event = baseEvent();
    expect(holdStamp(event, [], NOW)).toBeUndefined();
  });

  it('stamps now + CART_HOLD_MINUTES when a total cap is set', () => {
    const event = baseEvent({ capacity: { total: 100 } });
    const stamp = holdStamp(event, [], NOW);
    expect(stamp).toBe(new Date(NOW + CART_HOLD_MINUTES * 60_000).toISOString());
  });

  it('stamps when only a session maxRoutines cap is set', () => {
    const event = baseEvent();
    const session: EventSession = {
      id: 's1', name: 'Session 1', discipline: 'WAG', date: '2026-08-15', time: '09:00',
      levelIds: ['lvl-silver'], squads: [], maxRoutines: { VT: 10 },
    };
    expect(holdStamp(event, [session], NOW)).toBe(new Date(NOW + CART_HOLD_MINUTES * 60_000).toISOString());
  });

  it('undefined when every cap value is an explicit null (not really configured)', () => {
    const event = baseEvent({ capacity: { total: null } as unknown as Event['capacity'] });
    expect(holdStamp(event, [], NOW)).toBeUndefined();
  });
});

describe('checkCapacity', () => {
  it('total cap violation with exact used/requested/remaining', () => {
    const event = baseEvent({ capacity: { total: 2 } });
    const existing = [
      baseReg({ id: 'r1', athleteId: 'a1' }),
      baseReg({ id: 'r2', athleteId: 'a2' }),
    ];
    const incoming = [baseReg({ id: 'r3', athleteId: 'a3', paid: false, holdExpiresAt: FUTURE })];
    const violations = checkCapacity(event, [], existing, incoming, noGroups, NOW);
    expect(violations).toEqual([
      { scope: 'total', cap: 2, used: 2, requested: 1, remaining: 0 },
    ]);
  });

  it('multiple simultaneous violations (total + level)', () => {
    const event = baseEvent({ capacity: { total: 2, perLevel: { 'lvl-silver': 6 } } });
    const existing = [
      baseReg({ id: 'r1', athleteId: 'a1' }),
      baseReg({ id: 'r2', athleteId: 'a2' }),
    ];
    const incoming = [
      baseReg({ id: 'r3', athleteId: 'a3', paid: false, holdExpiresAt: FUTURE }),
    ];
    const violations = checkCapacity(event, [], existing, incoming, noGroups, NOW);
    expect(violations).toHaveLength(2);
    const total = violations.find((v) => v.scope === 'total');
    const level = violations.find((v) => v.scope === 'level');
    expect(total).toEqual({ scope: 'total', cap: 2, used: 2, requested: 1, remaining: 0 });
    expect(level).toEqual({
      scope: 'level', levelId: 'lvl-silver', cap: 6, used: 8, requested: 4, remaining: 0,
    });
  });

  it('per-session per-apparatus cap violation', () => {
    const event = baseEvent();
    const session: EventSession = {
      id: 's1', name: 'Session 1', discipline: 'WAG', date: '2026-08-15', time: '09:00',
      levelIds: ['lvl-silver'], squads: [], maxRoutines: { VT: 1 },
    };
    const existing = [baseReg({ id: 'r1', sessionId: 's1', apparatus: ['VT'] })];
    const incoming = [baseReg({ id: 'r2', athleteId: 'a2', sessionId: 's1', apparatus: ['VT'], paid: false, holdExpiresAt: FUTURE })];
    const violations = checkCapacity(event, [session], existing, incoming, noGroups, NOW);
    expect(violations).toEqual([
      { scope: 'session', sessionId: 's1', apparatus: 'VT', cap: 1, used: 1, requested: 1, remaining: 0 },
    ]);
  });

  it('fits under cap returns no violations', () => {
    const event = baseEvent({ capacity: { total: 10 } });
    const existing = [baseReg({ id: 'r1', athleteId: 'a1' })];
    const incoming = [baseReg({ id: 'r2', athleteId: 'a2', paid: false, holdExpiresAt: FUTURE })];
    expect(checkCapacity(event, [], existing, incoming, noGroups, NOW)).toEqual([]);
  });

  it('no-caps event returns no violations regardless of volume', () => {
    const event = baseEvent();
    const existing = Array.from({ length: 50 }, (_, i) =>
      baseReg({ id: `r${i}`, athleteId: `a${i}` }));
    const incoming = [baseReg({ id: 'rNew', athleteId: 'aNew', paid: false, holdExpiresAt: FUTURE })];
    expect(checkCapacity(event, [], existing, incoming, noGroups, NOW)).toEqual([]);
  });

  // Explicit nulls from jsonb must never behave as a 0 cap (`combined > null`
  // coerces to `> 0` and would 409 every checkout for the event).
  it('an explicit null total cap is ignored (no violations)', () => {
    const event = baseEvent({ capacity: { total: null } as unknown as Event['capacity'] });
    const existing = [baseReg({ id: 'r1', athleteId: 'a1' })];
    const incoming = [baseReg({ id: 'r2', athleteId: 'a2', paid: false, holdExpiresAt: FUTURE })];
    expect(checkCapacity(event, [], existing, incoming, noGroups, NOW)).toEqual([]);
  });

  it('null perLevel entries are skipped while numeric siblings stay enforced', () => {
    const event = baseEvent({
      capacity: { perLevel: { 'lvl-silver': null, 'lvl-gold': 3 } } as unknown as Event['capacity'],
    });
    // 4 silver routines (would exceed any real silver cap) + 4 gold routines vs cap 3.
    const incoming = [
      baseReg({ id: 'r1', athleteId: 'a1', paid: false, holdExpiresAt: FUTURE }),
      baseReg({ id: 'r2', athleteId: 'a2', levelId: 'lvl-gold', paid: false, holdExpiresAt: FUTURE }),
    ];
    const violations = checkCapacity(event, [], [], incoming, noGroups, NOW);
    expect(violations).toEqual([
      { scope: 'level', levelId: 'lvl-gold', cap: 3, used: 0, requested: 4, remaining: 3 },
    ]);
  });

  it('null maxRoutines entries are skipped while numeric siblings stay enforced', () => {
    const event = baseEvent();
    const session: EventSession = {
      id: 's1', name: 'Session 1', discipline: 'WAG', date: '2026-08-15', time: '09:00',
      levelIds: ['lvl-silver'], squads: [],
      maxRoutines: { VT: null, UB: 1 } as unknown as Record<string, number>,
    };
    const incoming = [
      baseReg({ id: 'r1', athleteId: 'a1', sessionId: 's1', apparatus: ['VT', 'UB'], paid: false, holdExpiresAt: FUTURE }),
      baseReg({ id: 'r2', athleteId: 'a2', sessionId: 's1', apparatus: ['VT', 'UB'], paid: false, holdExpiresAt: FUTURE }),
    ];
    const violations = checkCapacity(event, [session], [], incoming, noGroups, NOW);
    expect(violations).toEqual([
      { scope: 'session', sessionId: 's1', apparatus: 'UB', cap: 1, used: 0, requested: 2, remaining: 1 },
    ]);
  });

  it('incoming unpaid reg with an EXPIRED hold still counts (server re-check at checkout must not oversell)', () => {
    const event = baseEvent({ capacity: { perLevel: { 'lvl-silver': 4 } } });
    // Level cap already full via a paid existing reg.
    const existing = [baseReg({ id: 'r1', athleteId: 'a1', apparatus: ['VT', 'UB', 'BB', 'FX'] })];
    // Incoming reg's cart hold lapsed — it must STILL count as requested.
    const incoming = [baseReg({ id: 'r2', athleteId: 'a2', apparatus: ['VT'], paid: false, holdExpiresAt: PAST })];
    const violations = checkCapacity(event, [], existing, incoming, noGroups, NOW);
    expect(violations).toEqual([
      { scope: 'level', levelId: 'lvl-silver', cap: 4, used: 4, requested: 1, remaining: 0 },
    ]);
  });

  it('incoming waitlisted reg with a notified-but-LAPSED group hold still counts against a full cap', () => {
    const event = baseEvent({ capacity: { total: 1 } });
    const groups: Record<string, WaitlistGroup> = {
      g1: {
        id: 'g1', eventId: 'evt1', discipline: 'WAG', status: 'notified',
        queuedAt: PAST, notifiedAt: PAST, holdExpiresAt: PAST,
      },
    };
    const existing = [baseReg({ id: 'r1', athleteId: 'a1' })]; // cap full
    const incoming = [baseReg({ id: 'r2', athleteId: 'a2', paid: false, waitlisted: true, waitlistGroupId: 'g1' })];
    const violations = checkCapacity(event, [], existing, incoming, groups, NOW);
    expect(violations).toEqual([
      { scope: 'total', cap: 1, used: 1, requested: 1, remaining: 0 },
    ]);
  });

  it('incoming reg with a LIVE notified hold also present in existing counts once — no false violation for its own spot', () => {
    const event = baseEvent({ capacity: { total: 1 } });
    const groups: Record<string, WaitlistGroup> = {
      g1: {
        id: 'g1', eventId: 'evt1', discipline: 'WAG', status: 'notified',
        queuedAt: PAST, notifiedAt: PAST, holdExpiresAt: FUTURE,
      },
    };
    const reg = baseReg({ id: 'r1', athleteId: 'a1', paid: false, waitlisted: true, waitlistGroupId: 'g1' });
    // The only occupant of the cap is this reg's own live hold; checking out
    // that same reg must not double count it against itself.
    const violations = checkCapacity(event, [], [reg], [reg], groups, NOW);
    expect(violations).toEqual([]);
  });

  it('refunded incoming reg does not count as requested', () => {
    const event = baseEvent({ capacity: { total: 1 } });
    const existing = [baseReg({ id: 'r1', athleteId: 'a1' })]; // cap full
    const incoming = [baseReg({ id: 'r2', athleteId: 'a2', paid: false, refunded: true, holdExpiresAt: PAST })];
    expect(checkCapacity(event, [], existing, incoming, noGroups, NOW)).toEqual([]);
  });

  it('dedupes an incoming reg that also appears in existing (counts once, as incoming)', () => {
    const event = baseEvent({ capacity: { total: 1 } });
    const reg = baseReg({ id: 'r1', athleteId: 'a1', paid: false, holdExpiresAt: FUTURE });
    // Same reg id present in both existing (already holding a spot) and incoming
    // (checkout re-validating it) — must not double count toward the cap.
    const violations = checkCapacity(event, [], [reg], [reg], noGroups, NOW);
    expect(violations).toEqual([]);
  });
});

describe('splitFit', () => {
  it('greedily admits in order, waitlisting only what overflows total cap', () => {
    const event = baseEvent({ capacity: { total: 2 } });
    const incoming = [
      baseReg({ id: 'r1', athleteId: 'a1', paid: false, holdExpiresAt: FUTURE }),
      baseReg({ id: 'r2', athleteId: 'a2', paid: false, holdExpiresAt: FUTURE }),
      baseReg({ id: 'r3', athleteId: 'a3', paid: false, holdExpiresAt: FUTURE }),
    ];
    const { fits, overflow } = splitFit(event, [], [], incoming, noGroups, NOW);
    expect(fits.map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(overflow.map((r) => r.id)).toEqual(['r3']);
  });

  it('reg that fits on total but not on level goes to overflow while a later one that fits both is admitted', () => {
    const event = baseEvent({ capacity: { total: 10, perLevel: { 'lvl-gold': 4 } } });
    const incoming = [
      // Uses all 4 gold routine slots.
      baseReg({ id: 'r1', athleteId: 'a1', levelId: 'lvl-gold', apparatus: ['VT', 'UB', 'BB', 'FX'], paid: false, holdExpiresAt: FUTURE }),
      // Fits under total (2nd athlete) but level is now full -> overflow.
      baseReg({ id: 'r2', athleteId: 'a2', levelId: 'lvl-gold', apparatus: ['VT'], paid: false, holdExpiresAt: FUTURE }),
      // Different level, still room -> fits.
      baseReg({ id: 'r3', athleteId: 'a3', levelId: 'lvl-silver', apparatus: ['VT'], paid: false, holdExpiresAt: FUTURE }),
    ];
    const { fits, overflow } = splitFit(event, [], [], incoming, noGroups, NOW);
    expect(fits.map((r) => r.id)).toEqual(['r1', 'r3']);
    expect(overflow.map((r) => r.id)).toEqual(['r2']);
  });

  it('expired-hold incoming regs still consume fit slots in order (no skipping)', () => {
    const event = baseEvent({ capacity: { total: 2 } });
    const incoming = [
      baseReg({ id: 'r1', athleteId: 'a1', paid: false, holdExpiresAt: FUTURE }), // live hold
      baseReg({ id: 'r2', athleteId: 'a2', paid: false, holdExpiresAt: PAST }), // expired hold — must still take slot 2
      baseReg({ id: 'r3', athleteId: 'a3', paid: false, holdExpiresAt: FUTURE }), // live hold, but cap now full
    ];
    const { fits, overflow } = splitFit(event, [], [], incoming, noGroups, NOW);
    expect(fits.map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(overflow.map((r) => r.id)).toEqual(['r3']);
  });

  it('with no caps configured, everything fits', () => {
    const event = baseEvent();
    const incoming = [
      baseReg({ id: 'r1', athleteId: 'a1' }),
      baseReg({ id: 'r2', athleteId: 'a2' }),
    ];
    const { fits, overflow } = splitFit(event, [], [], incoming, noGroups, NOW);
    expect(fits).toHaveLength(2);
    expect(overflow).toHaveLength(0);
  });
});

describe('exported constants', () => {
  it('CART_HOLD_MINUTES and PROMOTION_HOLD_HOURS have the documented values', () => {
    expect(CART_HOLD_MINUTES).toBe(30);
    expect(PROMOTION_HOLD_HOURS).toBe(24);
  });
});
