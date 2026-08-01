import { describe, it, expect } from 'vitest';
import { unplacedScoreCount, sessionResults } from '../../src/lib/scoring';
import type { Event, Registration, Score } from '../../src/lib/types';

// Regression cover for the 2026-07-31 live finding: three scores existed in prod
// while every event's public results page read "No scores posted yet". Two
// separate defects produced that, and both are pinned here:
//   1. `sessionResults` scoped scores by `score.sessionId` — a write-time
//      snapshot that does NOT follow a registration's session reassignment.
//   2. There was no way to tell "no scores yet" from "scores exist but are
//      unreachable", so the page asserted the false one.

const reg = (over: Partial<Registration> & { id: string }): Registration => ({
  eventId: 'e1', athleteId: 'a-' + over.id, clubId: 'c1', discipline: 'MAG',
  levelId: 'lvl1', apparatus: ['FX'], sessionId: 's1', ...over,
} as Registration);

const score = (over: Partial<Score> & { regId: string }): Score => ({
  id: `e1|${over.regId}|FX`, eventId: 'e1', sessionId: null as unknown as string,
  apparatus: 'FX', final: 10, ...over,
} as Score);

const event = (): Event => ({
  id: 'e1', slug: 'e1', name: 'E1', disciplines: ['MAG'],
  sessions: [
    { id: 's1', name: 'S1', discipline: 'MAG', levelIds: ['lvl1'], squads: [] },
    { id: 's2', name: 'S2', discipline: 'MAG', levelIds: ['lvl1'], squads: [] },
  ],
} as unknown as Event);

describe('sessionResults score scoping', () => {
  it('surfaces a score whose own sessionId is null once its registration has a session', () => {
    // The exact prod shape: registration assigned to s1, score written earlier
    // with a null session. Before the fix this returned no score at all.
    const regs = [reg({ id: 'r1', sessionId: 's1' })];
    const scores = [score({ regId: 'r1', sessionId: null as unknown as string, final: 10.7 })];

    const out = sessionResults(event(), 's1', scores, regs);
    const row = out.byLevel.get('lvl1')?.[0];

    expect(row).toBeDefined();
    expect(row!.apparatus.FX?.final).toBe(10.7);
    expect(row!.aa).toBe(10.7);
  });

  it('follows a reassignment: a score stamped s1 shows under s2 when its reg moves to s2', () => {
    // The score's stale snapshot must not win over the registration.
    const regs = [reg({ id: 'r1', sessionId: 's2' })];
    const scores = [score({ regId: 'r1', sessionId: 's1', final: 9.9 })];

    expect(sessionResults(event(), 's2', scores, regs).byLevel.get('lvl1')?.[0].apparatus.FX?.final)
      .toBe(9.9);
    // ...and must NOT leak back into the session it was stamped with.
    expect(sessionResults(event(), 's1', scores, regs).byLevel.get('lvl1') ?? []).toHaveLength(0);
  });

  it('does not bleed one session\'s scores into another', () => {
    const regs = [reg({ id: 'r1', sessionId: 's1' }), reg({ id: 'r2', sessionId: 's2' })];
    const scores = [score({ regId: 'r1', final: 8 }), score({ regId: 'r2', final: 9 })];

    const s1 = sessionResults(event(), 's1', scores, regs).byLevel.get('lvl1')!;
    expect(s1).toHaveLength(1);
    expect(s1[0].apparatus.FX?.final).toBe(8);
  });
});

describe('unplacedScoreCount', () => {
  it('counts scores whose registration has no session', () => {
    const regs = [reg({ id: 'r1', sessionId: null }), reg({ id: 'r2', sessionId: null })];
    const scores = [score({ regId: 'r1' }), score({ regId: 'r2' })];
    expect(unplacedScoreCount(scores, regs)).toBe(2);
  });

  it('is zero when every score\'s registration is assigned', () => {
    const regs = [reg({ id: 'r1', sessionId: 's1' })];
    expect(unplacedScoreCount([score({ regId: 'r1' })], regs)).toBe(0);
  });

  it('counts a score whose registration is missing entirely', () => {
    // Also unreachable, and also worth telling someone about.
    expect(unplacedScoreCount([score({ regId: 'ghost' })], [])).toBe(1);
  });

  it('ignores refunded registrations — sessionResults drops those by design', () => {
    // A refunded reg's score being invisible is correct behavior, not a defect,
    // so reporting it would cry wolf on every refunded entry.
    const regs = [reg({ id: 'r1', sessionId: null, refunded: true })];
    expect(unplacedScoreCount([score({ regId: 'r1' })], regs)).toBe(0);
  });

  it('mixes correctly: only the unassigned, non-refunded ones count', () => {
    const regs = [
      reg({ id: 'ok', sessionId: 's1' }),
      reg({ id: 'orphan', sessionId: null }),
      reg({ id: 'refunded', sessionId: null, refunded: true }),
    ];
    const scores = [score({ regId: 'ok' }), score({ regId: 'orphan' }), score({ regId: 'refunded' })];
    expect(unplacedScoreCount(scores, regs)).toBe(1);
  });
});
