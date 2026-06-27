import type { DB, Discipline, Event, Registration, Score } from './types';
import { APPARATUS } from './types';

export interface AthleteResult {
  reg: Registration;
  events: Record<string, Score | undefined>;
  aa: number; // sum of finals across entered events
  aaComplete: boolean; // has score on every registered event
}

export interface EventRanking {
  event: string;
  rows: { reg: Registration; score: Score; rank: number }[];
}

export function sessionResults(db: DB, event: Event, sessionId: string): {
  byLevel: Map<string, AthleteResult[]>;
  eventRankings: EventRanking[];
  teamScores: { clubId: string; total: number; perEvent: Record<string, number> }[];
  discipline: Discipline;
} {
  const session = event.sessions.find((s) => s.id === sessionId)!;
  const regs = db.registrations.filter((r) => r.eventId === event.id && r.sessionId === sessionId && !r.refunded);
  const scores = db.scores.filter((s) => s.eventId === event.id && s.sessionId === sessionId);
  const scoreMap = new Map<string, Score>();
  for (const s of scores) scoreMap.set(`${s.regId}|${s.apparatus}`, s);

  const results: AthleteResult[] = regs.map((reg) => {
    const events: Record<string, Score | undefined> = {};
    let aa = 0;
    let aaComplete = true;
    for (const ev of reg.apparatus) {
      const sc = scoreMap.get(`${reg.id}|${ev}`);
      events[ev] = sc;
      if (sc?.final != null) aa += sc.final;
      else aaComplete = false;
    }
    return { reg, events, aa: Math.round(aa * 1000) / 1000, aaComplete };
  });

  const byLevel = new Map<string, AthleteResult[]>();
  for (const lid of session.levelIds) byLevel.set(lid, []);
  for (const r of results) {
    if (!byLevel.has(r.reg.levelId)) byLevel.set(r.reg.levelId, []);
    byLevel.get(r.reg.levelId)!.push(r);
  }
  for (const arr of byLevel.values()) arr.sort((a, b) => b.aa - a.aa);

  const evCodes = APPARATUS[session.discipline].map((e) => e.code);
  const eventRankings: EventRanking[] = evCodes.map((ev) => {
    const rows = results
      .filter((r) => r.events[ev]?.final != null)
      .map((r) => ({ reg: r.reg, score: r.events[ev]!, rank: 0 }))
      .sort((a, b) => (b.score.final ?? 0) - (a.score.final ?? 0));
    rows.forEach((row, i) => {
      // ties share rank
      row.rank = i > 0 && rows[i - 1].score.final === row.score.final ? rows[i - 1].rank : i + 1;
    });
    return { event: ev, rows };
  });

  // Team scores: top 3 finals per club per event
  const clubIds = [...new Set(regs.map((r) => r.clubId))];
  const teamScores = clubIds.map((clubId) => {
    const perEvent: Record<string, number> = {};
    let total = 0;
    for (const ev of evCodes) {
      const finals = results
        .filter((r) => r.reg.clubId === clubId && r.events[ev]?.final != null)
        .map((r) => r.events[ev]!.final!)
        .sort((a, b) => b - a)
        .slice(0, 3);
      const sum = Math.round(finals.reduce((s, f) => s + f, 0) * 1000) / 1000;
      perEvent[ev] = sum;
      total += sum;
    }
    return { clubId, total: Math.round(total * 1000) / 1000, perEvent };
  }).sort((a, b) => b.total - a.total);

  return { byLevel, eventRankings, teamScores, discipline: session.discipline };
}

export const fmtScore = (n: number | null | undefined) =>
  n == null ? '—' : n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '.0');

export const fmtMoney = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' }).replace(/\.00$/, '');
