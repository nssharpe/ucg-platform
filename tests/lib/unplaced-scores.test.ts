import { describe, it, expect } from 'vitest';
import { unplacedScoreCount, sessionResults, UNASSIGNED_SESSION_ID } from '../../src/lib/scoring';
import { diffSessions, assignSessionIds } from '../../src/lib/events-core';
import type { Event, EventSession, Registration, Score } from '../../src/lib/types';

// Regression cover for the 2026-07-31 live finding: three scores existed in prod
// while every event's public results page read "No scores posted yet". Two
// separate defects produced that, and both are pinned here:
//   1. `sessionResults` scoped scores by `score.sessionId` — a write-time
//      snapshot that does NOT follow a registration's session reassignment.
//   2. There was no way to tell "no scores yet" from "scores exist but are
//      unreachable", so the page asserted the false one.
//
// UAT Z-06 (2026-08-2x) relapsed the same symptom via a different mechanism:
// editing an event's sessions (`remoteReplace`, delete-then-insert) minted new
// `event_sessions` ids on every save, which — via
// `registrations.session_id references event_sessions(id) on delete set null`
// — nulled/orphaned every registration's session even for a same-id round trip.
// The fix has two layers, both covered below:
//   1. `src/lib/events-core.ts`'s `diffSessions` — the write path now upserts
//      by id and deletes only ids that are truly gone, instead of a blanket
//      delete-then-insert.
//   2. `sessionResults`/`unplacedScoreCount` now resolve a score's session as
//      `registration.session_id` (if it still names a REAL session) else
//      `score.session_id` (if THAT names a real one) — and render/report
//      whatever still doesn't resolve as an explicit "Unassigned" group
//      instead of silently dropping it.

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

const SESSION_IDS = ['s1', 's2'];

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

  it('(a) falls back to a valid score.sessionId when the registration\'s own sessionId is stale', () => {
    // UAT Z-06: a sessions-editor save deleted the session `r1.sessionId`
    // used to point at, so it no longer names a real session on the event —
    // but the score it produced still carries a session id that IS real.
    const regs = [reg({ id: 'r1', sessionId: 's-stale' })];
    const scores = [score({ regId: 'r1', sessionId: 's1', final: 9.1 })];

    const row = sessionResults(event(), 's1', scores, regs).byLevel.get('lvl1')?.[0];
    expect(row).toBeDefined();
    expect(row!.apparatus.FX?.final).toBe(9.1);
    // Must not also show up anywhere else, including the escape-hatch group.
    expect(sessionResults(event(), UNASSIGNED_SESSION_ID, scores, regs).byLevel.get('lvl1') ?? []).toHaveLength(0);
  });

  it('(b) lands in the "Unassigned" group when neither the reg nor the score resolves', () => {
    const regs = [reg({ id: 'r1', sessionId: 's-stale' })];
    const scores = [score({ regId: 'r1', sessionId: 's-also-stale', final: 7.2 })];

    // Not shown under either real session.
    expect(sessionResults(event(), 's1', scores, regs).byLevel.get('lvl1') ?? []).toHaveLength(0);
    expect(sessionResults(event(), 's2', scores, regs).byLevel.get('lvl1') ?? []).toHaveLength(0);
    // But rendered, not dropped, under the explicit Unassigned group.
    const row = sessionResults(event(), UNASSIGNED_SESSION_ID, scores, regs).byLevel.get('lvl1')?.[0];
    expect(row).toBeDefined();
    expect(row!.apparatus.FX?.final).toBe(7.2);
  });
});

describe('unplacedScoreCount', () => {
  it('counts scores whose registration has no session', () => {
    const regs = [reg({ id: 'r1', sessionId: null }), reg({ id: 'r2', sessionId: null })];
    const scores = [score({ regId: 'r1' }), score({ regId: 'r2' })];
    expect(unplacedScoreCount(scores, regs, SESSION_IDS)).toBe(2);
  });

  it('is zero when every score\'s registration is assigned', () => {
    const regs = [reg({ id: 'r1', sessionId: 's1' })];
    expect(unplacedScoreCount([score({ regId: 'r1' })], regs, SESSION_IDS)).toBe(0);
  });

  it('counts a score whose registration is missing entirely', () => {
    // Also unreachable, and also worth telling someone about.
    expect(unplacedScoreCount([score({ regId: 'ghost' })], [], SESSION_IDS)).toBe(1);
  });

  it('ignores refunded registrations — sessionResults drops those by design', () => {
    // A refunded reg's score being invisible is correct behavior, not a defect,
    // so reporting it would cry wolf on every refunded entry.
    const regs = [reg({ id: 'r1', sessionId: null, refunded: true })];
    expect(unplacedScoreCount([score({ regId: 'r1' })], regs, SESSION_IDS)).toBe(0);
  });

  it('mixes correctly: only the unassigned, non-refunded ones count', () => {
    const regs = [
      reg({ id: 'ok', sessionId: 's1' }),
      reg({ id: 'orphan', sessionId: null }),
      reg({ id: 'refunded', sessionId: null, refunded: true }),
    ];
    const scores = [score({ regId: 'ok' }), score({ regId: 'orphan' }), score({ regId: 'refunded' })];
    expect(unplacedScoreCount(scores, regs, SESSION_IDS)).toBe(1);
  });

  it('(a) does not count a stale reg.sessionId when the score\'s own sessionId still resolves', () => {
    const regs = [reg({ id: 'r1', sessionId: 's-stale' })];
    const scores = [score({ regId: 'r1', sessionId: 's1' })];
    expect(unplacedScoreCount(scores, regs, SESSION_IDS)).toBe(0);
  });

  it('(b) counts a score when neither the reg nor the score resolves to a real session', () => {
    const regs = [reg({ id: 'r1', sessionId: 's-stale' })];
    const scores = [score({ regId: 'r1', sessionId: 's-also-stale' })];
    expect(unplacedScoreCount(scores, regs, SESSION_IDS)).toBe(1);
  });

  it('treats a session id absent from the CURRENT event.sessions as unresolved even though it is non-null', () => {
    // This is the exact UAT Z-06 gap: the old implementation only checked
    // `!!r.sessionId`, so a registration still pointing at a session an edit
    // had since deleted read as "placed" and the count silently stayed 0.
    const regs = [reg({ id: 'r1', sessionId: 'deleted-session' })];
    const scores = [score({ regId: 'r1', sessionId: null as unknown as string })];
    expect(unplacedScoreCount(scores, regs, SESSION_IDS)).toBe(1);
  });
});

const sessionRow = (id: string, name = id): EventSession =>
  ({ id, name, discipline: 'MAG', levelIds: [], squads: [] } as EventSession);

describe('diffSessions', () => {
  const s = sessionRow;

  it('preserves every id that survives — upsert is exactly the next list, verbatim', () => {
    const existing = [s('s1'), s('s2')];
    const next = [s('s1', 'S1 renamed'), s('s2')];
    const { upsert, deleteIds } = diffSessions(existing, next);
    expect(upsert).toEqual(next);
    expect(upsert.map((x) => x.id)).toEqual(['s1', 's2']);
    expect(deleteIds).toEqual([]);
  });

  it('detects a removed session and prunes only that id', () => {
    const existing = [s('s1'), s('s2'), s('s3')];
    const next = [s('s1'), s('s3')]; // s2 dropped
    const { upsert, deleteIds } = diffSessions(existing, next);
    expect(deleteIds).toEqual(['s2']);
    expect(upsert.map((x) => x.id)).toEqual(['s1', 's3']);
  });

  it('a reorder alone deletes nothing — same ids, different order', () => {
    const existing = [s('s1'), s('s2')];
    const next = [s('s2'), s('s1')];
    const { deleteIds } = diffSessions(existing, next);
    expect(deleteIds).toEqual([]);
  });

  it('a brand-new session (id absent from existing) is upserted, not treated as a deletion source', () => {
    const existing = [s('s1')];
    const next = [s('s1'), s('s-new')];
    const { upsert, deleteIds } = diffSessions(existing, next);
    expect(deleteIds).toEqual([]);
    expect(upsert.map((x) => x.id)).toEqual(['s1', 's-new']);
  });

  it('an empty existing list (create mode) never deletes anything', () => {
    const { deleteIds } = diffSessions([], [s('s1'), s('s2')]);
    expect(deleteIds).toEqual([]);
  });
});

describe('assignSessionIds', () => {
  it('keeps an existing id verbatim and mints one for a new draft', () => {
    const ids = assignSessionIds('e1', ['e1-s1', undefined], ['e1-s1']);
    expect(ids[0]).toBe('e1-s1');
    expect(ids[1]).toBe('e1-s2');
  });

  it('remove-one + add-one in the same save must NOT recycle the removed id (UAT Z-06)', () => {
    // s2 was removed; the surviving drafts are s1, s3, plus one brand-new one.
    const previousIds = ['e1-s1', 'e1-s2', 'e1-s3'];
    const draftIds: (string | undefined)[] = ['e1-s1', 'e1-s3', undefined];

    const ids = assignSessionIds('e1', draftIds, previousIds);
    expect(ids[0]).toBe('e1-s1');
    expect(ids[1]).toBe('e1-s3');
    expect(ids[2]).not.toBe('e1-s2'); // must not resurrect the removed session's id

    // End-to-end with diffSessions: the removed session is actually pruned,
    // not silently upserted-in-place under the new draft's content.
    const next = ids.map((id) => sessionRow(id));
    const existing = previousIds.map((id) => sessionRow(id));
    expect(diffSessions(existing, next).deleteIds).toEqual(['e1-s2']);
  });

  it('sanity check: WITHOUT seeding from previousIds, the mint recycles the removed id', () => {
    // Proves the test above actually exercises the fix — omitting
    // `previousIds` reproduces the exact bug `assignSessionIds` closes.
    const draftIds: (string | undefined)[] = ['e1-s1', 'e1-s3', undefined];
    const idsWithoutPreviousSeed = assignSessionIds('e1', draftIds, []);
    expect(idsWithoutPreviousSeed[2]).toBe('e1-s2');

    const next = idsWithoutPreviousSeed.map((id) => sessionRow(id));
    const existing = ['e1-s1', 'e1-s2', 'e1-s3'].map((id) => sessionRow(id));
    // The removed session survives the diff under its recycled id instead
    // of being pruned — exactly the failure this fix exists to prevent.
    expect(diffSessions(existing, next).deleteIds).toEqual([]);
  });

  it('an all-new create (no previous ids) mints densely from 1', () => {
    const ids = assignSessionIds('e1', [undefined, undefined, undefined], []);
    expect(ids).toEqual(['e1-s1', 'e1-s2', 'e1-s3']);
  });

  it('two new drafts in the same save never collide with each other', () => {
    const ids = assignSessionIds('e1', ['e1-s1', undefined, undefined], ['e1-s1']);
    expect(new Set(ids).size).toBe(3);
    expect(ids[1]).not.toBe(ids[2]);
  });
});
