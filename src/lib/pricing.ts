// Pure pricing & coupon-validity logic — no React/store/Supabase imports (types
// erase at compile time). Unit-tested in tests/pricing.test.ts. Used by the
// membership purchase flow (W6) and promo codes (W14).
import type { CartItem, Coupon, Discipline, Membership, MembershipType, Season } from './types';

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
  /** Late-registration surcharge (emv2 P0 Task 3), added ON TOP of the normal
   *  entry/second-discipline fee — NOT the change fee (rule 4). Fee in DOLLARS. */
  lateReg?: { startsAt: string; fee: number };
};

/**
 * Does the late-registration surcharge apply, given the EARLIEST `createdAt`
 * among the athlete's referenced registrations for this event? (Rule 1/2: the
 * anchor is registration-CREATION time, once per athlete per event — not
 * per-discipline, not payment time.) `>=` at the boundary applies the fee
 * (rule: "at or after"). No `lateReg` configured ⇒ never applies.
 */
export function lateFeeApplies(
  event: Pick<RegFeeEvent, 'lateReg'>,
  earliestCreatedAtISO: string,
): boolean {
  if (!event.lateReg) return false;
  return Date.parse(earliestCreatedAtISO) >= Date.parse(event.lateReg.startsAt);
}

/**
 * Entry fee for one discipline of a registration. $0 when the athlete competes
 * FOR the event's host club; otherwise the second-discipline fee (if this is a
 * second discipline) or the base entry fee.
 *
 * Late-registration surcharge (emv2 P0 Task 3, optional so existing callers
 * are unaffected): pass `late.earliestCreatedAtISO` (earliest `createdAt`
 * among the athlete's regs at this event, per rule 2's once-per-athlete
 * anchor) to add `event.lateReg.fee` on top when it lands at/after
 * `lateReg.startsAt`. Only meaningful for the FIRST discipline of a brand-new
 * registration in isolation — callers pricing a whole multi-discipline
 * purchase at once should use `newRegistrationEntryTotal` instead, which
 * applies the surcharge once regardless of `newDisciplineCount`.
 */
export function registrationEntryFee(
  event: RegFeeEvent,
  { competingClubId, isSecondDiscipline = false, late }: {
    competingClubId: string;
    isSecondDiscipline?: boolean;
    /** Late-fee inputs (Task 3). Omit to preserve pre-Task-3 behavior. */
    late?: { earliestCreatedAtISO: string };
  },
): number {
  if (competingClubId === event.hostClubId) return 0;
  const base = isSecondDiscipline ? event.secondDisciplineFee : event.entryFee;
  if (late && lateFeeApplies(event, late.earliestCreatedAtISO)) {
    return base + (event.lateReg?.fee ?? 0);
  }
  return base;
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
 *
 * Late-registration surcharge (emv2 P0 Task 3, optional `late` param so
 * existing callers are unaffected): added ONCE per athlete per event — not
 * per-discipline (rule 2) — and never for the host club (rule 3, checked
 * first above). Pass `earliestCreatedAtISO`: the earliest `createdAt` among
 * ALL of the athlete's registrations at this event, INCLUDING the ones being
 * created right now (so a brand-new athlete with no prior reg passes
 * `nowISO`; an athlete adding a second discipline passes their ORIGINAL reg's
 * `createdAt`, which is earlier than now and is what actually anchors the
 * once-per-athlete rule — an original on-time registration is never
 * surcharged just because a later discipline was added inside the window).
 */
export function newRegistrationEntryTotal(
  event: RegFeeEvent,
  { competingClubId, priorDisciplineCount, newDisciplineCount, late }: {
    competingClubId: string;
    priorDisciplineCount: number;
    newDisciplineCount: number;
    /** Late-fee inputs (Task 3). Omit to preserve pre-Task-3 behavior. */
    late?: { earliestCreatedAtISO: string };
  },
): number {
  if (competingClubId === event.hostClubId) return 0;
  let total = 0;
  for (let i = 0; i < newDisciplineCount; i++) {
    const isSecond = priorDisciplineCount + i > 0;
    total += isSecond ? event.secondDisciplineFee : event.entryFee;
  }
  if (total > 0 && newDisciplineCount > 0 && late && lateFeeApplies(event, late.earliestCreatedAtISO)) {
    total += event.lateReg!.fee;
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

/**
 * Did ANYTHING change between `before` and `after`? Broader than
 * `changeIsEligible` — also true for a REMOVED discipline or an apparatus
 * add/remove within a shared discipline, which `changeIsEligible` deliberately
 * excludes from being chargeable. Used to enable a FREE "Save" for edits that
 * changed something but aren't eligible for a change fee (e.g. a pure T&T
 * apparatus tweak), while still disabling Save when nothing actually changed.
 */
export function regChangeHasDiff(before: RegChangeState, after: RegChangeState): boolean {
  if (before.clubId !== after.clubId) return true;
  if (before.athleteId !== after.athleteId) return true;

  const beforeMap = byDiscipline(before);
  const afterMap = byDiscipline(after);
  const allDisciplines = new Set([...beforeMap.keys(), ...afterMap.keys()]);

  for (const disc of allDisciplines) {
    const b = beforeMap.get(disc);
    const a = afterMap.get(disc);
    if (!b || !a) return true; // added or removed discipline
    if (a.levelId !== b.levelId) return true;
    if (apparatusLevelsDiffer(a.apparatusLevels, b.apparatusLevels)) return true;
    const aSet = new Set(a.apparatus);
    const bSet = new Set(b.apparatus);
    if (aSet.size !== bSet.size) return true;
    for (const x of aSet) if (!bSet.has(x)) return true;
  }
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

/** Minimal slice of a registration the synchro-level-sync logic needs. */
export type SynchroReg = {
  athleteId: string;
  apparatus: string[];
  apparatusLevels?: Record<string, string>;
  partnerAthleteId?: string | null;
};

/**
 * Synchro (T&T "SY") same-level auto-sync (B4.4): whoever actively selects a
 * partner sets the SY level for BOTH — not a validation, an active sync.
 * Given `savedReg` (the registration just being saved, with SY selected and a
 * partner named) and `existingRegs` (every OTHER registration for this event,
 * to find the partner's own row in), returns the partner's registration
 * updated to match `savedReg`'s SY level — or `null` if there's nothing to
 * sync (no SY/partner on `savedReg`, no partner registration found yet, or
 * the levels already match).
 */
export function syncSynchroPartnerLevel<T extends SynchroReg>(
  existingRegs: T[],
  savedReg: SynchroReg,
): T | null {
  if (!savedReg.apparatus.includes('SY') || !savedReg.partnerAthleteId) return null;
  const mySyLevel = savedReg.apparatusLevels?.SY;
  if (!mySyLevel) return null;
  const partnerReg = existingRegs.find(
    (r) => r.athleteId === savedReg.partnerAthleteId && r.apparatus.includes('SY'),
  );
  if (!partnerReg) return null;
  if (partnerReg.apparatusLevels?.SY === mySyLevel) return null;
  return { ...partnerReg, apparatusLevels: { ...partnerReg.apparatusLevels, SY: mySyLevel } };
}

/** Minimal slice of a registration `findIncomingSynchroPartner` needs. */
export type IncomingSynchroReg = {
  eventId: string;
  athleteId: string;
  apparatus: string[];
  levelId: string;
  apparatusLevels?: Record<string, string>;
  partnerAthleteId?: string | null;
  refunded?: boolean;
};

/** Find the registration (if any) that already named `athleteId` as its SY
 *  partner for this event — i.e. "who selected me". Used both to auto-link
 *  the reciprocal side (existing behavior) and, per B4.4, to read THEIR SY
 *  level so a fresh auto-linked registration defaults to matching it. */
export function findIncomingSynchroPartner<T extends IncomingSynchroReg>(
  regs: T[],
  eventId: string,
  athleteId: string,
): T | undefined {
  return regs.find(
    (r) => r.eventId === eventId && !r.refunded && r.apparatus.includes('SY') && r.partnerAthleteId === athleteId,
  );
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

/** Which registration-sync action applies when a cart item is removed
 *  (unified-cart-b2 Task A; extended 2026-07-02 for H5/H6/L2). Pure
 *  classification off the item's own fields — no DB access, so it's fully
 *  unit-testable:
 *  - `delete-registration`: a brand-new unpaid entry line (`refLineType` is
 *    'entry', or missing/legacy on an old meet-entry row with no other line
 *    type) — the linked registration(s) never existed before this cart item,
 *    so removing it should delete them entirely.
 *  - `revert-registration`: a 'change' line that captured a `priorRegSnapshot`
 *    at creation — the linked registration(s) should be restored to those
 *    snapshotted values.
 *  - `no-snapshot-remove-only`: a 'change' line with NO snapshot (created
 *    before this feature existed) — nothing to revert to; remove the cart
 *    item only and let the caller be honest about it in the UI.
 *  - `clear-membership-hold`: a member-pushed-to-club-cart membership line
 *    (`kind:'membership'` with `refUserId`+`refSeasonId`+`refType` set and
 *    `refType !== 'club'` — a club's OWN membership line has no `refUserId`
 *    and is left as `remove-only`, unchanged). Added for H6: removing this
 *    line must clear the payment hold it created (see cart-sync.ts).
 *  - `remove-only`: anything else (addon/other kinds, a club's own membership
 *    line, or a meet-entry line with no refRegIds to act on) — today's
 *    existing behavior, unchanged.
 *
 *  L2 note: a legacy pre-S4 change line can have `refLineType == null` but a
 *  non-null `refRegIds` — that would fall through to the 'entry' branch below
 *  and be misclassified as `delete-registration` (destroying a still-valid
 *  edited registration instead of reverting it). Live data was checked
 *  2026-07-02: every existing null-`refLineType` cart_items row also had a
 *  null `refRegIds`, so this branch is unreachable today and no backfill
 *  migration was needed. The `!item.refRegIds` guard above is the safety net
 *  if that ever stops being true — keep it.
 */
export type CartRemovalAction =
  | 'delete-registration'
  | 'revert-registration'
  | 'no-snapshot-remove-only'
  | 'clear-membership-hold'
  | 'remove-only';

export function classifyCartRemoval(
  item: Pick<CartItem, 'kind' | 'refLineType' | 'refRegIds' | 'priorRegSnapshot' | 'refUserId' | 'refSeasonId' | 'refType'>,
): CartRemovalAction {
  if (item.kind === 'membership') {
    return item.refUserId && item.refSeasonId && item.refType && item.refType !== 'club'
      ? 'clear-membership-hold'
      : 'remove-only';
  }
  if (item.kind !== 'meet-entry' || !item.refRegIds || item.refRegIds.length === 0) return 'remove-only';
  if (item.refLineType === 'change') {
    return item.priorRegSnapshot && item.priorRegSnapshot.length > 0 ? 'revert-registration' : 'no-snapshot-remove-only';
  }
  // 'entry', or missing/legacy (pre-refLineType meet-entry rows) — treated as
  // a brand-new-entry line: the registration(s) it points at didn't exist
  // before this cart item, so deleting it deletes them.
  return 'delete-registration';
}

/** Resolves EXACTLY which registration ids a `delete-registration` or
 *  `revert-registration` cart-item removal should act on, given the OTHER
 *  cart lines still in the same scope (H5: a registration can be referenced
 *  by more than one cart line — e.g. an entry line and a stacked change line
 *  — and removal must not delete/resurrect a reg another line still needs).
 *  Pure function, no DB access: the caller passes in exactly the reg-id sets
 *  it needs from the store.
 *
 *  - `toDelete` (delete-registration only): `item.refRegIds` MINUS any id
 *    still referenced by another cart line's `refRegIds` in `otherRefRegIds`
 *    — a reg another line still needs is left alone (not deleted) and
 *    reported in `kept` so the caller can toast which ones survived.
 *  - `toRevert` (revert-registration only): for each snapshot entry, revert
 *    it UNLESS its id is still referenced by another cart line (kept
 *    instead), matching the same "don't touch a reg another line needs"
 *    rule as delete. `toDelete` also carries any id in `item.refRegIds` that
 *    has NO snapshot entry — those regs were *created by this change itself*
 *    (e.g. a newly-added discipline mid-edit has no "before" state), so
 *    reverting can't restore them to a prior value; the only correct action
 *    is to delete them, exactly like a brand-new entry — again, unless
 *    another line still references that id, in which case it's kept.
 *  - `existingRegIds` guards the H5 "never resurrect" rule: a snapshot whose
 *    id no longer exists in the live registrations set is DROPPED, never
 *    re-inserted — reverting cannot bring back a registration something else
 *    (e.g. a refund, or another removal) already deleted for real.
 */
export function resolveRegRemoval(
  item: Pick<CartItem, 'refRegIds' | 'priorRegSnapshot'>,
  ctx: { otherRefRegIds: Set<string>; existingRegIds: Set<string> },
): { toDelete: string[]; toRevert: NonNullable<CartItem['priorRegSnapshot']>; kept: string[] } {
  const refIds = item.refRegIds ?? [];
  const stillReferenced = (id: string) => ctx.otherRefRegIds.has(id);

  const snapshotById = new Map((item.priorRegSnapshot ?? []).map((r) => [r.id, r]));
  const toDelete: string[] = [];
  const toRevert: NonNullable<CartItem['priorRegSnapshot']> = [];
  const kept: string[] = [];

  for (const id of refIds) {
    if (stillReferenced(id)) { kept.push(id); continue; }
    const snapshot = snapshotById.get(id);
    if (snapshot) {
      // Never resurrect a reg that was for-real deleted elsewhere.
      if (ctx.existingRegIds.has(id)) toRevert.push(snapshot);
      // else: it's already gone — nothing to revert, nothing to delete.
    } else {
      // No snapshot entry ⇒ this id was CREATED by the change this line
      // represents (or is a brand-new entry line, which has no snapshot at
      // all) — delete it rather than leaving it stranded.
      toDelete.push(id);
    }
  }

  return { toDelete, toRevert, kept };
}
