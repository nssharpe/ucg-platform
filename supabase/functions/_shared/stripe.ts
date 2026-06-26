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
 *  Mirrors `processingFee` in pricing.ts. */
export function processingFee(subtotalCents: number): number {
  return Math.round(subtotalCents * 0.03) + 30;
}

/** Minimal season slice the membership pricing needs (snake_case DB columns). */
export interface SeasonFees {
  id: string;
  name: string;
  athlete_fee: number;
  coach_fee: number;
  club_fee: number;
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

// --- Event registration fees (mirror of src/lib/pricing.ts § Registration fees) ---
// The host club's own athletes pay $0 for ALL registration-side fees (entry,
// second-discipline, change). All helpers return DOLLARS (use toCents to Stripe).

/** Minimal event slice the registration/addon pricing needs (snake_case DB cols).
 *  `change_fee` / `tshirt_addon` / `banner_addon` are nullable jsonb. */
export interface RegFeeEvent {
  id: string;
  host_club_id: string | null;
  entry_fee: number;
  second_discipline_fee: number;
  change_fee: { amount: number; startsAt?: string } | null;
  tshirt_addon: { price: number } | null;
  banner_addon: { price: number } | null;
}

/**
 * Total entry fee (DOLLARS) for a new registration purchase. Host club ⇒ 0.
 * First discipline = entry_fee; each additional = second_discipline_fee, where
 * "additional" means `priorDisciplineCount + i > 0`. Mirrors
 * `newRegistrationEntryTotal` in pricing.ts exactly.
 */
export function newRegistrationEntryTotalDollars(
  event: RegFeeEvent,
  { competingClubId, priorDisciplineCount, newDisciplineCount }: {
    competingClubId: string;
    priorDisciplineCount: number;
    newDisciplineCount: number;
  },
): number {
  if (competingClubId === event.host_club_id) return 0;
  let total = 0;
  for (let i = 0; i < newDisciplineCount; i++) {
    const isSecond = priorDisciplineCount + i > 0;
    total += isSecond ? event.second_discipline_fee : event.entry_fee;
  }
  return total;
}

/** Change fee (DOLLARS) for a registration edit. Host club ⇒ 0; else the event's
 *  configured change-fee amount (0 if none). Mirrors `registrationChangeFee`. */
export function registrationChangeFeeDollars(
  event: RegFeeEvent,
  { competingClubId }: { competingClubId: string },
): number {
  if (competingClubId === event.host_club_id) return 0;
  return event.change_fee?.amount ?? 0;
}

/** Addon price (DOLLARS) for an event, by line type. Unknown/missing ⇒ 0. */
export function addonPriceDollars(event: RegFeeEvent, lineType: string | null): number {
  if (lineType === 'tshirt') return event.tshirt_addon?.price ?? 0;
  if (lineType === 'banner') return event.banner_addon?.price ?? 0;
  return 0;
}

/** Dollars → integer cents (Stripe's unit). */
export function toCents(dollars: number): number {
  return Math.round(dollars * 100);
}
