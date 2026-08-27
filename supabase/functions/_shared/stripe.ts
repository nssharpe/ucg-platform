// _shared/stripe.ts — Stripe client + server-side pricing shared by the two
// payment functions (`create-checkout-session`, `stripe-webhook`).
//
// Trust boundary (non-negotiable): the browser only ever STARTS a payment. Both
// functions recompute every amount from these helpers against the referenced
// memberships — a client-sent dollar figure is display-only and never trusted.
// The pricing here MIRRORS `src/lib/pricing.ts` (processingFee + the membership
// "both costs the higher single fee" rule); keep the two in sync. We re-implement
// rather than import because Edge Functions bundle only the function dir + this
// `_shared/` folder, not `src/`.
//
// Secrets (Supabase): STRIPE_SECRET_KEY (required — getStripe throws if missing),
// STRIPE_WEBHOOK_SECRET (checked in the webhook, fail-closed if unset).

import Stripe from 'npm:stripe@17.7.0';

/** Construct the Stripe client. Uses the fetch HTTP client (Deno has no Node
 *  `http`/`https` the SDK's default client expects). Throws a clear, caller-
 *  surfaced error when the secret key is unset so the failure is loud. */
export function getStripe(): Stripe {
  const key = Deno.env.get('STRIPE_SECRET_KEY');
  if (!key) throw new Error('Payments are not configured: STRIPE_SECRET_KEY secret is missing.');
  return new Stripe(key, {
    // Deno/SubtleCrypto are async — see constructEventAsync in the webhook.
    httpClient: Stripe.createFetchHttpClient(),
  });
}

/** SubtleCrypto-backed provider for async webhook signature verification
 *  (`constructEventAsync`); the sync `constructEvent` throws in Edge Functions. */
export function getCryptoProvider(): Stripe.CryptoProvider {
  return Stripe.createSubtleCryptoProvider();
}

// --- Server-side pricing (mirror of src/lib/pricing.ts) --------------------

/** Service fee passed to the payer: 3% + $0.30 of the order subtotal, in CENTS.
 *  Rounds UP (never to-nearest) so the collected fee never falls a cent short
 *  of Stripe's actual processing fee on the total charged. Mirrors
 *  `processingFee` in pricing.ts. */
export function processingFee(subtotalCents: number): number {
  return Math.ceil(subtotalCents * 0.03) + 30;
}

/** Minimal season slice the membership pricing needs (snake_case DB columns).
 *  `starts_on`/`ends_on`/`active` back the date-derived purchase gate below
 *  (P3 2026-07-20 — "current"/"launched" are no longer stored flags) —
 *  mirrors `purchasableSeasons`/`isFutureSeason` in
 *  src/lib/season-lifecycle.ts (re-implemented, not imported — same reason as
 *  the rest of this file). */
export interface SeasonFees {
  id: string;
  name: string;
  athlete_fee: number;
  coach_fee: number;
  club_fee: number;
  active: boolean;
  starts_on: string;
  ends_on: string;
}

/** P3: a membership line may only target a season that's current-by-date
 *  (today falls in [starts_on, ends_on]) or a FUTURE season (starts_on after
 *  today) flagged `active` — never a past season, regardless of `active`
 *  (defense in depth; the client UI already restricts the offered seasons to
 *  this same set). `todayISO` is injectable for tests; defaults to now. */
export function seasonPurchasableForCheckout(season: SeasonFees, todayISO?: string): boolean {
  const d = (todayISO ?? new Date().toISOString()).slice(0, 10);
  const currentByDate = !!(season.starts_on && season.ends_on && d >= season.starts_on && d <= season.ends_on);
  if (currentByDate) return true;
  const isFuture = !!(season.starts_on && season.starts_on > d);
  return isFuture && season.active;
}

/** Minimal membership slice the pricing needs (snake_case DB columns). */
export interface MembershipRow {
  season_id: string;
  type: string;
  status: string;
}

export type MembershipType = 'athlete' | 'coach';

/** Base fee (DOLLARS) for a membership type in a season. Mirrors `membershipFee`. */
export function membershipFeeDollars(season: SeasonFees, type: MembershipType): number {
  return type === 'coach' ? season.coach_fee : season.athlete_fee;
}

/**
 * Combined price (DOLLARS) to acquire ALL of `types` at once, given the person's
 * existing memberships. Holding both athlete + coach is worth the HIGHER single
 * fee (athlete), so buying "both" costs the athlete fee, not the sum. Already-
 * owned active types are credited at their fee. Mirrors `priceForTypes`.
 */
export function priceForTypesDollars(
  season: SeasonFees,
  types: MembershipType[],
  existing: MembershipRow[],
): number {
  const valueOf = (ts: MembershipType[]): number =>
    ts.reduce((max, t) => Math.max(max, membershipFeeDollars(season, t)), 0);
  const owned = existing
    .filter((m) => m.season_id === season.id && m.status === 'active')
    .map((m) => m.type as MembershipType);
  const union = Array.from(new Set<MembershipType>([...owned, ...types]));
  return Math.max(0, valueOf(union) - valueOf(owned));
}

/** True when `personId` already holds an ACTIVE membership of `type` for
 *  `seasonId` among `rows` — the (person, season, type) duplicate-purchase
 *  guard (UAT G-02, 2026-08-27): an athlete bought the same membership twice
 *  because a second checkout session was created before the first had
 *  fulfilled. `create-checkout-session` calls this to refuse (409) a repeat
 *  purchase. Mirrors `membershipAlreadyActive` in src/lib/pricing.ts — keep
 *  in lockstep. A legacy row with no `type` (predating typed memberships) is
 *  treated as 'athlete', mirroring `membershipTypeOf` in
 *  src/lib/capabilities-core.ts. */
export function membershipAlreadyActive(
  rows: (MembershipRow & { person_id: string })[],
  personId: string,
  seasonId: string,
  type: MembershipType,
): boolean {
  return rows.some((m) =>
    m.person_id === personId
    && m.season_id === seasonId
    && (m.type === 'coach' ? 'coach' : 'athlete') === type
    && m.status === 'active');
}

// --- Event registration fees (mirror of src/lib/pricing.ts § Registration fees) ---
// The host club's own athletes pay $0 for ALL registration-side fees (entry,
// second-discipline, change). All helpers return DOLLARS (use toCents to Stripe).

/** Minimal event slice the registration/addon pricing needs (snake_case DB cols).
 *  `change_fee` / `tshirt_addon` / `banner_addon` / `banquet` / `camp_config` /
 *  `late_reg` are nullable jsonb. */
export interface RegFeeEvent {
  id: string;
  host_club_id: string | null;
  entry_fee: number;
  second_discipline_fee: number;
  change_fee: { amount: number; startsAt?: string } | null;
  tshirt_addon: { price: number; lastPurchaseAt?: string } | null;
  banner_addon: { price: number; lastPurchaseAt?: string } | null;
  /** Per-ticket banquet add-on (event-mgmt v2 Phase 2). */
  banquet: { price: number; name: string; lastPurchaseAt?: string } | null;
  /** Camp-only leo add-on lives nested under camp_config. */
  camp_config: { leoAddon?: { price: number; sizes: string[]; lastPurchaseAt?: string } } | null;
  /** Registration close instant (ISO) — the fallback add-on purchase deadline
   *  when a type has no `lastPurchaseAt` of its own. */
  reg_closes: string;
  /** Late-registration surcharge (emv2 P0 Task 3), DOLLARS, added ON TOP of the
   *  normal entry/second-discipline fee — NOT the change fee. MIRRORED IN
   *  src/lib/pricing.ts (RegFeeEvent.lateReg / lateFeeApplies) — keep in sync. */
  late_reg: { startsAt: string; fee: number } | null;
}

/**
 * Does the late-registration surcharge apply, given the EARLIEST `created_at`
 * among the athlete's referenced registrations for this event? `>=` at the
 * boundary applies the fee. No `late_reg` configured ⇒ never applies.
 * MIRRORED IN src/lib/pricing.ts (`lateFeeApplies`) — keep in sync.
 */
export function lateFeeAppliesDollars(
  event: Pick<RegFeeEvent, 'late_reg'>,
  earliestCreatedAtISO: string,
): boolean {
  if (!event.late_reg) return false;
  return Date.parse(earliestCreatedAtISO) >= Date.parse(event.late_reg.startsAt);
}

/** Minimal registration slice `lateFeeAnchor` needs (snake_case DB cols). */
export type LateAnchorRegRow = { id: string; created_at?: string | null };

/**
 * Late-fee ATTACHMENT rule (emv2 P0 Task 3, corrected): the surcharge
 * attaches ONLY to the purchase line that CONTAINS the athlete's
 * earliest-created registration for that event+club — otherwise any entry
 * line priced after the athlete's first in-window reg would re-add a fee
 * already charged with the first line (repeat purchase, or a second save
 * into the same cart).
 *
 * Given the regs referenced by THIS line and the athlete's OTHER
 * non-refunded regs at that event+club (disjoint from the line), returns the
 * anchor ISO — the overall-earliest `created_at` across both sets — when the
 * overall-earliest reg is IN the line, else null (⇒ no surcharge on this
 * line). Equal timestamps tie-break by reg id (lexicographic), so exactly
 * ONE line can ever qualify. A missing `created_at` on a line reg sorts as
 * `nowISO` (latest); a missing one on an outside reg ⇒ null (fail toward not
 * surcharging).
 *
 * MIRRORED IN src/lib/pricing.ts (`lateFeeAnchor`) — keep in sync.
 */
export function lateFeeAnchor(
  lineRegs: LateAnchorRegRow[],
  outsideRegs: LateAnchorRegRow[],
  nowISO: string,
): string | null {
  if (lineRegs.length === 0) return null;
  if (outsideRegs.some((r) => !r.created_at)) return null;
  type Entry = { t: number; id: string; iso: string; inLine: boolean };
  const entries: Entry[] = [
    ...lineRegs.map((r) => {
      const iso = r.created_at ?? nowISO;
      return { t: Date.parse(iso), id: r.id, iso, inLine: true };
    }),
    ...outsideRegs.map((r) => ({ t: Date.parse(r.created_at!), id: r.id, iso: r.created_at!, inLine: false })),
  ];
  let earliest = entries[0];
  for (let i = 1; i < entries.length; i++) {
    const e = entries[i];
    if (e.t < earliest.t || (e.t === earliest.t && e.id < earliest.id)) earliest = e;
  }
  return earliest.inLine ? earliest.iso : null;
}

/**
 * Total entry fee (DOLLARS) for a new registration purchase. Host club ⇒ 0.
 * First discipline = entry_fee; each additional = second_discipline_fee, where
 * "additional" means `priorDisciplineCount + i > 0`. Mirrors
 * `newRegistrationEntryTotal` in pricing.ts exactly.
 *
 * Late-registration surcharge (emv2 P0 Task 3, optional `late` param so
 * existing callers are unaffected): added ONCE per athlete per event, never
 * for the host club (checked first above). MIRRORED IN src/lib/pricing.ts
 * (`newRegistrationEntryTotal`'s `late` param) — keep in sync.
 */
export function newRegistrationEntryTotalDollars(
  event: RegFeeEvent,
  { competingClubId, priorDisciplineCount, newDisciplineCount, late }: {
    competingClubId: string;
    priorDisciplineCount: number;
    newDisciplineCount: number;
    late?: { earliestCreatedAtISO: string };
  },
): number {
  // `event.host_club_id` is `null` (not `''`) for a UCG-hosted event with no
  // host club — `'' === null` is already false, but guard explicitly so this
  // stays correct even if a future caller passes `''` for "no host club"
  // (mirrors `newRegistrationEntryTotal`'s guard in src/lib/pricing.ts).
  if (event.host_club_id && competingClubId === event.host_club_id) return 0;
  let total = 0;
  for (let i = 0; i < newDisciplineCount; i++) {
    const isSecond = priorDisciplineCount + i > 0;
    total += isSecond ? event.second_discipline_fee : event.entry_fee;
  }
  if (total > 0 && newDisciplineCount > 0 && late && lateFeeAppliesDollars(event, late.earliestCreatedAtISO)) {
    total += event.late_reg!.fee;
  }
  return total;
}

/** Change fee (DOLLARS) for a registration edit. Host club ⇒ 0; else the event's
 *  configured change-fee amount (0 if none). Mirrors `registrationChangeFee`. */
export function registrationChangeFeeDollars(
  event: RegFeeEvent,
  { competingClubId }: { competingClubId: string },
): number {
  // See `newRegistrationEntryTotalDollars`'s guard comment above.
  if (event.host_club_id && competingClubId === event.host_club_id) return 0;
  return event.change_fee?.amount ?? 0;
}

/**
 * Combined price (DOLLARS) for adding a discipline to a registration that
 * already has at least one PAID/updated-pending discipline at this
 * event+club (UAT M-10-01, S1): the ADDED discipline(s)' entry-total
 * (`newRegistrationEntryTotalDollars`, priced from `priorDisciplineCount` —
 * pass the count INCLUDING the already-paid discipline(s)) PLUS the event's
 * change fee (`registrationChangeFeeDollars`), as ONE combined amount —
 * never the change fee alone (that undercharge is exactly the C4-adjacent
 * bug this closes: an added reg must always be priced by the entry-total
 * logic, on top of, never instead of, the change fee). Host club ⇒ 0 (both
 * components zero themselves). Mirrors `addedDisciplineChangeTotal` in
 * src/lib/pricing.ts — keep in sync.
 */
export function addedDisciplineChangeTotalDollars(
  event: RegFeeEvent,
  { competingClubId, priorDisciplineCount, newDisciplineCount, late }: {
    competingClubId: string;
    priorDisciplineCount: number;
    newDisciplineCount: number;
    late?: { earliestCreatedAtISO: string };
  },
): number {
  return (
    newRegistrationEntryTotalDollars(event, { competingClubId, priorDisciplineCount, newDisciplineCount, late })
    + registrationChangeFeeDollars(event, { competingClubId })
  );
}

/** Addon price (DOLLARS) for an event, by line type. FAIL-CLOSED: an unknown
 *  line type, or a type not configured on this event (e.g. a tshirt line for
 *  an event with no `tshirt_addon`), returns `null` — the caller MUST reject
 *  the checkout rather than price it at 0 (a $0 add-on line would let a
 *  crafted/stale cart line through for free). Mirrors (extends) the pricing
 *  intent of the pre-Phase-2 version, which defaulted unknown → 0; that was
 *  safe only because addons were single-line-per-event with client-controlled
 *  presence — the per-unit model (Task 2) needs a hard reject instead. */
export function addonPriceDollars(event: RegFeeEvent, lineType: string | null): number | null {
  if (lineType === 'tshirt') return event.tshirt_addon ? event.tshirt_addon.price : null;
  if (lineType === 'banner') return event.banner_addon ? event.banner_addon.price : null;
  if (lineType === 'banquet') return event.banquet ? event.banquet.price : null;
  if (lineType === 'leo') return event.camp_config?.leoAddon ? event.camp_config.leoAddon.price : null;
  return null;
}

/** The configured purchase deadline (ISO), if any, for an add-on line type on
 *  this event — `undefined` when that type has no `lastPurchaseAt` set (the
 *  caller then falls back to `reg_closes` via `addonPurchaseOpen`). */
export function addonLastPurchaseAt(event: RegFeeEvent, lineType: string | null): string | undefined {
  if (lineType === 'tshirt') return event.tshirt_addon?.lastPurchaseAt;
  if (lineType === 'banner') return event.banner_addon?.lastPurchaseAt;
  if (lineType === 'banquet') return event.banquet?.lastPurchaseAt;
  if (lineType === 'leo') return event.camp_config?.leoAddon?.lastPurchaseAt;
  return undefined;
}

/**
 * Is an add-on purchasable RIGHT NOW? Purchasable until `lastPurchaseAt` when
 * set (which MAY be after `regCloses`); when unset, purchasable only while
 * registration is open (`now <= regCloses`). `now` is a parameter so this
 * stays pure/testable. MIRRORED IN src/lib/pricing.ts (`addonPurchaseOpen`) —
 * keep in sync.
 */
export function addonPurchaseOpen(
  lastPurchaseAt: string | undefined,
  regCloses: string,
  now: Date,
): boolean {
  const deadline = lastPurchaseAt ? Date.parse(lastPurchaseAt) : Date.parse(regCloses);
  return now.getTime() <= deadline;
}

/** Dollars → integer cents (Stripe's unit). */
export function toCents(dollars: number): number {
  return Math.round(dollars * 100);
}

// --- Coupon scoping (UAT M-11-01, S1) ---------------------------------------
// A promo code's "Applies to" setting must discount only the category of line
// it names — a code scoped to `appliesTo: 'meet-entry'` ("Event entries") is
// meant for actual new registrations, never a change fee or an add-on. Before
// this fix every non-membership line (entry, change fee, AND add-on) was
// tagged 'meet-entry', so a meet-entry-scoped code silently discounted the
// entire cart. `'change-fee'` and `'addon'` give those lines their own scope
// so only an `appliesTo: 'any'` (or, for change-fee, no scope match at all —
// there is no admin-facing "Change fees"/"Add-ons" coupon category today, see
// `Coupon['appliesTo']` in src/lib/types.ts) code reaches them.

/** Which category a server-priced line falls under, for coupon eligibility.
 *  MIRRORED IN src/lib/pricing.ts — keep in sync. */
export type CouponScope =
  | 'athlete-membership' | 'club-membership' | 'coach-membership'
  | 'meet-entry' | 'change-fee' | 'addon';

/** Minimal per-line shape `couponEligibleLine` needs. */
export interface CouponScopedLine {
  scope?: CouponScope;
  eventId?: string;
}

/** Minimal coupon-rule shape (the DB row is snake_case `applies_to`/
 *  `applies_to_event_id`; the client's `Coupon` type mirrors this camelCase —
 *  see pricing.ts). */
export interface CouponEligibilityRule {
  appliesTo: string;
  appliesToEventId?: string | null;
}

/**
 * Is `line` eligible for `coupon`'s discount, per the coupon's "Applies to"
 * scope? `'any'` matches every line; the legacy `'membership'` matches all
 * three membership scopes; `'meet-entry'` matches ONLY a true entry line
 * (never `'change-fee'` or `'addon'`), further narrowed to one event when
 * `appliesToEventId` is set; anything else falls back to an exact scope
 * match (today that only ever matches the fine-grained membership scopes,
 * since no coupon can be authored with `appliesTo: 'change-fee'`/`'addon'`).
 * Pure — used by BOTH the real eligibility filter in
 * `create-checkout-session` and (mirrored) any client-side coupon preview.
 * MIRRORED IN src/lib/pricing.ts — keep in sync.
 */
export function couponEligibleLine(line: CouponScopedLine, coupon: CouponEligibilityRule): boolean {
  const { appliesTo, appliesToEventId } = coupon;
  if (appliesTo === 'any') return true;
  if (appliesTo === 'membership') {
    return line.scope === 'athlete-membership' || line.scope === 'club-membership' || line.scope === 'coach-membership';
  }
  if (appliesTo === 'meet-entry') {
    return line.scope === 'meet-entry' && (!appliesToEventId || line.eventId === appliesToEventId);
  }
  return line.scope === appliesTo;
}
