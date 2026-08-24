// Pure display math for the host/admin capacity progress summary (capacity
// rework, 2026-08-24 — T3). No React/store/Supabase imports — unit-tested in
// tests/capacity-progress.test.ts, same idiom as capacity.ts itself.
//
// Two independent views, matching the two registration modes:
//  - `disciplineProgress` — by-discipline mode: one row per capped discipline
//    (or per level, in 'perLevel' mode), in ATHLETES, worst-case (owners'
//    decision 2026-08-24 — see the doc comment below for the exact math).
//  - `sessionProgress` — by-session mode: one row per session with any capped
//    apparatus, in ROUTINES (sessions don't have an athlete-count concept).
//
// Neither function computes waitlist size — that requires a network call
// (`fetchEventWaitlist`, the same RLS-safe source `WaitlistCard` uses; a raw
// `db.waitlistGroups` read is INCOMPLETE for a non-admin host, since that
// table's RLS only exposes a group to its own club/person — see capacity.ts's
// WaitlistCard comment). The component joins that in separately.
import {
  APPARATUS,
  DISCIPLINES,
  type CapacityDisciplineConfig,
  type Discipline,
  type Event,
  type EventSession,
  type Level,
  type Registration,
  type WaitlistGroup,
} from './types';
import { capOf, capacityUsage, normalizeCapacity, paidUsage, regRoutines } from './capacity';

/** Apparatus codes that do NOT count toward "all-around" for the worst-case
 *  athlete-spot math below. TNT's 'SY' (Synchro Trampoline) is a partnered
 *  team event within TNT, not an individual AA event — the same distinction
 *  `RegistrationEditor.tsx` draws ("SY is an event within TNT, not its own
 *  discipline"). Every other apparatus in every discipline counts. Keeping
 *  this as an exclusion set (rather than hardcoding 4/6/3) means an edit to
 *  `APPARATUS` can't silently desync the divisor. */
const NON_AA_APPARATUS: ReadonlySet<string> = new Set(['SY']);

/** The number of routines one athlete competing a full all-around at
 *  `discipline` contributes — the divisor for "remaining cap → worst-case
 *  additional athletes". WAG 4, MAG 6, TNT 3 today, derived from `APPARATUS`
 *  rather than hardcoded. */
export function aaApparatusCount(discipline: Discipline): number {
  return APPARATUS[discipline].filter((a) => !NON_AA_APPARATUS.has(a.code)).length;
}

export const DISCIPLINE_LABELS: Record<Discipline, string> = { MAG: 'MAG', WAG: 'WAG', TNT: 'T&T' };

/** One progress row: either a whole discipline ('discipline' mode) or one
 *  level within a discipline ('perLevel' mode) — `levelId` distinguishes
 *  them. All counts are already floored/clamped; render directly. */
export interface DisciplineProgressRow {
  /** Stable React key: the discipline alone, or `${discipline}:${levelId}`. */
  key: string;
  discipline: Discipline;
  /** Present only for a 'perLevel'-mode row. */
  levelId?: string;
  /** Discipline name ("WAG"/"T&T") or the level's display name (falls back
   *  to the raw levelId if the level isn't found — e.g. a retired level). */
  label: string;
  /** Distinct PAID athletes counted toward this cap — display-only, never
   *  the enforcement/holds tally (never use this for a checkout decision). */
  paidAthletes: number;
  /** paidAthletes + floor(remaining PAID routine capacity / aaCount) —
   *  worst-case assuming every remaining registrant competes all-around.
   *  Deliberately blind to cart/hold routines (see `heldRoutines`): this is
   *  what makes the accompanying "assumes all-around" hint necessary, and
   *  why the muted routines sub-line matters for a host who wonders why
   *  checkout blocked before this bar looked full. */
  worstCaseTotalAthletes: number;
  /** Routines actually paid for. */
  paidRoutines: number;
  /** The configured routine cap for this discipline/level. */
  capRoutines: number;
  /** Enforcement tally (paid + live cart/promotion holds) minus paidRoutines
   *  — routines currently reserved by a hold that hasn't converted to a paid
   *  registration yet. */
  heldRoutines: number;
  /** The AA apparatus-count divisor used for this row's discipline. */
  aaCount: number;
}

function distinctPaidAthletes(regs: Registration[], eventId: string, discipline: Discipline): number {
  const ids = new Set<string>();
  for (const r of regs) {
    if (r.eventId === eventId && r.discipline === discipline && r.paid === true && !r.refunded) {
      ids.add(r.athleteId);
    }
  }
  return ids.size;
}

function distinctPaidAthletesAtLevel(
  regs: Registration[],
  eventId: string,
  discipline: Discipline,
  levelId: string,
): number {
  const ids = new Set<string>();
  for (const r of regs) {
    if (r.eventId !== eventId || r.discipline !== discipline || r.paid !== true || r.refunded) continue;
    // Per-apparatus level attribution (T&T): an athlete counts toward a
    // level's AA total if ANY of their routines attribute to it — mirrors
    // checkCapacity's own `regTouchesViolation` scoping for a 'level' cap.
    if (regRoutines(r).some((routine) => routine.levelId === levelId)) ids.add(r.athleteId);
  }
  return ids.size;
}

/**
 * Host/admin progress rows for by-discipline-mode capacity caps. Empty array
 * when the event is in by-session mode (discipline/level caps don't apply
 * there — mirrors `checkCapacity`/`hasCapacityConfig` in capacity.ts) or when
 * no discipline carries a live cap (mode 'none'/absent rows are omitted
 * outright, not rendered as "no cap").
 */
export function disciplineProgress(
  event: Event,
  regs: Registration[],
  levels: Level[],
  groupsById: Record<string, WaitlistGroup>,
  now: number,
): DisciplineProgressRow[] {
  if ((event.registrationMode ?? 'by-discipline') !== 'by-discipline') return [];

  const cfg = normalizeCapacity(event.capacity);
  const paid = paidUsage(event, regs);
  const enforced = capacityUsage(event, regs, groupsById, now);
  const rows: DisciplineProgressRow[] = [];

  for (const discipline of DISCIPLINES) {
    const entry: CapacityDisciplineConfig | undefined = cfg.perDiscipline?.[discipline];
    if (!entry || entry.mode === 'none') continue;
    const aaCount = aaApparatusCount(discipline);

    if (entry.mode === 'discipline') {
      const cap = capOf(entry.cap);
      if (cap === undefined) continue;
      const paidRoutines = paid.perDiscipline[discipline] ?? 0;
      const enforcedRoutines = enforced.perDiscipline[discipline] ?? 0;
      const paidAthletes = distinctPaidAthletes(regs, event.id, discipline);
      const worstCaseTotalAthletes = paidAthletes
        + Math.floor(Math.max(0, cap - paidRoutines) / aaCount);
      rows.push({
        key: discipline,
        discipline,
        label: DISCIPLINE_LABELS[discipline],
        paidAthletes,
        worstCaseTotalAthletes,
        paidRoutines,
        capRoutines: cap,
        heldRoutines: Math.max(0, enforcedRoutines - paidRoutines),
        aaCount,
      });
      continue;
    }

    // 'perLevel'
    for (const [levelId, rawCap] of Object.entries(entry.perLevel ?? {})) {
      const cap = capOf(rawCap);
      if (cap === undefined) continue;
      const paidRoutines = paid.perDisciplineLevel[discipline]?.[levelId] ?? 0;
      const enforcedRoutines = enforced.perDisciplineLevel[discipline]?.[levelId] ?? 0;
      const paidAthletes = distinctPaidAthletesAtLevel(regs, event.id, discipline, levelId);
      const worstCaseTotalAthletes = paidAthletes
        + Math.floor(Math.max(0, cap - paidRoutines) / aaCount);
      rows.push({
        key: `${discipline}:${levelId}`,
        discipline,
        levelId,
        label: levels.find((l) => l.id === levelId)?.name ?? levelId,
        paidAthletes,
        worstCaseTotalAthletes,
        paidRoutines,
        capRoutines: cap,
        heldRoutines: Math.max(0, enforcedRoutines - paidRoutines),
        aaCount,
      });
    }
  }

  return rows;
}

/** One capped apparatus within a session, for the detail overlay. */
export interface SessionApparatusRow {
  apparatus: string;
  cap: number;
  used: number;
  left: number;
}

/** One session's aggregate progress bar, plus its per-apparatus breakdown for
 *  the detail overlay. Uses the ENFORCEMENT tally (paid + live cart/promotion
 *  holds) throughout — by-session mode is about real bookable spots, so a
 *  session bar (unlike the by-discipline athlete bars) does NOT hide holds. */
export interface SessionProgressRow {
  sessionId: string;
  label: string;
  totalCap: number;
  totalUsed: number;
  /** round(totalUsed / totalCap * 100), NOT clamped to 100 — a caller
   *  rendering a bar fill should clamp; the raw value stays visible in text
   *  for an over-capacity edge state. */
  pctUsed: number;
  routinesLeft: number;
  /** Ordered per the discipline's canonical `APPARATUS` list, not object-key
   *  order (which is whatever order the wizard happened to save fields in). */
  apparatusRows: SessionApparatusRow[];
}

/**
 * Host/admin progress rows for by-session-mode capacity caps: one row per
 * session that has at least one capped apparatus. A session with no capped
 * apparatus is omitted entirely (nothing to show a bar for), matching
 * `disciplineProgress`'s no-cap-omitted convention.
 */
export function sessionProgress(
  event: Event,
  sessions: EventSession[],
  regs: Registration[],
  groupsById: Record<string, WaitlistGroup>,
  now: number,
): SessionProgressRow[] {
  const enforced = capacityUsage(event, regs, groupsById, now);
  const rows: SessionProgressRow[] = [];

  for (const session of sessions) {
    const capMap = session.maxRoutines ?? {};
    const canonicalOrder = APPARATUS[session.discipline].map((a) => a.code);
    const apparatusRows: SessionApparatusRow[] = [];
    let totalCap = 0;
    let totalUsed = 0;

    for (const apparatus of canonicalOrder) {
      const cap = capOf(capMap[apparatus]);
      if (cap === undefined) continue;
      const used = enforced.perSession[session.id]?.[apparatus] ?? 0;
      totalCap += cap;
      totalUsed += used;
      apparatusRows.push({ apparatus, cap, used, left: Math.max(0, cap - used) });
    }

    if (apparatusRows.length === 0) continue;

    rows.push({
      sessionId: session.id,
      label: session.name,
      totalCap,
      totalUsed,
      pctUsed: totalCap > 0 ? Math.round((totalUsed / totalCap) * 100) : 0,
      routinesLeft: Math.max(0, totalCap - totalUsed),
      apparatusRows,
    });
  }

  return rows;
}
