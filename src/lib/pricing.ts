// Pure pricing & coupon-validity logic — no React/store/Supabase imports (types
// erase at compile time). Unit-tested in tests/pricing.test.ts. Used by the
// membership purchase flow (W6) and promo codes (W14).
import type { Coupon, Discipline, Membership, MembershipType, Season } from './types';

/** Base fee for a membership type in a season. */
export function membershipFee(season: Season, type: MembershipType): number {
  return type === 'coach' ? season.coachFee : season.athleteFee;
}

/**
 * Price to ADD a membership of `type` for `season`, given the person's existing
 * memberships. Rules (per 2026-06-18 feedback):
 *  - Adding coach when an athlete membership already exists that season → $0.
 *  - Adding athlete when a coach membership already exists that season →
 *    the difference (athleteFee − coachFee), floored at 0.
 *  - Otherwise the full fee for that type.
 * If the same-type membership already exists & is active, returns 0 (no re-charge).
 */
export function priceForAdding(
  season: Season,
  type: MembershipType,
  existing: Membership[],
): number {
  const sameSeason = existing.filter((m) => m.seasonId === season.id);
  const hasType = (t: MembershipType) =>
    sameSeason.some((m) => m.type === t && m.status === 'active');

  if (hasType(type)) return 0; // already have an active membership of this type

  if (type === 'coach' && hasType('athlete')) return 0;
  if (type === 'athlete' && hasType('coach')) {
    return Math.max(0, season.athleteFee - season.coachFee);
  }
  return membershipFee(season, type);
}

/**
 * Combined price to acquire ALL of `types` at once, given existing memberships.
 * Holding both athlete + coach is worth the HIGHER single fee (athlete), so
 * buying "both" together costs the athlete fee — not the sum. (Per 2026-06-22
 * feedback: athlete $50 / coach $40 / both $50.) Already-owned active types are
 * credited at their fee, so adding the cheaper type after the dearer one is $0
 * and adding the dearer after the cheaper costs only the difference.
 */
export function priceForTypes(
  season: Season,
  types: MembershipType[],
  existing: Membership[],
): number {
  const valueOf = (ts: MembershipType[]): number =>
    ts.reduce((max, t) => Math.max(max, membershipFee(season, t)), 0);
  const owned = existing
    .filter((m) => m.seasonId === season.id && m.status === 'active')
    .map((m) => m.type);
  const union = Array.from(new Set([...owned, ...types]));
  return Math.max(0, valueOf(union) - valueOf(owned));
}

/** Which membership types a person may purchase, from their profile roles. */
export function offeredMembershipTypes(roles: {
  athlete: boolean;
  coach: boolean;
}): MembershipType[] {
  const out: MembershipType[] = [];
  if (roles.athlete) out.push('athlete');
  if (roles.coach) out.push('coach');
  return out;
}

// --- Registration fees (3g/3h) ---------------------------------------------
// Pure pricing for event registration. The host club's own athletes pay $0 for
// all registration-side fees (decision 3g: base entry, second-discipline, AND
// change fee are all waived when the competing-for club IS the event's host).

/** Minimal slice of a `Event` these helpers need (keeps them trivially testable). */
export type RegFeeEvent = {
  hostClubId: string;
  entryFee: number;
  secondDisciplineFee: number;
  changeFee?: { amount: number; startsAt: string };
};

/**
 * Entry fee for one discipline of a registration. $0 when the athlete competes
 * FOR the event's host club; otherwise the second-discipline fee (if this is a
 * second discipline) or the base entry fee.
 */
export function registrationEntryFee(
  event: RegFeeEvent,
  { competingClubId, isSecondDiscipline = false }: {
    competingClubId: string;
    isSecondDiscipline?: boolean;
  },
): number {
  if (competingClubId === event.hostClubId) return 0;
  return isSecondDiscipline ? event.secondDisciplineFee : event.entryFee;
}

/**
 * Change fee for modifying a registration. $0 for the host club's own athletes;
 * otherwise the event's configured change-fee amount (0 if none). Whether a change
 * fee applies AT ALL (eligibility per 3h, timing per `changeFee.startsAt`) is the
 * caller's decision — this only zeroes it for the host club.
 */
export function registrationChangeFee(
  event: RegFeeEvent,
  { competingClubId }: { competingClubId: string },
): number {
  if (competingClubId === event.hostClubId) return 0;
  return event.changeFee?.amount ?? 0;
}

/**
 * Total entry fee owed for a brand-new registration purchase (3f/3g): the base
 * entry fee for the FIRST discipline plus the second-discipline fee for each
 * additional discipline, all zeroed for the host club's own athletes.
 *
 * `priorDisciplineCount` is how many disciplines the athlete is ALREADY
 * registered for at this event (so a discipline added when others exist counts as
 * a second discipline). `newDisciplineCount` is how many are being added now.
 * Returns 0 for the host club (every fee waived) — the caller treats a 0 total
 * as "nothing to purchase ⇒ create the registration already paid".
 */
export function newRegistrationEntryTotal(
  event: RegFeeEvent,
  { competingClubId, priorDisciplineCount, newDisciplineCount }: {
    competingClubId: string;
    priorDisciplineCount: number;
    newDisciplineCount: number;
  },
): number {
  if (competingClubId === event.hostClubId) return 0;
  let total = 0;
  for (let i = 0; i < newDisciplineCount; i++) {
    const isSecond = priorDisciplineCount + i > 0;
    total += isSecond ? event.secondDisciplineFee : event.entryFee;
  }
  return total;
}

// --- Change-fee eligibility (3h) -------------------------------------------
// A pure predicate: given the BEFORE and AFTER state of an athlete's
// registration for an event, is the change "meaningful" enough to be chargeable
// (i.e. show the "Add change to cart" action)?
//
// The normalized input shape is `RegChangeState`: a top-level `clubId` +
// `athleteId` (the same across all of an athlete's discipline entries) plus a
// `disciplines` array, one entry per discipline the athlete is registered in.
// Each `RegDisciplineEntry` carries the discipline-level (`levelId`), the chosen
// `apparatus`, and optional per-apparatus level overrides (`apparatusLevels`, used by T&T).
// This maps 1:1 from the RegistrationEditor's per-discipline draft.

/** One discipline's worth of an athlete's registration draft. */
export type RegDisciplineEntry = {
  discipline: Discipline;
  levelId: string;
  apparatus: string[];
  /** Per-event level overrides (event code → levelId); T&T uses this. */
  apparatusLevels?: Record<string, string>;
};

/** Normalized before/after snapshot of an athlete's whole registration. */
export type RegChangeState = {
  clubId: string;
  athleteId: string;
  disciplines: RegDisciplineEntry[];
};

function byDiscipline(state: RegChangeState): Map<Discipline, RegDisciplineEntry> {
  return new Map(state.disciplines.map((d) => [d.discipline, d]));
}

function apparatusLevelsDiffer(
  a: Record<string, string> | undefined,
  b: Record<string, string> | undefined,
): boolean {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const k of keys) {
    if ((a?.[k] ?? '') !== (b?.[k] ?? '')) return true;
  }
  return false;
}

/**
 * Is the change from `before` → `after` ELIGIBLE for a chargeable change?
 * Returns true if ANY of: a discipline was ADDED; a discipline-level (`levelId`)
 * or T&T apparatus-level (`apparatusLevels`) changed for a discipline in both; the
 * club changed; or the athlete was swapped. Adding/removing apparatus WITHIN an
 * already-registered discipline, REMOVING a discipline, or no change at all are
 * NOT (on their own) eligible.
 */
export function changeIsEligible(before: RegChangeState, after: RegChangeState): boolean {
  // Change club or swap athlete.
  if (before.clubId !== after.clubId) return true;
  if (before.athleteId !== after.athleteId) return true;

  const beforeMap = byDiscipline(before);
  const afterMap = byDiscipline(after);

  // Add a discipline (present in after, absent in before).
  for (const disc of afterMap.keys()) {
    if (!beforeMap.has(disc)) return true;
  }

  // Level change (discipline-level or T&T apparatus-level) for a shared discipline.
  for (const [disc, a] of afterMap) {
    const b = beforeMap.get(disc);
    if (!b) continue;
    if (a.levelId !== b.levelId) return true;
    if (apparatusLevelsDiffer(a.apparatusLevels, b.apparatusLevels)) return true;
  }

  // Note: a REMOVED discipline, or apparatus add/remove within an existing
  // discipline (events array only), is NOT eligible on its own.
  return false;
}

// --- Synchro-partner reassignment on athlete swap (3e) ---------------------
// When athlete `fromId` is swapped out for `toId` on their registrations, any
// OTHER registration that named `fromId` as its synchro partner must be
// repointed to `toId`. Pure: takes the registration slice it needs and returns
// the subset that CHANGED (so the caller can persist only those). Scope is the
// same one the partner model uses — the caller passes the registrations already
// filtered to the relevant event & non-refunded set.

/** Minimal slice of a registration the partner-reassign logic needs. */
export type PartnerReg = {
  id: string;
  athleteId: string;
  partnerAthleteId?: string | null;
};

/**
 * Of `regs`, return (a shallow copy of) each whose `partnerAthleteId` pointed at
 * `fromId`, with `partnerAthleteId` repointed to `toId`. Registrations belonging
 * to the swapped athlete themselves (athleteId === fromId/toId) are left for the
 * caller's swap logic and never returned here, so we don't clobber a self-link.
 * Only partners that pointed at the swapped-OUT athlete are touched.
 */
export function reassignPartners<T extends PartnerReg>(
  regs: T[],
  fromId: string,
  toId: string,
): T[] {
  if (fromId === toId) return [];
  const out: T[] = [];
  for (const r of regs) {
    if (r.athleteId === fromId || r.athleteId === toId) continue;
    if (r.partnerAthleteId === fromId) {
      out.push({ ...r, partnerAthleteId: toId });
    }
  }
  return out;
}

/** Is a coupon usable at `nowISO`? Checks time window + usage cap, plus a HARD
 *  expiration: when scoped to a specific event (`appliesTo === 'meet-entry'` +
 *  `appliesToEventId`), the code is invalid once that event's end date has
 *  passed — regardless of `endsAt` (a manual expiration set in the future
 *  cannot keep a code alive past the event it was created for). Pass the
 *  scoped event's `endDate` (ISO date) as `eventEndDateISO` when known. */
export function couponValid(coupon: Coupon, nowISO: string, eventEndDateISO?: string | null): boolean {
  const now = Date.parse(nowISO);
  if (coupon.startsAt && Date.parse(coupon.startsAt) > now) return false;
  if (coupon.endsAt && Date.parse(coupon.endsAt) < now) return false;
  if (coupon.maxUses != null && (coupon.usedCount ?? 0) >= coupon.maxUses) return false;
  if (coupon.appliesTo === 'meet-entry' && coupon.appliesToEventId && eventEndDateISO) {
    // End-of-day on the event's end date, so the code stays valid through the
    // event itself and only hard-expires the day after.
    const eventCutoff = Date.parse(eventEndDateISO) + 24 * 60 * 60 * 1000;
    if (eventCutoff < now) return false;
  }
  return true;
}

/** Apply a coupon's discount to an amount (never below 0). */
export function applyCoupon(amount: number, coupon: Coupon): number {
  if (coupon.amountOff != null) return Math.max(0, amount - coupon.amountOff);
  if (coupon.pctOff != null) return Math.max(0, amount * (1 - coupon.pctOff / 100));
  return amount;
}

/** Service fee passed to the payer: 3% + $0.30 of the order subtotal, in CENTS.
 *  Operates in Stripe's cent unit (distinct from the dollar-based legacy fns above).
 *  Rounds UP (never to-nearest) so the collected fee never falls a cent short
 *  of Stripe's actual processing fee on the total charged. Mirrors
 *  `processingFee` in supabase/functions/_shared/stripe.ts. */
export function processingFee(subtotalCents: number): number {
  return Math.ceil(subtotalCents * 0.03) + 30;
}

/** Generate a random uppercase promo code (default 8 chars, no ambiguous chars). */
export function randomPromoCode(len = 8): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I,O,0,1
  let out = '';
  for (let i = 0; i < len; i++) {
    // Deterministic-free randomness is fine here (codes, not security).
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}
