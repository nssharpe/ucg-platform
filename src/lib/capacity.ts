// Pure capacity/violation engine for event-mgmt v2 Phase 4 (capacity & sessions).
// No React/store/Supabase imports (types erase at compile time) — unit-tested in
// tests/capacity.test.ts. See Event.capacity / Event.registrationMode /
// EventSession.maxRoutines / Registration.{waitlisted,waitlistGroupId,holdExpiresAt}
// / WaitlistGroup in ./types for the shapes this operates on.
import type { Discipline, Event, EventSession, Registration, WaitlistGroup } from './types';

/** Minutes a cart-add soft hold reserves a registration's capacity spot for. */
export const CART_HOLD_MINUTES = 30;

/** Hours a promoted (notified) waitlist group's spot reservation lasts. */
export const PROMOTION_HOLD_HOURS = 24;

/** One routine (apparatus entry) a registration contributes toward capacity,
 *  attributed to whichever level actually governs that apparatus. */
export interface Routine {
  apparatus: string;
  levelId: string;
}

/** The routines (apparatus entries) a registration contributes. Per-apparatus
 *  level attribution: `reg.apparatusLevels?.[apparatus] ?? reg.levelId`. A reg
 *  with an empty `apparatus` array (e.g. a camp reg, or a blanked retained
 *  reg) contributes zero routines. */
export function regRoutines(reg: Registration): Routine[] {
  return (reg.apparatus ?? []).map((apparatus) => ({
    apparatus,
    levelId: reg.apparatusLevels?.[apparatus] ?? reg.levelId,
  }));
}

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
}

/** True while `group` (the registration's waitlist group) is in a promoted,
 *  still-live "notified" hold — its reserved spot counts against capacity so
 *  nobody else can take it during the 24h decision window. */
function groupHasLiveHold(group: WaitlistGroup | undefined, now: number): boolean {
  if (!group) return false;
  if (group.status !== 'notified') return false;
  const holdExpires = parseTime(group.holdExpiresAt);
  return holdExpires !== null && holdExpires > now;
}

/**
 * Whether a registration currently occupies a capacity spot for its event.
 * A refunded reg never occupies. Otherwise one of:
 *  1. `paid === true` or `updatedPending === true` (an updated-pending athlete
 *     already holds their spot; the change fee doesn't release it), or
 *  2. unpaid with a live soft hold (`holdExpiresAt` in the future), or
 *  3. waitlisted AND its group is a live "notified" promotion hold.
 * Plain waitlisted regs (waiting/expired/cancelled group, or notified-but-
 * lapsed) do NOT occupy.
 */
export function isOccupying(
  reg: Registration,
  groupsById: Record<string, WaitlistGroup>,
  now: number,
): boolean {
  if (reg.refunded) return false;

  if (reg.waitlisted) {
    const group = reg.waitlistGroupId ? groupsById[reg.waitlistGroupId] : undefined;
    return groupHasLiveHold(group, now);
  }

  if (reg.paid === true || reg.updatedPending === true) return true;

  const holdExpires = parseTime(reg.holdExpiresAt);
  return holdExpires !== null && holdExpires > now;
}

/** Aggregated capacity usage across a set of registrations for one event. */
export interface CapacityUsage {
  totalAthletes: number;
  perLevel: Record<string, number>;
  perDiscipline: Partial<Record<Discipline, number>>;
  /** perSession[sessionId][apparatusCode] = routine count. */
  perSession: Record<string, Record<string, number>>;
}

/** Tallies occupying-registration usage: `totalAthletes` = distinct occupying
 *  athletes; `perLevel`/`perDiscipline`/`perSession` = routine (apparatus
 *  entry) counts. */
export function capacityUsage(
  event: Event,
  regs: Registration[],
  groupsById: Record<string, WaitlistGroup>,
  now: number,
): CapacityUsage {
  const occupying = regs.filter((r) => r.eventId === event.id && isOccupying(r, groupsById, now));

  const athleteIds = new Set<string>();
  const perLevel: Record<string, number> = {};
  const perDiscipline: Partial<Record<Discipline, number>> = {};
  const perSession: Record<string, Record<string, number>> = {};

  for (const reg of occupying) {
    athleteIds.add(reg.athleteId);

    for (const routine of regRoutines(reg)) {
      perLevel[routine.levelId] = (perLevel[routine.levelId] ?? 0) + 1;
      perDiscipline[reg.discipline] = (perDiscipline[reg.discipline] ?? 0) + 1;

      if (reg.sessionId) {
        const sessionCounts = perSession[reg.sessionId] ?? (perSession[reg.sessionId] = {});
        sessionCounts[routine.apparatus] = (sessionCounts[routine.apparatus] ?? 0) + 1;
      }
    }
  }

  return { totalAthletes: athleteIds.size, perLevel, perDiscipline, perSession };
}

/** True if the event has ANY capacity configuration set — drives whether
 *  holds/countdowns are needed at all. */
export function hasCapacityConfig(event: Event, sessions: EventSession[]): boolean {
  if (event.capacity?.total !== undefined) return true;
  if (event.capacity?.perLevel && Object.keys(event.capacity.perLevel).length > 0) return true;
  if (event.capacity?.perDiscipline && Object.keys(event.capacity.perDiscipline).length > 0) return true;
  return sessions.some((s) => s.maxRoutines && Object.keys(s.maxRoutines).length > 0);
}

export type CapacityViolationScope = 'total' | 'level' | 'discipline' | 'session';

export interface CapacityViolation {
  scope: CapacityViolationScope;
  levelId?: string;
  discipline?: Discipline;
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
  existingRegs: Registration[],
  incomingRegs: Registration[],
): { baseline: Registration[]; incoming: Registration[] } {
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
  event: Event,
  sessions: EventSession[],
  existingRegs: Registration[],
  incomingRegs: Registration[],
  groupsById: Record<string, WaitlistGroup>,
  now: number,
): CapacityViolation[] {
  const violations: CapacityViolation[] = [];
  const { baseline, incoming } = splitExistingIncoming(existingRegs, incomingRegs);

  const baselineUsage = capacityUsage(event, baseline, groupsById, now);
  const combinedUsage = capacityUsage(event, [...baseline, ...incoming], groupsById, now);

  // Total (athletes).
  const totalCap = event.capacity?.total;
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
  for (const [levelId, cap] of Object.entries(perLevelCap)) {
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
  for (const [discipline, cap] of Object.entries(perDisciplineCap) as [Discipline, number][]) {
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
    const maxRoutines = session.maxRoutines ?? {};
    for (const [apparatus, cap] of Object.entries(maxRoutines)) {
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
  event: Event,
  sessions: EventSession[],
  existingRegs: Registration[],
  incomingRegs: Registration[],
  groupsById: Record<string, WaitlistGroup>,
  now: number,
): { fits: Registration[]; overflow: Registration[] } {
  const { baseline } = splitExistingIncoming(existingRegs, incomingRegs);
  const fits: Registration[] = [];
  const overflow: Registration[] = [];

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
