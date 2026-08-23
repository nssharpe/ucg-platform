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

/** A sentinel `sessionId` for `sessionResults` meaning "the scores that
 *  don't resolve to any real session" — the results page's explicit
 *  "Unassigned" group (UAT Z-06), rendered instead of silently dropping
 *  them. Never a real `EventSession.id`. */
export const UNASSIGNED_SESSION_ID = '__unassigned__';

/** Which session a registration's row is attributed to, given the CURRENT
 *  set of real session ids on the event. The registration's own `sessionId`
 *  is authoritative (2026-07-31) as long as it still names a real session;
 *  when it doesn't — e.g. a sessions-editor save deleted that session (UAT
 *  Z-06: `registrations.session_id references event_sessions(id) on delete
 *  set null` used to fire on every save, not just a real removal) — fall
 *  back to any of the registration's OWN scores that still carry a
 *  `sessionId` naming a real one; a stale write-time snapshot beats nothing.
 *  Returns null ("Unassigned") only when neither resolves. */
function resolveRegSessionId(reg: Registration, scoresForReg: Score[], validSessionIds: Set<string>): string | null {
  if (reg.sessionId && validSessionIds.has(reg.sessionId)) return reg.sessionId;
  const fallback = scoresForReg.find((s) => s.sessionId && validSessionIds.has(s.sessionId));
  return fallback ? fallback.sessionId : null;
}

/** How many of an event's scores resolve to no real session (see
 *  `resolveRegSessionId`) — they still render, under the results page's
 *  explicit "Unassigned" group (`UNASSIGNED_SESSION_ID`), so this count
 *  drives that group's caption rather than a hidden/missing count.
 *
 *  `sessionIds` must be the event's CURRENT session ids. Checking
 *  `reg.sessionId` for mere truthiness (as this used to) misses exactly the
 *  case that caused UAT Z-06's relapse: a registration whose `sessionId`
 *  still names a session a sessions-editor save has since deleted reads as
 *  "placed" under a truthiness check, while it is exactly as unreachable as
 *  a null one.
 *
 *  Exists so the results page can tell the truth instead of rendering
 *  "No scores posted yet" over the top of posted scores — the exact failure
 *  seen live in prod 2026-07-31, where every event read as empty while three
 *  scores sat in the database. Pure so it is testable without a DB.
 *
 *  Refunded registrations are excluded: `sessionResults` drops them by design,
 *  so their scores being unreachable is correct, not a defect to report. */
export function unplacedScoreCount(scores: Score[], allEventRegs: Registration[], sessionIds: string[]): number {
  const validIds = new Set(sessionIds);
  const regById = new Map(allEventRegs.map((r) => [r.id, r]));
  const scoresByReg = new Map<string, Score[]>();
  for (const s of scores) {
    const arr = scoresByReg.get(s.regId);
    if (arr) arr.push(s); else scoresByReg.set(s.regId, [s]);
  }
  return scores.filter((s) => {
    const reg = regById.get(s.regId);
    if (reg?.refunded) return false;
    if (!reg) return true; // ghost registration — nothing to resolve against, can't ever render
    return resolveRegSessionId(reg, scoresByReg.get(s.regId) ?? [], validIds) === null;
  }).length;
}

/** Pure. `scores` and `allEventRegs` are caller-supplied parameters (Phase 2/3,
 *  docs/specs/2026-07-24-data-layer-scale.md) rather than read off
 *  `db.scores`/`db.registrations` — neither is globally hydrated any more, so
 *  this keeps the function pure/testable and makes the slice boundary
 *  honest. Callers pass the event's scores/registrations (e.g. from
 *  `useEventScores(event.id)`/`useEventRegistrations(event.id)`).
 *
 *  Pass `UNASSIGNED_SESSION_ID` for `sessionId` to get the "Unassigned"
 *  group instead of a real session's results — every registration whose
 *  session can't be resolved (see `resolveRegSessionId`) but that has at
 *  least one posted score. Since those registrations may span disciplines
 *  the returned `discipline`/apparatus set is best-effort (whichever
 *  discipline the first row has) rather than a real session's fixed one. */
export function sessionResults(event: Event, sessionId: string, scores: Score[], allEventRegs: Registration[]): {
  byLevel: Map<string, AthleteResult[]>;
  apparatusRankings: ApparatusRanking[];
  teamScores: { clubId: string; total: number; perApparatus: Record<string, number> }[];
  discipline: Discipline;
} {
  const isUnassigned = sessionId === UNASSIGNED_SESSION_ID;
  const validIds = new Set(event.sessions.map((s) => s.id));
  const session = isUnassigned ? undefined : event.sessions.find((s) => s.id === sessionId)!;

  const eventScores = scores.filter((s) => s.eventId === event.id);
  const scoresByReg = new Map<string, Score[]>();
  for (const s of eventScores) {
    const arr = scoresByReg.get(s.regId);
    if (arr) arr.push(s); else scoresByReg.set(s.regId, [s]);
  }

  // Scope scores by the REGISTRATION set, never by `score.sessionId` (2026-07-31).
  // A score's own session is a denormalized snapshot taken when it was written;
  // the registration is the authority, and reassigning a registration's session
  // does NOT rewrite its scores. Filtering on the snapshot silently dropped every
  // score whose registration was assigned a session after the score was entered —
  // observed live in prod, where 3 posted scores rendered as "No scores posted yet"
  // on the public page. Keying off regIds cannot drift: a registration belongs to
  // exactly one session, and only regs in `regs` are ever looked up below.
  //
  // `resolveRegSessionId` (UAT Z-06) is that same registration-first rule with one
  // addition: the registration's `sessionId` must still name a REAL session, or the
  // resolution falls back to the score's own stamp — and if THAT doesn't resolve
  // either, the registration lands in the explicit "Unassigned" group instead of
  // being silently dropped.
  const regs = allEventRegs.filter((r) => {
    if (r.eventId !== event.id || r.refunded) return false;
    const scoresForReg = scoresByReg.get(r.id) ?? [];
    const resolved = resolveRegSessionId(r, scoresForReg, validIds);
    return isUnassigned ? (resolved === null && scoresForReg.length > 0) : resolved === sessionId;
  });
  const regIds = new Set(regs.map((r) => r.id));
  const scopedScores = eventScores.filter((s) => regIds.has(s.regId));
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
  if (!isUnassigned) for (const lid of session!.levelIds) byLevel.set(lid, []);
  for (const r of results) {
    if (!byLevel.has(r.reg.levelId)) byLevel.set(r.reg.levelId, []);
    byLevel.get(r.reg.levelId)!.push(r);
  }
  for (const arr of byLevel.values()) arr.sort((a, b) => b.aa - a.aa);

  const discipline: Discipline = isUnassigned
    ? (regs[0]?.discipline ?? event.disciplines[0] ?? 'MAG')
    : session!.discipline;
  const evCodes = APPARATUS[discipline].map((e) => e.code);
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

  return { byLevel, apparatusRankings, teamScores, discipline };
}

export const fmtScore = (n: number | null | undefined) =>
  n == null ? '—' : n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '.0');

export const fmtMoney = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' }).replace(/\.00$/, '');
