// Pure pricing & coupon-validity logic — no React/store/Supabase imports (types
// erase at compile time). Unit-tested in tests/pricing.test.ts. Used by the
// membership purchase flow (W6) and promo codes (W14).
import type { Coupon, Membership, MembershipType, Season } from './types';

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
