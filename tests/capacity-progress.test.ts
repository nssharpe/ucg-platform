import { describe, it, expect } from 'vitest';
import {
  aaApparatusCount,
  disciplineProgress,
  sessionProgress,
} from '../src/lib/capacity-progress';
import type { Event, EventSession, Level, Registration, WaitlistGroup } from '../src/lib/types';

const NOW = new Date('2026-08-01T12:00:00Z').getTime();
const FUTURE = new Date('2026-08-01T13:00:00Z').toISOString(); // +1h

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
  id: `r-${Math.random()}`,
  eventId: 'evt1',
  athleteId: 'a1',
  clubId: 'club1',
  discipline: 'WAG',
  levelId: 'lvl1',
  apparatus: ['VT', 'UB', 'BB', 'FX'],
  sessionId: null,
  paid: true,
  ...overrides,
});

const noGroups: Record<string, WaitlistGroup> = {};

describe('aaApparatusCount', () => {
  it('WAG = 4, MAG = 6, TNT = 3 (SY excluded)', () => {
    expect(aaApparatusCount('WAG')).toBe(4);
    expect(aaApparatusCount('MAG')).toBe(6);
    expect(aaApparatusCount('TNT')).toBe(3);
  });
});

describe('disciplineProgress — discipline mode', () => {
  it('worked example: WAG cap 30 routines, 21 used by 6 athletes -> "6 of 8"', () => {
    const event = baseEvent({
      disciplines: ['WAG'],
      capacity: { perDiscipline: { WAG: { mode: 'discipline', cap: 30 } } },
    });
    const regs: Registration[] = [
      ...['a1', 'a2', 'a3', 'a4', 'a5'].map((id) => baseReg({ id: `r-${id}`, athleteId: id })),
      baseReg({ id: 'r-a6', athleteId: 'a6', apparatus: ['VT'] }),
    ];
    const rows = disciplineProgress(event, regs, [], noGroups, NOW);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.paidRoutines).toBe(21);
    expect(row.paidAthletes).toBe(6);
    expect(row.capRoutines).toBe(30);
    expect(row.worstCaseTotalAthletes).toBe(8);
    expect(row.heldRoutines).toBe(0);
    expect(row.aaCount).toBe(4);
  });

  it('partial-apparatus mix: fewer routines per athlete still divides correctly', () => {
    const event = baseEvent({
      disciplines: ['WAG'],
      capacity: { perDiscipline: { WAG: { mode: 'discipline', cap: 20 } } },
    });
    const regs: Registration[] = ['a1', 'a2', 'a3'].map((id) =>
      baseReg({ id: `r-${id}`, athleteId: id, apparatus: ['VT', 'FX'] }));
    const rows = disciplineProgress(event, regs, [], noGroups, NOW);
    const [row] = rows;
    expect(row.paidRoutines).toBe(6); // 3 athletes * 2 apparatus
    expect(row.paidAthletes).toBe(3);
    // remaining = 20 - 6 = 14, floor(14/4) = 3 -> 3 + 3 = 6
    expect(row.worstCaseTotalAthletes).toBe(6);
  });

  it('MAG divisor 6', () => {
    const event = baseEvent({
      disciplines: ['MAG'],
      capacity: { perDiscipline: { MAG: { mode: 'discipline', cap: 36 } } },
    });
    const regs: Registration[] = ['a1', 'a2', 'a3', 'a4'].map((id) =>
      baseReg({ id: `r-${id}`, athleteId: id, discipline: 'MAG', apparatus: ['FX', 'PH', 'SR', 'VT', 'PB', 'HB'] }));
    const rows = disciplineProgress(event, regs, [], noGroups, NOW);
    const [row] = rows;
    expect(row.aaCount).toBe(6);
    expect(row.paidRoutines).toBe(24);
    // remaining = 36 - 24 = 12, floor(12/6) = 2 -> 4 + 2 = 6
    expect(row.worstCaseTotalAthletes).toBe(6);
  });

  it('TNT divisor 3: SY routines count toward the cap but not the AA divisor', () => {
    const event = baseEvent({
      disciplines: ['TNT'],
      capacity: { perDiscipline: { TNT: { mode: 'discipline', cap: 12 } } },
    });
    const regs: Registration[] = ['a1', 'a2'].map((id) =>
      baseReg({ id: `r-${id}`, athleteId: id, discipline: 'TNT', apparatus: ['TR', 'DM', 'TU', 'SY'] }));
    const rows = disciplineProgress(event, regs, [], noGroups, NOW);
    const [row] = rows;
    expect(row.aaCount).toBe(3);
    expect(row.paidRoutines).toBe(8); // 2 athletes * 4 apparatus (incl. SY)
    // remaining = 12 - 8 = 4, floor(4/3) = 1 -> 2 + 1 = 3
    expect(row.worstCaseTotalAthletes).toBe(3);
  });

  it('no-cap discipline (mode "none" or absent) is omitted entirely', () => {
    const event = baseEvent({
      disciplines: ['WAG', 'TNT'],
      capacity: {
        perDiscipline: {
          WAG: { mode: 'discipline', cap: 10 },
          TNT: { mode: 'none' },
        },
      },
    });
    const rows = disciplineProgress(event, [], [], noGroups, NOW);
    expect(rows.map((r) => r.discipline)).toEqual(['WAG']);
  });

  it('holds delta: an unpaid live-hold reg counts toward heldRoutines, not paidRoutines/paidAthletes', () => {
    const event = baseEvent({
      disciplines: ['WAG'],
      capacity: { perDiscipline: { WAG: { mode: 'discipline', cap: 10 } } },
    });
    const regs: Registration[] = [
      baseReg({ id: 'r-a1', athleteId: 'a1' }), // paid, 4 routines
      baseReg({ id: 'r-a2', athleteId: 'a2', apparatus: ['VT', 'FX'], paid: false, holdExpiresAt: FUTURE }),
    ];
    const rows = disciplineProgress(event, regs, [], noGroups, NOW);
    const [row] = rows;
    expect(row.paidRoutines).toBe(4);
    expect(row.paidAthletes).toBe(1);
    expect(row.heldRoutines).toBe(2); // (4 paid + 2 held) - 4 paid
    // remaining = 10 - 4 = 6, floor(6/4) = 1 -> 1 + 1 = 2
    expect(row.worstCaseTotalAthletes).toBe(2);
  });

  it('by-session mode returns no discipline rows, even with stale legacy caps', () => {
    const event = baseEvent({
      registrationMode: 'by-session',
      capacity: { perDiscipline: { WAG: { mode: 'discipline', cap: 10 } } },
    });
    expect(disciplineProgress(event, [], [], noGroups, NOW)).toEqual([]);
  });
});

describe('disciplineProgress — perLevel mode', () => {
  const levels: Level[] = [
    { id: 'lvl-silver', discipline: 'WAG', name: 'Xcel Silver', svMax: null, vaults: 1, order: 1 },
    { id: 'lvl-gold', discipline: 'WAG', name: 'Xcel Gold', svMax: null, vaults: 1, order: 2 },
  ];

  it('one row per capped level, labeled by level name, uncapped levels omitted', () => {
    const event = baseEvent({
      disciplines: ['WAG'],
      capacity: {
        perDiscipline: {
          WAG: { mode: 'perLevel', perLevel: { 'lvl-silver': 18, 'lvl-gold': null } },
        },
      },
    });
    const regs: Registration[] = [
      ...['a1', 'a2'].map((id) => baseReg({ id: `r-${id}`, athleteId: id, levelId: 'lvl-silver' })),
      baseReg({ id: 'r-a3', athleteId: 'a3', levelId: 'lvl-gold', apparatus: ['VT'] }),
    ];
    const rows = disciplineProgress(event, regs, levels, noGroups, NOW);
    expect(rows).toHaveLength(1); // lvl-gold has no live cap (null) -> omitted
    const [row] = rows;
    expect(row.levelId).toBe('lvl-silver');
    expect(row.label).toBe('Xcel Silver');
    expect(row.paidRoutines).toBe(8); // 2 athletes * 4 apparatus
    expect(row.paidAthletes).toBe(2);
    expect(row.capRoutines).toBe(18);
  });

  it('per-apparatus level override (T&T-style) attributes an athlete to the level their routine actually used', () => {
    const tntLevels: Level[] = [
      { id: 'lvl-new', discipline: 'TNT', name: 'New Flyers', svMax: null, vaults: 0, order: 1 },
      { id: 'lvl-high', discipline: 'TNT', name: 'High Flyers', svMax: null, vaults: 0, order: 2 },
    ];
    const event = baseEvent({
      disciplines: ['TNT'],
      capacity: {
        perDiscipline: { TNT: { mode: 'perLevel', perLevel: { 'lvl-new': 10, 'lvl-high': 10 } } },
      },
    });
    const reg = baseReg({
      id: 'r-a1', athleteId: 'a1', discipline: 'TNT', levelId: 'lvl-new',
      apparatus: ['TR', 'SY'], apparatusLevels: { SY: 'lvl-high' },
    });
    const rows = disciplineProgress(event, [reg], tntLevels, noGroups, NOW);
    const newRow = rows.find((r) => r.levelId === 'lvl-new')!;
    const highRow = rows.find((r) => r.levelId === 'lvl-high')!;
    expect(newRow.paidAthletes).toBe(1);
    expect(newRow.paidRoutines).toBe(1);
    expect(highRow.paidAthletes).toBe(1);
    expect(highRow.paidRoutines).toBe(1);
  });

  it('a refunded (kept, blanked) registration never counts as a paid athlete', () => {
    const event = baseEvent({
      disciplines: ['WAG'],
      capacity: { perDiscipline: { WAG: { mode: 'discipline', cap: 10 } } },
    });
    const regs: Registration[] = [
      baseReg({ id: 'r-a1', athleteId: 'a1', paid: true, refunded: true, apparatus: [] }),
      baseReg({ id: 'r-a2', athleteId: 'a2', paid: true }),
    ];
    const rows = disciplineProgress(event, regs, [], noGroups, NOW);
    expect(rows[0].paidAthletes).toBe(1);
    expect(rows[0].paidRoutines).toBe(4);
  });
});

describe('sessionProgress', () => {
  const session = (overrides: Partial<EventSession> = {}): EventSession => ({
    id: 's1',
    name: 'Session 1',
    discipline: 'WAG',
    date: '2026-08-15',
    time: '09:00',
    levelIds: ['lvl1'],
    squads: [],
    ...overrides,
  });

  it('aggregates capped apparatus, canonical-orders rows regardless of object key order', () => {
    const s = session({ maxRoutines: { FX: 10, VT: 10 } }); // insertion order FX, VT
    const event = baseEvent({ registrationMode: 'by-session', sessions: [s] });
    const regs: Registration[] = [
      baseReg({ id: 'r1', athleteId: 'a1', sessionId: 's1', apparatus: ['VT', 'FX'] }),
    ];
    const rows = sessionProgress(event, [s], regs, noGroups, NOW);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    // WAG canonical order is VT, UB, BB, FX -> VT before FX despite object key order
    expect(row.apparatusRows.map((a) => a.apparatus)).toEqual(['VT', 'FX']);
    expect(row.totalCap).toBe(20);
    expect(row.totalUsed).toBe(2);
    expect(row.pctUsed).toBe(10);
    expect(row.routinesLeft).toBe(18);
    expect(row.apparatusRows.find((a) => a.apparatus === 'VT')).toEqual({ apparatus: 'VT', cap: 10, used: 1, left: 9 });
  });

  it('sessions with no capped apparatus are omitted', () => {
    const s = session({ id: 's2', maxRoutines: {} });
    const event = baseEvent({ registrationMode: 'by-session', sessions: [s] });
    expect(sessionProgress(event, [s], [], noGroups, NOW)).toEqual([]);
  });

  it('uses the enforcement tally (paid + live holds), not paid-only', () => {
    const s = session({ id: 's3', maxRoutines: { VT: 5 } });
    const event = baseEvent({ registrationMode: 'by-session', sessions: [s] });
    const regs: Registration[] = [
      baseReg({ id: 'r1', athleteId: 'a1', sessionId: 's3', apparatus: ['VT'], paid: true }),
      baseReg({ id: 'r2', athleteId: 'a2', sessionId: 's3', apparatus: ['VT'], paid: false, holdExpiresAt: FUTURE }),
    ];
    const rows = sessionProgress(event, [s], regs, noGroups, NOW);
    expect(rows[0].totalUsed).toBe(2);
    expect(rows[0].apparatusRows[0]).toEqual({ apparatus: 'VT', cap: 5, used: 2, left: 3 });
  });
});
