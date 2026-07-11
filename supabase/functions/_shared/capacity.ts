// _shared/capacity.ts — Deno mirror of src/lib/capacity.ts (event-mgmt v2 Phase
// 4, capacity & sessions engine). Edge Functions bundle only the function dir +
// this `_shared/` folder, not `src/`, so we re-implement rather than import.
//
// KEEP LINE-FOR-LINE COMPARABLE WITH src/lib/capacity.ts. Any change to a cap
// rule, occupancy predicate, or violation shape must land in BOTH files. The
// vitest suite (tests/capacity.test.ts) is the correctness lock for the src
// side; this port has no local Deno runner, so it rides on the mirror + review.
//
// Row shapes here are snake_case DB columns (vs. the camelCase app types the
// src side operates on) — see supabase/migrations/20260711135842_emv2_p4_capacity_schema.sql
// and the base 20260601000001_schema.sql for the registrations/event_sessions
// columns this mirrors.

/** Minutes a cart-add soft hold reserves a registration's capacity spot for. */
export const CART_HOLD_MINUTES = 30;

/** Hours a promoted (notified) waitlist group's spot reservation lasts. */
export const PROMOTION_HOLD_HOURS = 24;

export interface RegRow {
  id: string;
  event_id: string;
  athlete_id: string;
  discipline: string;
  level_id: string | null;
  apparatus: string[] | null;
  apparatus_levels: Record<string, string> | null;
  session_id: string | null;
  paid: boolean | null;
  updated_pending: boolean | null;
  refunded: boolean | null;
  waitlisted: boolean | null;
  waitlist_group_id: string | null;
  hold_expires_at: string | null;
}

export interface SessionRow {
  id: string;
  max_routines: Record<string, number> | null;
}

export interface GroupRow {
  id: string;
  status: string;
  hold_expires_at: string | null;
}

export interface CapacityEventRow {
  id: string;
  capacity: {
    total?: number;
    perLevel?: Record<string, number>;
    perDiscipline?: Record<string, number>;
  } | null;
}

/** One routine (apparatus entry) a registration contributes toward capacity,
 *  attributed to whichever level actually governs that apparatus. */
export interface Routine {
  apparatus: string;
  levelId: string;
}

/** The routines (apparatus entries) a registration contributes. Per-apparatus
 *  level attribution: `reg.apparatus_levels?.[apparatus] ?? reg.level_id`. A
 *  reg with an empty/null `apparatus` array (e.g. a camp reg, or a blanked
 *  retained reg) contributes zero routines. */
export function regRoutines(reg: RegRow): Routine[] {
  return (reg.apparatus ?? []).map((apparatus) => ({
    apparatus,
    levelId: reg.apparatus_levels?.[apparatus] ?? reg.level_id ?? '',
  }));
}

/** A cap value read from jsonb config is only a cap if it's a finite number —
 *  a config UI clearing a field can persist explicit nulls (`{"total": null}`,
 *  a per-level map with null values), which must read as "not configured",
 *  never as a live cap (`combined > null` coerces to `> 0` and would 409
 *  every checkout for the event). */
function capOf(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** True if any value in a cap map is a real (finite-number) cap. */
function hasAnyCap(map: Record<string, unknown> | null | undefined): boolean {
  return !!map && Object.values(map).some((v) => capOf(v) !== undefined);
}

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
}

/** True while `group` (the registration's waitlist group) is in a promoted,
 *  still-live "notified" hold — its reserved spot counts against capacity so
 *  nobody else can take it during the 24h decision window. */
function groupHasLiveHold(group: GroupRow | undefined, now: number): boolean {
  if (!group) return false;
  if (group.status !== 'notified') return false;
  const holdExpires = parseTime(group.hold_expires_at);
  return holdExpires !== null && holdExpires > now;
}

/**
 * Whether a registration currently occupies a capacity spot for its event.
 * A refunded reg never occupies. Otherwise one of:
 *  1. `paid === true` or `updated_pending === true` (an updated-pending
 *     athlete already holds their spot; the change fee doesn't release it), or
 *  2. unpaid with a live soft hold (`hold_expires_at` in the future), or
 *  3. waitlisted AND its group is a live "notified" promotion hold.
 * Plain waitlisted regs (waiting/expired/cancelled group, or notified-but-
 * lapsed) do NOT occupy.
 */
export function isOccupying(
  reg: RegRow,
  groupsById: Record<string, GroupRow>,
  now: number,
): boolean {
  if (reg.refunded) return false;

  if (reg.waitlisted) {
    const group = reg.waitlist_group_id ? groupsById[reg.waitlist_group_id] : undefined;
    return groupHasLiveHold(group, now);
  }

  if (reg.paid === true || reg.updated_pending === true) return true;

  const holdExpires = parseTime(reg.hold_expires_at);
  return holdExpires !== null && holdExpires > now;
}

/** Aggregated capacity usage across a set of registrations for one event. */
export interface CapacityUsage {
  totalAthletes: number;
  perLevel: Record<string, number>;
  perDiscipline: Record<string, number>;
  /** perSession[sessionId][apparatusCode] = routine count. */
  perSession: Record<string, Record<string, number>>;
}

/** Internal tally over whichever regs `isCounted` admits. The checkout
 *  validators below count INCOMING regs unconditionally (except refunded) —
 *  an incoming reg IS the request being validated, so an expired cart hold or
 *  lapsed promotion hold must not let it slip through uncounted (oversell). */
function tallyUsage(
  eventId: string,
  regs: RegRow[],
  isCounted: (reg: RegRow) => boolean,
): CapacityUsage {
  const occupying = regs.filter((r) => r.event_id === eventId && isCounted(r));

  const athleteIds = new Set<string>();
  const perLevel: Record<string, number> = {};
  const perDiscipline: Record<string, number> = {};
  const perSession: Record<string, Record<string, number>> = {};

  for (const reg of occupying) {
    athleteIds.add(reg.athlete_id);

    for (const routine of regRoutines(reg)) {
      perLevel[routine.levelId] = (perLevel[routine.levelId] ?? 0) + 1;
      perDiscipline[reg.discipline] = (perDiscipline[reg.discipline] ?? 0) + 1;

      if (reg.session_id) {
        const sessionCounts = perSession[reg.session_id] ?? (perSession[reg.session_id] = {});
        sessionCounts[routine.apparatus] = (sessionCounts[routine.apparatus] ?? 0) + 1;
      }
    }
  }

  return { totalAthletes: athleteIds.size, perLevel, perDiscipline, perSession };
}

/** Tallies LIVE occupying-registration usage (via `isOccupying`):
 *  `totalAthletes` = distinct occupying athletes; `perLevel`/`perDiscipline`/
 *  `perSession` = routine (apparatus entry) counts. */
export function capacityUsage(
  eventId: string,
  regs: RegRow[],
  groupsById: Record<string, GroupRow>,
  now: number,
): CapacityUsage {
  return tallyUsage(eventId, regs, (r) => isOccupying(r, groupsById, now));
}

/** True if the event has ANY capacity configuration set — drives whether
 *  holds/countdowns are needed at all. */
export function hasCapacityConfig(event: CapacityEventRow, sessions: SessionRow[]): boolean {
  if (capOf(event.capacity?.total) !== undefined) return true;
  if (hasAnyCap(event.capacity?.perLevel)) return true;
  if (hasAnyCap(event.capacity?.perDiscipline)) return true;
  return sessions.some((s) => hasAnyCap(s.max_routines));
}

export type CapacityViolationScope = 'total' | 'level' | 'discipline' | 'session';

export interface CapacityViolation {
  scope: CapacityViolationScope;
  levelId?: string;
  discipline?: string;
  sessionId?: string;
  apparatus?: string;
  cap: number;
  used: number;
  requested: number;
  remaining: number;
}

/** Dedupes `incomingRegs` against `existingRegs` by id — a reg present in both
 *  is counted once, as incoming (checkout re-validates regs that already hold
 *  spots via a cart-add hold). */
function splitExistingIncoming(
  existingRegs: RegRow[],
  incomingRegs: RegRow[],
): { baseline: RegRow[]; incoming: RegRow[] } {
  const incomingIds = new Set(incomingRegs.map((r) => r.id));
  const baseline = existingRegs.filter((r) => !incomingIds.has(r.id));
  return { baseline, incoming: incomingRegs };
}

/**
 * Reports every capacity cap violated by adding `incomingRegs` on top of
 * `existingRegs`, with exact used/requested/remaining numbers. Empty array
 * means the whole incoming batch fits under every cap. All-or-nothing
 * checkout semantics live in the CALLER — this just enumerates violations.
 */
export function checkCapacity(
  event: CapacityEventRow,
  sessions: SessionRow[],
  existingRegs: RegRow[],
  incomingRegs: RegRow[],
  groupsById: Record<string, GroupRow>,
  now: number,
): CapacityViolation[] {
  const violations: CapacityViolation[] = [];
  const { baseline, incoming } = splitExistingIncoming(existingRegs, incomingRegs);

  // Baseline uses live-occupancy semantics; INCOMING regs count unconditionally
  // (except refunded) — they're the request under validation, so an expired
  // cart hold / lapsed promotion hold must still consume capacity here. A reg
  // in both lists was deduped out of `baseline` above, so it counts once, as
  // incoming (i.e. unconditionally).
  const incomingIds = new Set(incoming.map((r) => r.id));
  const baselinePredicate = (r: RegRow) => isOccupying(r, groupsById, now);
  const combinedPredicate = (r: RegRow) =>
    incomingIds.has(r.id) ? !r.refunded : baselinePredicate(r);

  const baselineUsage = tallyUsage(event.id, baseline, baselinePredicate);
  const combinedUsage = tallyUsage(event.id, [...baseline, ...incoming], combinedPredicate);

  // Total (athletes).
  const totalCap = capOf(event.capacity?.total);
  if (totalCap !== undefined) {
    const used = baselineUsage.totalAthletes;
    const requested = combinedUsage.totalAthletes - baselineUsage.totalAthletes;
    if (combinedUsage.totalAthletes > totalCap) {
      violations.push({
        scope: 'total',
        cap: totalCap,
        used,
        requested,
        remaining: Math.max(0, totalCap - used),
      });
    }
  }

  // Per-level (routines).
  const perLevelCap = event.capacity?.perLevel ?? {};
  for (const [levelId, rawCap] of Object.entries(perLevelCap)) {
    const cap = capOf(rawCap);
    if (cap === undefined) continue;
    const used = baselineUsage.perLevel[levelId] ?? 0;
    const combined = combinedUsage.perLevel[levelId] ?? 0;
    const requested = combined - used;
    if (combined > cap) {
      violations.push({
        scope: 'level',
        levelId,
        cap,
        used,
        requested,
        remaining: Math.max(0, cap - used),
      });
    }
  }

  // Per-discipline (routines; T&T).
  const perDisciplineCap = event.capacity?.perDiscipline ?? {};
  for (const [discipline, rawCap] of Object.entries(perDisciplineCap)) {
    const cap = capOf(rawCap);
    if (cap === undefined) continue;
    const used = baselineUsage.perDiscipline[discipline] ?? 0;
    const combined = combinedUsage.perDiscipline[discipline] ?? 0;
    const requested = combined - used;
    if (combined > cap) {
      violations.push({
        scope: 'discipline',
        discipline,
        cap,
        used,
        requested,
        remaining: Math.max(0, cap - used),
      });
    }
  }

  // Per-session per-apparatus (by-session mode).
  for (const session of sessions) {
    const maxRoutines = session.max_routines ?? {};
    for (const [apparatus, rawCap] of Object.entries(maxRoutines)) {
      const cap = capOf(rawCap);
      if (cap === undefined) continue;
      const used = baselineUsage.perSession[session.id]?.[apparatus] ?? 0;
      const combined = combinedUsage.perSession[session.id]?.[apparatus] ?? 0;
      const requested = combined - used;
      if (combined > cap) {
        violations.push({
          scope: 'session',
          sessionId: session.id,
          apparatus,
          cap,
          used,
          requested,
          remaining: Math.max(0, cap - used),
        });
      }
    }
  }

  return violations;
}

/**
 * Greedily admits `incomingRegs` (in given order) on top of `existingRegs`,
 * one at a time, keeping a reg only if it violates no cap given the existing
 * baseline plus everything already admitted. Used for the deliberate-split
 * "register the N who fit, waitlist the rest" option.
 */
export function splitFit(
  event: CapacityEventRow,
  sessions: SessionRow[],
  existingRegs: RegRow[],
  incomingRegs: RegRow[],
  groupsById: Record<string, GroupRow>,
  now: number,
): { fits: RegRow[]; overflow: RegRow[] } {
  const { baseline } = splitExistingIncoming(existingRegs, incomingRegs);
  const fits: RegRow[] = [];
  const overflow: RegRow[] = [];

  for (const reg of incomingRegs) {
    const violations = checkCapacity(event, sessions, baseline, [...fits, reg], groupsById, now);
    if (violations.length === 0) {
      fits.push(reg);
    } else {
      overflow.push(reg);
    }
  }

  return { fits, overflow };
}
