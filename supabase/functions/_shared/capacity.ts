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

/** Mirrors `CapacityDisciplineConfig` (src/lib/types.ts). */
export interface CapacityDisciplineConfig {
  mode: 'none' | 'discipline' | 'perLevel';
  cap?: number | null;
  perLevel?: Record<string, number | null>;
}

/** Mirrors `CapacityConfig` (src/lib/types.ts) — canonical, post-normalize. */
export interface CapacityConfig {
  perDiscipline?: Record<string, CapacityDisciplineConfig>;
}

/** Mirrors `CapacityConfigRaw` (src/lib/types.ts) — `Event.capacity` as
 *  actually stored, legacy-flat-shape tolerant. Never branch on these fields
 *  directly; always go through `normalizeCapacity`. */
export interface CapacityConfigRaw {
  /** @deprecated legacy event-wide athlete cap — always ignored. */
  total?: number | null;
  perDiscipline?: Record<string, number | CapacityDisciplineConfig | null>;
  /** @deprecated legacy flat per-level cap, discipline-independent. */
  perLevel?: Record<string, number | null>;
}

export interface CapacityEventRow {
  id: string;
  capacity: CapacityConfigRaw | null;
  /** 'by-discipline' (default) | 'by-session' — discipline/level caps apply
   *  only in by-discipline mode. Optional so older callers that never select
   *  it keep today's (by-discipline) behavior. */
  registration_mode?: string | null;
}

/** Mirrors `DISCIPLINES` (src/lib/types.ts) — keep the three literal values in
 *  sync by hand. */
const DISCIPLINES = ['MAG', 'WAG', 'TNT'] as const;

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

/** A cap value read from jsonb config is only a LIVE cap if it's a positive
 *  integer — a config UI clearing a field can persist explicit nulls
 *  (`{"total": null}`, a per-level map with null values), which must read as
 *  "not configured", never as a live cap (`combined > null` coerces to
 *  `> 0` and would 409 every checkout for the event). Also rejects 0 and
 *  negative/non-integer values (capacity rework, 2026-08-24 — T1: 0 used to
 *  read as a live cap and would block every checkout for the event, since
 *  any non-negative usage count is `> 0`). */
function capOf(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;
}

/** True if any value in a cap map is a real (positive-integer) cap. */
function hasAnyCap(map: Record<string, unknown> | null | undefined): boolean {
  return !!map && Object.values(map).some((v) => capOf(v) !== undefined);
}

/**
 * Reshapes `CapacityEventRow.capacity` (which may still be the legacy flat
 * pre-2026-08-24 shape) into the canonical per-discipline `CapacityConfig`.
 * Mirrors `normalizeCapacity` in src/lib/capacity.ts — KEEP IN LOCKSTEP,
 * including the legacy-mapping rules documented there (in short: `total` is
 * ignored outright; `perDiscipline: {D: number}` becomes `{mode:
 * 'discipline', cap: number}`; `perLevel: {levelId: number}` fans out
 * identically to every discipline's `perLevel` since usage naturally
 * self-scopes per registration's own discipline at enforcement time; a
 * discipline present in both legacy maps has `perLevel` win, the stricter
 * reading).
 */
export function normalizeCapacity(raw: CapacityConfigRaw | null | undefined): CapacityConfig {
  if (!raw) return {};

  const legacyPerLevel: Record<string, number> = {};
  if (raw.perLevel) {
    for (const [levelId, v] of Object.entries(raw.perLevel)) {
      const cap = capOf(v);
      if (cap !== undefined) legacyPerLevel[levelId] = cap;
    }
  }
  const hasLegacyPerLevel = Object.keys(legacyPerLevel).length > 0;

  const perDiscipline: Record<string, CapacityDisciplineConfig> = {};
  for (const d of DISCIPLINES) {
    const existing = raw.perDiscipline?.[d];
    if (existing && typeof existing === 'object' && 'mode' in existing) {
      // Already the new shape — pass through unchanged.
      perDiscipline[d] = existing;
      continue;
    }
    if (hasLegacyPerLevel) {
      perDiscipline[d] = { mode: 'perLevel', perLevel: { ...legacyPerLevel } };
      continue;
    }
    const legacyCap = capOf(existing);
    if (legacyCap !== undefined) {
      perDiscipline[d] = { mode: 'discipline', cap: legacyCap };
    }
    // else: no cap configured for this discipline (mode 'none' implicit).
  }

  return Object.keys(perDiscipline).length ? { perDiscipline } : {};
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
  perDiscipline: Record<string, number>;
  /** perDisciplineLevel[discipline][levelId] = routine count, scoped to that
   *  discipline's OWN registrations — see `normalizeCapacity`'s legacy
   *  fan-out doc comment for why this scoping matters. */
  perDisciplineLevel: Record<string, Record<string, number>>;
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
  const perDiscipline: Record<string, number> = {};
  const perDisciplineLevel: Record<string, Record<string, number>> = {};
  const perSession: Record<string, Record<string, number>> = {};

  for (const reg of occupying) {
    athleteIds.add(reg.athlete_id);

    for (const routine of regRoutines(reg)) {
      perDiscipline[reg.discipline] = (perDiscipline[reg.discipline] ?? 0) + 1;

      const levelCounts = perDisciplineLevel[reg.discipline] ?? (perDisciplineLevel[reg.discipline] = {});
      levelCounts[routine.levelId] = (levelCounts[routine.levelId] ?? 0) + 1;

      if (reg.session_id) {
        const sessionCounts = perSession[reg.session_id] ?? (perSession[reg.session_id] = {});
        sessionCounts[routine.apparatus] = (sessionCounts[routine.apparatus] ?? 0) + 1;
      }
    }
  }

  return { totalAthletes: athleteIds.size, perDiscipline, perDisciplineLevel, perSession };
}

/** Tallies LIVE occupying-registration usage (via `isOccupying`):
 *  `totalAthletes` = distinct occupying athletes; `perDiscipline`/
 *  `perDisciplineLevel`/`perSession` = routine (apparatus entry) counts. */
export function capacityUsage(
  eventId: string,
  regs: RegRow[],
  groupsById: Record<string, GroupRow>,
  now: number,
): CapacityUsage {
  return tallyUsage(eventId, regs, (r) => isOccupying(r, groupsById, now));
}

/** Tallies PAID-only usage (`paid === true`) — display-only, for the capacity
 *  progress UI (upcoming T3). Enforcement (`checkCapacity`) always keeps
 *  counting paid + live holds via `isOccupying`/`capacityUsage`; this is a
 *  separate, narrower view for showing hosts/managers how much of a cap is
 *  spoken for by completed purchases alone. */
export function paidUsage(eventId: string, regs: RegRow[]): CapacityUsage {
  return tallyUsage(eventId, regs, (r) => r.paid === true);
}

/** True if the event has ANY capacity configuration set — drives whether
 *  holds/countdowns are needed at all. */
export function hasCapacityConfig(event: CapacityEventRow, sessions: SessionRow[]): boolean {
  const cfg = (event.registration_mode ?? 'by-discipline') === 'by-discipline'
    ? normalizeCapacity(event.capacity) : {};
  const anyDisciplineCap = Object.values(cfg.perDiscipline ?? {}).some((entry) => {
    if (!entry) return false;
    if (entry.mode === 'discipline') return capOf(entry.cap) !== undefined;
    if (entry.mode === 'perLevel') return hasAnyCap(entry.perLevel);
    return false;
  });
  if (anyDisciplineCap) return true;
  return sessions.some((s) => hasAnyCap(s.max_routines));
}

export type CapacityViolationScope = 'level' | 'discipline' | 'session';

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

  // Per-discipline, one of two modes (capacity rework, 2026-08-24 — T1: the
  // old event-wide `total` athlete cap is GONE, no replacement).
  const cfg = (event.registration_mode ?? 'by-discipline') === 'by-discipline'
    ? normalizeCapacity(event.capacity) : {};
  for (const [discipline, entry] of Object.entries(cfg.perDiscipline ?? {})) {
    if (!entry) continue;

    if (entry.mode === 'discipline') {
      const cap = capOf(entry.cap);
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
      continue;
    }

    if (entry.mode === 'perLevel') {
      for (const [levelId, rawCap] of Object.entries(entry.perLevel ?? {})) {
        const cap = capOf(rawCap);
        if (cap === undefined) continue;
        const used = baselineUsage.perDisciplineLevel[discipline]?.[levelId] ?? 0;
        const combined = combinedUsage.perDisciplineLevel[discipline]?.[levelId] ?? 0;
        const requested = combined - used;
        if (combined > cap) {
          violations.push({
            scope: 'level',
            discipline,
            levelId,
            cap,
            used,
            requested,
            remaining: Math.max(0, cap - used),
          });
        }
      }
    }
    // mode 'none': no cap for this discipline.
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
