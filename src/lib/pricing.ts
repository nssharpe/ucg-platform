// Pure pricing & coupon-validity logic — no React/store/Supabase imports (types
// erase at compile time). Unit-tested in tests/pricing.test.ts. Used by the
// membership purchase flow (W6) and promo codes (W14).
import type { Athlete, CampSurveyQuestion, CartItem, Coupon, Discipline, Membership, MembershipType, Registration, Season, SessionRequestAnswers } from './types';

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

/** A membership row carrying its owner's person id — `Membership` itself is
 *  always nested under one `Athlete.memberships`, so the (person, season,
 *  type) duplicate-purchase guard below needs this widened shape to check
 *  across a batch of rows for potentially different people. */
export type MembershipRecord = Membership & { personId: string };

/**
 * True when `personId` already holds an ACTIVE membership of `type` for
 * `seasonId` among `rows` — the (person, season, type) duplicate-purchase
 * guard (UAT G-02, 2026-08-27): an athlete bought the same membership twice
 * because two checkout sessions were created before either had fulfilled
 * (see money-invariants.md's "One live slot" duplicate-payment class for the
 * analogous registration-side race). `create-checkout-session` calls the
 * mirrored `membershipAlreadyActive` in `_shared/stripe.ts` to 409 a repeat
 * purchase; this copy is the canonical, unit-tested one — keep them in
 * lockstep. A legacy row with no `type` (predating typed memberships) is
 * treated as 'athlete', mirroring `membershipTypeOf` in capabilities-core.ts.
 */
export function membershipAlreadyActive(
  rows: MembershipRecord[],
  personId: string,
  seasonId: string,
  type: MembershipType,
): boolean {
  return rows.some((m) =>
    m.personId === personId
    && m.seasonId === seasonId
    && (m.type === 'coach' ? 'coach' : 'athlete') === type
    && m.status === 'active');
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
 * Does the late-registration surcharge apply, given the anchor timestamp for
 * an athlete+event+club — the EARLIEST `createdAt` across ALL of the athlete's
 * regs there (the moment they first registered; creation time, never payment
 * time)? `>=` at the boundary applies the fee ("at or after"). No `lateReg`
 * configured ⇒ never applies. WHICH purchase line the surcharge attaches to is
 * decided by `lateFeeAnchor` below (only the line CONTAINING the earliest reg)
 * — this predicate only answers the in-window question for a given anchor.
 */
export function lateFeeApplies(
  event: Pick<RegFeeEvent, 'lateReg'>,
  earliestCreatedAtISO: string,
): boolean {
  if (!event.lateReg) return false;
  return Date.parse(earliestCreatedAtISO) >= Date.parse(event.lateReg.startsAt);
}

/** Minimal registration slice `lateFeeAnchor` needs. */
export type LateAnchorReg = { id: string; createdAt?: string };

/**
 * Late-fee ATTACHMENT rule (emv2 P0 Task 3, corrected 2026-07-06): the
 * surcharge attaches ONLY to the purchase line that CONTAINS the athlete's
 * earliest-created registration for that event+club. Without this, any entry
 * line priced after the athlete's first in-window reg would re-add a fee
 * already charged with the first line (repeat purchase months later, or a
 * second save into the same cart).
 *
 * Given the regs referenced by THIS line (`lineRegs`) and the athlete's OTHER
 * non-refunded regs at that event+club (`outsideRegs`, disjoint from the
 * line), returns the anchor ISO — the overall-earliest `createdAt` across
 * both sets — when the overall-earliest reg is IN the line, else null (⇒ the
 * caller omits the `late` pricing input entirely, so no surcharge). Equal
 * timestamps tie-break by reg id (lexicographic), so exactly ONE line can
 * ever qualify. PURE: `nowISO` is a parameter, no Date.now() inside.
 *
 * Missing `createdAt` handling (client-constructed rows the store hasn't
 * reloaded from the DB yet):
 *  - a LINE reg with no `createdAt` is being created right now ⇒ sorts as
 *    `nowISO` (latest);
 *  - an OUTSIDE reg with no `createdAt` pre-exists this purchase by
 *    construction (saved earlier this session, not yet re-synced) ⇒ the line
 *    cannot contain the earliest reg ⇒ null. Fails toward NOT surcharging —
 *    the server recomputes authoritatively from real DB timestamps at
 *    checkout.
 *
 * MIRRORED IN supabase/functions/_shared/stripe.ts (`lateFeeAnchor`) — keep
 * in sync.
 */
export function lateFeeAnchor(
  lineRegs: LateAnchorReg[],
  outsideRegs: LateAnchorReg[],
  nowISO: string,
): string | null {
  if (lineRegs.length === 0) return null;
  if (outsideRegs.some((r) => !r.createdAt)) return null;
  type Entry = { t: number; id: string; iso: string; inLine: boolean };
  const entries: Entry[] = [
    ...lineRegs.map((r) => {
      const iso = r.createdAt ?? nowISO;
      return { t: Date.parse(iso), id: r.id, iso, inLine: true };
    }),
    ...outsideRegs.map((r) => ({ t: Date.parse(r.createdAt!), id: r.id, iso: r.createdAt!, inLine: false })),
  ];
  let earliest = entries[0];
  for (let i = 1; i < entries.length; i++) {
    const e = entries[i];
    if (e.t < earliest.t || (e.t === earliest.t && e.id < earliest.id)) earliest = e;
  }
  return earliest.inLine ? earliest.iso : null;
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
  // `event.hostClubId` is `''` for UCG-hosted events with no host club
  // resolved (PM feedback 2026-07-22) — never treat that as a match even if
  // the caller passes an equally-empty `competingClubId` (an unaffiliated
  // athlete's `selectedClubId` defaults to `''`, e.g. camp registration,
  // which waives the club-membership gate). Guard explicitly rather than
  // relying on `'' === ''` being coincidentally false.
  if (event.hostClubId && competingClubId === event.hostClubId) return 0;
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
  // See `registrationEntryFee`'s guard comment above — never treat an empty
  // `event.hostClubId` as matching an equally-empty `competingClubId`.
  if (event.hostClubId && competingClubId === event.hostClubId) return 0;
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
  // See `registrationEntryFee`'s guard comment above — never treat an empty
  // `event.hostClubId` as matching an equally-empty `competingClubId`.
  if (event.hostClubId && competingClubId === event.hostClubId) return 0;
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

/**
 * Combined price for adding a discipline to a registration that already has
 * at least one PAID/updated-pending discipline at this event+club (UAT
 * M-10-01, S1 — confirmed by the requirements owner): the ADDED
 * discipline(s)' entry-total (`newRegistrationEntryTotal`, priced from
 * `priorDisciplineCount` — pass the count INCLUDING the already-paid
 * discipline(s), so the added one lands at the second-discipline rate) PLUS
 * the event's change fee (`registrationChangeFee`), as ONE combined amount —
 * never the change fee alone. That undercharge was the actual bug: a mixed
 * line (one paid reg + one brand-new reg) was previously priced as either a
 * cheap change-fee-only line or a full fresh-entry line, never "extra
 * discipline + change fee" together. Host club ⇒ 0 (both components zero
 * themselves via their own guards). MIRRORED IN
 * supabase/functions/_shared/stripe.ts (`addedDisciplineChangeTotalDollars`)
 * — keep in sync.
 */
export function addedDisciplineChangeTotal(
  event: RegFeeEvent,
  { competingClubId, priorDisciplineCount, newDisciplineCount, late }: {
    competingClubId: string;
    priorDisciplineCount: number;
    newDisciplineCount: number;
    /** Late-fee inputs (Task 3), applied to the ADDED discipline(s) only. */
    late?: { earliestCreatedAtISO: string };
  },
): number {
  return (
    newRegistrationEntryTotal(event, { competingClubId, priorDisciplineCount, newDisciplineCount, late })
    + registrationChangeFee(event, { competingClubId })
  );
}

/** Minimal prior-registration slice `regsForChangeLine` needs. */
export type PriorRegPaidState = { paid?: boolean; updatedPending?: boolean };

/**
 * Of `newRegs`, return the subset that belongs on a PURE change-fee cart
 * line's `refRegIds` (UAT M-10 x Z-04, 2026-08-22): regs with a prior row
 * that was ALREADY paid or updated_pending. Everything else in `newRegs` —
 * no prior row at all (a brand-new discipline), OR a prior row that was
 * NEVER paid (e.g. a still-unpaid discipline added in an earlier,
 * not-yet-checked-out edit this same session) — belongs on a SEPARATE entry
 * line instead, never this one.
 *
 * This distinction is the whole point of the rework: `create-checkout-session`
 * derives entry-vs-change PER REG from that reg's own `paid`/`updated_pending`
 * DB state, never from which cart line the client put it on (the C4 fix).
 * Including a never-paid reg here would silently reconstruct a MIXED line
 * server-side the moment this line is priced — the server's mixed branch
 * would fire, disagree with the client's pure-change amount (triggering the
 * "prices updated" banner), and — worse — double-charge that reg if it
 * already sits on its OWN separate pending entry line elsewhere (the two
 * lines would both reference the same id).
 */
export function regsForChangeLine<T extends { id: string }>(
  newRegs: T[],
  priorById: Map<string, PriorRegPaidState>,
): T[] {
  return newRegs.filter((r) => {
    const prior = priorById.get(r.id);
    return !!prior && (prior.paid === true || prior.updatedPending === true);
  });
}

// --- Per-unit add-on pricing + purchase deadlines (event-mgmt v2 Phase 2) --
// Each add-on type (banquet/tshirt/banner/leo) can carry an optional
// `lastPurchaseAt` independent of `regCloses` (may be AFTER regCloses). Pure
// client-side mirror of the server's authoritative pricing/deadline logic in
// supabase/functions/_shared/stripe.ts — used for display/validation ONLY;
// the server always recomputes and never trusts the client.

/** One add-on's config shape, as stored on the Event (`price` + optional
 *  `lastPurchaseAt`; `sizes`/`name` are irrelevant to pricing/deadlines). */
export type AddonConfig = { price: number; lastPurchaseAt?: string };

/** Minimal Event slice the add-on pricing/deadline helpers need. */
export type AddonPricingEvent = {
  tshirtAddon?: AddonConfig;
  bannerAddon?: AddonConfig;
  banquet?: AddonConfig;
  campConfig?: { leoAddon?: AddonConfig };
};

export type AddonLineType = 'tshirt' | 'banner' | 'banquet' | 'leo';

/** This add-on type's config on the event, or `undefined` if not offered. */
export function addonConfig(
  event: AddonPricingEvent,
  lineType: AddonLineType | string | null,
): AddonConfig | undefined {
  if (lineType === 'tshirt') return event.tshirtAddon;
  if (lineType === 'banner') return event.bannerAddon;
  if (lineType === 'banquet') return event.banquet;
  if (lineType === 'leo') return event.campConfig?.leoAddon;
  return undefined;
}

/** Addon price (DOLLARS), by line type. Unconfigured/unknown type ⇒ `null` —
 *  callers must treat that as "can't price this" (e.g. hide/disable the
 *  purchase action), never fall back to charging $0. MIRRORS
 *  supabase/functions/_shared/stripe.ts's `addonPriceDollars`. */
export function addonPrice(event: AddonPricingEvent, lineType: AddonLineType | string | null): number | null {
  const cfg = addonConfig(event, lineType);
  return cfg ? cfg.price : null;
}

/**
 * Is an add-on purchasable RIGHT NOW? Purchasable until `config.lastPurchaseAt`
 * when set (which MAY be after `regCloses`); when unset, purchasable only
 * while registration is open (`now <= regCloses`). `now` is a parameter so
 * this stays pure/testable. MIRRORED IN supabase/functions/_shared/stripe.ts
 * (`addonPurchaseOpen`) — keep in sync.
 */
export function addonPurchaseOpen(
  config: { lastPurchaseAt?: string } | undefined,
  regCloses: string,
  now: Date,
): boolean {
  const deadline = config?.lastPurchaseAt ? Date.parse(config.lastPurchaseAt) : Date.parse(regCloses);
  return now.getTime() <= deadline;
}

// --- Per-unit add-on draft state (individual purchase UI, Phase 2 Task 3) --
// Pure helpers shared by the registration popup's add-on step and the
// standalone post-registration purchase dialog in src/pages/Events.tsx. One
// cart line is created per UNIT (each shirt/leo/banquet ticket its own line).

/** Minimal Event slice the add-on draft helpers need (name/id for labels,
 *  regCloses/eventType for windows + camp forced-choice behavior). Overrides
 *  `AddonPricingEvent`'s bare `AddonConfig`s with the fuller shapes
 *  (`sizes`/`name`) `buildAddonCartItems` needs for labels/pricing. */
export type AddonDraftEvent = {
  id: string;
  name: string;
  regCloses: string;
  eventType?: 'competition' | 'camp';
  tshirtAddon?: { price: number; sizes: string[]; lastPurchaseAt?: string };
  bannerAddon?: AddonConfig;
  banquet?: { price: number; name: string; lastPurchaseAt?: string };
  campConfig?: { leoAddon?: { price: number; sizes: string[]; lastPurchaseAt?: string } };
};

/** One athlete's in-progress add-on selections. Each array entry is one
 *  purchasable UNIT — one cart line per entry once submitted. Shirt/leo unit
 *  values: a real size, `'none'` (camp explicit opt-out), or `''` (camp: not
 *  yet chosen — invalid). Banquet unit values: a person id (assigned) or the
 *  literal `'extra'`. */
export interface AddonDraft {
  shirtUnits: string[];
  leoUnits: string[];
  banquetUnits: string[];
  /** Registration-popup only — the standalone purchase doesn't offer the banner. */
  bannerText: string;
}

/** Fresh draft for `event`. In the REGISTRATION popup on a CAMP, the shirt/leo
 *  pickers must force an explicit choice (event-mgmt v2 Phase 2 spec §G) —
 *  seed a single unfilled unit (`''`) so the picker renders required and
 *  nothing is pre-selected. Standalone purchases are always optional/
 *  quantity-based, so they start empty regardless of event type. */
export function initialAddonDraft(event: AddonDraftEvent, mode: 'registration' | 'standalone'): AddonDraft {
  const forceCamp = mode === 'registration' && event.eventType === 'camp';
  return {
    shirtUnits: forceCamp && event.tshirtAddon ? [''] : [],
    leoUnits: forceCamp && event.campConfig?.leoAddon ? [''] : [],
    banquetUnits: [],
    bannerText: '',
  };
}

/** Any configured add-on type still purchasable right now? Gates whether the
 *  registration popup shows an add-ons step, and whether the standalone
 *  "Add-ons" affordance appears on the event page. `includeBanner` is false
 *  for the standalone check (the banner is a registration-time-only line). */
export function anyAddonWindowOpen(event: AddonDraftEvent, now: Date, opts: { includeBanner?: boolean } = {}): boolean {
  const includeBanner = opts.includeBanner ?? true;
  return (
    (!!event.tshirtAddon && addonPurchaseOpen(event.tshirtAddon, event.regCloses, now)) ||
    (includeBanner && !!event.bannerAddon && addonPurchaseOpen(event.bannerAddon, event.regCloses, now)) ||
    (!!event.banquet && addonPurchaseOpen(event.banquet, event.regCloses, now)) ||
    (!!event.campConfig?.leoAddon && addonPurchaseOpen(event.campConfig.leoAddon, event.regCloses, now))
  );
}

/** Camp forced-choice validation: any configured+open camp shirt/leo picker
 *  must have an explicit selection (a size or `'none'`) before continuing.
 *  Always true for non-camp events (their shirt add-on is quantity-based, so
 *  0 selected just means "skip it"). `now` is a parameter so this stays pure. */
export function addonDraftValid(event: AddonDraftEvent, draft: AddonDraft, now: Date): boolean {
  if (event.eventType !== 'camp') return true;
  if (event.tshirtAddon && addonPurchaseOpen(event.tshirtAddon, event.regCloses, now) && !draft.shirtUnits[0]) return false;
  if (event.campConfig?.leoAddon && addonPurchaseOpen(event.campConfig.leoAddon, event.regCloses, now) && !draft.leoUnits[0]) return false;
  return true;
}

/** Turns a draft into one cart line PER UNIT (per-unit add-on model, Tasks
 *  1+2). `'none'`/`''` shirt-leo units are skipped (no line). Ids are
 *  timestamp+running-index so a mixed multi-type submission never collides. */
export function buildAddonCartItems(
  event: AddonDraftEvent,
  athlete: Pick<Athlete, 'id' | 'firstName' | 'lastName'>,
  draft: AddonDraft,
  ts: number,
): CartItem[] {
  const items: CartItem[] = [];
  let n = 0;
  if (event.tshirtAddon) {
    for (const size of draft.shirtUnits) {
      if (!size || size === 'none') continue;
      n += 1;
      items.push({
        id: `ci-tshirt-${ts}-${n}`,
        label: `${event.name} t-shirt — ${athlete.firstName} ${athlete.lastName} (size ${size})`,
        amount: event.tshirtAddon.price,
        kind: 'addon',
        refUserId: athlete.id,
        refEventId: event.id,
        refLineType: 'tshirt',
        addonSize: size,
      });
    }
  }
  if (event.campConfig?.leoAddon) {
    for (const size of draft.leoUnits) {
      if (!size || size === 'none') continue;
      n += 1;
      items.push({
        id: `ci-leo-${ts}-${n}`,
        label: `${event.name} leotard — ${athlete.firstName} ${athlete.lastName} (size ${size})`,
        amount: event.campConfig.leoAddon.price,
        kind: 'addon',
        refUserId: athlete.id,
        refEventId: event.id,
        refLineType: 'leo',
        addonSize: size,
      });
    }
  }
  if (event.banquet) {
    for (const assigneeId of draft.banquetUnits) {
      n += 1;
      items.push({
        id: `ci-banquet-${ts}-${n}`,
        label: `${event.name} ${event.banquet.name} — ${assigneeId === athlete.id ? `For ${athlete.firstName} ${athlete.lastName}` : 'Extra ticket'}`,
        amount: event.banquet.price,
        kind: 'addon',
        refUserId: athlete.id,
        refEventId: event.id,
        refLineType: 'banquet',
        addonAssigneeId: assigneeId,
      });
    }
  }
  if (event.bannerAddon && draft.bannerText.trim()) {
    items.push({
      id: `ci-banner-${ts}`,
      label: `${event.name} club banner — "${draft.bannerText.trim()}"`,
      amount: event.bannerAddon.price,
      kind: 'addon',
      refUserId: athlete.id,
      refEventId: event.id,
      refLineType: 'banner',
    });
  }
  return items;
}

// --- Camp registrant survey (event-mgmt v2 §G; editable questions 2026-07-23)
// Asked per athlete, LAST in the camp registration popup (after add-ons),
// only when the event's survey is enabled. Persists onto
// `Registration.campSurvey` (jsonb `camp_survey` column), keyed by question
// id. Survey edits are FREE — never a change fee — so this stays entirely
// outside the pricing/cart-line logic above; it only affects a line's LABEL
// summary. `campSurveyQuestionsOf` is the SINGLE resolver every consumer
// (wizard editor, registration UI, responses card, exports, edge functions)
// must go through — it's what makes the old fixed 4-question events keep
// working without a data migration.

/** Cabin-gender-preference options: the app's existing Gender option
 *  conventions (Profile.tsx) + "No preference". Reused as the legacy
 *  `cabinGenderPref` question's option list. */
export const CABIN_GENDER_OPTIONS = ['Male', 'Female', 'Non-binary', 'Genderfluid', 'Agender', 'Other', 'No preference'];

/** Minimal `Event.campConfig` slice the resolver needs — kept as a standalone
 *  type (rather than importing `Event`) so this module's camp-survey helpers
 *  stay decoupled from the full Event shape. Matches the deprecated fields'
 *  doc comments in types.ts. */
export type CampConfigForSurvey = {
  overnightSurvey?: boolean;
  surveyMandatory?: { bedtime?: boolean; noiseLevel?: boolean; cabinGenderPref?: boolean; roommateRequest?: boolean };
  survey?: { enabled: boolean; questions: CampSurveyQuestion[] };
};

/** Legacy (pre-2026-07-23) label maps for the 4 fixed-id questions' option
 *  values — used only by `campSurveyAnswerLabel` and the legacy-question
 *  option lists below. Custom questions store option text verbatim, so their
 *  answers ARE their own label (no map needed). */
const LEGACY_BEDTIME_LABELS: Record<string, string> = {
  'before-10': 'Before 10pm', '10-to-midnight': '10pm–midnight', 'after-midnight': 'After midnight',
};
const LEGACY_NOISE_LABELS: Record<string, string> = { quiet: 'Quiet', moderate: 'Moderate', lively: 'Lively' };

/** The 4 legacy fixed questions, in their historical order/wording, with the
 *  legacy default "Mandatory?" values (bedtime/noise/cabin-pref required,
 *  roommate optional) — overridden per-question by `campConfigForSurvey.
 *  surveyMandatory` when present. */
function legacyQuestions(config?: CampConfigForSurvey): CampSurveyQuestion[] {
  const m = config?.surveyMandatory;
  return [
    {
      id: 'bedtime', label: 'What time do you plan to go to bed?', type: 'single',
      options: ['before-10', '10-to-midnight', 'after-midnight'], required: m?.bedtime ?? true,
    },
    {
      id: 'noiseLevel', label: 'What is the preferred noise level in your cabin?', type: 'single',
      options: ['quiet', 'moderate', 'lively'], required: m?.noiseLevel ?? true,
    },
    {
      id: 'cabinGenderPref', label: 'Would you prefer a co-ed or single gender cabin?', type: 'single',
      options: [...CABIN_GENDER_OPTIONS], required: m?.cabinGenderPref ?? true,
    },
    {
      id: 'roommateRequest',
      label: 'If you have any roommate requests (including people you DO NOT want to room with), please list them here.',
      type: 'text', required: m?.roommateRequest ?? false,
    },
  ];
}

/** Resolve an event's effective survey (enabled + question list) — the
 *  single source of truth every consumer must call rather than reading
 *  `campConfig.survey`/`overnightSurvey`/`surveyMandatory` directly:
 *   - `campConfig.survey` present ⇒ used as-is (the current, editable shape).
 *   - Otherwise derived from the legacy `overnightSurvey` on/off flag + the
 *     legacy `surveyMandatory` per-question toggles, so pre-2026-07-23 camps
 *     (including ones with no campConfig at all) keep their historical
 *     4-question survey, editable going forward. */
export function campSurveyQuestionsOf(config?: CampConfigForSurvey): { enabled: boolean; questions: CampSurveyQuestion[] } {
  if (config?.survey) return config.survey;
  return { enabled: !!config?.overnightSurvey, questions: legacyQuestions(config) };
}

/** Human-readable label for one answer VALUE to question `questionId`. Legacy
 *  fixed-id questions map their coded values (`before-10`, `quiet`, …)
 *  through the historical label maps; every other question (including all
 *  custom ones) stores its option text verbatim, so the value already IS the
 *  label. */
export function campSurveyAnswerLabel(questionId: string, value: string): string {
  if (questionId === 'bedtime') return LEGACY_BEDTIME_LABELS[value] ?? value;
  if (questionId === 'noiseLevel') return LEGACY_NOISE_LABELS[value] ?? value;
  return value;
}

/** A question is "answered" iff its stored value is non-blank (text/single)
 *  or has at least one selection (multi). */
function campSurveyQuestionAnswered(answers: Registration['campSurvey'] | undefined, q: CampSurveyQuestion): boolean {
  const v = answers?.[q.id];
  if (q.type === 'multi') return Array.isArray(v) && v.length > 0;
  return typeof v === 'string' && v.trim().length > 0;
}

/** Every `required` question in `questions` must be answered; anything not
 *  required is optional regardless of what's in `answers`. */
export function campSurveyAnswersValid(answers: Registration['campSurvey'] | undefined, questions: CampSurveyQuestion[]): boolean {
  return questions.every((q) => !q.required || campSurveyQuestionAnswered(answers, q));
}

/** Answers → the shape stored on `Registration.campSurvey`. Returns
 *  `undefined` when nothing was answered (so a reg with the survey skipped
 *  doesn't carry an empty-object stub). Drops blank text answers and
 *  empty-array multi answers so a stored survey never carries "answered but
 *  empty" noise. */
export function campSurveyToStored(answers: Record<string, string | string[]>): Registration['campSurvey'] {
  const out: Record<string, string | string[]> = {};
  for (const [id, v] of Object.entries(answers)) {
    if (Array.isArray(v)) {
      if (v.length > 0) out[id] = v;
    } else if (v.trim()) {
      out[id] = v.trim();
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Short human-readable summary for a cart/reg line-item label, e.g.
 *  "Bedtime: 10pm–midnight, Noise level: Quiet". Empty string when there's
 *  nothing to summarize. Iterates `questions` (not the raw answers object) so
 *  the order matches the event's configured question order. */
export function campSurveySummary(survey: Registration['campSurvey'] | undefined, questions: CampSurveyQuestion[]): string {
  if (!survey) return '';
  const parts: string[] = [];
  for (const q of questions) {
    const v = survey[q.id];
    if (v == null || (Array.isArray(v) && v.length === 0) || v === '') continue;
    const label = Array.isArray(v) ? v.map((x) => campSurveyAnswerLabel(q.id, x)).join(', ') : campSurveyAnswerLabel(q.id, v);
    parts.push(`${q.label}: ${label}`);
  }
  return parts.join(', ');
}

// --- Club-manager per-unit add-on draft (Phase 2 Task 4) --------------------
// The club-manager "Add-ons card" (Club.tsx) is a variant of the athlete
// AddonDraft above: no camp/leo (camps have no club-manager registration
// path), and banquet tickets are assigned to ANY club-affiliated person (not
// just "self or extra") via a roster dropdown, so the shape differs enough to
// warrant its own draft type rather than overloading AddonDraft.

/** Minimal Event slice `buildClubAddonCartItems` needs. */
export type ClubAddonDraftEvent = {
  id: string;
  name: string;
  tshirtAddon?: { price: number; sizes: string[]; lastPurchaseAt?: string };
  bannerAddon?: AddonConfig;
  banquet?: { price: number; name: string; lastPurchaseAt?: string };
};

/** The club manager's in-progress add-on selections. `shirtUnits`: one size
 *  per unit. `banquetUnits`: one entry per ticket — a club-affiliated
 *  person's id, or the literal `'extra'` for an unassigned ticket. */
export interface ClubAddonDraft {
  shirtUnits: string[];
  banquetUnits: string[];
  bannerText: string;
}

export function initialClubAddonDraft(): ClubAddonDraft {
  return { shirtUnits: [], banquetUnits: [], bannerText: '' };
}

/** Turns a club add-on draft into one cart line PER UNIT, matching the
 *  per-unit add-on model (Tasks 1+2). `assigneeName(id)` resolves a banquet
 *  ticket's roster person id to a display name for the line label. Ids are
 *  timestamp+running-index so a mixed multi-type submission never collides. */
export function buildClubAddonCartItems(
  event: ClubAddonDraftEvent,
  draft: ClubAddonDraft,
  assigneeName: (id: string) => string,
  ts: number,
): CartItem[] {
  const items: CartItem[] = [];
  let n = 0;
  if (event.tshirtAddon) {
    for (const size of draft.shirtUnits) {
      if (!size) continue;
      n += 1;
      items.push({
        id: `ci-club-tshirt-${ts}-${n}`,
        label: `${event.name} t-shirt (size ${size})`,
        amount: event.tshirtAddon.price,
        kind: 'addon',
        refEventId: event.id,
        refLineType: 'tshirt',
        addonSize: size,
      });
    }
  }
  if (event.banquet) {
    for (const assigneeId of draft.banquetUnits) {
      if (!assigneeId) continue;
      n += 1;
      items.push({
        id: `ci-club-banquet-${ts}-${n}`,
        label: `${event.name} ${event.banquet.name} — ${assigneeId === 'extra' ? 'Extra ticket' : `For ${assigneeName(assigneeId)}`}`,
        amount: event.banquet.price,
        kind: 'addon',
        refUserId: assigneeId === 'extra' ? undefined : assigneeId,
        refEventId: event.id,
        refLineType: 'banquet',
        addonAssigneeId: assigneeId,
      });
    }
  }
  if (event.bannerAddon && draft.bannerText.trim()) {
    items.push({
      id: `ci-club-banner-${ts}`,
      label: `${event.name} club banner — "${draft.bannerText.trim()}"`,
      amount: event.bannerAddon.price,
      kind: 'addon',
      refEventId: event.id,
      refLineType: 'banner',
    });
  }
  return items;
}

// --- Purchased add-on unit ordering (UAT round 2, M-01-05) -----------------
// The club-manager "Add-Ons" tab's "Purchased add-ons" list used to render in
// whatever order `db.invoices`/`inv.items` happened to iterate in. Julia's
// spec: sort by add-on TYPE first, then alphabetically by assignee within a
// type. Only banquet units carry a real assignee (tshirt/banner units don't
// — see `buildClubAddonCartItems` above), so `assigneeName` is simply `''`
// for those and they sort together, in a stable relative order, ahead of any
// named assignee (empty string sorts first).
const ADDON_TYPE_ORDER: Record<string, number> = { tshirt: 0, banquet: 1, banner: 2, leo: 3 };

/** Pure comparator for `Array.prototype.sort` — the caller resolves each
 *  unit's own `refLineType` and a display `assigneeName` (already looked up
 *  from a roster id, or `''` when the type has no assignee) before calling
 *  this; it does no lookups of its own so it stays trivially unit-testable. */
export function addonUnitSort(
  a: { refLineType?: string; assigneeName: string },
  b: { refLineType?: string; assigneeName: string },
): number {
  const ta = ADDON_TYPE_ORDER[a.refLineType ?? ''] ?? 99;
  const tb = ADDON_TYPE_ORDER[b.refLineType ?? ''] ?? 99;
  if (ta !== tb) return ta - tb;
  return a.assigneeName.localeCompare(b.assigneeName);
}

/** Minimal `Invoice` slice `clubPurchasedAddonUnits` needs. */
export type PurchasedAddonInvoice = { clubId: string | null; items: CartItem[] };

/** The club's non-refunded, already-purchased add-on units for one event —
 *  the SAME derivation `ClubAddonsCard` uses for its "Purchased add-ons" list
 *  (Club.tsx), lifted here (M-01-05 spec-mismatch fix) so `EventRegGrid` can
 *  ALSO use it to decide whether the Add-Ons tab should be visible at all:
 *  the tab must stay visible once every add-on purchase window has closed as
 *  long as the club actually bought something, even though the card's own
 *  purchase/add affordances stay window-gated. `db.invoices` is boot-scoped
 *  and RLS-restricted to invoices the caller can see, so this is cheap to
 *  call from either component without an extra fetch. */
export function clubPurchasedAddonUnits(
  invoices: PurchasedAddonInvoice[],
  clubId: string,
  eventId: string,
): CartItem[] {
  return invoices
    .filter((inv) => inv.clubId === clubId)
    .flatMap((inv) => inv.items.filter((it) => it.kind === 'addon' && it.refEventId === eventId && !it.refunded));
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
  /** By-session-mode session pick (event-mgmt v2 P4). Absent/null are
   *  equivalent (by-discipline events, or no session assigned yet) — compared
   *  as `?? null` below so an unset-vs-unset pair never registers as a
   *  "change". Callers building the BEFORE side of a brand-new registration
   *  never pass one through `changeIsEligible` at all (a new reg has no
   *  `existing` row, so `isEditingExisting` is false and the eligibility
   *  check is skipped entirely) — so a first-time by-session assignment is
   *  never mistaken for a chargeable session move. */
  sessionId?: string | null;
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
 * or T&T apparatus-level (`apparatusLevels`) changed for a discipline in both;
 * a SESSION move (by-session events, emv2 P4 — see `RegDisciplineEntry.sessionId`)
 * for a discipline in both; the club changed; or the athlete was swapped.
 * Adding/removing apparatus WITHIN an already-registered discipline, REMOVING
 * a discipline, or no change at all are NOT (on their own) eligible.
 *
 * A level change that ALSO forces a session move (the new level no longer
 * fits the old session) still returns true only once — the level branch below
 * already caught it, so callers charge exactly one change fee, never two.
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

  // Level / session change for a shared discipline.
  for (const [disc, a] of afterMap) {
    const b = beforeMap.get(disc);
    if (!b) continue;
    if (a.levelId !== b.levelId) return true;
    if (apparatusLevelsDiffer(a.apparatusLevels, b.apparatusLevels)) return true;
    if ((a.sessionId ?? null) !== (b.sessionId ?? null)) return true;
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
    if ((a.sessionId ?? null) !== (b.sessionId ?? null)) return true;
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

// --- Coupon scoping (UAT M-11-01, S1) ---------------------------------------
// Which "Applies to" category a priced line falls under, so a coupon scoped
// to e.g. `appliesTo: 'meet-entry'` ("Event entries") discounts actual new
// registrations only — never a change fee or an add-on line, which used to
// all share the same 'meet-entry' tag and so got discounted right along with
// real entries. MIRRORED IN supabase/functions/_shared/stripe.ts — keep in
// sync. Not currently wired into any client-side preview (the cart/checkout
// UI renders only the server's authoritative Subtotal/Coupon/Fee/Total, per
// money-invariants.md — there is no client-side coupon recompute to fix);
// exported so the eligibility rule has exactly one tested implementation per
// runtime, reusable if a client preview is ever added.
export type CouponScope =
  | 'athlete-membership' | 'club-membership' | 'coach-membership'
  | 'meet-entry' | 'change-fee' | 'addon';

/** Minimal per-line shape `couponEligibleLine` needs. */
export interface CouponScopedLine {
  scope?: CouponScope;
  eventId?: string;
}

/**
 * Is `line` eligible for `coupon`'s discount, per the coupon's "Applies to"
 * scope? `'any'` matches every line; the legacy `'membership'` matches all
 * three membership scopes; `'meet-entry'` matches ONLY a true entry line
 * (never `'change-fee'` or `'addon'`), further narrowed to one event when
 * `appliesToEventId` is set; anything else falls back to an exact scope
 * match. MIRRORED IN supabase/functions/_shared/stripe.ts (`couponEligibleLine`)
 * — keep in sync.
 */
export function couponEligibleLine(line: CouponScopedLine, coupon: Pick<Coupon, 'appliesTo' | 'appliesToEventId'>): boolean {
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

/** Service fee passed to the payer: 3% + $0.30 of the order subtotal, in CENTS.
 *  Operates in Stripe's cent unit (distinct from the dollar-based legacy fns above).
 *  Rounds UP (never to-nearest) so the collected fee never falls a cent short
 *  of Stripe's actual processing fee on the total charged. Mirrors
 *  `processingFee` in supabase/functions/_shared/stripe.ts. */
export function processingFee(subtotalCents: number): number {
  return Math.ceil(subtotalCents * 0.03) + 30;
}

/** Pure decision for `CartCheckout.tsx`'s preview→pay gate (UAT M-12-01): given
 *  `create-checkout-session { mode: 'preview' }`'s returned `total` in CENTS
 *  (post-discount subtotal plus service fee — the server charges $0 service
 *  fee when the subtotal is already $0, mirroring its free-order branch),
 *  decide whether the UI must stop for an explicit no-charge confirmation
 *  ('free-confirm') or can proceed straight to creating a real Stripe session
 *  ('stripe'). A $0 total is reachable ONLY via a coupon discounting the
 *  whole cart — the server fulfills that order immediately once asked for
 *  real (no Stripe step to confirm through), so the client must never
 *  auto-request it without the user explicitly confirming first. */
export function checkoutMode(previewTotalCents: number): 'free-confirm' | 'stripe' {
  return previewTotalCents <= 0 ? 'free-confirm' : 'stripe';
}

/** One line of the "We updated these prices to today's rates" notice shown on
 *  the Cart page (S4, money-story UX spec §1): a cart item whose server
 *  preview price differs from the stale, client-written amount the cart was
 *  displaying. Dollars, ready for `fmtMoney`. */
export interface CartPriceDiffLine {
  itemId: string;
  label: string;
  oldDollars: number;
  newDollars: number;
}

/** Pure diff between the cart's currently-DISPLAYED (stale) line amounts and
 *  `create-checkout-session { mode: 'preview' }`'s server-priced lines (S4).
 *  No DB/React access, fully unit-testable — this is the heart of the
 *  cart/checkout price-agreement feature.
 *
 *  Compares in CENTS (rounding each displayed dollar amount) to avoid float
 *  noise from repeated dollar arithmetic; returns DOLLARS for direct display.
 *  A server line with no matching displayed item (or a displayed item the
 *  server didn't price) is silently skipped — that's a cart/response
 *  membership mismatch for the caller to handle separately, not a price
 *  change to report. Result order follows `serverLines`. */
export function diffCartLinePrices(
  displayedItems: { id: string; label: string; amount: number }[],
  serverLines: { itemId: string; label: string; amountCents: number }[],
): CartPriceDiffLine[] {
  const displayedById = new Map(displayedItems.map((i) => [i.id, i]));
  const diffs: CartPriceDiffLine[] = [];
  for (const line of serverLines) {
    const displayed = displayedById.get(line.itemId);
    if (!displayed) continue;
    const oldCents = Math.round(displayed.amount * 100);
    if (oldCents !== line.amountCents) {
      diffs.push({
        itemId: line.itemId,
        label: line.label,
        oldDollars: displayed.amount,
        newDollars: line.amountCents / 100,
      });
    }
  }
  return diffs;
}

/** UI/UX review H5 (2026-07-04 doc, fixed 2026-07-26): how many CartCard
 *  groups `Cart.tsx`'s `groupCartItems` would render for one scope (the
 *  personal cart, or one managed club's cart) — Memberships (0 or 1) + one
 *  per distinct event + Other (0 or 1). `CartScope` uses this to decide
 *  whether its "Total / Print Invoice / Check out everything" bar adds real
 *  information (2+ groups) or is pure redundancy with the sole CartCard's
 *  own subtotal + checkout button (1 group). */
export function cartSectionCount(groups: { membership: unknown[]; events: unknown[]; other: unknown[] }): number {
  return (groups.membership.length > 0 ? 1 : 0) + groups.events.length + (groups.other.length > 0 ? 1 : 0);
}

/** UAT M-12-03: which event ids a set of just-checked-out cart items could
 *  reference, derived WITHOUT touching any registration slice — the same
 *  `label.includes(event.name)` join `Cart.tsx`'s `groupCartItems` already
 *  uses to build the per-event cart cards, so it names exactly the events
 *  those cards represent. `CartScope.onPaid` unions this with its existing
 *  `regs`-derived lookup (walk each item's `refRegIds`, resolve to a
 *  registration, take its `eventId`) before calling
 *  `invalidateEventRegistrations` for every id found, rather than relying on
 *  the regs-derived lookup alone.
 *
 *  Why the union matters: the regs-derived lookup silently drops any
 *  `refRegId` not present in `regs` — and `regs` there is the by-club (or
 *  "mine") registration slice, which can be incomplete right at
 *  checkout-completion (not yet 'ready', or a row not yet locally upserted
 *  into that scope). For a PERSONAL checkout this is harmless: `onPaid` also
 *  unconditionally calls `invalidateMyRegistrations()`, and
 *  `MyRegistrations.tsx` reads that exact same "mine" tier — so even a
 *  missed by-event invalidation doesn't show stale data. For a CLUB
 *  checkout, `Club.tsx`'s `EventRegGrid` reads ONLY the by-event slice
 *  (`useEventRegistrations`), which has no such fallback — a missed id here
 *  is a genuinely stale "Pending Purchase" badge until a hard reload resets
 *  every module-level slice cache. This function gives that path an
 *  independent, always-available second source for the same ids. */
export function eventIdsForCartItems(
  items: { label: string }[],
  events: { id: string; name: string }[],
): string[] {
  const ids = new Set<string>();
  for (const item of items) {
    const event = events.find((e) => item.label.includes(e.name));
    if (event) ids.add(event.id);
  }
  return [...ids];
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

/**
 * Given a set of registration ids that just got waitlisted (event-mgmt v2 P4
 * T6 checkout-conflict resolution — NOT the ✕ removal path above, which
 * deletes/reverts regs; here the regs SURVIVE as waitlist placeholders and
 * only the cart line covering them needs to go away), returns the cart with
 * every affected line's `refRegIds` shrunk to just the unaffected remainder.
 * A line left with zero remaining refRegIds is dropped entirely (nothing left
 * for it to charge); a line untouched by `waitlistedRegIds` passes through
 * unchanged (same object reference, so callers can cheaply detect no-ops).
 * Pure: no store/DB access, no id generation.
 */
export function shrinkOrDropCartLines(
  cart: CartItem[],
  waitlistedRegIds: Set<string>,
): CartItem[] {
  const next: CartItem[] = [];
  for (const item of cart) {
    if (!item.refRegIds || item.refRegIds.length === 0) { next.push(item); continue; }
    const remaining = item.refRegIds.filter((id) => !waitlistedRegIds.has(id));
    if (remaining.length === item.refRegIds.length) { next.push(item); continue; }
    if (remaining.length === 0) continue; // fully covered by the waitlist — drop the line
    next.push({ ...item, refRegIds: remaining });
  }
  return next;
}

/**
 * Refund amount for one item (event-mgmt v2 Phase 3, spec §H — Nate decision
 * 2026-07-10): the SERVICE FEE IS NEVER REFUNDED — this takes only the item's
 * own price (entry fee or add-on price), already excluding the service fee.
 * 100% back when approved on/before the event's `lastDateToEdit` (or when the
 * event has no `lastDateToEdit` at all — matches `canStillEditRegistration`'s
 * "no cutoff ⇒ always" convention in events-core.ts); 75% back after.
 * `Math.round` (not floor/ceil) on the 75% case, matching the service fee's
 * "documented rounding direction, mirrored consistently" spirit elsewhere in
 * this file. `approvedAt`/`lastDateToEdit` are both ISO timestamps compared
 * via `Date`, exactly like `canStillEditRegistration`. */
export function refundAmountCents(
  itemAmountCents: number,
  lastDateToEdit: string | null | undefined,
  approvedAt: string,
): number {
  const onTime = !lastDateToEdit || new Date(approvedAt).getTime() <= new Date(lastDateToEdit).getTime();
  return onTime ? itemAmountCents : Math.round(itemAmountCents * 0.75);
}

/**
 * Cap a computed refund at what's actually left to refund on the payment
 * (T6, spec §H). The refund BASE is the snapshot line's POST-discount
 * `paid_cents` (frozen onto payments.lines_snapshot by create-checkout-session;
 * legacy payments without it fall back to the PRE-coupon `invoice_items.amount`).
 * This cap is the FINAL guard on top of that base: it covers cross-request
 * over-refunds on the same payment and the $0-total free-order path
 * (`payments.amount_subtotal` 0, no Stripe payment intent). `availableCents`
 * is the caller-computed `payment.amount_subtotal` minus the sum of
 * `refund_amount_cents` already approved against the SAME payment. Never
 * negative, never more than what's left. NOT sufficient alone for a legacy
 * partially-couponed multi-line payment — see the documenting test in
 * tests/pricing.test.ts. Mirrored in
 * `supabase/functions/process-refund/index.ts`. */
export function capRefundCents(computedCents: number, availableCents: number): number {
  return Math.min(computedCents, Math.max(0, availableCents));
}

/**
 * One resolved refundable line for `allocateRegistrationRefund` — a paid
 * `invoice_items` row (entry or extra-discipline fee) for the registration
 * being refunded, already resolved to the payment that funded it. */
export interface RefundAllocationLine {
  paymentId: string;
  /** `invoice_items.ref_line_type` — a `'change'` line is excluded entirely
   *  (rule 2: change fees are never refundable), regardless of `afterDeadline`. */
  refLineType: string | null;
  /** Post-coupon `paid_cents` for this line (payments.lines_snapshot; falls
   *  back to `invoice_items.amount` when the snapshot predates the field —
   *  see process-refund's resolution). */
  paidCents: number;
}

/**
 * Per-PAYMENT refund allocation for a registration refund (UAT Z-04, rules
 * 1/2/4): a registration can be paid across MULTIPLE Stripe payments — an
 * original entry invoice plus a later "add discipline" invoice, each its own
 * charge — and a refund on that registration must refund EVERY one of them,
 * not just the first one resolved. Pure: groups the given lines by
 * `paymentId`, drops any `'change'` line (never refundable), sums what's left
 * per payment, then scales each payment's sum to 75% (rounded) when
 * `afterDeadline` — PER PAYMENT, not on the combined total, so each Stripe
 * refund call gets its own correctly-rounded amount and rounding never
 * leaks a cent from one payment's allocation into another's. A payment left
 * with zero refundable lines (only a change line referenced it) does not
 * appear in the result at all. Mirrored in
 * `supabase/functions/_shared/refund-allocation.ts` for `process-refund`
 * (Deno can't import `src/lib` code). Caller is responsible for actually
 * calling `claim_refund_approval` once per returned payment — this function
 * only computes amounts, it does no I/O and no capping against what's
 * already been approved (that's the RPC's job, per payment).
 */
export function allocateRegistrationRefund(
  lines: RefundAllocationLine[],
  opts: { afterDeadline: boolean },
): { paymentId: string; cents: number }[] {
  const byPayment = new Map<string, number>();
  for (const line of lines) {
    if (line.refLineType === 'change') continue;
    byPayment.set(line.paymentId, (byPayment.get(line.paymentId) ?? 0) + line.paidCents);
  }
  return Array.from(byPayment.entries()).map(([paymentId, sumCents]) => ({
    paymentId,
    cents: opts.afterDeadline ? Math.round(sumCents * 0.75) : sumCents,
  }));
}

/**
 * Rule 7 (UAT Z-04): `process-refund` returns a 409 "already reviewed" when a
 * group has no pending rows left — which happens both for a genuine conflict
 * (a second reviewer rejected it while this one was approving) AND for the
 * harmless case of two reviewers clicking the SAME decision (e.g. both hit
 * Approve within a race). `RefundReview.tsx` should silently refetch and move
 * the request to history in the harmless case, and keep the error toast for
 * the genuine conflict. Pure so the branch is unit-testable without a live
 * 409: 'silent' when the request's CURRENT status already equals the outcome
 * the reviewer just attempted, 'toast' otherwise (including when it's still
 * 'pending' somehow, or decided to the OPPOSITE outcome). */
export function decideAfterConflict(
  currentStatus: 'pending' | 'approved' | 'rejected',
  attempted: 'approve' | 'reject',
): 'silent' | 'toast' {
  const outcomeStatus = attempted === 'approve' ? 'approved' : 'rejected';
  return currentStatus === outcomeStatus ? 'silent' : 'toast';
}

// --- Nationals session-request survey (event-mgmt v2 Phase 5 A1, spec §L.1/§E5.4) ---
// Pure derivation of WHICH surveys a club/independent athlete owes for a
// nationals event, and whether a given set of existing survey rows already
// covers them. Reused by the A2 survey UI (what to render/prompt) and the A3
// checkout gate (block checkout until answered); the same rules are mirrored
// server-side for A3 (spec calls for enforcement at checkout, not just UI).

/** Minimal Event slice these helpers need. */
export type SessionRequestEvent = { kind?: 'standard' | 'nationals' };

/** One required survey slot: a discipline, plus (WAG club variant only) the
 *  specific level it's scoped to. `levelId: null` means the combined
 *  MAG/T&T club survey OR any independent-athlete survey (which never
 *  splits by level). */
export type SessionRequestKey = { discipline: Discipline; levelId: string | null };

/** Minimal Registration slice these helpers need. */
export type SessionRequestReg = { discipline: Discipline; levelId: string };

/**
 * Which session-request surveys are required for ONE scope (a club's
 * registrations, or one independent athlete's registrations) at `event`.
 * Returns [] for any non-nationals event — the survey only exists on
 * `event.kind === 'nationals'`.
 *
 * Considers ALL passed registrations — paid AND pending/in-cart — since the
 * survey is about session PLANNING (which needs to account for what's in the
 * pipeline), not billing state.
 *
 * `scope`:
 *  - 'club': one key per distinct WAG level with ≥1 reg (`{ WAG, levelId }`
 *    each), plus one combined `{ MAG, null }` key if any MAG reg exists,
 *    plus one combined `{ TNT, null }` key if any T&T reg exists.
 *  - 'person' (independent athlete): one `{ discipline, null }` key per
 *    distinct discipline the person is registered in — never split by
 *    level, regardless of discipline.
 */
export function requiredSessionRequests(
  event: SessionRequestEvent,
  regs: SessionRequestReg[],
  scope: 'club' | 'person',
): SessionRequestKey[] {
  if (event.kind !== 'nationals') return [];
  const keys: SessionRequestKey[] = [];
  if (scope === 'person') {
    const disciplines = new Set<Discipline>();
    for (const r of regs) disciplines.add(r.discipline);
    for (const discipline of disciplines) keys.push({ discipline, levelId: null });
    return keys;
  }
  // scope === 'club'
  const wagLevels = new Set<string>();
  let hasMag = false;
  let hasTnt = false;
  for (const r of regs) {
    if (r.discipline === 'WAG') wagLevels.add(r.levelId);
    else if (r.discipline === 'MAG') hasMag = true;
    else if (r.discipline === 'TNT') hasTnt = true;
  }
  for (const levelId of wagLevels) keys.push({ discipline: 'WAG', levelId });
  if (hasMag) keys.push({ discipline: 'MAG', levelId: null });
  if (hasTnt) keys.push({ discipline: 'TNT', levelId: null });
  return keys;
}

/** A survey counts as answered once `arrival` (arrival window/day) is a
 *  non-empty string — every other field (preferred sessions, separate-gyms,
 *  notes) is optional, so completeness hinges on the one required choice. */
export function sessionRequestAnswered(answers: SessionRequestAnswers): boolean {
  return !!answers.arrival && answers.arrival.trim().length > 0;
}

/** Minimal existing-survey-row slice these helpers need. */
export type ExistingSessionRequest = { discipline: Discipline; levelId: string | null; answers: SessionRequestAnswers };

/** Which of `required` keys have no matching ANSWERED row in `existing` —
 *  an existing-but-unanswered row (e.g. a draft saved mid-fill) does not
 *  satisfy the requirement. Match is by (discipline, levelId) exact pair;
 *  `levelId` compares `null`-to-`null` for combined/independent surveys. */
export function missingSessionRequests(
  required: SessionRequestKey[],
  existing: ExistingSessionRequest[],
): SessionRequestKey[] {
  return required.filter((key) => !existing.some((e) =>
    e.discipline === key.discipline && e.levelId === key.levelId && sessionRequestAnswered(e.answers)));
}

/** Minimal registration slice `checkinAthleteCount` needs. */
export type CheckinScopeReg = { athleteId: string };

/** Distinct-athlete count for a check-in scope (event-mgmt v2 Phase 5 E1,
 *  spec §L.4) — "Athlete gift count" on the check-in card. Callers pass
 *  already-scoped, non-refunded/non-waitlisted registrations (one athlete
 *  can appear in several regs across disciplines/apparatus — the gift count
 *  is per ATHLETE, not per registration). */
export function checkinAthleteCount(regs: CheckinScopeReg[]): number {
  return new Set(regs.map((r) => r.athleteId)).size;
}

// --- Checkout gate (A3): mirrors the server-side block in
// create-checkout-session so the "Pay" action can be disabled/warned BEFORE
// the request is even sent (the server check is authoritative; this is
// advisory only). ---

/** Minimal event slice for the checkout-gate scan (adds id/name to
 *  `SessionRequestEvent`). */
export type SessionRequestGateEvent = { id: string; name: string; kind?: 'standard' | 'nationals' };

/** Minimal INCOMING (cart-referenced) registration slice for the
 *  checkout-gate scan — these are the regs actually being paid for right
 *  now, matching the server's "levels newly added by in-cart athletes"
 *  scope (not the athlete's/club's full history). */
export type SessionRequestGateReg = {
  athleteId: string; clubId: string; eventId: string;
  discipline: Discipline; levelId: string; refunded?: boolean;
};

/** Minimal person slice: only `mainClubId` decides independent (person-scoped)
 *  vs club-affiliated (club-scoped). */
export type SessionRequestGatePerson = { id: string; mainClubId: string | null };

/** Minimal existing-survey-row slice carrying the scoping columns — the
 *  checkout-gate scan spans multiple events/scopes in one pass (unlike the
 *  A2 UI callers, which pre-filter to one event/scope), so it filters here. */
export type ExistingSessionRequestRow = ExistingSessionRequest & {
  eventId: string; clubId?: string | null; personId?: string | null;
};

/**
 * Client-side mirror of the A3 server checkout gate (spec §L.1/§E5.4): given
 * the INCOMING registrations a cart line references (about to be paid for),
 * returns every nationals event among them that still has an unanswered
 * required session-request survey. Used to disable "Pay" before the request
 * is even sent — the server re-derives and enforces the same thing, this is
 * advisory only.
 *
 * Mirrors create-checkout-session's server algorithm exactly: partition
 * incoming regs PER-REGISTRATION by the athlete's `mainClubId` (independent
 * ⇒ person-scoped survey keyed by that athlete; else ⇒ club-scoped, keyed by
 * the reg's OWN `clubId`), derive required keys via `requiredSessionRequests`,
 * and check `missingSessionRequests` against `existing`. A self cart's regs
 * are always the payer's own and a club cart's regs always belong to that
 * club (both enforced server-side by the H4 ownership checks) — so this
 * naturally never cross-gates one scope on another scope's missing survey;
 * no extra filtering by cart owner is needed here. An athlete id absent from
 * `people` defaults to club-scoped (same as the server's `main_club_id`
 * lookup, where a missing row is NOT null ⇒ not independent).
 */
export function missingNationalsSurveyEvents(
  events: SessionRequestGateEvent[],
  incomingRegs: SessionRequestGateReg[],
  people: SessionRequestGatePerson[],
  existing: ExistingSessionRequestRow[],
): { eventId: string; eventName: string }[] {
  const eventsById = new Map(events.map((e) => [e.id, e]));
  const peopleById = new Map(people.map((p) => [p.id, p]));
  const regsByEvent = new Map<string, SessionRequestGateReg[]>();
  for (const r of incomingRegs) {
    if (r.refunded) continue;
    const list = regsByEvent.get(r.eventId) ?? [];
    list.push(r);
    regsByEvent.set(r.eventId, list);
  }

  const flagged: { eventId: string; eventName: string }[] = [];
  for (const [eventId, regs] of regsByEvent) {
    const event = eventsById.get(eventId);
    if (!event || event.kind !== 'nationals') continue;

    const byAthlete = new Map<string, SessionRequestGateReg[]>();
    const byClub = new Map<string, SessionRequestGateReg[]>();
    for (const r of regs) {
      const person = peopleById.get(r.athleteId);
      if (person && person.mainClubId === null) {
        const list = byAthlete.get(r.athleteId) ?? [];
        list.push(r);
        byAthlete.set(r.athleteId, list);
      } else {
        const list = byClub.get(r.clubId) ?? [];
        list.push(r);
        byClub.set(r.clubId, list);
      }
    }

    let hasMissing = false;
    for (const [athleteId, athleteRegs] of byAthlete) {
      const required = requiredSessionRequests(event, athleteRegs, 'person');
      const existingForAthlete = existing.filter((e) => e.eventId === eventId && e.personId === athleteId);
      if (missingSessionRequests(required, existingForAthlete).length > 0) hasMissing = true;
    }
    for (const [clubId, clubRegs] of byClub) {
      const required = requiredSessionRequests(event, clubRegs, 'club');
      const existingForClub = existing.filter((e) => e.eventId === eventId && e.clubId === clubId);
      if (missingSessionRequests(required, existingForClub).length > 0) hasMissing = true;
    }

    if (hasMissing) flagged.push({ eventId, eventName: event.name });
  }
  return flagged;
}

/** Arrival-window options for the A2 session-request survey UI (club +
 *  independent variants share this so the buckets stay identical). These
 *  mirror the assignment-tool mapping in spec §L.2 (Tue/Wed, Thu-before-noon,
 *  Thu-before-8, Fri) — the assignment tool itself is out of scope here. */
export const SESSION_REQUEST_ARRIVAL_OPTIONS = [
  { value: 'tue-wed', label: 'Arriving Tuesday or Wednesday' },
  { value: 'thu-before-noon', label: 'Arriving Thursday before noon' },
  { value: 'thu-before-8pm', label: 'Arriving Thursday before 8pm' },
  { value: 'fri', label: 'Arriving Friday' },
] as const;
