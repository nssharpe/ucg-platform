// create-checkout-session — start a Stripe Embedded Checkout for a member's
// MEMBERSHIP cart items (Phase S2, membership scope).
//
// Auth: any signed-in user. The caller may only pay for THEIR OWN cart items.
//
// Trust boundary: the client sends only the cart-item ids to pay. Every amount
// is recomputed here from the season fees + the person's existing memberships
// (`_shared/stripe.ts`, mirroring pricing.ts) — the cart row's `amount` is
// display-only and never trusted. We then add the service-fee line, create an
// Embedded Checkout Session (`ui_mode: 'embedded'`, no redirect — the FE keeps
// the user on-page via onComplete), and insert a `pending` `payments` row that
// links the session → person → exact cart items so the verified webhook can
// fulfill it. Returns the session `client_secret` for the embedded form.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  getStripe,
  membershipFeeDollars,
  processingFee,
  priceForTypesDollars,
  toCents,
  type MembershipRow,
  type MembershipType,
  type SeasonFees,
} from '../_shared/stripe.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

interface CartItemRow {
  id: string;
  person_id: string | null;
  label: string;
  amount: number;
  kind: string;
  ref_user_id: string | null;
  ref_season_id: string | null;
  ref_type: string | null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const db = createClient(url, serviceKey, { auth: { persistSession: false } });

  // --- Authenticate (any signed-in user) ---
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return json({ ok: false, error: 'Missing Authorization header.' }, 401);
  const { data: userData, error: userErr } = await db.auth.getUser(token);
  if (userErr || !userData.user) return json({ ok: false, error: 'Invalid or expired session.' }, 401);

  // --- Resolve the caller's linked person ---
  const { data: person } = await db
    .from('people')
    .select('id')
    .eq('auth_user_id', userData.user.id)
    .maybeSingle();
  if (!person) return json({ ok: false, error: 'No linked person for caller.' }, 403);
  const personId = person.id as string;

  // --- Validate payload ---
  let body: { cartItemIds?: unknown };
  try { body = await req.json(); } catch { return json({ ok: false, error: 'Invalid JSON body.' }, 400); }
  const cartItemIds = Array.isArray(body.cartItemIds)
    ? body.cartItemIds.filter((x): x is string => typeof x === 'string')
    : [];
  if (cartItemIds.length === 0) return json({ ok: false, error: 'No cart items to pay.' }, 400);

  // --- Load the caller's OWN cart items (RLS bypass via service role, so we
  //     filter on person_id ourselves — a caller can only pay their own rows) ---
  const { data: itemRows, error: itemErr } = await db
    .from('cart_items')
    .select('id, person_id, label, amount, kind, ref_user_id, ref_season_id, ref_type')
    .in('id', cartItemIds)
    .eq('person_id', personId);
  if (itemErr) return json({ ok: false, error: itemErr.message }, 500);
  const items = (itemRows ?? []) as CartItemRow[];
  if (items.length === 0) return json({ ok: false, error: 'None of those cart items are yours.' }, 403);

  // --- Membership scope (S2): only membership lines are supported for now ---
  const membershipItems = items.filter((i) => i.kind === 'membership' && i.ref_season_id && i.ref_type);
  if (membershipItems.length !== items.length) {
    return json({ ok: false, error: 'This checkout currently supports membership items only.' }, 400);
  }

  // --- Recompute amounts server-side, grouped by season ---
  const seasonIds = Array.from(new Set(membershipItems.map((i) => i.ref_season_id!)));
  const { data: seasonRows, error: seasonErr } = await db
    .from('seasons')
    .select('id, name, athlete_fee, coach_fee')
    .in('id', seasonIds);
  if (seasonErr) return json({ ok: false, error: seasonErr.message }, 500);
  const seasons = new Map((seasonRows ?? []).map((s) => [s.id as string, s as SeasonFees]));

  const { data: membershipRows, error: memErr } = await db
    .from('memberships')
    .select('season_id, type, status')
    .eq('person_id', personId);
  if (memErr) return json({ ok: false, error: memErr.message }, 500);
  const existing = (membershipRows ?? []) as MembershipRow[];

  // Build Stripe line items. Per season, the combined price (the higher single
  // fee for "both", not the sum) is carried by the dearest newly-added type; any
  // other new type then shows $0 (included) so the lines sum exactly. Zero lines
  // are dropped (Stripe rejects $0 line items in a paid session).
  type Line = { label: string; cents: number };
  const lines: Line[] = [];
  let subtotalCents = 0;
  for (const seasonId of seasonIds) {
    const season = seasons.get(seasonId);
    if (!season) return json({ ok: false, error: `Unknown season ${seasonId}.` }, 400);
    const types = Array.from(
      new Set(membershipItems.filter((i) => i.ref_season_id === seasonId).map((i) => i.ref_type as MembershipType)),
    ).filter((t) => t === 'athlete' || t === 'coach');
    const combinedCents = toCents(priceForTypesDollars(season, types, existing));
    subtotalCents += combinedCents;
    // Dearest type (by season fee) carries the combined charge; others are $0
    // (included) — mirrors pricing.ts so the lines sum exactly to the combined.
    const dearest = types.slice()
      .sort((a, b) => membershipFeeDollars(season, b) - membershipFeeDollars(season, a))[0];
    for (const t of types) {
      const item = membershipItems.find((i) => i.ref_season_id === seasonId && i.ref_type === t)!;
      const cents = t === dearest ? combinedCents : 0;
      if (cents > 0) lines.push({ label: item.label, cents });
    }
  }
  if (subtotalCents <= 0) {
    return json({ ok: false, error: 'Nothing to pay — these memberships are already covered.' }, 400);
  }

  const feeCents = processingFee(subtotalCents);
  lines.push({ label: 'Service fee (card processing)', cents: feeCents });

  // --- Create the Embedded Checkout Session ---
  let stripe;
  try { stripe = getStripe(); } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }

  // Single-membership checkouts record the exact (season, type) so the webhook /
  // any club-pay matching can key on it; multi-item ones rely on cart_item_ids.
  const single = membershipItems.length === 1 ? membershipItems[0] : null;

  let session;
  try {
    session = await stripe.checkout.sessions.create({
      ui_mode: 'embedded',
      mode: 'payment',
      redirect_on_completion: 'never',
      line_items: lines.map((l) => ({
        price_data: {
          currency: 'usd',
          unit_amount: l.cents,
          product_data: { name: l.label },
        },
        quantity: 1,
      })),
      metadata: { person_id: personId, kind: 'membership' },
    });
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 502);
  }

  // --- Insert the pending payments row (server source of truth) ---
  const { data: payment, error: payErr } = await db
    .from('payments')
    .insert({
      stripe_session_id: session.id,
      person_id: personId,
      status: 'pending',
      amount_subtotal: subtotalCents,
      service_fee: feeCents,
      currency: 'usd',
      cart_item_ids: membershipItems.map((i) => i.id),
      ref_season_id: single?.ref_season_id ?? null,
      ref_type: single?.ref_type ?? null,
    })
    .select('id')
    .single();
  if (payErr) return json({ ok: false, error: payErr.message }, 500);

  return json({
    ok: true,
    clientSecret: session.client_secret,
    sessionId: session.id,
    paymentId: payment.id,
    amountSubtotal: subtotalCents,
    serviceFee: feeCents,
  });
});
