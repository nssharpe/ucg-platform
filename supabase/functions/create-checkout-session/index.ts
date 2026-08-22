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
//
// FREE-ORDER PATH (emv2 P3, 2026-07-10): if a coupon reduces the order TOTAL
// to exactly $0 (e.g. a scholarship code), there's no Stripe session to
// create — the server fulfills the order directly via the shared
// `fulfillPayment` core (`_shared/fulfill.ts`, the same core `stripe-webhook`
// uses) and returns `{ free: true, paymentId }` instead of a client secret.
// No service fee is charged on a $0 order.
//
// PREVIEW MODE (money-story UX S4, 2026-07-25): `{ mode: 'preview' }` runs
// this exact same auth + H4 ownership + capacity/survey validation + pricing
// recompute, then returns the priced lines/subtotal/fee/total WITHOUT any
// side effect — no payments insert, no lines_snapshot write, no cart_items
// mutation, no Stripe call, no coupon redemption. The cart page (`Cart.tsx`)
// uses this to show the server's real price instead of the stale
// client-written `cart_items.amount`, so the cart and the checkout summary
// can never disagree. See "PREVIEW BRANCH POINT" below.
//
// COUPON RESERVATION (security hardening Phase 3, M1, 2026-07-26): validating
// a coupon's `used_count < max_uses` here isn't enough on its own — N
// concurrent checkouts for the same code would all pass that check and all
// collect the discount, since nothing was ever claimed until fulfillment.
// After the PREVIEW BRANCH POINT (never on the preview path), an applied
// coupon is atomically RESERVED via `reserve_coupon` for this request's
// `paymentId` BEFORE anything is created in Stripe or the DB; a losing
// reservation returns a clean 409 with nothing created. The reservation
// self-heals via a 60-minute `expires_at` (`coupon_reservations` table,
// migration 20260726130005) rather than requiring an explicit release on
// every failure path — `redeem_coupon` converts a winning reservation into
// the permanent `used_count` bump at fulfillment time.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  addedDisciplineChangeTotalDollars,
  addonLastPurchaseAt,
  addonPriceDollars,
  addonPurchaseOpen,
  getStripe,
  lateFeeAnchor,
  membershipFeeDollars,
  newRegistrationEntryTotalDollars,
  priceForTypesDollars,
  processingFee,
  registrationChangeFeeDollars,
  seasonPurchasableForCheckout,
  toCents,
  type MembershipRow,
  type MembershipType,
  type RegFeeEvent,
  type SeasonFees,
} from '../_shared/stripe.ts';
import { fulfillPayment, type PaymentRow } from '../_shared/fulfill.ts';
import {
  CART_HOLD_MINUTES,
  checkCapacity,
  hasCapacityConfig,
  type CapacityEventRow,
  type GroupRow,
  type SessionRow,
} from '../_shared/capacity.ts';
import { findPaidSibling } from '../_shared/registration-status.ts';

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
  addon_size: string | null;
  addon_assignee: string | null;
}

// Widened to also carry the columns the capacity engine (`_shared/capacity.ts`)
// needs — this row shape is reused as-is for both the H4 ownership checks
// above and the capacity checks below, so the reg queries need only run once.
interface RegRow {
  id: string;
  event_id: string;
  athlete_id: string;
  club_id: string | null;
  refunded: boolean;
  paid: boolean | null;
  updated_pending: boolean | null;
  created_at?: string;
  discipline: string;
  level_id: string | null;
  apparatus: string[] | null;
  apparatus_levels: Record<string, string> | null;
  session_id: string | null;
  waitlisted: boolean | null;
  waitlist_group_id: string | null;
  hold_expires_at: string | null;
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
  let body: { cartItemIds?: unknown; couponCode?: unknown; mode?: unknown };
  try { body = await req.json(); } catch { return json({ ok: false, error: 'Invalid JSON body.' }, 400); }
  const cartItemIds = Array.isArray(body.cartItemIds)
    ? body.cartItemIds.filter((x): x is string => typeof x === 'string')
    : [];
  if (cartItemIds.length === 0) return json({ ok: false, error: 'No cart items to pay.' }, 400);
  const couponCodeInput = typeof body.couponCode === 'string' ? body.couponCode.trim().toUpperCase() : '';
  // S4 (money-story UX): `mode: 'preview'` runs the exact same auth,
  // ownership (H4), and pricing logic below and returns BEFORE any write —
  // no payments insert, no cart_items mutation, no Stripe call, no coupon
  // redemption/reservation. See the single preview-return branch point
  // (search "PREVIEW BRANCH POINT" below) and the one individually-guarded
  // write that precedes it (the capacity hold-refresh).
  const isPreview = body.mode === 'preview';

  // --- Load the requested cart items (service role; we authorize ownership below) ---
  const { data: itemRows, error: itemErr } = await db
    .from('cart_items')
    .select('id, club_id, person_id, label, amount, kind, ref_user_id, ref_season_id, ref_type, ref_reg_ids, ref_event_id, ref_line_type, addon_size, addon_assignee')
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
      .select('id, event_id, athlete_id, club_id, refunded, paid, updated_pending, created_at, ' +
        'discipline, level_id, apparatus, apparatus_levels, session_id, waitlisted, waitlist_group_id, hold_expires_at')
      .in('id', allRefRegIds);
    if (rrErr) return json({ ok: false, error: rrErr.message }, 500);
    regsByLine = (rr ?? []) as RegRow[];
  }
  const regById = new Map(regsByLine.map((r) => [r.id, r]));

  // --- H4: authorize the REFERENCED registrations, not just the cart rows ----
  // The cart-row ownership check above (person_id/club_id) does NOT constrain
  // the regs a meet-entry line POINTS AT via ref_reg_ids. Without this, a
  // crafted line could make the webhook flip a victim's registration to paid
  // (cross-account), and it's the same trust gap C4 exploits for cheap entry.
  // Self cart ⇒ every referenced reg is the payer's own; club cart ⇒ every
  // referenced reg belongs to that club.
  for (const r of regsByLine) {
    const owned = isSelfCart ? r.athlete_id === personId : r.club_id === clubId;
    if (!owned) {
      return json({ ok: false, error: 'A cart line references a registration that is not yours to pay for.' }, 403);
    }
  }
  // Every referenced reg id must actually resolve (a line pointing at a
  // nonexistent/refunded reg is rejected here rather than silently priced/flipped).
  const missingRef = allRefRegIds.find((id) => !regById.has(id));
  if (missingRef) {
    return json({ ok: false, error:
      'A cart line references a registration that no longer exists — remove it from your cart (✕) and try again.' }, 400);
  }

  // Event ids = explicit ref_event_id ∪ the events of any referenced regs.
  const eventIds = Array.from(new Set([
    ...items.map((i) => i.ref_event_id).filter((m): m is string => !!m),
    ...regsByLine.map((r) => r.event_id),
  ]));
  let events = new Map<string, RegFeeEvent>();
  let eventNames = new Map<string, string>();
  let allEventRegs: RegRow[] = []; // ALL non-refunded regs for the involved events (for prior counts)
  if (eventIds.length) {
    const { data: mr, error: mErr } = await db
      .from('events')
      .select('id, name, host_club_id, entry_fee, second_discipline_fee, change_fee, tshirt_addon, banner_addon, banquet, camp_config, reg_closes, late_reg')
      .in('id', eventIds);
    if (mErr) return json({ ok: false, error: mErr.message }, 500);
    events = new Map((mr ?? []).map((m) => [m.id as string, m as unknown as RegFeeEvent]));
    // Display-only lookup for the UAT Z-02 duplicate-slot 409 message below —
    // `RegFeeEvent` (mirrored from `_shared/stripe.ts`, shared with the
    // webhook) deliberately doesn't carry `name`, so this stays a separate
    // side map rather than widening that shared type.
    eventNames = new Map((mr ?? []).map((m) => [m.id as string, ((m as { name?: string | null }).name ?? 'this event')]));
    const { data: amr, error: amErr } = await db
      .from('registrations')
      .select('id, event_id, athlete_id, club_id, refunded, created_at, ' +
        'discipline, level_id, apparatus, apparatus_levels, session_id, paid, updated_pending, ' +
        'waitlisted, waitlist_group_id, hold_expires_at')
      .in('event_id', eventIds)
      .eq('refunded', false);
    if (amErr) return json({ ok: false, error: amErr.message }, 500);
    allEventRegs = (amr ?? []) as RegRow[];
  }

  let seasons = new Map<string, SeasonFees>();
  if (seasonIds.length) {
    const { data: sr, error: sErr } = await db
      .from('seasons')
      .select('id, name, athlete_fee, coach_fee, club_fee, active, starts_on, ends_on')
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

  // --- H4: authorize the membership TARGET(s) (ref_user_id) ------------------
  // Self cart ⇒ you can only buy an athlete/coach membership for YOURSELF.
  // Club cart ⇒ only for a person affiliated with THIS club (main club or an
  // alternate-club affiliation) — a manager can't grant a membership to an
  // arbitrary person outside their club.
  if (targetPersonIds.length) {
    if (isSelfCart) {
      const bad = targetPersonIds.find((id) => id !== personId);
      if (bad) return json({ ok: false, error: 'You can only buy a membership for yourself in your own cart.' }, 403);
    } else if (clubId) {
      const affiliated = new Set<string>();
      const { data: pr } = await db.from('people').select('id, main_club_id').in('id', targetPersonIds);
      for (const p of pr ?? []) {
        if ((p as { main_club_id?: string }).main_club_id === clubId) affiliated.add(p.id as string);
      }
      const { data: alt } = await db.from('person_alt_clubs')
        .select('person_id').eq('club_id', clubId).in('person_id', targetPersonIds);
      for (const a of alt ?? []) affiliated.add((a as { person_id: string }).person_id);
      const bad = targetPersonIds.find((id) => !affiliated.has(id));
      if (bad) return json({ ok: false, error: 'A membership targets a person who is not on this club’s roster.' }, 403);
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

  // --- Banquet ticket assignment (emv2 P2 Task 2) -----------------------------
  // Each banquet line (`kind:'addon'`, `ref_line_type:'banquet'`) must name an
  // assignee: a person id, or the literal sentinel 'extra' for an unassigned
  // ticket. Person-assigned tickets are authorized the same way H4 authorizes a
  // membership target (self cart ⇒ only the payer; club cart ⇒ only someone on
  // that club's roster), and capped at ONE assigned ticket per person per event
  // — counting already-purchased (non-refunded) invoice_items plus every other
  // line in THIS checkout that assigns the same person for the same event.
  const banquetItems = items.filter((i) => i.kind === 'addon' && i.ref_line_type === 'banquet');
  if (banquetItems.length) {
    const missingAssignee = banquetItems.find((i) => !i.addon_assignee);
    if (missingAssignee) {
      return json({ ok: false, error:
        `Banquet ticket "${missingAssignee.label}" needs an assignee — select a person or "Extra ticket" before checking out.` }, 400);
    }

    const assigneeIds = Array.from(new Set(
      banquetItems.map((i) => i.addon_assignee).filter((a): a is string => !!a && a !== 'extra'),
    ));
    if (assigneeIds.length) {
      if (isSelfCart) {
        const bad = assigneeIds.find((id) => id !== personId);
        if (bad) return json({ ok: false, error: 'You can only assign a banquet ticket to yourself in your own cart.' }, 403);
      } else if (clubId) {
        const affiliated = new Set<string>();
        const { data: pr } = await db.from('people').select('id, main_club_id').in('id', assigneeIds);
        for (const p of pr ?? []) {
          if ((p as { main_club_id?: string }).main_club_id === clubId) affiliated.add(p.id as string);
        }
        const { data: alt } = await db.from('person_alt_clubs')
          .select('person_id').eq('club_id', clubId).in('person_id', assigneeIds);
        for (const a of alt ?? []) affiliated.add((a as { person_id: string }).person_id);
        const bad = assigneeIds.find((id) => !affiliated.has(id));
        if (bad) return json({ ok: false, error: 'A banquet ticket is assigned to a person who is not on this club’s roster.' }, 403);
      }

      // Count assigned tickets per (event, person): existing paid tickets + this checkout's.
      // Keyed by JSON-encoded [eventId, assignee] pair to avoid any string-concat
      // collision risk between an id and the separator.
      const eventIdsForBanquet = Array.from(new Set(banquetItems.map((i) => i.ref_event_id).filter((e): e is string => !!e)));
      const totalCounts = new Map<string, { eventId: string; assignee: string; count: number }>();
      const bump = (eventId: string, assignee: string) => {
        const k = JSON.stringify([eventId, assignee]);
        const entry = totalCounts.get(k) ?? { eventId, assignee, count: 0 };
        entry.count += 1;
        totalCounts.set(k, entry);
      };
      if (eventIdsForBanquet.length) {
        const { data: existingLines, error: exErr } = await db
          .from('invoice_items')
          .select('ref_event_id, addon_assignee, refunded')
          .eq('kind', 'addon')
          .eq('ref_line_type', 'banquet')
          .in('ref_event_id', eventIdsForBanquet)
          .in('addon_assignee', assigneeIds)
          .eq('refunded', false);
        if (exErr) return json({ ok: false, error: exErr.message }, 500);
        for (const row of existingLines ?? []) {
          const eId = row.ref_event_id as string | null;
          const assignee = row.addon_assignee as string | null;
          if (!eId || !assignee) continue;
          bump(eId, assignee);
        }
      }
      for (const i of banquetItems) {
        if (!i.addon_assignee || i.addon_assignee === 'extra' || !i.ref_event_id) continue;
        bump(i.ref_event_id, i.addon_assignee);
      }
      for (const { assignee, count } of totalCounts.values()) {
        if (count > 1) {
          return json({ ok: false, error:
            `More than one banquet ticket is assigned to the same person (${assignee}) for this event — each person may have at most one assigned ticket.` }, 400);
        }
      }
    }
  }

  // --- Capacity & sessions enforcement (event-mgmt v2 P4 T3) -----------------
  // Gates BOTH the Stripe path and the $0 free-order path below — must run
  // before either. Scoped to the events actually referenced via ref_reg_ids
  // (entry/change lines) — `regsByLine` and `allEventRegs`, both already
  // loaded above for the H4 ownership checks, are reused as-is (no re-query).
  {
    const capacityEventIds = Array.from(new Set(regsByLine.map((r) => r.event_id)));
    if (capacityEventIds.length) {
      const { data: capEventRows, error: capEvErr } = await db
        .from('events')
        .select('id, name, capacity, registration_mode')
        .in('id', capacityEventIds);
      if (capEvErr) return json({ ok: false, error: capEvErr.message }, 500);
      const capEventsById = new Map(
        (capEventRows ?? []).map((e) => [e.id as string, e as unknown as CapacityEventRow & { name: string; registration_mode: string }]),
      );

      const { data: sessionRows, error: sessErr } = await db
        .from('event_sessions')
        .select('id, event_id, max_routines')
        .in('event_id', capacityEventIds);
      if (sessErr) return json({ ok: false, error: sessErr.message }, 500);
      const sessionsByEvent = new Map<string, SessionRow[]>();
      for (const s of (sessionRows ?? []) as (SessionRow & { event_id: string })[]) {
        const list = sessionsByEvent.get(s.event_id) ?? [];
        list.push(s);
        sessionsByEvent.set(s.event_id, list);
      }

      const { data: groupRows, error: groupErr } = await db
        .from('waitlist_groups')
        .select('id, event_id, status, hold_expires_at')
        .in('event_id', capacityEventIds)
        .eq('status', 'notified');
      if (groupErr) return json({ ok: false, error: groupErr.message }, 500);
      const groupsById: Record<string, GroupRow> = {};
      for (const g of (groupRows ?? []) as (GroupRow & { event_id: string })[]) groupsById[g.id] = g;

      const nowMs = Date.now();
      const holdExpiresAtIso = new Date(nowMs + CART_HOLD_MINUTES * 60_000).toISOString();

      for (const [eventId, capEvent] of capEventsById) {
        const sessions = sessionsByEvent.get(eventId) ?? [];
        const mode = capEvent.registration_mode ?? 'by-discipline';
        if (!hasCapacityConfig(capEvent, sessions) && mode === 'by-discipline') continue;

        const incomingForEvent = regsByLine.filter((r) => r.event_id === eventId);
        if (incomingForEvent.length === 0) continue;

        // By-session mode: every incoming reg must name one of the event's
        // own sessions — a missing/foreign session_id is a structural error,
        // not a capacity overage, so it's reported separately (400, not 409).
        if (mode === 'by-session') {
          const sessionIds = new Set(sessions.map((s) => s.id));
          const offending = incomingForEvent.filter((r) => !r.session_id || !sessionIds.has(r.session_id));
          if (offending.length) {
            return json({
              ok: false,
              error: `"${capEvent.name}" requires selecting a session for each entry — missing or invalid for ${offending.length} registration(s).`,
              code: 'session-required',
              eventId,
              eventName: capEvent.name,
              regIds: offending.map((r) => r.id),
            }, 400);
          }
        }

        // Refresh the 30-min soft hold on checkout start (CLAUDE.md: "checkout
        // start refreshes the hold"). Client-writable `hold_expires_at` is
        // clamped server-side to this same 30-min ceiling by a DB trigger
        // (migration emv2_p4_hold_clamp) — this write and that clamp agree.
        // S4: this is the ONE write that happens before the preview-return
        // branch point (it's part of validation setup, not the pricing
        // computation) — individually guarded rather than restructured,
        // since previewing a price must never extend a capacity hold.
        if (!isPreview) {
          const { error: holdErr } = await db
            .from('registrations')
            .update({ hold_expires_at: holdExpiresAtIso })
            .in('id', incomingForEvent.map((r) => r.id));
          if (holdErr) return json({ ok: false, error: holdErr.message }, 500);
        }

        const violations = checkCapacity(capEvent, sessions, allEventRegs, incomingForEvent, groupsById, nowMs);
        if (violations.length) {
          const describe = (v: (typeof violations)[number]) => {
            if (v.scope === 'total') {
              return `"${capEvent.name}" is at capacity: ${v.remaining} of ${v.cap} spot(s) remain (this order needs ${v.requested}).`;
            }
            if (v.scope === 'level') {
              return `Level ${v.levelId} at "${capEvent.name}" is over its routine cap: ${v.remaining} of ${v.cap} spot(s) remain (this order needs ${v.requested}).`;
            }
            if (v.scope === 'discipline') {
              return `${v.discipline} at "${capEvent.name}" is over its routine cap: ${v.remaining} of ${v.cap} spot(s) remain (this order needs ${v.requested}).`;
            }
            return `Apparatus ${v.apparatus} in session ${v.sessionId} at "${capEvent.name}" is over its routine cap: ${v.remaining} of ${v.cap} spot(s) remain (this order needs ${v.requested}).`;
          };
          return json({
            ok: false,
            error: violations.map(describe).join(' '),
            code: 'capacity-exceeded',
            eventId,
            eventName: capEvent.name,
            violations,
          }, 409);
        }
      }
    }
  }

  // --- Nationals session-request survey gate (event-mgmt v2 Phase 5 A3,
  // spec §L.1/§E5.4) ----------------------------------------------------------
  // Gates BOTH the Stripe path and the $0 free-order path below (same
  // position as the capacity block above) — a nationals event must not be
  // checked out until every required session-planning survey is answered,
  // "including levels newly added by in-cart athletes." Mirrors
  // `requiredSessionRequests`/`sessionRequestAnswered`/`missingSessionRequests`
  // in `src/lib/pricing.ts` (the edge function can't import from `src/`, so
  // the rules are re-derived here — keep in sync). Scoped to the INCOMING
  // regs referenced via ref_reg_ids (`regsByLine`, already loaded above for
  // H4) — required keys derive from what's being paid for right NOW, not the
  // athlete's/club's full registration history, which is exactly the "levels
  // newly added by in-cart athletes" clause.
  {
    const nationalsIncomingRegs = regsByLine.filter((r) => !r.refunded);
    const nationalsEventIds = Array.from(new Set(nationalsIncomingRegs.map((r) => r.event_id)));
    if (nationalsEventIds.length) {
      const { data: natEventRows, error: natEvErr } = await db
        .from('events')
        .select('id, name, kind')
        .in('id', nationalsEventIds);
      if (natEvErr) return json({ ok: false, error: natEvErr.message }, 500);
      const nationalsEventsById = new Map(
        (natEventRows ?? [])
          .filter((e) => (e as { kind: string }).kind === 'nationals')
          .map((e) => [e.id as string, e as { id: string; name: string; kind: string }]),
      );

      if (nationalsEventsById.size) {
        // Athlete -> main_club_id, for every distinct athlete on an incoming
        // nationals reg. A missing row (shouldn't happen) defaults to
        // "not independent" (fail closed), matching the client mirror.
        const nationalsAthleteIds = Array.from(new Set(
          nationalsIncomingRegs
            .filter((r) => nationalsEventsById.has(r.event_id))
            .map((r) => r.athlete_id),
        ));
        const mainClubById = new Map<string, string | null>();
        if (nationalsAthleteIds.length) {
          const { data: peopleRows, error: peopleErr } = await db
            .from('people')
            .select('id, main_club_id')
            .in('id', nationalsAthleteIds);
          if (peopleErr) return json({ ok: false, error: peopleErr.message }, 500);
          for (const p of peopleRows ?? []) {
            mainClubById.set(p.id as string, (p as { main_club_id: string | null }).main_club_id);
          }
        }

        // Existing surveys for the involved nationals event(s).
        const { data: surveyRows, error: surveyErr } = await db
          .from('session_requests')
          .select('event_id, club_id, person_id, discipline, level_id, answers')
          .in('event_id', Array.from(nationalsEventsById.keys()));
        if (surveyErr) return json({ ok: false, error: surveyErr.message }, 500);
        type SurveyRow = {
          event_id: string; club_id: string | null; person_id: string | null;
          discipline: string; level_id: string | null; answers: Record<string, unknown> | null;
        };
        const surveys = (surveyRows ?? []) as SurveyRow[];
        const isAnswered = (s: SurveyRow) =>
          typeof s.answers?.arrival === 'string' && s.answers.arrival.trim().length > 0;

        for (const [eventId, natEvent] of nationalsEventsById) {
          const incomingForEvent = nationalsIncomingRegs.filter((r) => r.event_id === eventId);
          if (incomingForEvent.length === 0) continue;

          // Partition per-registration by the ATHLETE's main_club_id: null
          // ⇒ independent (person-scoped survey keyed by that athlete);
          // else ⇒ club-scoped, keyed by the reg's OWN club_id.
          const byAthlete = new Map<string, RegRow[]>();
          const byClub = new Map<string, RegRow[]>();
          for (const r of incomingForEvent) {
            const mainClubId = mainClubById.get(r.athlete_id) ?? null;
            if (mainClubById.has(r.athlete_id) && mainClubId === null) {
              const list = byAthlete.get(r.athlete_id) ?? [];
              list.push(r);
              byAthlete.set(r.athlete_id, list);
            } else {
              const list = byClub.get(r.club_id ?? '') ?? [];
              list.push(r);
              byClub.set(r.club_id ?? '', list);
            }
          }

          // Required keys, mirroring requiredSessionRequests: person scope
          // = one {discipline, null} per distinct discipline; club scope =
          // one {WAG, levelId} per distinct WAG level + {MAG,null}/{TNT,null}
          // if present.
          const missingDescriptions: string[] = [];

          for (const [athleteId, regs] of byAthlete) {
            const disciplines = new Set(regs.map((r) => r.discipline));
            for (const discipline of disciplines) {
              const answered = surveys.some((s) =>
                s.person_id === athleteId && s.event_id === eventId &&
                s.discipline === discipline && s.level_id === null && isAnswered(s));
              if (!answered) missingDescriptions.push(`${discipline} (athlete survey)`);
            }
          }

          for (const [clubId, regs] of byClub) {
            const wagLevels = new Set<string>();
            let hasMag = false;
            let hasTnt = false;
            for (const r of regs) {
              if (r.discipline === 'WAG') wagLevels.add(r.level_id);
              else if (r.discipline === 'MAG') hasMag = true;
              else if (r.discipline === 'TNT') hasTnt = true;
            }
            for (const levelId of wagLevels) {
              const answered = surveys.some((s) =>
                s.club_id === clubId && s.event_id === eventId &&
                s.discipline === 'WAG' && s.level_id === levelId && isAnswered(s));
              if (!answered) missingDescriptions.push(`WAG level (club survey)`);
            }
            if (hasMag) {
              const answered = surveys.some((s) =>
                s.club_id === clubId && s.event_id === eventId &&
                s.discipline === 'MAG' && s.level_id === null && isAnswered(s));
              if (!answered) missingDescriptions.push('MAG (club survey)');
            }
            if (hasTnt) {
              const answered = surveys.some((s) =>
                s.club_id === clubId && s.event_id === eventId &&
                s.discipline === 'TNT' && s.level_id === null && isAnswered(s));
              if (!answered) missingDescriptions.push('T&T (club survey)');
            }
          }

          if (missingDescriptions.length) {
            return json({
              ok: false,
              error: `"${natEvent.name}" requires the nationals session-planning survey to be answered before checkout ` +
                `(missing: ${missingDescriptions.join(', ')}). Answer it on the club/registrations page, then try again.`,
              code: 'session-survey-required',
              eventId,
              eventName: natEvent.name,
              missing: missingDescriptions,
            }, 400);
          }
        }
      }
    }
  }

  // --- Recompute each line into Stripe line items + subtotal ----------------
  // `scope`/`eventId` are the coupon-matching tags: which "Applies to" category
  // (per the promo-code feature) this line falls under, so a coupon can be
  // scoped to e.g. just athlete memberships or just one specific event.
  type CouponScope = 'athlete-membership' | 'club-membership' | 'coach-membership' | 'meet-entry';
  // `itemId` ties each Stripe line back to its cart item so the POST-discount
  // per-line amount (the coupon allocation below mutates `cents` in place) can
  // be frozen onto the snapshot as `paid_cents` — the refund base (T6).
  type Line = { itemId: string; label: string; cents: number; scope?: CouponScope; eventId?: string };
  const lines: Line[] = [];
  let subtotalCents = 0;
  // Per-cart-item server-priced cents (PRE-discount), for the fulfillment
  // snapshot's `amount_cents`. EVERY item gets an entry (incl. $0 host-club /
  // already-covered lines) so the webhook can fulfill it. Grouped memberships:
  // the dearest item carries the combined amount, the rest 0.
  const serverCentsByItem = new Map<string, number>();
  const pushLine = (itemId: string, label: string, dollars: number, scope?: CouponScope, eventId?: string) => {
    const cents = toCents(dollars);
    subtotalCents += cents;
    serverCentsByItem.set(itemId, cents);
    if (cents > 0) lines.push({ itemId, label, cents, scope, eventId });
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
    // P3: reject a membership targeting a season that's neither current-by-date
    // nor an `active` future season (a past season, or an inactive future one).
    if (!seasonPurchasableForCheckout(season)) {
      return json({ ok: false, error: `${season.name} isn't open for membership purchases yet.` }, 400);
    }
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
      serverCentsByItem.set(item.id, cents);
      if (cents > 0) lines.push({ itemId: item.id, label: item.label, cents, scope: t === 'athlete' ? 'athlete-membership' : 'coach-membership' });
    }
  }

  for (const i of items) {
    if (consumed.has(i.id)) continue;

    // --- Club membership ---
    if (i.kind === 'membership' && i.ref_type === 'club' && i.ref_season_id) {
      const season = seasons.get(i.ref_season_id);
      if (!season) return json({ ok: false, error: `Unknown season ${i.ref_season_id}.` }, 400);
      // P3: same current-by-date-or-active-future gate as the athlete/coach path above.
      if (!seasonPurchasableForCheckout(season)) {
        return json({ ok: false, error: `${season.name} isn't open for membership purchases yet.` }, 400);
      }
      const alreadyActive = clubId && clubMembershipSeasons.has(`${clubId}:${i.ref_season_id}`);
      pushLine(i.id, i.label, alreadyActive ? 0 : season.club_fee, 'club-membership');
      continue;
    }

    // --- Event entry / change fee ---
    // C4: entry-vs-change is derived from the REFERENCED REGISTRATIONS' STATE,
    // never from the client-supplied `ref_line_type` tag (which is trusted only
    // for display/grouping). A reg already purchased or re-pended by an edit
    // (`paid` or `updated_pending`) is a CHANGE; a brand-new unpaid reg is an
    // ENTRY. Rule: treat as change ONLY when EVERY referenced reg is
    // already-purchased/changed — if ANY is brand-new, price the (more
    // expensive, correct) entry total, so a new reg can't be smuggled into a
    // "change" line to be underpriced (the literal C4 exploit: a $0/cheap
    // change fee for what should be a full entry).
    if (i.kind === 'meet-entry') {
      const refRegs = (i.ref_reg_ids ?? []).map((id) => regById.get(id)).filter((r): r is RegRow => !!r);
      const reg = refRegs[0];
      if (!reg) {
        return json({ ok: false, error:
          `"${i.label}" no longer matches a real registration (it may have been refunded or removed) — remove it from your cart (✕) and try checking out again.` }, 400);
      }
      const event = events.get(reg.event_id);
      if (!event) return json({ ok: false, error: `Unknown event ${reg.event_id}.` }, 400);
      // Every reg in one meet-entry line must be the SAME athlete at the SAME
      // event (reviewer-added with UAT M-10): the prior/added discipline
      // counts below are derived from `reg` (refRegs[0]), so a crafted line
      // mixing athlete A's paid reg with athlete B's new reg would price B at
      // the second-discipline rate instead of a full entry. Fail closed.
      if (refRegs.some((r) => r.event_id !== reg.event_id || r.athlete_id !== reg.athlete_id)) {
        return json({ ok: false, error:
          `"${i.label}" mixes registrations for different athletes or events — remove it from your cart (✕) and add the registrations again.` }, 400);
      }

      // UAT Z-02 (S1): no athlete can be charged twice for the same
      // (event, discipline) slot. Two different sessions (e.g. a league
      // admin and a club manager) can each create their OWN registration row
      // for the same athlete+event+discipline — client-minted ids
      // (`RegistrationEditor.tsx`) guarantee the rows never collide on id,
      // so nothing before this point notices. `allEventRegs` (already loaded
      // above: every non-refunded reg at every event this checkout touches,
      // across every club) is exactly the dataset to check against — no
      // extra query for the paid-sibling half. This is defense in depth
      // alongside the DB-level `registrations_live_slot_uniq` partial unique
      // index, which is what actually stops a second duplicate ROW from ever
      // being created; this check exists for a duplicate row that already
      // exists (pre-migration data, or a race that briefly created one
      // before the index applied).
      const pendingCutoffIso = new Date(Date.now() - CART_HOLD_MINUTES * 60_000).toISOString();
      for (const r of refRegs) {
        const paidSibling = findPaidSibling(r, allEventRegs);
        // Other LIVE (non-refunded) rows at this exact slot, excluding every
        // reg this very line already references (this line editing/paying
        // its own regs is never a conflict with itself).
        const otherSlotRegIds = allEventRegs
          .filter((s) => s.event_id === r.event_id && s.athlete_id === r.athlete_id && s.discipline === r.discipline)
          .filter((s) => !refRegs.some((line) => line.id === s.id))
          .map((s) => s.id);
        let conflictReason: string | null = null;
        if (paidSibling) {
          conflictReason = 'paid';
        } else if (otherSlotRegIds.length) {
          // Mid-checkout collision: someone else's UNPAID registration for
          // this exact slot is referenced by a payment still `pending`
          // within the last CART_HOLD_MINUTES — i.e. sitting inside an
          // active, not-yet-completed Stripe Embedded Checkout right now.
          // Mirrors the CART_HOLD_MINUTES (30 min) soft-hold model used
          // elsewhere for capacity. `payments.ref_reg_ids` is populated at
          // insert time below (both the free and Stripe paths) specifically
          // so this overlap query works — it was otherwise an unpopulated
          // vestigial column (see money-invariants.md).
          const { data: pendingPay } = await db.from('payments')
            .select('id')
            .eq('status', 'pending')
            .gte('created_at', pendingCutoffIso)
            .overlaps('ref_reg_ids', otherSlotRegIds)
            .limit(1)
            .maybeSingle();
          if (pendingPay) conflictReason = 'pending';
        }
        if (conflictReason) {
          const { data: athleteRow } = await db.from('people')
            .select('first_name, last_name').eq('id', r.athlete_id).maybeSingle();
          const athleteName = (athleteRow
            ? `${(athleteRow as { first_name?: string }).first_name ?? ''} ${(athleteRow as { last_name?: string }).last_name ?? ''}`.trim()
            : '') || 'This athlete';
          const eventName = eventNames.get(r.event_id) ?? 'this event';
          const message = conflictReason === 'paid'
            ? `${athleteName} is already registered for ${r.discipline} at ${eventName} — refresh the page and check the roster before checking out.`
            : `${athleteName} is already being checked out for ${r.discipline} at ${eventName} by someone else right now — wait a few minutes and check the roster before trying again.`;
          return json({ ok: false, error: message }, 409);
        }
      }
      const competingClubId = reg.club_id ?? '';
      const lineRegIds = new Set(i.ref_reg_ids ?? []);
      // All of this athlete's non-refunded regs at this event+club — used both
      // for prior-discipline counts and as the late-fee anchor's full pool.
      const athleteEventRegs = allEventRegs.filter((r) =>
        r.event_id === reg.event_id &&
        r.athlete_id === reg.athlete_id &&
        (r.club_id ?? '') === competingClubId,
      );
      // Other non-refunded regs for (event, athlete, competing club) NOT in
      // this line at all (neither changed nor added here).
      const outsideRegs = athleteEventRegs.filter((r) => !lineRegIds.has(r.id));

      // UAT M-10-01 (S1): entry-vs-change is derived PER-REG, then the line is
      // split three ways rather than the old binary `every(...)` check — a
      // line whose refs MIX an already-purchased/re-pended reg with a
      // brand-new one (adding a discipline to a paid registration) must be
      // priced as extra-discipline entry fee + change fee, ONE combined line
      // — never as a cheap change-fee-only line (C4 anti-smuggling: an added
      // reg is ALWAYS priced by the entry-total logic, never the change fee
      // alone) and never as a full fresh-entry line (which double-charges the
      // base entry fee already paid for the first discipline).
      const changedRegs = refRegs.filter((r) => r.paid === true || r.updated_pending === true);
      const addedRegs = refRegs.filter((r) => !(r.paid === true || r.updated_pending === true));

      if (addedRegs.length === 0) {
        // Pure edit (level/apparatus/club change on already-purchased regs,
        // no new reg row): change-fee only, unchanged.
        pushLine(i.id, i.label, registrationChangeFeeDollars(event, { competingClubId }), 'meet-entry', reg.event_id);
      } else if (changedRegs.length === 0) {
        // Every referenced reg is brand-new: full entry-total path, unchanged.
        const newDisciplineCount = refRegs.length;
        const priorDisciplineCount = outsideRegs.length;
        // Late-registration fee attachment (emv2 P0 Task 3, corrected): the
        // surcharge attaches ONLY to the line CONTAINING the athlete's
        // earliest-created reg for this event+club (`lateFeeAnchor` returns
        // that line's anchor or null) — otherwise every later entry purchase
        // would re-add a fee already charged with the athlete's first line.
        // MIRRORS src/lib/pricing.ts's `lateFeeAnchor` — keep in sync.
        const lineRegs = athleteEventRegs.filter((r) => lineRegIds.has(r.id));
        const anchor = lateFeeAnchor(lineRegs, outsideRegs, new Date().toISOString());
        pushLine(i.id, i.label, newRegistrationEntryTotalDollars(event, {
          competingClubId, priorDisciplineCount, newDisciplineCount,
          late: anchor ? { earliestCreatedAtISO: anchor } : undefined,
        }), 'meet-entry', reg.event_id);
      } else {
        // Mixed line: a discipline was ADDED alongside an already-purchased/
        // re-pended one — extra-discipline entry fee + change fee, as ONE
        // line. `priorDisciplineCount` counts the changed regs in THIS line
        // (already-registered before) PLUS everything outside the line, so
        // the added discipline(s) price at the second-discipline rate onward.
        // The late-fee anchor considers only the ADDED regs as "this line"
        // (`lineRegs`) against everything else including the changed regs
        // (`outsideRegs`) — an added discipline can still be a late
        // registration; an already-paid discipline never re-triggers it.
        const addedRegIds = new Set(addedRegs.map((r) => r.id));
        const newDisciplineCount = addedRegs.length;
        const priorDisciplineCount = changedRegs.length + outsideRegs.length;
        const lineRegs = athleteEventRegs.filter((r) => addedRegIds.has(r.id));
        const outsideRegsForAnchor = athleteEventRegs.filter((r) => !addedRegIds.has(r.id));
        const anchor = lateFeeAnchor(lineRegs, outsideRegsForAnchor, new Date().toISOString());
        pushLine(i.id, i.label, addedDisciplineChangeTotalDollars(event, {
          competingClubId, priorDisciplineCount, newDisciplineCount,
          late: anchor ? { earliestCreatedAtISO: anchor } : undefined,
        }), 'meet-entry', reg.event_id);
      }
      continue;
    }

    // --- Addon (tshirt / banner / banquet / leo), per unit --------------------
    if (i.kind === 'addon') {
      if (!i.ref_event_id) return json({ ok: false, error: `Addon line ${i.id} has no event.` }, 400);
      const event = events.get(i.ref_event_id);
      if (!event) return json({ ok: false, error: `Unknown event ${i.ref_event_id}.` }, 400);
      const lineType = i.ref_line_type;
      const typeName = lineType === 'tshirt' ? 'T-shirt'
        : lineType === 'banner' ? 'Club banner'
        : lineType === 'banquet' ? 'Banquet'
        : lineType === 'leo' ? 'Leotard'
        : 'Add-on';
      // Fail-closed: an unconfigured/unknown add-on type is REJECTED, never
      // priced at 0 (see addonPriceDollars's doc comment — this is what
      // actually closes the gap the old default-0 behavior left open).
      const price = addonPriceDollars(event, lineType);
      if (price === null) {
        return json({ ok: false, error:
          `"${i.label}" is not a configured add-on for this event — remove it from your cart (✕) and try again.` }, 400);
      }
      // Purchase deadline: this type's own lastPurchaseAt if set (may be after
      // regCloses), else registration must still be open.
      const deadline = addonLastPurchaseAt(event, lineType);
      if (!addonPurchaseOpen(deadline, event.reg_closes, new Date())) {
        return json({ ok: false, error: `The purchase window for the ${typeName} add-on has closed.` }, 400);
      }
      pushLine(i.id, i.label, price, 'meet-entry', i.ref_event_id);
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
  // subtotalCents can never go negative: discountCents is capped at
  // eligibleCents, which is a subset-sum of the (pre-discount) subtotalCents
  // lines, so eligibleCents <= preDiscountSubtotalCents always. The only way
  // to reach exactly 0 here is a coupon that discounts EVERY line to 0 (the
  // subtotalCents<=0 "nothing to pay" guard above already rejected an
  // already-zero pre-discount cart), which is the free-order case below.
  if (subtotalCents < 0) {
    return json({ ok: false, error: 'Coupon discount exceeds the order total — please contact support.' }, 500);
  }

  // Single-membership checkouts record the exact (season, type) so any club-pay
  // matching can key on it (vestigial); multi-item ones rely on cart_item_ids.
  const single = items.length === 1 && items[0].kind === 'membership' ? items[0] : null;

  // Per-cart-item POST-discount cents: after the greedy coupon allocation
  // above, `lines[].cents` holds what the payer is ACTUALLY charged for each
  // line (a $0/covered line never entered `lines`, so it falls back to its
  // pre-discount 0 via serverCentsByItem below). Frozen onto the snapshot as
  // `paid_cents` — the refund base for `process-refund` (T6): refunding the
  // PRE-discount `amount_cents` of a partially-couponed line would take other
  // lines' money with it (e.g. a $135 entry discounted to $85 + a $30 shirt →
  // amount_subtotal $115; a $135 refund base capped at the payment level still
  // pays out $115 for an $85 line). `amount_cents` (and invoice_items.amount)
  // deliberately keeps the list price for receipts/invoices.
  const paidCentsByItem = new Map<string, number>(lines.map((l) => [l.itemId, l.cents]));

  // ============================================================================
  // === PREVIEW BRANCH POINT (S4, money-story UX spec §1) =====================
  // === Everything above this line is auth, ownership (H4), capacity/survey
  // === validation, and pure pricing computation — no side effect except the
  // === one individually-guarded hold-refresh write above (skipped when
  // === `isPreview`). Everything BELOW this line writes: the free-order path
  // === deletes cart_items + inserts payments + fulfills; the paid path
  // === creates a Stripe session + inserts payments. `mode:'preview'` MUST
  // === return here, before any of that, so it is structurally impossible for
  // === a preview request to write anything.
  // ===
  // === M1 (coupon reservation, applied): the reservation call sits strictly
  // === AFTER this branch point, on the non-preview path only — a preview
  // === must never reserve a coupon use just because someone loaded the cart
  // === page (see the `isPreview` early-return immediately below).
  // ============================================================================
  if (isPreview) {
    // No service fee on what would be a $0 order (mirrors the free-order
    // path below, which never calls processingFee on a $0 subtotal).
    const previewFeeCents = subtotalCents > 0 ? processingFee(subtotalCents) : 0;
    // One entry per ORIGINAL cart item (incl. $0 host-club/covered lines),
    // priced at what the payer would actually be charged post-discount —
    // exactly `paidCentsByItem`'s convention, same as `lines_snapshot.paid_cents`
    // would freeze on a real checkout. This is only what clicking "Check out"
    // would already reveal — no new information disclosure.
    const previewLines = items.map((i) => ({
      itemId: i.id,
      label: i.label,
      amountCents: paidCentsByItem.get(i.id) ?? serverCentsByItem.get(i.id) ?? 0,
    }));
    return json({
      ok: true,
      preview: true,
      lines: previewLines,
      amountSubtotal: preDiscountSubtotalCents,
      discountAmount: discountCents,
      serviceFee: previewFeeCents,
      total: subtotalCents + previewFeeCents,
    });
  }

  // --- Freeze the validated, server-priced line set onto the payment row -----
  // Fulfillment reads FROM THIS SNAPSHOT, not from live `cart_items` (which
  // stays client-writable until fulfillment — the TOCTOU closed here). One
  // entry per cart item the payment covers, incl. $0 (host-club / already
  // covered) lines so they still get fulfilled. `amount_cents` is the
  // server-computed PRE-discount charge (grouped memberships: dearest carries
  // the combined amount, the rest 0) — used for invoice_items, never trusted
  // from the client. `paid_cents` is the POST-discount charge (same per-line
  // convention), used only for refund math.
  const linesSnapshot = items.map((i) => ({
    id: i.id,
    kind: i.kind,
    label: i.label,
    amount_cents: serverCentsByItem.get(i.id) ?? 0,
    paid_cents: paidCentsByItem.get(i.id) ?? serverCentsByItem.get(i.id) ?? 0,
    club_id: i.club_id,
    ref_user_id: i.ref_user_id,
    ref_season_id: i.ref_season_id,
    ref_type: i.ref_type,
    ref_reg_ids: i.ref_reg_ids,
    ref_event_id: i.ref_event_id,
    ref_line_type: i.ref_line_type,
    addon_size: i.addon_size,
    addon_assignee: i.addon_assignee,
  }));

  // --- M1: reserve the coupon use (if any) BEFORE creating anything, in
  //     Stripe or the DB. `paymentId` is generated here (rather than left to
  //     the payments insert's default) so it exists to key the reservation
  //     on before either the Stripe session or the payments row is created —
  //     both the free-order path and the paid path below reuse this same id.
  //     `reserve_coupon` re-validates the coupon (window, person restriction,
  //     capacity = used_count + live reservations) and atomically claims a
  //     slot for `paymentId`, locking the coupon row for the duration so two
  //     concurrent checkouts for a single-use code can't both win. A losing
  //     caller gets a clean 409 here — before any Stripe session or payments
  //     row exists — rather than silently keeping a discount it can't have.
  //     Never reached on the preview path (returned above).
  const paymentId = crypto.randomUUID();
  const RESERVATION_MINUTES = 60;
  let reservedCoupon = false;
  if (appliedCouponCode) {
    const reserveExpiresAtIso = new Date(Date.now() + RESERVATION_MINUTES * 60_000).toISOString();
    const { data: reserved, error: reserveErr } = await db.rpc('reserve_coupon', {
      p_code: appliedCouponCode,
      p_payment_id: paymentId,
      p_person_id: personId,
      p_expires_at: reserveExpiresAtIso,
    });
    if (reserveErr) return json({ ok: false, error: reserveErr.message }, 500);
    if (!reserved) {
      return json({ ok: false, error:
        `The coupon code "${appliedCouponCode}" is no longer available (it may have just reached its usage limit) — remove it and try checking out again.` }, 409);
    }
    reservedCoupon = true;
  }
  // Best-effort release helper for any failure between here and a successful
  // payments-row insert (either path) — a reservation left in place beyond
  // that point self-heals via `expires_at` regardless, so this is a UX nicety
  // (immediate retry works) rather than a correctness requirement.
  const releaseReservedCoupon = async () => {
    if (!reservedCoupon) return;
    await db.rpc('release_coupon_reservation', { p_payment_id: paymentId }).then(() => {}, () => {});
  };

  // === FREE-ORDER PATH (2026-07-10): a coupon reduced the total to exactly
  // === $0 — e.g. a scholarship code covering 100% of a Nationals entry. This
  // === is a real, supported order fulfilled WITHOUT Stripe: no service fee
  // === (a $0 order must not be charged the $0.30 minimum — `processingFee`
  // === is simply never called on this path) and no Checkout Session. =======
  if (subtotalCents === 0) {
    // A $0 order is reachable ONLY via a coupon (the pre-discount "nothing to
    // pay" guard above already rejected an already-zero cart) — assert that
    // invariant rather than silently free-fulfilling a pricing-bug zero.
    if (!appliedCouponCode || discountCents <= 0) {
      return json({ ok: false, error: 'Could not verify a $0 total — please try again.' }, 500);
    }

    // --- Claim the cart items FIRST, atomically, by deleting them ----------
    // Unlike the Stripe path (where a separate `payments` row + Stripe's own
    // session lifecycle naturally prevents a double-click from double-
    // fulfilling — only one session ever gets PAID), the free path fulfills
    // synchronously inside this one request. A double-click / retry racing
    // two concurrent requests for the SAME cart items must not both fulfill.
    // Deleting the cart_items rows here (idempotent delete-by-id, same
    // operation fulfillment does at the end) and requiring EVERY id to have
    // actually been deleted is the claim: only the request that wins the
    // delete proceeds to fulfill; a loser sees fewer rows deleted than it
    // asked for and is rejected outright, before any money-equivalent state
    // (membership activation, registration paid-flip, coupon redemption) is
    // touched.
    const { data: deletedItems, error: delErr } = await db
      .from('cart_items')
      .delete()
      .in('id', items.map((i) => i.id))
      .select('id');
    if (delErr) { await releaseReservedCoupon(); return json({ ok: false, error: delErr.message }, 500); }
    if (!deletedItems || deletedItems.length !== items.length) {
      await releaseReservedCoupon();
      return json({ ok: false, error:
        'This order was already processed (likely by a duplicate request) — check your Purchase History.' }, 409);
    }

    const { data: freePayment, error: freePayErr } = await db
      .from('payments')
      .insert({
        id: paymentId,
        stripe_session_id: null,
        person_id: personId,
        status: 'pending',
        amount_subtotal: 0,
        service_fee: 0,
        currency: 'usd',
        cart_item_ids: items.map((i) => i.id),
        // Populated (previously always null — a dormant/vestigial column,
        // see money-invariants.md) so the UAT Z-02 mid-checkout pending-slot
        // overlap query above, and admin-delete-person's existing
        // `ref_reg_ids.ov.{}` scrub filter, both actually work.
        ref_reg_ids: allRefRegIds.length ? allRefRegIds : null,
        lines_snapshot: linesSnapshot,
        ref_season_id: single?.ref_season_id ?? null,
        ref_type: single?.ref_type ?? null,
        coupon_code: appliedCouponCode,
      })
      .select('id, person_id, status, amount_subtotal, service_fee, currency, cart_item_ids, lines_snapshot, invoice_id, stripe_event_id, fulfilled_at, coupon_code')
      .single();
    if (freePayErr) { await releaseReservedCoupon(); return json({ ok: false, error: freePayErr.message }, 500); }

    // --- Fulfill, with an inline retry -------------------------------------
    // The Stripe path recovers from a mid-fulfillment throw via Stripe's
    // webhook retries; the free path has NO external retry mechanism, and the
    // cart items above are already deleted — an unhandled transient failure
    // (network blip to Resend/Supabase, etc.) would strand the order forever:
    // payments row stuck pending, registrations never flipped, coupon never
    // redeemed. fulfillPayment's writes are idempotent by design (its own doc
    // comment supports a defensive re-call), so: try, retry once inline, and
    // if BOTH attempts fail, log to error_logs (the webhook's M5 pattern) and
    // return an honest 500. The payments row is deliberately NOT rolled back —
    // it holds the lines_snapshot and stays claimable (fulfilled_at NULL) for
    // a manual re-run by support.
    const freeOpts = { piId: null, stripeFeeCents: null, eventId: null };
    try {
      await fulfillPayment(db, freePayment as PaymentRow, freeOpts);
    } catch (firstErr) {
      console.error('[create-checkout-session] free-order fulfillment failed, retrying once:', firstErr);
      try {
        await fulfillPayment(db, freePayment as PaymentRow, freeOpts);
      } catch (retryErr) {
        const message = retryErr instanceof Error ? retryErr.message : String(retryErr);
        const stack = retryErr instanceof Error ? retryErr.stack ?? null : null;
        await db.from('error_logs').insert({
          context: 'create-checkout-session',
          message: `free-order fulfillment failed after retry: ${message}`,
          stack,
          detail: { kind: 'free-order', paymentId: freePayment.id, personId, couponCode: appliedCouponCode },
        }).then(() => {}, () => {});
        return json({ ok: false, error:
          `Your $0 order was received but could not be finalized automatically — it has been flagged for review, and ` +
          `no payment is due. If it doesn't appear in your Purchase History soon, contact support with reference ` +
          `${freePayment.id}.` }, 500);
      }
    }

    return json({
      ok: true,
      free: true,
      paymentId: freePayment.id,
      amountSubtotal: preDiscountSubtotalCents,
      discountAmount: discountCents,
      serviceFee: 0,
    });
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
    await releaseReservedCoupon();
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }

  let session;
  try {
    session = await stripe.checkout.sessions.create({
      ui_mode: 'embedded',
      mode: 'payment',
      redirect_on_completion: 'never',
      line_items: stripeLineItems,
      metadata: { person_id: personId, club_id: clubId ?? '', kind: 'cart' },
      // M1: when a coupon is applied, cap the session's own lifetime at the
      // same 60 minutes as the reservation so the two agree — a session that
      // outlived its reservation could complete after the hold expired and
      // the slot was handed to someone else. No coupon ⇒ leave Stripe's
      // default session lifetime alone; don't shorten checkout for everyone
      // to solve a coupon-only problem. (Stripe's own minimum is 30 min.)
      ...(reservedCoupon ? { expires_at: Math.floor(Date.now() / 1000) + RESERVATION_MINUTES * 60 } : {}),
    });
  } catch (e) {
    await releaseReservedCoupon();
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 502);
  }

  // --- Insert the pending payments row (server source of truth). person_id is the
  //     PAYER (caller) for self-read polling + receipt; the webhook reads the
  //     loaded cart items' club_id to know club-vs-person fulfillment. ---
  const { data: payment, error: payErr } = await db
    .from('payments')
    .insert({
      id: paymentId,
      stripe_session_id: session.id,
      person_id: personId,
      status: 'pending',
      amount_subtotal: subtotalCents,
      service_fee: feeCents,
      currency: 'usd',
      cart_item_ids: items.map((i) => i.id),
      // See the free-order insert above for why this is populated now.
      ref_reg_ids: allRefRegIds.length ? allRefRegIds : null,
      lines_snapshot: linesSnapshot,
      ref_season_id: single?.ref_season_id ?? null,
      ref_type: single?.ref_type ?? null,
      coupon_code: appliedCouponCode,
    })
    .select('id')
    .single();
  if (payErr) {
    // The Stripe session already exists at this point — it can't be deleted
    // (Stripe has no "cancel" for a not-yet-completed embedded session short
    // of letting it expire), so this leaves an orphan session. That's a
    // pre-existing risk this task doesn't change (same as before M1 — the
    // insert could already fail after session creation); the reservation
    // must still be released so a genuinely available coupon isn't held
    // hostage by a payments-insert failure.
    await releaseReservedCoupon();
    return json({ ok: false, error: payErr.message }, 500);
  }

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
