// create-checkout-session — start a Stripe Embedded Checkout for a cart (Phase S4,
// generalized: memberships, meet entries, change fees, addons; self OR club carts).
//
// Auth: any signed-in user. The caller may pay for EITHER their own person cart
// (every item person_id === caller, club_id null) OR a club cart they manage
// (every item club_id === X, person_id null, caller in club_managers for X).
//
// Trust boundary: the client sends only the cart-item ids to pay. EVERY amount is
// recomputed here server-side from admin config (season fees, meet config) + the
// referenced state (`_shared/stripe.ts`, mirroring pricing.ts) — the cart row's
// `amount` is display-only and never trusted. We add the service-fee line, create
// an Embedded Checkout Session (`ui_mode: 'embedded'`, no redirect — the FE keeps
// the user on-page via onComplete), and insert a `pending` `payments` row that
// links the session → payer → exact cart items so the verified webhook can
// fulfill it. Returns the session `client_secret` for the embedded form.
//
// $0 lines (host-club regs, already-covered memberships) are DROPPED from Stripe
// but their ids stay in cart_item_ids so the webhook still clears/flips them.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  addonPriceDollars,
  getStripe,
  membershipFeeDollars,
  newRegistrationEntryTotalDollars,
  priceForTypesDollars,
  processingFee,
  registrationChangeFeeDollars,
  toCents,
  type MembershipRow,
  type MembershipType,
  type RegFeeMeet,
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
  club_id: string | null;
  person_id: string | null;
  label: string;
  amount: number;
  kind: string;
  ref_user_id: string | null;
  ref_season_id: string | null;
  ref_type: string | null;
  ref_reg_ids: string[] | null;
  ref_meet_id: string | null;
  ref_line_type: string | null;
}

interface RegRow {
  id: string;
  meet_id: string;
  athlete_id: string;
  club_id: string | null;
  refunded: boolean;
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

  // --- Resolve the caller's linked person (the PAYER) ---
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

  // --- Load the requested cart items (service role; we authorize ownership below) ---
  const { data: itemRows, error: itemErr } = await db
    .from('cart_items')
    .select('id, club_id, person_id, label, amount, kind, ref_user_id, ref_season_id, ref_type, ref_reg_ids, ref_meet_id, ref_line_type')
    .in('id', cartItemIds);
  if (itemErr) return json({ ok: false, error: itemErr.message }, 500);
  const items = (itemRows ?? []) as CartItemRow[];
  if (items.length === 0) return json({ ok: false, error: 'No such cart items.' }, 404);

  // --- Authorize: a self cart OR a single club cart the caller manages ---
  let clubId: string | null = null;
  const isSelfCart = items.every((i) => i.person_id === personId && i.club_id == null);
  if (!isSelfCart) {
    const clubIds = Array.from(new Set(items.map((i) => i.club_id).filter((c): c is string => !!c)));
    const allClubOwned = items.every((i) => i.club_id != null && i.person_id == null);
    if (!allClubOwned || clubIds.length !== 1) {
      return json({ ok: false, error: 'Cart items must all belong to you, or all to one club.' }, 403);
    }
    clubId = clubIds[0];
    const { data: mgr } = await db
      .from('club_managers')
      .select('club_id')
      .eq('club_id', clubId)
      .eq('person_id', personId)
      .maybeSingle();
    if (!mgr) return json({ ok: false, error: 'You do not manage that club.' }, 403);
  }

  // --- Batch-load everything the recompute needs ----------------------------
  // Seasons (memberships), meets (meet-entry + addon), registrations (entry/change
  // counts), existing memberships (per target person), club_memberships (club fee).
  const seasonIds = Array.from(new Set(
    items.filter((i) => i.kind === 'membership' && i.ref_season_id).map((i) => i.ref_season_id!),
  ));
  // ref_reg_ids → resolve regs to meets; ref_meet_id covers addons + change lines.
  const allRefRegIds = Array.from(new Set(items.flatMap((i) => i.ref_reg_ids ?? [])));

  let regsByLine: RegRow[] = [];
  if (allRefRegIds.length) {
    const { data: rr, error: rrErr } = await db
      .from('registrations')
      .select('id, meet_id, athlete_id, club_id, refunded')
      .in('id', allRefRegIds);
    if (rrErr) return json({ ok: false, error: rrErr.message }, 500);
    regsByLine = (rr ?? []) as RegRow[];
  }
  const regById = new Map(regsByLine.map((r) => [r.id, r]));

  // Meet ids = explicit ref_meet_id ∪ the meets of any referenced regs.
  const meetIds = Array.from(new Set([
    ...items.map((i) => i.ref_meet_id).filter((m): m is string => !!m),
    ...regsByLine.map((r) => r.meet_id),
  ]));
  let meets = new Map<string, RegFeeMeet>();
  let allMeetRegs: RegRow[] = []; // ALL non-refunded regs for the involved meets (for prior counts)
  if (meetIds.length) {
    const { data: mr, error: mErr } = await db
      .from('meets')
      .select('id, host_club_id, entry_fee, second_discipline_fee, change_fee, tshirt_addon, banner_addon')
      .in('id', meetIds);
    if (mErr) return json({ ok: false, error: mErr.message }, 500);
    meets = new Map((mr ?? []).map((m) => [m.id as string, m as unknown as RegFeeMeet]));
    const { data: amr, error: amErr } = await db
      .from('registrations')
      .select('id, meet_id, athlete_id, club_id, refunded')
      .in('meet_id', meetIds)
      .eq('refunded', false);
    if (amErr) return json({ ok: false, error: amErr.message }, 500);
    allMeetRegs = (amr ?? []) as RegRow[];
  }

  let seasons = new Map<string, SeasonFees>();
  if (seasonIds.length) {
    const { data: sr, error: sErr } = await db
      .from('seasons')
      .select('id, name, athlete_fee, coach_fee, club_fee')
      .in('id', seasonIds);
    if (sErr) return json({ ok: false, error: sErr.message }, 500);
    seasons = new Map((sr ?? []).map((s) => [s.id as string, s as SeasonFees]));
  }

  // Existing memberships for ALL target persons (ref_user_id ?? payer).
  const targetPersonIds = Array.from(new Set(
    items
      .filter((i) => i.kind === 'membership' && (i.ref_type === 'athlete' || i.ref_type === 'coach'))
      .map((i) => i.ref_user_id ?? personId),
  ));
  const existingByPerson = new Map<string, MembershipRow[]>();
  if (targetPersonIds.length) {
    const { data: emr, error: emErr } = await db
      .from('memberships')
      .select('person_id, season_id, type, status')
      .in('person_id', targetPersonIds);
    if (emErr) return json({ ok: false, error: emErr.message }, 500);
    for (const m of (emr ?? []) as (MembershipRow & { person_id: string })[]) {
      const list = existingByPerson.get(m.person_id) ?? [];
      list.push(m);
      existingByPerson.set(m.person_id, list);
    }
  }

  // Active club_memberships for the involved (club, season) pairs (club-fee $0 check).
  const clubMembershipSeasons = new Set<string>(); // `${clubId}:${seasonId}` that are already active
  const clubMemSeasonIds = Array.from(new Set(
    items.filter((i) => i.kind === 'membership' && i.ref_type === 'club' && i.ref_season_id)
      .map((i) => i.ref_season_id!),
  ));
  if (clubId && clubMemSeasonIds.length) {
    const { data: cmr, error: cmErr } = await db
      .from('club_memberships')
      .select('club_id, season_id, status')
      .eq('club_id', clubId)
      .in('season_id', clubMemSeasonIds)
      .eq('status', 'active');
    if (cmErr) return json({ ok: false, error: cmErr.message }, 500);
    for (const c of cmr ?? []) clubMembershipSeasons.add(`${c.club_id}:${c.season_id}`);
  }

  // --- Recompute each line into Stripe line items + subtotal ----------------
  type Line = { label: string; cents: number };
  const lines: Line[] = [];
  let subtotalCents = 0;
  const pushLine = (label: string, dollars: number) => {
    const cents = toCents(dollars);
    subtotalCents += cents;
    if (cents > 0) lines.push({ label, cents });
  };

  // Membership athlete/coach lines are priced per (targetPerson, season) GROUP so
  // the "both costs the higher single fee" rule holds across the group; club &
  // non-membership lines price independently. Track which item ids we've consumed.
  const consumed = new Set<string>();

  // Group athlete/coach membership items by `${targetPerson}:${seasonId}`.
  const memGroups = new Map<string, { targetPerson: string; seasonId: string; items: CartItemRow[] }>();
  for (const i of items) {
    if (i.kind !== 'membership' || !(i.ref_type === 'athlete' || i.ref_type === 'coach') || !i.ref_season_id) continue;
    const targetPerson = i.ref_user_id ?? personId;
    const key = `${targetPerson}:${i.ref_season_id}`;
    const g = memGroups.get(key) ?? { targetPerson, seasonId: i.ref_season_id, items: [] };
    g.items.push(i);
    memGroups.set(key, g);
  }
  for (const g of memGroups.values()) {
    const season = seasons.get(g.seasonId);
    if (!season) return json({ ok: false, error: `Unknown season ${g.seasonId}.` }, 400);
    const types = Array.from(new Set(g.items.map((i) => i.ref_type as MembershipType)))
      .filter((t) => t === 'athlete' || t === 'coach');
    const existing = existingByPerson.get(g.targetPerson) ?? [];
    const combinedDollars = priceForTypesDollars(season, types, existing);
    const combinedCents = toCents(combinedDollars);
    subtotalCents += combinedCents;
    // Dearest type carries the combined charge; other types are $0 (included).
    const dearest = types.slice()
      .sort((a, b) => membershipFeeDollars(season, b) - membershipFeeDollars(season, a))[0];
    for (const t of types) {
      const item = g.items.find((i) => i.ref_type === t)!;
      consumed.add(item.id);
      const cents = t === dearest ? combinedCents : 0;
      if (cents > 0) lines.push({ label: item.label, cents });
    }
  }

  for (const i of items) {
    if (consumed.has(i.id)) continue;

    // --- Club membership ---
    if (i.kind === 'membership' && i.ref_type === 'club' && i.ref_season_id) {
      const season = seasons.get(i.ref_season_id);
      if (!season) return json({ ok: false, error: `Unknown season ${i.ref_season_id}.` }, 400);
      const alreadyActive = clubId && clubMembershipSeasons.has(`${clubId}:${i.ref_season_id}`);
      pushLine(i.label, alreadyActive ? 0 : season.club_fee);
      continue;
    }

    // --- Meet-entry change fee ---
    if (i.kind === 'meet-entry' && i.ref_line_type === 'change') {
      const refRegs = (i.ref_reg_ids ?? []).map((id) => regById.get(id)).filter((r): r is RegRow => !!r);
      const reg = refRegs[0];
      if (!reg) return json({ ok: false, error: `Change line ${i.id} references no known registration.` }, 400);
      const meet = meets.get(reg.meet_id);
      if (!meet) return json({ ok: false, error: `Unknown meet ${reg.meet_id}.` }, 400);
      pushLine(i.label, registrationChangeFeeDollars(meet, { competingClubId: reg.club_id ?? '' }));
      continue;
    }

    // --- Meet-entry (new entry; 'entry' or legacy null line type) ---
    if (i.kind === 'meet-entry') {
      const refRegs = (i.ref_reg_ids ?? []).map((id) => regById.get(id)).filter((r): r is RegRow => !!r);
      const reg = refRegs[0];
      if (!reg) return json({ ok: false, error: `Entry line ${i.id} references no known registration.` }, 400);
      const meet = meets.get(reg.meet_id);
      if (!meet) return json({ ok: false, error: `Unknown meet ${reg.meet_id}.` }, 400);
      const competingClubId = reg.club_id ?? '';
      const lineRegIds = new Set(i.ref_reg_ids ?? []);
      const newDisciplineCount = refRegs.length;
      // Prior = other non-refunded regs for (meet, athlete, competing club) not in this line.
      const priorDisciplineCount = allMeetRegs.filter((r) =>
        r.meet_id === reg.meet_id &&
        r.athlete_id === reg.athlete_id &&
        (r.club_id ?? '') === competingClubId &&
        !lineRegIds.has(r.id),
      ).length;
      pushLine(i.label, newRegistrationEntryTotalDollars(meet, {
        competingClubId, priorDisciplineCount, newDisciplineCount,
      }));
      continue;
    }

    // --- Addon (tshirt / banner) ---
    if (i.kind === 'addon') {
      if (!i.ref_meet_id) return json({ ok: false, error: `Addon line ${i.id} has no meet.` }, 400);
      const meet = meets.get(i.ref_meet_id);
      if (!meet) return json({ ok: false, error: `Unknown meet ${i.ref_meet_id}.` }, 400);
      pushLine(i.label, addonPriceDollars(meet, i.ref_line_type));
      continue;
    }

    return json({ ok: false, error: `Unsupported cart line kind "${i.kind}".` }, 400);
  }

  if (subtotalCents <= 0) {
    return json({ ok: false, error: 'Nothing to pay — these items are already covered.' }, 400);
  }

  const feeCents = processingFee(subtotalCents);
  lines.push({ label: 'Service fee (card processing)', cents: feeCents });

  // --- Create the Embedded Checkout Session ---
  let stripe;
  try { stripe = getStripe(); } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }

  // Single-membership checkouts record the exact (season, type) so any club-pay
  // matching can key on it (vestigial); multi-item ones rely on cart_item_ids.
  const single = items.length === 1 && items[0].kind === 'membership' ? items[0] : null;

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
      metadata: { person_id: personId, club_id: clubId ?? '', kind: 'cart' },
    });
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 502);
  }

  // --- Insert the pending payments row (server source of truth). person_id is the
  //     PAYER (caller) for self-read polling + receipt; the webhook reads the
  //     loaded cart items' club_id to know club-vs-person fulfillment. ---
  const { data: payment, error: payErr } = await db
    .from('payments')
    .insert({
      stripe_session_id: session.id,
      person_id: personId,
      status: 'pending',
      amount_subtotal: subtotalCents,
      service_fee: feeCents,
      currency: 'usd',
      cart_item_ids: items.map((i) => i.id),
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
