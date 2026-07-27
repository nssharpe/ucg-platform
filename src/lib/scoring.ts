import type { DB, Discipline, Event, Registration, Score } from './types';
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

/** Pure. `scores` is a caller-supplied parameter (Phase 2, docs/specs/2026-07-24-
 *  data-layer-scale.md) rather than read off `db.scores` — scores are no
 *  longer globally hydrated, so this keeps the function pure/testable and
 *  makes the slice boundary honest. Callers pass the event's scores (e.g.
 *  from `useEventScores(event.id)`). */
export function sessionResults(db: DB, event: Event, sessionId: string, scores: Score[]): {
  byLevel: Map<string, AthleteResult[]>;
  apparatusRankings: ApparatusRanking[];
  teamScores: { clubId: string; total: number; perApparatus: Record<string, number> }[];
  discipline: Discipline;
} {
  const session = event.sessions.find((s) => s.id === sessionId)!;
  const regs = db.registrations.filter((r) => r.eventId === event.id && r.sessionId === sessionId && !r.refunded);
  const scopedScores = scores.filter((s) => s.eventId === event.id && s.sessionId === sessionId);
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
