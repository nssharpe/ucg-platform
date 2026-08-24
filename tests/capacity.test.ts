import { describe, it, expect } from 'vitest';
import {
  regRoutines,
  isOccupying,
  capacityUsage,
  paidUsage,
  normalizeCapacity,
  hasCapacityConfig,
  checkCapacity,
  splitFit,
  holdStamp,
  CART_HOLD_MINUTES,
  PROMOTION_HOLD_HOURS,
  waitlistGroupKeyFor,
  regsAffectedByViolations,
  groupRegsByWaitlistKey,
  isWaitlistable,
  waitlistPosition,
  type CapacityViolation,
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
    expect(usage.perDisciplineLevel.WAG?.['lvl-silver']).toBe(4);
    expect(usage.perDiscipline.WAG).toBe(4);
    expect(usage.perDiscipline.TNT).toBe(1);
  });

  it('empty-apparatus reg counts as 1 athlete, 0 routines', () => {
    const event = baseEvent();
    const regs = [baseReg({ id: 'r1', apparatus: [] })];
    const usage = capacityUsage(event, regs, noGroups, NOW);
    expect(usage.totalAthletes).toBe(1);
    expect(Object.keys(usage.perDisciplineLevel)).toHaveLength(0);
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

describe('normalizeCapacity (legacy read fallback, 2026-08-24 rework)', () => {
  it('maps legacy flat perDiscipline to mode discipline and drops total', () => {
    const cfg = normalizeCapacity({ total: 40, perDiscipline: { TNT: 12 } } as never);
    expect(cfg.perDiscipline?.TNT).toEqual({ mode: 'discipline', cap: 12 });
    expect(Object.keys(cfg.perDiscipline ?? {})).toEqual(['TNT']);
  });

  it("maps legacy flat perLevel into that discipline's perLevel mode; perLevel wins when both legacy maps name a discipline", () => {
    const cfg = normalizeCapacity({
      perDiscipline: { WAG: 30 },
      perLevel: { 'lvl-silver': 8 },
    } as never);
    // lvl-silver is a WAG level in these fixtures; the stricter perLevel mode wins.
    expect(cfg.perDiscipline?.WAG?.mode).toBe('perLevel');
    expect(cfg.perDiscipline?.WAG?.perLevel).toEqual({ 'lvl-silver': 8 });
  });

  it('passes the new shape through unchanged, including mode none', () => {
    const next = { perDiscipline: { MAG: { mode: 'none' as const } } };
    expect(normalizeCapacity(next)).toEqual(next);
  });

  it('rejects 0 / negative / fractional caps as not-configured (fixes the 0-blocks-everything bug)', () => {
    const cfg = normalizeCapacity({ perDiscipline: { WAG: { mode: 'discipline', cap: 0 } } });
    const event = baseEvent({ capacity: cfg as Event['capacity'] });
    expect(checkCapacity(event, [], [], [baseReg({ id: 'r1', paid: false, holdExpiresAt: FUTURE })], noGroups, NOW)).toEqual([]);
    const frac = baseEvent({ capacity: { perDiscipline: { WAG: { mode: 'discipline', cap: 2.5 } } } as Event['capacity'] });
    expect(checkCapacity(frac, [], [], [baseReg({ id: 'r1', paid: false, holdExpiresAt: FUTURE })], noGroups, NOW)).toEqual([]);
  });
});

describe('paidUsage (display-only progress tally for the upcoming T3 capacity UI)', () => {
  it('counts only paid:true regs, excluding live cart holds and promoted-waitlist holds', () => {
    const event = baseEvent();
    const regs = [
      baseReg({ id: 'r1', athleteId: 'a1', paid: true }),
      baseReg({ id: 'r2', athleteId: 'a2', paid: false, holdExpiresAt: FUTURE }), // live cart hold, unpaid — excluded
      baseReg({ id: 'r3', athleteId: 'a3', paid: false, updatedPending: true }), // occupies per isOccupying but not literally paid:true — excluded
    ];
    const usage = paidUsage(event, regs);
    expect(usage.totalAthletes).toBe(1);
    expect(usage.perDiscipline.WAG).toBe(4);
  });

  it('is a literal paid:true tally, not occupancy — enforcement (checkCapacity) stays on capacityUsage/isOccupying, this is display-only', () => {
    const event = baseEvent();
    const regs = [baseReg({ id: 'r1', paid: true, refunded: true, keepListed: true })];
    const usage = paidUsage(event, regs);
    expect(usage.totalAthletes).toBe(1);
  });

  it('empty for no paid regs', () => {
    const event = baseEvent();
    const regs = [baseReg({ id: 'r1', paid: false })];
    expect(paidUsage(event, regs).totalAthletes).toBe(0);
  });
});

describe('hasCapacityConfig', () => {
  it('false when no caps set anywhere', () => {
    const event = baseEvent();
    expect(hasCapacityConfig(event, [])).toBe(false);
  });

  it('true when a discipline cap (new shape) is set', () => {
    const event = baseEvent({ capacity: { perDiscipline: { WAG: { mode: 'discipline', cap: 100 } } } });
    expect(hasCapacityConfig(event, [])).toBe(true);
  });

  // Capacity rework, 2026-08-24 — T1: the event-wide `total` cap is dead —
  // ignored outright even when set to a real, non-null, positive number.
  it('a legacy total cap alone configures NOTHING — it is entirely ignored, no replacement', () => {
    const event = baseEvent({ capacity: { total: 100 } });
    expect(hasCapacityConfig(event, [])).toBe(false);
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

  it('stamps now + CART_HOLD_MINUTES when a discipline cap (new shape) is set', () => {
    const event = baseEvent({ capacity: { perDiscipline: { WAG: { mode: 'discipline', cap: 100 } } } });
    const stamp = holdStamp(event, [], NOW);
    expect(stamp).toBe(new Date(NOW + CART_HOLD_MINUTES * 60_000).toISOString());
  });

  it('undefined when only a legacy total cap is set (dead field, no replacement)', () => {
    const event = baseEvent({ capacity: { total: 100 } });
    expect(holdStamp(event, [], NOW)).toBeUndefined();
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
  it('LEGACY total cap is ignored entirely (removed by the 2026-08-24 rework)', () => {
    const event = baseEvent({ capacity: { total: 2 } as unknown as Event['capacity'] });
    const existing = [
      baseReg({ id: 'r1', athleteId: 'a1' }),
      baseReg({ id: 'r2', athleteId: 'a2' }),
    ];
    const incoming = [baseReg({ id: 'r3', athleteId: 'a3', paid: false, holdExpiresAt: FUTURE })];
    const violations = checkCapacity(event, [], existing, incoming, noGroups, NOW);
    expect(violations).toEqual([]);
  });

  it('LEGACY {total, perLevel}: total is dropped, perLevel maps into the discipline per-level mode', () => {
    const event = baseEvent({ capacity: { total: 2, perLevel: { 'lvl-silver': 6 } } as unknown as Event['capacity'] });
    const existing = [
      baseReg({ id: 'r1', athleteId: 'a1' }),
      baseReg({ id: 'r2', athleteId: 'a2' }),
    ];
    const incoming = [
      baseReg({ id: 'r3', athleteId: 'a3', paid: false, holdExpiresAt: FUTURE }),
    ];
    const violations = checkCapacity(event, [], existing, incoming, noGroups, NOW);
    expect(violations).toEqual([{
      scope: 'level', discipline: 'WAG', levelId: 'lvl-silver', cap: 6, used: 8, requested: 4, remaining: 0,
    }]);
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
      { scope: 'level', discipline: 'WAG', levelId: 'lvl-gold', cap: 3, used: 0, requested: 4, remaining: 3 },
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
      { scope: 'level', discipline: 'WAG', levelId: 'lvl-silver', cap: 4, used: 4, requested: 1, remaining: 0 },
    ]);
  });

  it('incoming waitlisted reg with a notified-but-LAPSED group hold still counts against a full discipline cap', () => {
    const event = baseEvent({ capacity: { perDiscipline: { WAG: { mode: 'discipline', cap: 1 } } } });
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
      // Routine-counting (P4 semantic, kept): r1 = 4 apparatus = 4 used; r2 adds 4.
      { scope: 'discipline', discipline: 'WAG', cap: 1, used: 4, requested: 4, remaining: 0 },
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
  it('greedily admits in order, waitlisting only what overflows the discipline cap', () => {
    // Each baseReg = 4 routines; cap 8 admits exactly two athletes.
    const event = baseEvent({ capacity: { perDiscipline: { WAG: { mode: 'discipline', cap: 8 } } } });
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
    const event = baseEvent({ capacity: { total: 10, perLevel: { 'lvl-gold': 4 } } as unknown as Event['capacity'] });
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
    // Each baseReg = 4 routines; cap 8 = two slots of four.
    const event = baseEvent({ capacity: { perDiscipline: { WAG: { mode: 'discipline', cap: 8 } } } });
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

describe('waitlistGroupKeyFor', () => {
  it('mirrors discipline/levelId/sessionId, nulling absent session', () => {
    const reg = baseReg({ sessionId: null });
    expect(waitlistGroupKeyFor(reg)).toEqual({ discipline: 'WAG', levelId: 'lvl-silver', sessionId: null });
  });

  it('nulls an empty-string sessionId, not just null/undefined (regression: rowToRegistration maps a null DB session_id to \'\', not null — a bare ?? would ship sessionId:\'\' into a new WaitlistGroup row and fail waitlist_groups_session_id_fkey; caught live on staging)', () => {
    const reg = baseReg({ sessionId: '' as unknown as null });
    expect(waitlistGroupKeyFor(reg)).toEqual({ discipline: 'WAG', levelId: 'lvl-silver', sessionId: null });
  });
});

describe('regsAffectedByViolations', () => {
  it('discipline violation implicates every non-refunded reg of that discipline only', () => {
    const regs = [
      baseReg({ id: 'r1' }),
      baseReg({ id: 'r2', levelId: 'other' }),
      baseReg({ id: 'r3', refunded: true }),
      baseReg({ id: 'r4', discipline: 'MAG', levelId: 'lvl-dev' }),
    ];
    const violations: CapacityViolation[] = [{ scope: 'discipline', discipline: 'WAG', cap: 2, used: 2, requested: 1, remaining: 0 }];
    expect(regsAffectedByViolations(regs, violations).map((r) => r.id)).toEqual(['r1', 'r2']);
  });

  it('level violation only implicates regs with a routine at that level', () => {
    const regs = [
      baseReg({ id: 'r1', levelId: 'lvl-gold' }),
      baseReg({ id: 'r2', levelId: 'lvl-silver' }),
    ];
    const violations: CapacityViolation[] = [{ scope: 'level', discipline: 'WAG', levelId: 'lvl-gold', cap: 4, used: 4, requested: 4, remaining: 0 }];
    expect(regsAffectedByViolations(regs, violations).map((r) => r.id)).toEqual(['r1']);
  });

  it('session violation requires matching sessionId AND apparatus', () => {
    const regs = [
      baseReg({ id: 'r1', sessionId: 's1', apparatus: ['VT'] }),
      baseReg({ id: 'r2', sessionId: 's1', apparatus: ['UB'] }),
      baseReg({ id: 'r3', sessionId: 's2', apparatus: ['VT'] }),
    ];
    const violations: CapacityViolation[] = [
      { scope: 'session', sessionId: 's1', apparatus: 'VT', cap: 1, used: 1, requested: 1, remaining: 0 },
    ];
    expect(regsAffectedByViolations(regs, violations).map((r) => r.id)).toEqual(['r1']);
  });
});

describe('groupRegsByWaitlistKey', () => {
  it('partitions regs sharing discipline/levelId/sessionId into one cohort each', () => {
    const regs = [
      baseReg({ id: 'r1', levelId: 'lvl-gold' }),
      baseReg({ id: 'r2', levelId: 'lvl-gold' }),
      baseReg({ id: 'r3', levelId: 'lvl-silver' }),
    ];
    const groups = groupRegsByWaitlistKey(regs);
    expect(groups).toHaveLength(2);
    expect(groups[0].key).toEqual({ discipline: 'WAG', levelId: 'lvl-gold', sessionId: null });
    expect(groups[0].regs.map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(groups[1].regs.map((r) => r.id)).toEqual(['r3']);
  });
});

describe('isWaitlistable (money-invariant gate, fable review of T6)', () => {
  it('a never-paid pending reg (paid:false, no updatedPending) IS waitlistable', () => {
    expect(isWaitlistable(baseReg({ paid: false }))).toBe(true);
  });

  it('paid undefined (never stamped) counts as unpaid — waitlistable', () => {
    expect(isWaitlistable(baseReg({ paid: undefined }))).toBe(true);
  });

  it('a PAID reg is never waitlistable', () => {
    expect(isWaitlistable(baseReg({ paid: true }))).toBe(false);
  });

  it('the updatedPending trap: a paid reg mid-change reads paid:false but still holds its purchased spot — NOT waitlistable', () => {
    expect(isWaitlistable(baseReg({ paid: false, updatedPending: true }))).toBe(false);
  });

  it('a refunded reg is not waitlistable (nothing to waitlist)', () => {
    expect(isWaitlistable(baseReg({ paid: false, refunded: true }))).toBe(false);
  });
});

describe('waitlistPosition', () => {
  const grp = (overrides: Partial<WaitlistGroup> = {}): WaitlistGroup => ({
    id: 'g1', eventId: 'evt1', discipline: 'WAG', status: 'waiting', queuedAt: PAST, ...overrides,
  });

  it('1-based FIFO rank among waiting groups for the same event, oldest first', () => {
    const groups = [
      grp({ id: 'g1', queuedAt: '2026-08-01T10:00:00Z' }),
      grp({ id: 'g2', queuedAt: '2026-08-01T09:00:00Z' }),
      grp({ id: 'g3', queuedAt: '2026-08-01T11:00:00Z' }),
    ];
    expect(waitlistPosition('g2', groups)).toBe(1);
    expect(waitlistPosition('g1', groups)).toBe(2);
    expect(waitlistPosition('g3', groups)).toBe(3);
  });

  it('only counts groups for the SAME event', () => {
    const groups = [
      grp({ id: 'g1', eventId: 'evt1', queuedAt: '2026-08-01T09:00:00Z' }),
      grp({ id: 'g2', eventId: 'evt2', queuedAt: '2026-08-01T08:00:00Z' }),
    ];
    expect(waitlistPosition('g1', groups)).toBe(1);
  });

  it('undefined for a group not in waiting status (notified/promoted/cancelled/expired)', () => {
    const groups = [
      grp({ id: 'g1', status: 'notified' }),
      grp({ id: 'g2', status: 'waiting' }),
    ];
    expect(waitlistPosition('g1', groups)).toBeUndefined();
  });

  it('undefined when the group id is not found', () => {
    expect(waitlistPosition('missing', [grp()])).toBeUndefined();
  });

  it('a notified/promoted group ahead in queued_at does not count toward position (only waiting groups compete)', () => {
    const groups = [
      grp({ id: 'g1', status: 'notified', queuedAt: '2026-08-01T08:00:00Z' }),
      grp({ id: 'g2', status: 'waiting', queuedAt: '2026-08-01T09:00:00Z' }),
    ];
    expect(waitlistPosition('g2', groups)).toBe(1);
  });
});
