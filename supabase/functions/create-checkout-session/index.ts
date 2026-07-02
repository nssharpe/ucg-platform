// create-checkout-session — start a Stripe Embedded Checkout for a cart (Phase S4,
// generalized: memberships, event entries, change fees, addons; self OR club carts).
//
// Auth: any signed-in user. The caller may pay for EITHER their own person cart
// (every item person_id === caller, club_id null) OR a club cart they manage
// (every item club_id === X, person_id null, caller in club_managers for X).
//
// Trust boundary: the client sends only the cart-item ids to pay. EVERY amount is
// recomputed here server-side from admin config (season fees, event config) + the
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
  type RegFeeEvent,
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
  ref_event_id: string | null;
  ref_line_type: string | null;
}

interface RegRow {
  id: string;
  event_id: string;
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
  let body: { cartItemIds?: unknown; couponCode?: unknown };
  try { body = await req.json(); } catch { return json({ ok: false, error: 'Invalid JSON body.' }, 400); }
  const cartItemIds = Array.isArray(body.cartItemIds)
    ? body.cartItemIds.filter((x): x is string => typeof x === 'string')
    : [];
  if (cartItemIds.length === 0) return json({ ok: false, error: 'No cart items to pay.' }, 400);
  const couponCodeInput = typeof body.couponCode === 'string' ? body.couponCode.trim().toUpperCase() : '';

  // --- Load the requested cart items (service role; we authorize ownership below) ---
  const { data: itemRows, error: itemErr } = await db
    .from('cart_items')
    .select('id, club_id, person_id, label, amount, kind, ref_user_id, ref_season_id, ref_type, ref_reg_ids, ref_event_id, ref_line_type')
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
  // Seasons (memberships), events (meet-entry + addon), registrations (entry/change
  // counts), existing memberships (per target person), club_memberships (club fee).
  const seasonIds = Array.from(new Set(
    items.filter((i) => i.kind === 'membership' && i.ref_season_id).map((i) => i.ref_season_id!),
  ));
  // ref_reg_ids → resolve regs to events; ref_event_id covers addons + change lines.
  const allRefRegIds = Array.from(new Set(items.flatMap((i) => i.ref_reg_ids ?? [])));

  let regsByLine: RegRow[] = [];
  if (allRefRegIds.length) {
    const { data: rr, error: rrErr } = await db
      .from('registrations')
      .select('id, event_id, athlete_id, club_id, refunded')
      .in('id', allRefRegIds);
    if (rrErr) return json({ ok: false, error: rrErr.message }, 500);
    regsByLine = (rr ?? []) as RegRow[];
  }
  const regById = new Map(regsByLine.map((r) => [r.id, r]));

  // Event ids = explicit ref_event_id ∪ the events of any referenced regs.
  const eventIds = Array.from(new Set([
    ...items.map((i) => i.ref_event_id).filter((m): m is string => !!m),
    ...regsByLine.map((r) => r.event_id),
  ]));
  let events = new Map<string, RegFeeEvent>();
  let allEventRegs: RegRow[] = []; // ALL non-refunded regs for the involved events (for prior counts)
  if (eventIds.length) {
    const { data: mr, error: mErr } = await db
      .from('events')
      .select('id, host_club_id, entry_fee, second_discipline_fee, change_fee, tshirt_addon, banner_addon')
      .in('id', eventIds);
    if (mErr) return json({ ok: false, error: mErr.message }, 500);
    events = new Map((mr ?? []).map((m) => [m.id as string, m as unknown as RegFeeEvent]));
    const { data: amr, error: amErr } = await db
      .from('registrations')
      .select('id, event_id, athlete_id, club_id, refunded')
      .in('event_id', eventIds)
      .eq('refunded', false);
    if (amErr) return json({ ok: false, error: amErr.message }, 500);
    allEventRegs = (amr ?? []) as RegRow[];
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
  // `scope`/`eventId` are the coupon-matching tags: which "Applies to" category
  // (per the promo-code feature) this line falls under, so a coupon can be
  // scoped to e.g. just athlete memberships or just one specific event.
  type CouponScope = 'athlete-membership' | 'club-membership' | 'coach-membership' | 'meet-entry';
  type Line = { label: string; cents: number; scope?: CouponScope; eventId?: string };
  const lines: Line[] = [];
  let subtotalCents = 0;
  const pushLine = (label: string, dollars: number, scope?: CouponScope, eventId?: string) => {
    const cents = toCents(dollars);
    subtotalCents += cents;
    if (cents > 0) lines.push({ label, cents, scope, eventId });
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
      if (cents > 0) lines.push({ label: item.label, cents, scope: t === 'athlete' ? 'athlete-membership' : 'coach-membership' });
    }
  }

  for (const i of items) {
    if (consumed.has(i.id)) continue;

    // --- Club membership ---
    if (i.kind === 'membership' && i.ref_type === 'club' && i.ref_season_id) {
      const season = seasons.get(i.ref_season_id);
      if (!season) return json({ ok: false, error: `Unknown season ${i.ref_season_id}.` }, 400);
      const alreadyActive = clubId && clubMembershipSeasons.has(`${clubId}:${i.ref_season_id}`);
      pushLine(i.label, alreadyActive ? 0 : season.club_fee, 'club-membership');
      continue;
    }

    // --- Event-entry change fee ---
    if (i.kind === 'meet-entry' && i.ref_line_type === 'change') {
      const refRegs = (i.ref_reg_ids ?? []).map((id) => regById.get(id)).filter((r): r is RegRow => !!r);
      const reg = refRegs[0];
      if (!reg) return json({ ok: false, error: `Change line ${i.id} references no known registration.` }, 400);
      const event = events.get(reg.event_id);
      if (!event) return json({ ok: false, error: `Unknown event ${reg.event_id}.` }, 400);
      pushLine(i.label, registrationChangeFeeDollars(event, { competingClubId: reg.club_id ?? '' }), 'meet-entry', reg.event_id);
      continue;
    }

    // --- Event-entry (new entry; 'entry' or legacy null line type) ---
    if (i.kind === 'meet-entry') {
      const refRegs = (i.ref_reg_ids ?? []).map((id) => regById.get(id)).filter((r): r is RegRow => !!r);
      const reg = refRegs[0];
      if (!reg) return json({ ok: false, error: `Entry line ${i.id} references no known registration.` }, 400);
      const event = events.get(reg.event_id);
      if (!event) return json({ ok: false, error: `Unknown event ${reg.event_id}.` }, 400);
      const competingClubId = reg.club_id ?? '';
      const lineRegIds = new Set(i.ref_reg_ids ?? []);
      const newDisciplineCount = refRegs.length;
      // Prior = other non-refunded regs for (event, athlete, competing club) not in this line.
      const priorDisciplineCount = allEventRegs.filter((r) =>
        r.event_id === reg.event_id &&
        r.athlete_id === reg.athlete_id &&
        (r.club_id ?? '') === competingClubId &&
        !lineRegIds.has(r.id),
      ).length;
      pushLine(i.label, newRegistrationEntryTotalDollars(event, {
        competingClubId, priorDisciplineCount, newDisciplineCount,
      }), 'meet-entry', reg.event_id);
      continue;
    }

    // --- Addon (tshirt / banner) ---
    if (i.kind === 'addon') {
      if (!i.ref_event_id) return json({ ok: false, error: `Addon line ${i.id} has no event.` }, 400);
      const event = events.get(i.ref_event_id);
      if (!event) return json({ ok: false, error: `Unknown event ${i.ref_event_id}.` }, 400);
      pushLine(i.label, addonPriceDollars(event, i.ref_line_type), 'meet-entry', i.ref_event_id);
      continue;
    }

    return json({ ok: false, error: `Unsupported cart line kind "${i.kind}".` }, 400);
  }

  if (subtotalCents <= 0) {
    return json({ ok: false, error: 'Nothing to pay — these items are already covered.' }, 400);
  }

  // --- Optional coupon: validated + applied entirely server-side. The client
  //     only ever sends a CODE — never a discount amount. Reduces the actual
  //     eligible line(s), per the code's "Applies to" scope, not the whole cart
  //     indiscriminately (a code scoped to "Athlete Membership" or one specific
  //     event must not discount an unrelated line). ---
  let discountCents = 0;
  let appliedCouponCode: string | null = null;
  if (couponCodeInput) {
    const { data: couponRow } = await db.from('coupons').select('*').eq('code', couponCodeInput).maybeSingle();
    if (couponRow) {
      const nowMs = Date.now();
      const startsAt = couponRow.starts_at as string | null;
      const endsAt = couponRow.ends_at as string | null;
      const maxUses = couponRow.max_uses as number | null;
      const usedCount = (couponRow.used_count as number | null) ?? 0;
      const restrictedTo = couponRow.restricted_to_person_id as string | null;
      const appliesTo = couponRow.applies_to as string;
      const appliesToEventId = (couponRow.applies_to_event_id as string | null) ?? null;

      let valid = true;
      if (startsAt && Date.parse(startsAt) > nowMs) valid = false;
      if (endsAt && Date.parse(endsAt) < nowMs) valid = false;
      if (maxUses != null && usedCount >= maxUses) valid = false;
      if (restrictedTo && restrictedTo !== personId) valid = false;

      // Hard expiration: once the scoped event has ended, the code is dead
      // regardless of `ends_at` — a manual expiration set far in the future
      // cannot keep it alive past the event it was created for.
      if (valid && appliesTo === 'meet-entry' && appliesToEventId) {
        const { data: scopedEvent } = await db.from('events').select('end_date').eq('id', appliesToEventId).maybeSingle();
        const endDate = (scopedEvent as { end_date?: string } | null)?.end_date;
        if (endDate) {
          const cutoff = Date.parse(endDate) + 24 * 60 * 60 * 1000; // through end-of-day
          if (cutoff < nowMs) valid = false;
        }
      }

      if (valid) {
        const eligible = lines.filter((l) => {
          if (appliesTo === 'any') return true;
          if (appliesTo === 'membership') {
            return l.scope === 'athlete-membership' || l.scope === 'club-membership' || l.scope === 'coach-membership';
          }
          if (appliesTo === 'meet-entry') {
            return l.scope === 'meet-entry' && (!appliesToEventId || l.eventId === appliesToEventId);
          }
          return l.scope === appliesTo;
        });
        const eligibleCents = eligible.reduce((s, l) => s + l.cents, 0);
        if (eligibleCents > 0) {
          const pctOff = couponRow.pct_off == null ? null : Number(couponRow.pct_off);
          const amountOff = couponRow.amount_off == null ? null : Number(couponRow.amount_off);
          const raw = amountOff != null ? toCents(amountOff) : pctOff != null ? Math.round(eligibleCents * pctOff / 100) : 0;
          discountCents = Math.min(raw, eligibleCents);
          if (discountCents > 0) {
            // Reduce eligible lines greedily, in order, until the discount is
            // exhausted; every line stays >= 0 so Stripe's line items stay valid.
            let remaining = discountCents;
            for (const l of eligible) {
              if (remaining <= 0) break;
              const take = Math.min(l.cents, remaining);
              l.cents -= take;
              remaining -= take;
            }
            appliedCouponCode = couponCodeInput;
          }
        }
      }
    }
  }
  const preDiscountSubtotalCents = subtotalCents;
  subtotalCents -= discountCents;
  if (subtotalCents <= 0) {
    return json({ ok: false, error: 'This coupon fully covers the cost — nothing left to charge a card for.' }, 400);
  }

  const feeCents = processingFee(subtotalCents);
  const stripeLineItems = lines
    .filter((l) => l.cents > 0)
    .map((l) => ({
      price_data: { currency: 'usd', unit_amount: l.cents, product_data: { name: l.label } },
      quantity: 1,
    }));
  stripeLineItems.push({
    price_data: { currency: 'usd', unit_amount: feeCents, product_data: { name: 'Service fee (card processing)' } },
    quantity: 1,
  });

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
      line_items: stripeLineItems,
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
      coupon_code: appliedCouponCode,
    })
    .select('id')
    .single();
  if (payErr) return json({ ok: false, error: payErr.message }, 500);

  return json({
    ok: true,
    clientSecret: session.client_secret,
    sessionId: session.id,
    paymentId: payment.id,
    // Pre-discount subtotal, so the client can show "Subtotal / Coupon -$X /
    // Service fee / Total" without double-counting the discount (the payments
    // row itself still records the true post-discount amount_subtotal).
    amountSubtotal: preDiscountSubtotalCents,
    discountAmount: discountCents,
    serviceFee: feeCents,
  });
});
