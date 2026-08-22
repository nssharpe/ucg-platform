// _shared/fulfill.ts — the snapshot-driven cart-fulfillment core, shared by
// `stripe-webhook` (paid orders) and `create-checkout-session` (the $0-total
// "free order" path — a coupon that fully covers the cost, e.g. a scholarship
// registration; emv2 P3).
//
// This module owns EVERYTHING from "what does a paid/free order do to the
// database" onward: activate membership(s)/club membership, flip paid
// registrations, write the invoice, clear the paid cart lines, and — for the
// atomic claim WINNER only — redeem the coupon and email the receipt. All
// writes are deterministic-id upserts / idempotent deletes, and the claim
// (`fulfilled_at` flips from null exactly once, Postgres-atomic) sits at the
// END, so a caller can safely invoke `fulfillPayment` more than once for the
// same payment row (a Stripe retry, or a defensive re-call) without double
// side effects.
//
// What stays OUTSIDE this module (caller-specific, not shared):
//  - Loading the payment row (webhook loads by stripe_session_id; the free
//    path already has the row it just inserted).
//  - The amount-reconciliation assertion (webhook: M5, Stripe's
//    `session.amount_total` vs. the payment row; free path: asserting the
//    snapshot total is exactly 0) — these compare against different sources
//    of truth and must not be blurred together.
//  - Retrieving Stripe's real processing fee from the balance transaction
//    (webhook only — the free path has no Stripe PaymentIntent).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendOne } from './resend.ts';
import { renderEmail } from './email-layout.ts';
import { buildCampConfirmationHtml, campSurveyQuestionsOfConfig, type CampAthleteSurvey, type CampConfigLike } from './camp-confirmation.ts';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const fmtMoney = (cents: number) =>
  `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface PaymentRow {
  id: string;
  person_id: string | null;
  status: string;
  amount_subtotal: number | null;
  service_fee: number | null;
  currency: string;
  cart_item_ids: string[] | null;
  lines_snapshot: SnapshotItem[] | null;
  invoice_id: string | null;
  stripe_event_id: string | null;
  fulfilled_at: string | null;
  coupon_code: string | null;
}
// The unit of fulfillment — one per cart item the payment covers. `amount_cents`
// is the server-priced (pre-discount) charge frozen at session-create time.
// Sourced from `payments.lines_snapshot` (the trusted path); for legacy pending
// payments with no snapshot it's reconstructed from live `cart_items`.
export interface SnapshotItem {
  id: string;
  club_id: string | null;
  label: string;
  amount_cents: number;
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

export type DB = ReturnType<typeof createClient>;

/** Caller-supplied, source-specific facts the shared core needs but doesn't
 *  derive itself:
 *  - `piId` / `stripeFeeCents`: the real Stripe PaymentIntent id + processing
 *    fee (webhook only — null for the free path, which never touches Stripe).
 *  - `eventId`: the Stripe event id to stamp for idempotency tracking
 *    (webhook only — null for the free path, which has no Stripe event). */
export interface FulfillOpts {
  piId: string | null;
  stripeFeeCents: number | null;
  eventId: string | null;
}

/** Complete a cart purchase (memberships, registrations, addons) — paid via
 *  Stripe OR a $0-total free order. Fulfills FROM THE SNAPSHOT on the payment
 *  row (never from live cart_items), which lets the idempotency claim sit at
 *  the END: all writes below use deterministic ids and are safe to repeat, so
 *  a mid-fulfillment failure leaves `fulfilled_at` null and a retry re-runs
 *  cleanly (H1 — no more permanently-stuck partial fulfillment), while two
 *  concurrent deliveries both write the same idempotent rows and only the
 *  claim winner redeems the coupon + emails. */
export async function fulfillPayment(db: DB, payment: PaymentRow, opts: FulfillOpts): Promise<void> {
  // Fast-path early-out for an obviously-finished payment. NOT the race guard —
  // that's the conditional claim at the very end.
  if (payment.status === 'paid' || payment.fulfilled_at) return;
  const personId = payment.person_id;
  if (!personId) { console.warn('[fulfill] payment has no person', payment.id); return; }

  // --- The lines to fulfill: the frozen snapshot (trusted path), or, for a
  //     pending payment created before the snapshot column existed, the live
  //     cart_items as a fallback. ---
  const cartItemIds = payment.cart_item_ids ?? [];
  let items: SnapshotItem[];
  if (payment.lines_snapshot && payment.lines_snapshot.length) {
    items = payment.lines_snapshot;
  } else {
    const { data: itemRows } = cartItemIds.length
      ? await db.from('cart_items')
        .select('id, club_id, label, amount, kind, ref_user_id, ref_season_id, ref_type, ref_reg_ids, ref_event_id, ref_line_type, addon_size, addon_assignee')
        .in('id', cartItemIds)
      : { data: [] as Record<string, unknown>[] };
    items = (itemRows ?? []).map((i: Record<string, unknown>) => ({
      id: i.id as string, club_id: (i.club_id as string | null) ?? null,
      label: i.label as string, amount_cents: Math.round(((i.amount as number) ?? 0) * 100),
      kind: i.kind as string, ref_user_id: (i.ref_user_id as string | null) ?? null,
      ref_season_id: (i.ref_season_id as string | null) ?? null, ref_type: (i.ref_type as string | null) ?? null,
      ref_reg_ids: (i.ref_reg_ids as string[] | null) ?? null, ref_event_id: (i.ref_event_id as string | null) ?? null,
      ref_line_type: (i.ref_line_type as string | null) ?? null,
      addon_size: (i.addon_size as string | null) ?? null, addon_assignee: (i.addon_assignee as string | null) ?? null,
    }));
  }
  // A club cart ⇒ any item carries the club_id (person carts have it null).
  const clubId = items.find((i) => i.club_id)?.club_id ?? null;
  const now = new Date().toISOString();

  // === All writes below are IDEMPOTENT (deterministic ids / set-true-again /
  // === delete-by-id) so a retry re-runs them harmlessly. ======================

  // --- Fulfill memberships + club memberships -------------------------------
  // Waiver state is resolved server-side from waiver_signatures for the TARGET
  // person: signed ⇒ active, else pending-waiver. paid_via reflects who paid
  // (card for a self cart, club for a club cart; free-order carts follow the
  // same self/club distinction). The club-cart hold is cleared.
  //
  // "First membership" welcome email: snapshot which target people had NO
  // membership row AT ALL (any status — active, pending-waiver, or
  // pending-club-payment all count as "already engaged the purchase flow
  // once") before this fulfillment, so we can tell, after the loop, which
  // ones just got their first one.
  const membershipTargets = Array.from(new Set(
    items
      .filter((i) => i.kind === 'membership' && i.ref_season_id && (i.ref_type === 'athlete' || i.ref_type === 'coach'))
      .map((i) => i.ref_user_id ?? personId),
  ));
  const hadPriorMembership = new Set<string>();
  if (membershipTargets.length) {
    const { data: priorRows } = await db.from('memberships')
      .select('person_id')
      .in('person_id', membershipTargets);
    for (const r of (priorRows ?? []) as { person_id: string }[]) hadPriorMembership.add(r.person_id);
  }
  const becameActive = new Set<string>();

  for (const item of items) {
    if (item.kind !== 'membership' || !item.ref_season_id) continue;
    const seasonId = item.ref_season_id;

    if (item.ref_type === 'club') {
      if (!clubId) continue;
      // Upsert-ignore on the (club, season) unique key — idempotent under retry
      // (a second delivery is a no-op instead of a duplicate/uuid churn).
      await db.from('club_memberships').upsert({
        id: crypto.randomUUID(),
        club_id: clubId, season_id: seasonId,
        status: 'active', granted_by_admin: false, created_at: now,
      }, { onConflict: 'club_id,season_id', ignoreDuplicates: true });
      continue;
    }

    if (item.ref_type === 'athlete' || item.ref_type === 'coach') {
      const targetPerson = item.ref_user_id ?? personId;
      const type = item.ref_type;
      const { data: sig } = await db.from('waiver_signatures')
        .select('signer_name, signed_at')
        .eq('person_id', targetPerson).eq('season_id', seasonId)
        .order('signed_at', { ascending: false }).limit(1).maybeSingle();
      const signed = !!sig;
      await db.from('memberships').upsert({
        id: `${targetPerson}:${seasonId}:${type}`,
        person_id: targetPerson, season_id: seasonId, type,
        status: signed ? 'active' : 'pending-waiver',
        waiver_signed_at: (sig as { signed_at?: string } | null)?.signed_at ?? null,
        waiver_signed_by: (sig as { signer_name?: string } | null)?.signer_name ?? null,
        paid_via: clubId ? 'club' : 'card',
        activated_by_admin: false,
        club_cart_pending: false,
      }, { onConflict: 'person_id,season_id,type' });
      if (signed && !clubId) becameActive.add(targetPerson);
    }
  }

  // Fire the welcome email for each target that just got their FIRST active
  // membership. Only ever applies to a self/card(-or-free) cart (!clubId) — a
  // club-cart payment implies the target belongs to a club, and
  // send-membership-welcome's own server-side re-check (no-club only) would
  // reject it anyway. Best-effort, never blocks fulfillment.
  for (const targetPerson of becameActive) {
    if (hadPriorMembership.has(targetPerson)) continue;
    try {
      await fetch(`${Deno.env.get('SUPABASE_URL')!}/functions/v1/send-membership-welcome`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!}` },
        body: JSON.stringify({ personId: targetPerson }),
      });
    } catch (welcomeErr) {
      console.error('[fulfill] failed to trigger welcome email:', welcomeErr);
    }
  }

  // --- Flip the paid registrations (event entries + change fees) -------------
  // Service role bypasses the guard_registration_paid trigger (Phase 1), so
  // this remains the authoritative writer of registrations.paid.
  const paidRegIds = Array.from(new Set(items.flatMap((i) => i.ref_reg_ids ?? [])));
  if (paidRegIds.length) {
    await db.from('registrations')
      .update({ paid: true, updated_pending: false })
      .in('id', paidRegIds);
  }

  // --- Write the paid invoice (idempotent: id derived from the payment row) ---
  // Club cart ⇒ billed to the club; self cart ⇒ billed to the payer.
  const invoiceId = payment.invoice_id ?? `inv-${payment.id}`;
  let number: string;
  const { data: existingInv } = await db.from('invoices').select('number').eq('id', invoiceId).maybeSingle();
  if (existingInv) {
    // Already created by an earlier (partial) attempt — reuse its number so a
    // retry doesn't renumber the invoice.
    number = (existingInv as { number?: string }).number ?? `UCG-${payment.id}`;
  } else {
    // Concurrency-safe sequence claim (UAT Z-01 follow-up): a row-COUNT-based
    // number used to be minted here, which let two concurrent fulfillments
    // (a Stripe retry racing a fresh checkout) read the same count and mint
    // the SAME number — the loser then failed on invoices.number's unique
    // constraint, permanently stuck at `pending` (the atomic claim below
    // never runs). `next_invoice_number` (20260821140000) claims the number
    // atomically via a single insert-on-conflict-returning, so there's no
    // read-then-write gap to race. No fallback on error — an invoice number
    // must never be guessed; a failure here throws and this fulfillment
    // attempt aborts (payment stays pending for the caller's existing
    // retry/error_logs path to pick up, exactly as any other write failure
    // in this function already does).
    const { data: numberData, error: numberErr } = await db.rpc('next_invoice_number');
    if (numberErr || typeof numberData !== 'string' || !numberData) {
      throw new Error(`fulfillPayment: next_invoice_number failed for payment ${payment.id}: ${numberErr?.message ?? 'no number returned'}`);
    }
    number = numberData;
  }
  await db.from('invoices').upsert({
    id: invoiceId, number,
    club_id: clubId, athlete_id: clubId ? null : personId,
    coupon_code: payment.coupon_code ?? null, created_at: now, paid_at: now,
    stripe_payment_intent_id: opts.piId, stripe_fee: opts.stripeFeeCents,
  }, { onConflict: 'id' });
  // Invoice lines mirror ALL paid items (human-readable detail; amounts from the
  // server snapshot, not the client). Financial source of truth stays the
  // payment row (server-recomputed subtotal + Stripe's real fee, or 0/0 for a
  // free order).
  if (items.length) {
    await db.from('invoice_items').upsert(
      items.map((i, idx) => ({
        id: `ii-${payment.id}-${idx}`, invoice_id: invoiceId,
        label: i.label, amount: i.amount_cents / 100, kind: i.kind,
        ref_user_id: i.ref_user_id ?? null,
        ref_reg_ids: i.ref_reg_ids, ref_event_id: i.ref_event_id, ref_line_type: i.ref_line_type,
        addon_size: i.addon_size ?? null, addon_assignee: i.addon_assignee ?? null,
        refunded: false,
      })),
      { onConflict: 'id' },
    );
  } else if (payment.amount_subtotal != null) {
    // No snapshot AND the legacy cart_items were already gone — but a real
    // charge was captured. Write a single fallback line from the payment's own
    // authoritative amount so the receipt/invoice NEVER shows $0.
    await db.from('invoice_items').upsert([{
      id: `ii-${payment.id}-0`, invoice_id: invoiceId,
      label: 'Payment', amount: payment.amount_subtotal / 100, kind: 'membership',
      ref_user_id: null, ref_reg_ids: null, ref_event_id: null, ref_line_type: null,
      refunded: false,
    }], { onConflict: 'id' });
  }
  // The service fee (the only source of non-whole-dollar cents in what the
  // customer actually paid) was previously computed for checkout display and
  // the receipt EMAIL only, never persisted — so Purchase History / the
  // receipt PDF silently dropped it. Write it as its own line so it's summed
  // into the invoice total like any other item. A free order has service_fee
  // 0, so this is a no-op for it.
  if ((payment.service_fee ?? 0) > 0) {
    await db.from('invoice_items').upsert([{
      id: `ii-${payment.id}-fee`, invoice_id: invoiceId,
      label: 'Service fee (card processing)', amount: (payment.service_fee ?? 0) / 100, kind: 'fee',
      ref_user_id: null, ref_reg_ids: null, ref_event_id: null, ref_line_type: null,
      refunded: false,
    }], { onConflict: 'id' });
  }

  // --- Clear the paid cart lines (idempotent delete-by-id) ---
  if (cartItemIds.length) {
    await db.from('cart_items').delete().in('id', cartItemIds);
  }

  // --- Finalize: ATOMIC claim at the END --------------------------------------
  // Only one caller flips `fulfilled_at` from null (Postgres-atomic conditional
  // UPDATE). All the writes above already ran idempotently for BOTH a winner and
  // any concurrent/duplicate delivery; the loser simply skips the once-only
  // side effects below. Because the claim is here (not before the work), a
  // mid-fulfillment throw leaves `fulfilled_at` null ⇒ a retry re-runs.
  const { data: claimed } = await db.from('payments').update({
    status: 'paid',
    stripe_payment_intent_id: opts.piId,
    stripe_fee: opts.stripeFeeCents,
    invoice_id: invoiceId,
    stripe_event_id: opts.eventId,
    fulfilled_at: now,
  }).eq('id', payment.id).is('fulfilled_at', null).select('id');
  if (!claimed || claimed.length === 0) {
    console.warn('[fulfill] payment finalized by a concurrent delivery; skipping once-only steps', payment.id);
    return;
  }

  // --- Winner-only, once-only side effects -----------------------------------
  // Coupon redemption bumps used_count, so it must run exactly once — pass the
  // payer so a person-restricted code (Phase 1's redeem_coupon check)
  // validates, and pass this payment's id (M1) so redemption also deletes its
  // reservation row in the same call — the reservation and the used_count
  // bump must never both be live, or a concurrent reserve_coupon capacity
  // check double-counts this use.
  if (payment.coupon_code) {
    await db.rpc('redeem_coupon', { p_code: payment.coupon_code, p_person_id: personId, p_payment_id: payment.id });
  }
  // Email the REAL payer a receipt (best-effort; never fails fulfillment).
  try {
    await emailReceipt(db, personId, items, payment, number);
  } catch (e) {
    console.error('[fulfill] receipt email failed:', e);
  }
}

/** Email the payer their confirmation + HTML receipt. Recipient is the payer's
 *  own people.email (resolved server-side). */
async function emailReceipt(
  db: DB,
  personId: string,
  items: SnapshotItem[],
  payment: PaymentRow,
  invoiceNumber: string,
): Promise<void> {
  const { data: p } = await db.from('people')
    .select('first_name, last_name, email').eq('id', personId).maybeSingle();
  const person = p as { first_name?: string; last_name?: string; email?: string } | null;
  const toEmail = (person?.email ?? '').trim();
  if (!EMAIL_RE.test(toEmail)) return;
  const forName = `${person?.first_name ?? ''} ${person?.last_name ?? ''}`.trim() || 'Member';

  const subtotal = payment.amount_subtotal ?? items.reduce((s, i) => s + i.amount_cents, 0);
  const fee = payment.service_fee ?? 0;
  const total = subtotal + fee;

  // Per-event confirmation config (emv2 P0 Task 4): events referenced by the
  // purchased lines can carry a host-configured confirmation message
  // (rendered above the receipt), a director to cc, a reply-to, and a from
  // display name (alias + reply-to stand in for a custom from address, which
  // Resend's verified-domain rule forbids — emv2 spec §N7-6). Alias/reply-to
  // are applied only when UNAMBIGUOUS (exactly one distinct value across the
  // cart's events). Failures here must never block the receipt.
  let eventSectionsHtml = '';
  const ccSet = new Set<string>();
  const replyTos = new Set<string>();
  const fromAliases = new Set<string>();
  // Hoisted so the camp-confirmation block (built in its own try/catch below)
  // can reuse the same event rows without a second round trip.
  let evs: { id: string; name: string | null; event_type: string | null; camp_config: CampConfigLike | null }[] = [];
  try {
    const eventIds = [...new Set(items.map((i) => i.ref_event_id).filter((id): id is string => !!id))];
    if (eventIds.length) {
      const { data: evRows } = await db
        .from('events')
        .select('id, name, confirmation_email, director, event_type, camp_config')
        .in('id', eventIds);
      evs = (evRows ?? []) as unknown as { id: string; name: string | null; event_type: string | null; camp_config: CampConfigLike | null }[];
      for (const evRow of evRows ?? []) {
        const ev = evRow as unknown as {
          id: string; name: string | null;
          confirmation_email: { bodyHtml?: string; fromAlias?: string; replyTo?: string } | null;
          director: { name?: string; email?: string; ccOnConfirmation?: boolean } | null;
        };
        const conf = ev.confirmation_email;
        if (conf?.bodyHtml?.trim()) {
          // Host-authored HTML: editable only by sanctioning team / league
          // admins today (EventWizard) — rendered as-is inside the card.
          eventSectionsHtml += `<div style="margin:16px 0;padding:12px 14px;border-left:3px solid #F4694A;background:#f7f9fb;">` +
            `<p style="margin:0 0 6px;font-weight:700;color:#1E2B38;">A message from ${esc(ev.name ?? 'the event')}</p>` +
            `<div style="color:#1E2B38;">${conf.bodyHtml}</div></div>`;
        }
        const replyTo = (conf?.replyTo ?? '').trim().toLowerCase();
        if (EMAIL_RE.test(replyTo)) replyTos.add(replyTo);
        if (conf?.fromAlias?.trim()) fromAliases.add(conf.fromAlias.trim());
        const dirEmail = (ev.director?.email ?? '').trim().toLowerCase();
        if (ev.director?.ccOnConfirmation && EMAIL_RE.test(dirEmail) && dirEmail !== toEmail.toLowerCase()) {
          ccSet.add(dirEmail);
        }
      }
    }
  } catch (e) {
    console.error('emailReceipt: per-event confirmation config failed (sending plain receipt)', e);
    eventSectionsHtml = ''; ccSet.clear(); replyTos.clear(); fromAliases.clear();
  }

  // Camp confirmation block (emv2 P2 §G): for any purchased CAMP event, append
  // a summary of each registered athlete's overnight-survey answers plus this
  // payment's add-ons, with a link back to the member edit surface. Entirely
  // best-effort — any failure here must never break the receipt, so it's
  // isolated in its own try/catch and defaults to '' (no camp section) rather
  // than touching eventSectionsHtml/ccSet/etc. above.
  let campSectionHtml = '';
  try {
    const campEvents = evs.filter((ev) => ev.event_type === 'camp');
    const campEventIds = new Set(campEvents.map((ev) => ev.id));
    // Per-event resolved question list (`campSurveyQuestionsOfConfig` mirrors
    // `campSurveyQuestionsOf`, src/lib/pricing.ts) — a reg's own event decides
    // which questions render for it, so a multi-camp cart renders each
    // athlete against the RIGHT event's question set.
    const questionsByEventId = new Map(campEvents.map((ev) => [ev.id, campSurveyQuestionsOfConfig(ev.camp_config ?? undefined).questions]));
    if (campEventIds.size) {
      // regId → its event id, so each registration's answers render against
      // that event's own question list (not just any camp event's).
      const eventIdByRegId = new Map<string, string>();
      for (const i of items) {
        if (!i.ref_event_id || !campEventIds.has(i.ref_event_id) || i.kind === 'addon') continue;
        for (const regId of i.ref_reg_ids ?? []) eventIdByRegId.set(regId, i.ref_event_id);
      }
      const regIds = [...eventIdByRegId.keys()];
      let athletes: CampAthleteSurvey[] = [];
      if (regIds.length) {
        const { data: regRows } = await db.from('registrations')
          .select('id, athlete_id, camp_survey')
          .in('id', regIds);
        const regs = (regRows ?? []) as { id: string; athlete_id: string | null; camp_survey: CampAthleteSurvey['survey'] | null }[];
        const athleteIds = [...new Set(regs.map((r) => r.athlete_id).filter((id): id is string => !!id))];
        const nameById = new Map<string, string>();
        if (athleteIds.length) {
          const { data: peopleRows } = await db.from('people')
            .select('id, first_name, last_name')
            .in('id', athleteIds);
          for (const pr of (peopleRows ?? []) as { id: string; first_name?: string; last_name?: string }[]) {
            nameById.set(pr.id, `${pr.first_name ?? ''} ${pr.last_name ?? ''}`.trim() || 'Athlete');
          }
        }
        athletes = regs.map((r) => ({
          name: (r.athlete_id && nameById.get(r.athlete_id)) || 'Athlete',
          survey: r.camp_survey,
          questions: questionsByEventId.get(eventIdByRegId.get(r.id) ?? '') ?? [],
        }));
      }
      // Add-on lines already carry a fully human-readable label (athlete name
      // + size / assignee baked in by buildAddonCartItems) — reuse as-is
      // rather than re-resolving names.
      const addonLabels = items
        .filter((i) => i.kind === 'addon' && i.ref_event_id && campEventIds.has(i.ref_event_id))
        .map((i) => i.label);
      const appUrl = Deno.env.get('APP_PUBLIC_URL') ?? 'https://nssharpe.github.io/ucg-platform';
      campSectionHtml = buildCampConfirmationHtml({
        athletes, addonLabels, editUrl: `${appUrl}/#/me/registrations`,
      });
    }
  } catch (e) {
    console.error('emailReceipt: camp confirmation block failed (sending receipt without it)', e);
    campSectionHtml = '';
  }

  // Only list lines that carry a charge (grouped-membership "included" lines and
  // $0 host-club lines are server-priced to 0 and would just clutter the receipt).
  const rows = items
    .filter((i) => i.amount_cents > 0)
    .map((i) => `<tr><td style="padding:6px 16px 6px 0;color:#1E2B38;">${esc(i.label)}</td>` +
      `<td style="padding:6px 0;text-align:right;white-space:nowrap;color:#1E2B38;">${fmtMoney(i.amount_cents)}</td></tr>`)
    .join('');
  const feeRow = fee > 0
    ? `<tr><td style="padding:6px 16px 6px 0;color:#5b6b7a;">Service fee (card processing)</td>` +
      `<td style="padding:6px 0;text-align:right;white-space:nowrap;color:#5b6b7a;">${fmtMoney(fee)}</td></tr>`
    : '';

  const subject = 'Your United Club Gymnastics receipt';
  const html = renderEmail({
    heading: 'Your receipt',
    bodyHtml: `<p>Hi ${esc(forName)},</p>
<p>Thanks for your purchase. Here's your receipt for the items below.</p>
${eventSectionsHtml}${campSectionHtml}<p style="color:#5b6b7a;font-size:13px;margin:0 0 12px;">Receipt ${esc(invoiceNumber)}</p>
<table style="border-collapse:collapse;margin:8px 0;font-size:14px;width:100%;">
${rows}${feeRow}
<tr><td style="padding:10px 16px 0 0;border-top:2px solid #1E2B38;font-weight:700;color:#1E2B38;">Total paid</td>
<td style="padding:10px 0 0;border-top:2px solid #1E2B38;text-align:right;font-weight:700;color:#1E2B38;">${fmtMoney(total)}</td></tr>
</table>`,
    footnoteHtml: `Billed to ${esc(forName)} (${esc(toEmail)}). You can re-download a PDF receipt any time from your Purchase History on the platform.`,
  });

  await sendOne({
    to: `${forName} <${toEmail}>`,
    subject,
    html,
    ...(ccSet.size ? { cc: [...ccSet] } : {}),
    ...(replyTos.size === 1 ? { reply_to: [...replyTos][0] } : {}),
    ...(fromAliases.size === 1 ? { fromName: [...fromAliases][0] } : {}),
  });
}
