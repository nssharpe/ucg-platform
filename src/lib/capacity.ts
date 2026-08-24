// Pure capacity/violation engine for event-mgmt v2 Phase 4 (capacity & sessions).
// No React/store/Supabase imports (types erase at compile time) — unit-tested in
// tests/capacity.test.ts. See Event.capacity / Event.registrationMode /
// EventSession.maxRoutines / Registration.{waitlisted,waitlistGroupId,holdExpiresAt}
// / WaitlistGroup in ./types for the shapes this operates on.
//
// MIRRORED in supabase/functions/_shared/capacity.ts for edge-function
// enforcement (create-checkout-session) — snake_case DB row shapes there vs.
// the camelCase app types here, but identical function names/semantics. Keep
// the two in sync (same idiom as _shared/stripe.ts ↔ pricing.ts).
import {
  DISCIPLINES,
  type CapacityConfig,
  type CapacityConfigRaw,
  type CapacityDisciplineConfig,
  type Discipline,
  type Event,
  type EventSession,
  type Registration,
  type WaitlistGroup,
} from './types';

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
function hasAnyCap(map: Record<string, unknown> | undefined | null): boolean {
  return !!map && Object.values(map).some((v) => capOf(v) !== undefined);
}

/**
 * Reshapes `Event.capacity` (which may still be the legacy flat pre-2026-08-24
 * shape) into the canonical per-discipline `CapacityConfig`. Pass EVERY
 * capacity read through this — `checkCapacity`/`hasCapacityConfig` do, and no
 * other code should branch on `Event['capacity']`'s fields directly.
 *
 * Legacy mapping:
 *  - `total` is IGNORED outright (no replacement — owners approved dropping
 *    the event-wide athlete cap entirely; the event wizard shows a one-time
 *    migration notice for events that had one, T2).
 *  - `perDiscipline: {D: number}` becomes `perDiscipline[D] = {mode:
 *    'discipline', cap: number}`.
 *  - `perLevel: {levelId: number}` is discipline-independent in the legacy
 *    shape (nothing recorded which discipline a level id belonged to), so it
 *    is fanned out identically to EVERY discipline's `perLevel`. This is safe,
 *    not a double-count risk: enforcement (`checkCapacity`) tallies routines
 *    per (discipline, levelId) pair off each registration's OWN discipline, so
 *    a level id that never appears on a given discipline's registrations
 *    always reads zero usage there — a harmless no-op.
 *  - **A discipline present in BOTH legacy maps: `perLevel` wins.** This is
 *    the stricter reading and matches how `checkCapacity` treated the two
 *    dimensions as fully independent caps pre-rework (a routine could trip
 *    either one) — now that a discipline can only carry ONE mode, the
 *    finer-grained per-level constraint is kept.
 *  - A value already in the new shape (`{mode, cap?, perLevel?}`) passes
 *    through unchanged.
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

  const perDiscipline: Partial<Record<Discipline, CapacityDisciplineConfig>> = {};
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
  perDiscipline: Partial<Record<Discipline, number>>;
  /** perDisciplineLevel[discipline][levelId] = routine count, scoped to that
   *  discipline's OWN registrations — see `normalizeCapacity`'s legacy
   *  fan-out doc comment for why this scoping matters. */
  perDisciplineLevel: Partial<Record<Discipline, Record<string, number>>>;
  /** perSession[sessionId][apparatusCode] = routine count. */
  perSession: Record<string, Record<string, number>>;
}

/** Internal tally over whichever regs `isCounted` admits. The checkout
 *  validators below count INCOMING regs unconditionally (except refunded) —
 *  an incoming reg IS the request being validated, so an expired cart hold or
 *  lapsed promotion hold must not let it slip through uncounted (oversell). */
function tallyUsage(
  event: Event,
  regs: Registration[],
  isCounted: (reg: Registration) => boolean,
): CapacityUsage {
  const occupying = regs.filter((r) => r.eventId === event.id && isCounted(r));

  const athleteIds = new Set<string>();
  const perDiscipline: Partial<Record<Discipline, number>> = {};
  const perDisciplineLevel: Partial<Record<Discipline, Record<string, number>>> = {};
  const perSession: Record<string, Record<string, number>> = {};

  for (const reg of occupying) {
    athleteIds.add(reg.athleteId);

    for (const routine of regRoutines(reg)) {
      perDiscipline[reg.discipline] = (perDiscipline[reg.discipline] ?? 0) + 1;

      const levelCounts = perDisciplineLevel[reg.discipline] ?? (perDisciplineLevel[reg.discipline] = {});
      levelCounts[routine.levelId] = (levelCounts[routine.levelId] ?? 0) + 1;

      if (reg.sessionId) {
        const sessionCounts = perSession[reg.sessionId] ?? (perSession[reg.sessionId] = {});
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
  event: Event,
  regs: Registration[],
  groupsById: Record<string, WaitlistGroup>,
  now: number,
): CapacityUsage {
  return tallyUsage(event, regs, (r) => isOccupying(r, groupsById, now));
}

/** Tallies PAID-only usage (`r.paid === true`) — display-only, for the
 *  capacity progress UI (upcoming T3). Enforcement (`checkCapacity`) always
 *  keeps counting paid + live holds via `isOccupying`/`capacityUsage`; this
 *  is a separate, narrower view for showing hosts/managers how much of a cap
 *  is spoken for by completed purchases alone (excludes cart holds and
 *  promoted-waitlist holds). */
export function paidUsage(event: Event, regs: Registration[]): CapacityUsage {
  return tallyUsage(event, regs, (r) => r.paid === true);
}

/** True if the event has ANY capacity configuration set — drives whether
 *  holds/countdowns are needed at all. */
export function hasCapacityConfig(event: Event, sessions: EventSession[]): boolean {
  // Discipline/level caps exist only in by-discipline mode (owners' spec
  // 2026-08-24): a by-session event may still CARRY stale legacy caps in its
  // jsonb, but they must neither enforce nor trigger soft holds.
  const byDiscipline = (event.registrationMode ?? 'by-discipline') === 'by-discipline';
  const cfg = byDiscipline ? normalizeCapacity(event.capacity) : {};
  const anyDisciplineCap = Object.values(cfg.perDiscipline ?? {}).some((entry) => {
    if (!entry) return false;
    if (entry.mode === 'discipline') return capOf(entry.cap) !== undefined;
    if (entry.mode === 'perLevel') return hasAnyCap(entry.perLevel);
    return false;
  });
  if (anyDisciplineCap) return true;
  return sessions.some((s) => hasAnyCap(s.maxRoutines));
}

export type CapacityViolationScope = 'level' | 'discipline' | 'session';

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

  // Baseline uses live-occupancy semantics; INCOMING regs count unconditionally
  // (except refunded) — they're the request under validation, so an expired
  // cart hold / lapsed promotion hold must still consume capacity here. A reg
  // in both lists was deduped out of `baseline` above, so it counts once, as
  // incoming (i.e. unconditionally).
  const incomingIds = new Set(incoming.map((r) => r.id));
  const baselinePredicate = (r: Registration) => isOccupying(r, groupsById, now);
  const combinedPredicate = (r: Registration) =>
    incomingIds.has(r.id) ? !r.refunded : baselinePredicate(r);

  const baselineUsage = tallyUsage(event, baseline, baselinePredicate);
  const combinedUsage = tallyUsage(event, [...baseline, ...incoming], combinedPredicate);

  // Per-discipline, one of two modes (capacity rework, 2026-08-24 — T1: the
  // old event-wide `total` athlete cap is GONE, no replacement). Discipline/
  // level caps apply ONLY in by-discipline mode — a by-session event with
  // stale legacy caps in its jsonb must not double-enforce (T2 review).
  const cfg = (event.registrationMode ?? 'by-discipline') === 'by-discipline'
    ? normalizeCapacity(event.capacity) : {};
  for (const [discipline, entry] of Object.entries(cfg.perDiscipline ?? {}) as [Discipline, CapacityDisciplineConfig | undefined][]) {
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
    const maxRoutines = session.maxRoutines ?? {};
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
/**
 * Fresh cart-add soft-hold expiry (ISO timestamp), or `undefined` when the
 * event has no capacity configuration at all (nothing to hold a spot
 * against). Call this at the moment a registration is pushed IN CONJUNCTION
 * WITH creating/updating a cart line (entry or change) — never on a free
 * edit that adds no cart line, and never just because the reg was touched.
 * Pure/testable: `now` (epoch ms) is a parameter, no `Date.now()` inside.
 */
export function holdStamp(event: Event, sessions: EventSession[], now: number): string | undefined {
  if (!hasCapacityConfig(event, sessions)) return undefined;
  return new Date(now + CART_HOLD_MINUTES * 60_000).toISOString();
}

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

// ---- Checkout-rejection → waitlist helpers (event-mgmt v2 P4 T6) ----------
// A checkout-time 409 (`capacity-exceeded`) names the violated caps; these
// pure helpers translate that into WHICH of the checkout's own registrations
// are implicated, and how to group them into the same (discipline, level,
// session) cohorts `WaitlistGroup` rows key on (a `WaitlistGroup` is a whole
// cohort queuing together — see its doc comment in ./types).

/**
 * True if a registration may be flipped to a waitlist placeholder. ONLY a
 * never-paid registration qualifies: `paid !== true && updatedPending !==
 * true` (and not refunded). The `updatedPending` half is the money-invariant
 * trap this exists to close: an already-PAID reg edited into a chargeable
 * change reads `paid:false, updatedPending:true` while its change fee sits
 * in the cart — but the athlete still HOLDS their purchased spot
 * (`isOccupying` counts updatedPending as occupying). Waitlisting it would
 * silently release a paid-for spot, and "Leave waitlist" hard-deletes
 * waitlisted regs — for a paid-history reg, deletion is a REFUND action
 * only, never a cart-flow side effect. The correct resolution for a
 * non-waitlistable conflicted reg is removing the change line from the cart
 * (✕), which reverts the reg to its prior paid state.
 */
export function isWaitlistable(reg: Registration): boolean {
  return reg.paid !== true && reg.updatedPending !== true && !reg.refunded;
}

/** The (discipline, levelId, sessionId) key a registration's waitlist group
 *  would key on — mirrors `WaitlistGroup`'s own grouping columns exactly. */
export interface WaitlistGroupKey {
  discipline: Discipline;
  levelId: string | null;
  sessionId: string | null;
}

export function waitlistGroupKeyFor(reg: Registration): WaitlistGroupKey {
  // `||`, not `??`: `rowToRegistration` (supabase.ts) maps a null DB
  // `session_id` to `''` (empty string), not `null` — a `??` here would ship
  // `sessionId: ''` into a new `WaitlistGroup` row, which then fails
  // `waitlist_groups_session_id_fkey` (empty string isn't a valid FK target
  // and isn't NULL either) — caught live via a staging capacity-conflict
  // dry run (event-mgmt v2 P4 T6). `registrationToRow`'s own
  // `r.sessionId || null` is the same falsy-coalescing idiom.
  return { discipline: reg.discipline, levelId: reg.levelId || null, sessionId: reg.sessionId || null };
}

/** True if `reg` contributes at least one routine counted toward `violation`
 *  (i.e. reverting/waitlisting `reg` would help relieve that specific cap). A
 *  refunded reg never counts. A `level` violation is always scoped to a
 *  specific discipline (capacity rework, 2026-08-24 — T1), so it only
 *  implicates a reg of that SAME discipline with a matching routine level. */
function regTouchesViolation(reg: Registration, violation: CapacityViolation): boolean {
  if (reg.refunded) return false;
  const routines = regRoutines(reg);
  if (violation.scope === 'level') {
    return reg.discipline === violation.discipline && routines.some((r) => r.levelId === violation.levelId);
  }
  if (violation.scope === 'discipline') return reg.discipline === violation.discipline;
  // 'session'
  return reg.sessionId === violation.sessionId && routines.some((r) => r.apparatus === violation.apparatus);
}

/** Every `reg` (from the checkout's own registrations at the violated event)
 *  that touches at least one of `violations` — the set a "waitlist the whole
 *  group" resolution must act on. Order-preserving, no dedup needed (callers
 *  pass a reg list with unique ids). */
export function regsAffectedByViolations(
  regs: Registration[],
  violations: CapacityViolation[],
): Registration[] {
  return regs.filter((reg) => violations.some((v) => regTouchesViolation(reg, v)));
}

/** Partitions `regs` into cohorts sharing a `waitlistGroupKeyFor` key — one
 *  `WaitlistGroup` row per cohort. Insertion-ordered (first reg seen for a key
 *  determines that cohort's position). */
export function groupRegsByWaitlistKey(
  regs: Registration[],
): { key: WaitlistGroupKey; regs: Registration[] }[] {
  const order: string[] = [];
  const byKey = new Map<string, { key: WaitlistGroupKey; regs: Registration[] }>();
  for (const reg of regs) {
    const key = waitlistGroupKeyFor(reg);
    const k = `${key.discipline}|${key.levelId ?? ''}|${key.sessionId ?? ''}`;
    let entry = byKey.get(k);
    if (!entry) { entry = { key, regs: [] }; byKey.set(k, entry); order.push(k); }
    entry.regs.push(reg);
  }
  return order.map((k) => byKey.get(k)!);
}

// ---- Waitlist position (event-mgmt v2 P4 T7) -------------------------------

/**
 * 1-based rank of `groupId` among 'waiting' groups for the same event, in
 * strict FIFO order (`queuedAt` ascending, `id` as a stable tiebreaker for
 * equal timestamps). Returns `undefined` when the group isn't found in
 * `groups` or isn't currently in 'waiting' status (a notified/promoted/
 * cancelled/expired group has no queue position to show). Pure/display-only —
 * the promotion sweep (scheduled-dispatch) is the actual FIFO authority; this
 * just mirrors its ordering for UI display.
 */
export function waitlistPosition(groupId: string, groups: WaitlistGroup[]): number | undefined {
  const target = groups.find((g) => g.id === groupId);
  if (!target || target.status !== 'waiting') return undefined;
  const waiting = groups
    .filter((g) => g.eventId === target.eventId && g.status === 'waiting')
    .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt) || a.id.localeCompare(b.id));
  const idx = waiting.findIndex((g) => g.id === groupId);
  return idx >= 0 ? idx + 1 : undefined;
}
