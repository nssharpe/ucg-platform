import { describe, it, expect } from 'vitest';
import type { DB, Event, NationalsConfig, Registration, Score } from '../../src/lib/types';
import {
  platformCategory,
  buildEntries,
  computeArtisticDiscipline,
  computeNationals,
} from '../../src/lib/nationals-adapter';

/** Minimal synthetic platform data exercising the adapter → engine seam. */
function scenario() {
  const config: NationalsConfig = {
    finalsLevelIds: ['wag-open'],
    cutoffs: {
      event: { 'Community Women+': { 'wag-open': 3 } },
      aa: { 'Community Women+': { 'wag-open': 3 } },
      team: {},
      teamMixed: {},
    },
  };
  const event = {
    id: 'm1', slug: 'nats', name: 'Nationals', hostClubId: 'c1', city: '', state: '', timezone: 'UTC',
    startDate: '', endDate: '', status: 'in-progress', regOpens: '', regCloses: '', entryFee: 0,
    secondDisciplineFee: 0, disciplines: ['WAG'], kind: 'nationals', nationalsConfig: config,
    sessions: [
      { id: 'sp', name: 'WAG Prelims', discipline: 'WAG', date: '', time: '', levelIds: ['wag-open'], squads: [], phase: 'prelim' },
      { id: 'sf', name: 'WAG Finals', discipline: 'WAG', date: '', time: '', levelIds: ['wag-open'], squads: [], phase: 'final' },
    ],
  } as unknown as Event;

  // 4 Community Women+ athletes; AA ranks A>B>C>D, cutoff 3 ⇒ A,B,C qualify.
  const names = ['A', 'B', 'C', 'D'];
  const people = names.map((n, i) => ({
    id: `p${i}`, kind: 'athlete', firstName: n, lastName: 'Last', email: `${n}@x.com`,
    gender: 'Female', studentStatus: 'Non-Student', mainClubId: i < 2 ? 'c1' : 'c2',
    placement: { WAG: 'women+' }, dob: '', gradYear: 1900, shirt: '', country: '', state: '', phone: '',
    memberships: [], achievements: [],
  }));
  const clubs = [
    { id: 'c1', name: 'Club One', shortName: 'C1', state: '', region: 'Other', managerIds: [], email: '', allowClubPay: false },
    { id: 'c2', name: 'Club Two', shortName: 'C2', state: '', region: 'Other', managerIds: [], email: '', allowClubPay: false },
  ];
  const evs = ['VT', 'UB', 'BB', 'FX'];
  const totals = [40, 38, 36, 34]; // descending AA
  const registrations: unknown[] = [];
  const scores: unknown[] = [];
  people.forEach((p, i) => {
    const reg = { id: `r${i}`, eventId: 'm1', athleteId: p.id, clubId: p.mainClubId, discipline: 'WAG', levelId: 'wag-open', apparatus: evs, sessionId: 'sp' };
    registrations.push(reg);
    for (const ev of evs) scores.push({ id: `${reg.id}|${ev}`, eventId: 'm1', sessionId: 'sp', regId: reg.id, apparatus: ev, sv: null, deductions: null, final: totals[i] / 4, enteredBy: 't', enteredAt: '', flashed: true });
  });
  // Finals scores for the three qualifiers (A,B,C) in the finals session.
  people.slice(0, 3).forEach((p, i) => {
    const reg = { id: `rf${i}`, eventId: 'm1', athleteId: p.id, clubId: p.mainClubId, discipline: 'WAG', levelId: 'wag-open', apparatus: evs, sessionId: 'sf' };
    registrations.push(reg);
    for (const ev of evs) scores.push({ id: `${reg.id}|${ev}`, eventId: 'm1', sessionId: 'sf', regId: reg.id, apparatus: ev, sv: null, deductions: null, final: (38 - i * 2) / 4, enteredBy: 't', enteredAt: '', flashed: true });
  });

  const db = { levels: [], clubs, people, events: [event], registrations, scores } as unknown as DB;
  return { db, event, registrations: registrations as unknown as Registration[], scores: scores as unknown as Score[] };
}

describe('nationals adapter', () => {
  it('derives placement category from explicit placement + student status', () => {
    expect(platformCategory('women+', 'Male', 'Student')).toBe('Collegiate Women+');
    expect(platformCategory(undefined, 'Female', 'Non-Student')).toBe('Community Women+');
    expect(platformCategory('men+', 'Female', 'Non-Student')).toBe('Community Men+');
  });

  it('builds engine entries from registrations + scores', () => {
    const { db, event, registrations, scores } = scenario();
    const entries = buildEntries(db, event, registrations, 'WAG', scores, 'prelim');
    expect(entries).toHaveLength(4);
    const a = entries.find((e) => e.first === 'A')!;
    expect(a.category).toBe('Community Women+');
    expect(a.club).toBe('Club One');
    expect(a.apparatus.VT.score).toBe(10); // 40 / 4
    expect(a.apparatus.VT.status).toBe('Included');
  });

  it('computes prelim AA placement + qualification through the engine', () => {
    const { db, event, registrations, scores } = scenario();
    const { prelims } = computeArtisticDiscipline(db, event, registrations, 'WAG', scores);
    const byName = new Map(prelims.results.map((r) => [r.entry.first, r]));
    expect(byName.get('A')!.aa!.place).toBe(1);
    expect(byName.get('D')!.aa!.place).toBe(4);
    // cutoff 3 ⇒ top three qualify, fourth does not
    expect(byName.get('C')!.aa!.qual).toBe('Y');
    expect(byName.get('D')!.aa!.qual).toBe('N');
  });

  it('scratched scores are excluded from placement', () => {
    const { db, event, registrations, scores } = scenario();
    // Scratch athlete A's vault — still place-eligible on other events, but VT place skips A.
    const aVault = (scores as unknown as { regId: string; apparatus: string; scratched?: boolean }[]).find((s) => s.regId === 'r0' && s.apparatus === 'VT')!;
    aVault.scratched = true;
    const { prelims } = computeArtisticDiscipline(db, event, registrations, 'WAG', scores);
    const a = prelims.results.find((r) => r.entry.first === 'A')!;
    expect(a.apparatus.VT.place).toBeNull();
  });

  it('computeNationals returns a WAG bundle for a Nationals event', () => {
    const { db, event, registrations, scores } = scenario();
    const bundle = computeNationals(db, event, registrations, scores);
    expect(bundle.wag).toBeTruthy();
    expect(bundle.wag!.awards.length).toBeGreaterThan(0);
  });
});
