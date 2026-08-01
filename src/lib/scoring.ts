import type { Discipline, Event, Registration, Score } from './types';
import { APPARATUS } from './types';

export interface AthleteResult {
  reg: Registration;
  apparatus: Record<string, Score | undefined>;
  aa: number; // sum of finals across entered apparatus
  aaComplete: boolean; // has score on every registered apparatus
}

export interface ApparatusRanking {
  apparatus: string;
  rows: { reg: Registration; score: Score; rank: number }[];
}

/** How many of an event's scores can never appear under ANY session tab.
 *
 *  A score is reachable only if its registration carries a `sessionId` (the
 *  results page always has one session selected, so a null-session registration
 *  matches nothing). Scores whose registration is missing entirely, or whose
 *  registration has no session, are "unplaced": real, stored, and invisible.
 *
 *  Exists so the results page can tell the truth instead of rendering
 *  "No scores posted yet" over the top of posted scores — the exact failure
 *  seen live in prod 2026-07-31, where every event read as empty while three
 *  scores sat in the database. Pure so it is testable without a DB.
 *
 *  Refunded registrations are excluded: `sessionResults` drops them by design,
 *  so their scores being unreachable is correct, not a defect to report. */
export function unplacedScoreCount(scores: Score[], allEventRegs: Registration[]): number {
  const placedRegIds = new Set(
    allEventRegs.filter((r) => r.sessionId && !r.refunded).map((r) => r.id),
  );
  const refundedRegIds = new Set(allEventRegs.filter((r) => r.refunded).map((r) => r.id));
  return scores.filter((s) => !placedRegIds.has(s.regId) && !refundedRegIds.has(s.regId)).length;
}

/** Pure. `scores` and `allEventRegs` are caller-supplied parameters (Phase 2/3,
 *  docs/specs/2026-07-24-data-layer-scale.md) rather than read off
 *  `db.scores`/`db.registrations` — neither is globally hydrated any more, so
 *  this keeps the function pure/testable and makes the slice boundary
 *  honest. Callers pass the event's scores/registrations (e.g. from
 *  `useEventScores(event.id)`/`useEventRegistrations(event.id)`). */
export function sessionResults(event: Event, sessionId: string, scores: Score[], allEventRegs: Registration[]): {
  byLevel: Map<string, AthleteResult[]>;
  apparatusRankings: ApparatusRanking[];
  teamScores: { clubId: string; total: number; perApparatus: Record<string, number> }[];
  discipline: Discipline;
} {
  const session = event.sessions.find((s) => s.id === sessionId)!;
  const regs = allEventRegs.filter((r) => r.eventId === event.id && r.sessionId === sessionId && !r.refunded);
  // Scope scores by the REGISTRATION set, never by `score.sessionId` (2026-07-31).
  // A score's own session is a denormalized snapshot taken when it was written;
  // the registration is the authority, and reassigning a registration's session
  // does NOT rewrite its scores. Filtering on the snapshot silently dropped every
  // score whose registration was assigned a session after the score was entered —
  // observed live in prod, where 3 posted scores rendered as "No scores posted yet"
  // on the public page. Keying off regIds cannot drift: a registration belongs to
  // exactly one session, and only regs in `regs` are ever looked up below.
  const regIds = new Set(regs.map((r) => r.id));
  const scopedScores = scores.filter((s) => s.eventId === event.id && regIds.has(s.regId));
  const scoreMap = new Map<string, Score>();
  for (const s of scopedScores) scoreMap.set(`${s.regId}|${s.apparatus}`, s);

  const results: AthleteResult[] = regs.map((reg) => {
    const apparatus: Record<string, Score | undefined> = {};
    let aa = 0;
    let aaComplete = true;
    for (const ev of reg.apparatus) {
      const sc = scoreMap.get(`${reg.id}|${ev}`);
      apparatus[ev] = sc;
      if (sc?.final != null) aa += sc.final;
      else aaComplete = false;
    }
    return { reg, apparatus, aa: Math.round(aa * 1000) / 1000, aaComplete };
  });

  const byLevel = new Map<string, AthleteResult[]>();
  for (const lid of session.levelIds) byLevel.set(lid, []);
  for (const r of results) {
    if (!byLevel.has(r.reg.levelId)) byLevel.set(r.reg.levelId, []);
    byLevel.get(r.reg.levelId)!.push(r);
  }
  for (const arr of byLevel.values()) arr.sort((a, b) => b.aa - a.aa);

  const evCodes = APPARATUS[session.discipline].map((e) => e.code);
  const apparatusRankings: ApparatusRanking[] = evCodes.map((ev) => {
    const rows = results
      .filter((r) => r.apparatus[ev]?.final != null)
      .map((r) => ({ reg: r.reg, score: r.apparatus[ev]!, rank: 0 }))
      .sort((a, b) => (b.score.final ?? 0) - (a.score.final ?? 0));
    rows.forEach((row, i) => {
      // ties share rank
      row.rank = i > 0 && rows[i - 1].score.final === row.score.final ? rows[i - 1].rank : i + 1;
    });
    return { apparatus: ev, rows };
  });

  // Team scores: top 3 finals per club per apparatus
  const clubIds = [...new Set(regs.map((r) => r.clubId))];
  const teamScores = clubIds.map((clubId) => {
    const perApparatus: Record<string, number> = {};
    let total = 0;
    for (const ev of evCodes) {
      const finals = results
        .filter((r) => r.reg.clubId === clubId && r.apparatus[ev]?.final != null)
        .map((r) => r.apparatus[ev]!.final!)
        .sort((a, b) => b - a)
        .slice(0, 3);
      const sum = Math.round(finals.reduce((s, f) => s + f, 0) * 1000) / 1000;
      perApparatus[ev] = sum;
      total += sum;
    }
    return { clubId, total: Math.round(total * 1000) / 1000, perApparatus };
  }).sort((a, b) => b.total - a.total);

  return { byLevel, apparatusRankings, teamScores, discipline: session.discipline };
}

export const fmtScore = (n: number | null | undefined) =>
  n == null ? '—' : n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '.0');

export const fmtMoney = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' }).replace(/\.00$/, '');
