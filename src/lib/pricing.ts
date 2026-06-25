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
// Pure pricing for meet registration. The host club's own athletes pay $0 for
// all registration-side fees (decision 3g: base entry, second-discipline, AND
// change fee are all waived when the competing-for club IS the meet's host).

/** Minimal slice of a `Meet` these helpers need (keeps them trivially testable). */
export type RegFeeMeet = {
  hostClubId: string;
  entryFee: number;
  secondDisciplineFee: number;
  changeFee?: { amount: number; startsAt: string };
};

/**
 * Entry fee for one discipline of a registration. $0 when the athlete competes
 * FOR the meet's host club; otherwise the second-discipline fee (if this is a
 * second discipline) or the base entry fee.
 */
export function registrationEntryFee(
  meet: RegFeeMeet,
  { competingClubId, isSecondDiscipline = false }: {
    competingClubId: string;
    isSecondDiscipline?: boolean;
  },
): number {
  if (competingClubId === meet.hostClubId) return 0;
  return isSecondDiscipline ? meet.secondDisciplineFee : meet.entryFee;
}

/**
 * Change fee for modifying a registration. $0 for the host club's own athletes;
 * otherwise the meet's configured change-fee amount (0 if none). Whether a change
 * fee applies AT ALL (eligibility per 3h, timing per `changeFee.startsAt`) is the
 * caller's decision — this only zeroes it for the host club.
 */
export function registrationChangeFee(
  meet: RegFeeMeet,
  { competingClubId }: { competingClubId: string },
): number {
  if (competingClubId === meet.hostClubId) return 0;
  return meet.changeFee?.amount ?? 0;
}

// --- Change-fee eligibility (3h) -------------------------------------------
// A pure predicate: given the BEFORE and AFTER state of an athlete's
// registration for a meet, is the change "meaningful" enough to be chargeable
// (i.e. show the "Add change to cart" action)?
//
// The normalized input shape is `RegChangeState`: a top-level `clubId` +
// `athleteId` (the same across all of an athlete's discipline entries) plus a
// `disciplines` array, one entry per discipline the athlete is registered in.
// Each `RegDisciplineEntry` carries the discipline-level (`levelId`), the chosen
// `events`, and optional per-event level overrides (`eventLevels`, used by T&T).
// This maps 1:1 from the RegistrationEditor's per-discipline draft.

/** One discipline's worth of an athlete's registration draft. */
export type RegDisciplineEntry = {
  discipline: Discipline;
  levelId: string;
  events: string[];
  /** Per-event level overrides (event code → levelId); T&T uses this. */
  eventLevels?: Record<string, string>;
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

function eventLevelsDiffer(
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
 * or T&T event-level (`eventLevels`) changed for a discipline in both; the
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

  // Level change (discipline-level or T&T event-level) for a shared discipline.
  for (const [disc, a] of afterMap) {
    const b = beforeMap.get(disc);
    if (!b) continue;
    if (a.levelId !== b.levelId) return true;
    if (eventLevelsDiffer(a.eventLevels, b.eventLevels)) return true;
  }

  // Note: a REMOVED discipline, or apparatus add/remove within an existing
  // discipline (events array only), is NOT eligible on its own.
  return false;
}

/** Is a coupon usable at `nowISO`? Checks time window + usage cap. */
export function couponValid(coupon: Coupon, nowISO: string): boolean {
  const now = Date.parse(nowISO);
  if (coupon.startsAt && Date.parse(coupon.startsAt) > now) return false;
  if (coupon.endsAt && Date.parse(coupon.endsAt) < now) return false;
  if (coupon.maxUses != null && (coupon.usedCount ?? 0) >= coupon.maxUses) return false;
  return true;
}

/** Apply a coupon's discount to an amount (never below 0). */
export function applyCoupon(amount: number, coupon: Coupon): number {
  if (coupon.amountOff != null) return Math.max(0, amount - coupon.amountOff);
  if (coupon.pctOff != null) return Math.max(0, amount * (1 - coupon.pctOff / 100));
  return amount;
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
