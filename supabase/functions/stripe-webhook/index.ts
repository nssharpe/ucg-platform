// stripe-webhook — the SOLE source of truth that completes a payment (Phase S4,
// generalized: memberships, club memberships, event entries, change fees, addons;
// self OR club carts).
//
// Deploy with `--no-verify-jwt` (Stripe is the caller; it cannot send a Supabase
// JWT). Authenticity is the Stripe signature, verified with `constructEventAsync`
// (Deno/SubtleCrypto is async; the sync `constructEvent` throws here) against
// STRIPE_WEBHOOK_SECRET. Fail CLOSED: a missing secret rejects every request.
// Paste this function's URL into the Stripe dashboard webhook endpoint:
//   https://wkyerxlgricfphopocoz.supabase.co/functions/v1/stripe-webhook
//
// Secrets: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET. Auto-provided: SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY. Receipts reuse the Resend infra (RESEND_API_KEY,
// RESEND_FROM).
//
// On `checkout.session.completed` (+ `async_payment_succeeded`) it runs the
// server-side fulfillment — activate membership(s)/club membership, flip paid
// registrations, write the invoice, record Stripe's actual fee, clear the paid
// cart lines, email the real payer a receipt — IDEMPOTENTLY on the Stripe event
// id (and short-circuits if the payment row is already fulfilled). On
// `expired`/payment-failed it marks the payment `failed` and leaves items pending.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getStripe, getCryptoProvider } from '../_shared/stripe.ts';
import { sendOne } from '../_shared/resend.ts';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const fmtMoney = (cents: number) =>
  `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

interface PaymentRow {
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
interface SnapshotItem {
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
}

type DB = ReturnType<typeof createClient>;

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET');
  if (!webhookSecret) {
    console.error('[stripe-webhook] STRIPE_WEBHOOK_SECRET is not set — rejecting (fail closed).');
    return json({ error: 'Webhook is not configured.' }, 500);
  }

  let stripe;
  try { stripe = getStripe(); } catch (e) {
    console.error('[stripe-webhook]', e);
    return json({ error: 'Payments are not configured.' }, 500);
  }

  // Raw body is required verbatim for signature verification.
  const rawBody = await req.text();
  const sig = req.headers.get('stripe-signature') ?? '';
  if (!sig) return json({ error: 'Missing Stripe-Signature header.' }, 401);

  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(rawBody, sig, webhookSecret, undefined, getCryptoProvider());
  } catch (e) {
    console.error('[stripe-webhook] signature verification failed:', e);
    return json({ error: 'Invalid signature.' }, 401);
  }

  const url = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const db = createClient(url, serviceKey, { auth: { persistSession: false } });

  try {
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        const session = event.data.object as import('npm:stripe@17.7.0').Stripe.Checkout.Session;
        // Async (e.g. bank-debit) sessions complete on async_payment_succeeded —
        // skip fulfilling a `completed` whose payment isn't settled yet.
        if (event.type === 'checkout.session.completed' && session.payment_status === 'unpaid') {
          return json({ ok: true, handled: 'awaiting_async_payment' });
        }
        await fulfill(db, stripe, session, event.id);
        return json({ ok: true, handled: 'fulfilled' });
      }
      case 'checkout.session.expired':
      case 'checkout.session.async_payment_failed': {
        const session = event.data.object as import('npm:stripe@17.7.0').Stripe.Checkout.Session;
        await db.from('payments')
          .update({ status: 'failed', stripe_event_id: event.id })
          .eq('stripe_session_id', session.id)
          .is('fulfilled_at', null);
        return json({ ok: true, handled: 'failed' });
      }
      default:
        return json({ ok: true, handled: 'ignored', type: event.type });
    }
  } catch (e) {
    console.error('[stripe-webhook] handler error:', e);
    const message = e instanceof Error ? e.message : String(e);
    const stack = e instanceof Error ? e.stack ?? null : null;
    // Added 2026-07-02: there is no remote function-log access for this project,
    // so any handler exception is otherwise invisible — record it to the existing
    // error_logs table (anyone-insert / admin-read RLS already supports this) so
    // it's visible on the admin Error Log page instead of silently failing.
    await db.from('error_logs').insert({
      context: 'stripe-webhook', message, stack,
      detail: { eventType: event.type, eventId: event.id },
    }).then(() => {}, () => {});
    return json({ error: message }, 500);
  }
});

/** Complete a cart purchase (memberships, registrations, addons). Fulfills FROM
 *  THE SNAPSHOT on the payment row (never from live cart_items), which lets the
 *  idempotency claim sit at the END: all writes below use deterministic ids and
 *  are safe to repeat, so a mid-fulfillment failure leaves `fulfilled_at` null
 *  and Stripe's retry re-runs cleanly (fixes H1 — no more permanently-stuck
 *  partial fulfillment), while two concurrent deliveries both write the same
 *  idempotent rows and only the claim winner redeems the coupon + emails. */
async function fulfill(
  db: DB,
  stripe: ReturnType<typeof getStripe>,
  session: import('npm:stripe@17.7.0').Stripe.Checkout.Session,
  eventId: string,
): Promise<void> {
  const { data: payRow } = await db.from('payments')
    .select('id, person_id, status, amount_subtotal, service_fee, currency, cart_item_ids, lines_snapshot, invoice_id, stripe_event_id, fulfilled_at, coupon_code')
    .eq('stripe_session_id', session.id)
    .maybeSingle();
  const payment = payRow as PaymentRow | null;
  if (!payment) {
    // No row we created — nothing to fulfill (still 2xx so Stripe stops retrying).
    console.warn('[stripe-webhook] no payments row for session', session.id);
    return;
  }
  // Fast-path early-out for an obviously-finished payment. NOT the race guard —
  // that's the conditional claim at the very end.
  if (payment.status === 'paid' || payment.fulfilled_at) return;
  const personId = payment.person_id;
  if (!personId) { console.warn('[stripe-webhook] payment has no person', payment.id); return; }

  // --- M5: reconcile what Stripe actually collected against the server-written
  //     amounts (defense-in-depth against tampering / a pricing bug). ---------
  const expectedTotal = (payment.amount_subtotal ?? 0) + (payment.service_fee ?? 0);
  if (typeof session.amount_total === 'number' && session.amount_total !== expectedTotal) {
    await db.from('error_logs').insert({
      context: 'stripe-webhook',
      message: `amount mismatch: Stripe collected ${session.amount_total} but the payment row expects ${expectedTotal} (subtotal ${payment.amount_subtotal} + fee ${payment.service_fee})`,
      detail: { paymentId: payment.id, sessionId: session.id, eventId },
    }).then(() => {}, () => {});
    // Do NOT fulfill a mismatched charge. Leave the payment 'pending' (not
    // 'failed' — money WAS collected) for manual review; return 2xx so Stripe
    // stops retrying a condition that won't self-resolve. Visible in error_logs.
    return;
  }

  // --- Stripe's actual processing fee, from the balance transaction ---------
  const piId = typeof session.payment_intent === 'string'
    ? session.payment_intent
    : session.payment_intent?.id ?? null;
  let stripeFeeCents: number | null = null;
  if (piId) {
    try {
      const intent = await stripe.paymentIntents.retrieve(piId, { expand: ['latest_charge.balance_transaction'] });
      const charge = intent.latest_charge;
      if (charge && typeof charge !== 'string') {
        const bt = charge.balance_transaction;
        if (bt && typeof bt !== 'string') stripeFeeCents = bt.fee;
      }
    } catch (e) {
      console.error('[stripe-webhook] could not read balance txn fee:', e);
    }
  }

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
        .select('id, club_id, label, amount, kind, ref_user_id, ref_season_id, ref_type, ref_reg_ids, ref_event_id, ref_line_type')
        .in('id', cartItemIds)
      : { data: [] as Record<string, unknown>[] };
    items = (itemRows ?? []).map((i) => ({
      id: i.id as string, club_id: (i.club_id as string | null) ?? null,
      label: i.label as string, amount_cents: Math.round(((i.amount as number) ?? 0) * 100),
      kind: i.kind as string, ref_user_id: (i.ref_user_id as string | null) ?? null,
      ref_season_id: (i.ref_season_id as string | null) ?? null, ref_type: (i.ref_type as string | null) ?? null,
      ref_reg_ids: (i.ref_reg_ids as string[] | null) ?? null, ref_event_id: (i.ref_event_id as string | null) ?? null,
      ref_line_type: (i.ref_line_type as string | null) ?? null,
    }));
  }
  // A club cart ⇒ any item carries the club_id (person carts have it null).
  const clubId = items.find((i) => i.club_id)?.club_id ?? null;
  const now = new Date().toISOString();

  // === All writes below are IDEMPOTENT (deterministic ids / set-true-again /
  // === delete-by-id) so a Stripe retry re-runs them harmlessly. ==============

  // --- Fulfill memberships + club memberships -------------------------------
  // Waiver state is resolved server-side from waiver_signatures for the TARGET
  // person: signed ⇒ active, else pending-waiver. paid_via reflects who paid
  // (card for a self cart, club for a club cart); the club-cart hold is cleared.
  //
  // "First membership" welcome email: previously only fired on the admin-comp
  // path (Membership.tsx) — a real card payment (this path) never triggered it,
  // even for the exact no-club/Independent member it's meant for. Snapshot
  // which target people had NO membership row AT ALL (any status — active,
  // pending-waiver, or pending-club-payment all count as "already engaged the
  // purchase flow once") before this fulfillment, so we can tell, after the
  // loop, which ones just got their first one. Per-docs/plans/2026-07-02-
  // welcome-email-stripe-path.md's requirement — broader than a plain
  // status='active' check, so an abandoned/never-paid prior attempt still
  // correctly suppresses a duplicate welcome.
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
  // membership via a real card payment (never wired before this fix). Only
  // ever applies to a self/card cart (!clubId) — a club-cart payment implies
  // the target belongs to a club, and send-membership-welcome's own
  // server-side re-check (no-club only) would reject it anyway. Best-effort,
  // never blocks fulfillment; mirrors the same trigger in
  // record-waiver-signature/index.ts.
  for (const targetPerson of becameActive) {
    if (hadPriorMembership.has(targetPerson)) continue;
    try {
      await fetch(`${Deno.env.get('SUPABASE_URL')!}/functions/v1/send-membership-welcome`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!}` },
        body: JSON.stringify({ personId: targetPerson }),
      });
    } catch (welcomeErr) {
      console.error('[stripe-webhook] failed to trigger welcome email:', welcomeErr);
    }
  }

  // --- Flip the paid registrations (event entries + change fees) -------------
  // Service role bypasses the guard_registration_paid trigger (Phase 1), so the
  // webhook remains the authoritative writer of registrations.paid.
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
    const { count } = await db.from('invoices').select('id', { count: 'exact', head: true });
    number = `UCG-2026-${String((count ?? 0) + 1).padStart(4, '0')}`;
  }
  await db.from('invoices').upsert({
    id: invoiceId, number,
    club_id: clubId, athlete_id: clubId ? null : personId,
    coupon_code: payment.coupon_code ?? null, created_at: now, paid_at: now,
    stripe_payment_intent_id: piId, stripe_fee: stripeFeeCents,
  }, { onConflict: 'id' });
  // Invoice lines mirror ALL paid items (human-readable detail; amounts from the
  // server snapshot, not the client). Financial source of truth stays the
  // payment row (server-recomputed subtotal + Stripe's real fee).
  if (items.length) {
    await db.from('invoice_items').upsert(
      items.map((i, idx) => ({
        id: `ii-${payment.id}-${idx}`, invoice_id: invoiceId,
        label: i.label, amount: i.amount_cents / 100, kind: i.kind,
        ref_user_id: i.ref_user_id ?? null,
        ref_reg_ids: i.ref_reg_ids, ref_event_id: i.ref_event_id, ref_line_type: i.ref_line_type,
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
  // customer actually paid — entry/membership/change fees are always
  // whole-dollar configured amounts) was previously computed for checkout
  // display and the receipt EMAIL only, never persisted — so Purchase
  // History / the receipt PDF silently dropped it and always looked like a
  // rounded whole-dollar total. Write it as its own line so it's summed into
  // the invoice total like any other item.
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
  // mid-fulfillment throw leaves `fulfilled_at` null ⇒ Stripe's retry re-runs.
  const { data: claimed } = await db.from('payments').update({
    status: 'paid',
    stripe_payment_intent_id: piId,
    stripe_fee: stripeFeeCents,
    invoice_id: invoiceId,
    stripe_event_id: eventId,
    fulfilled_at: now,
  }).eq('id', payment.id).is('fulfilled_at', null).select('id');
  if (!claimed || claimed.length === 0) {
    console.warn('[stripe-webhook] payment finalized by a concurrent delivery; skipping once-only steps', payment.id);
    return;
  }

  // --- Winner-only, once-only side effects -----------------------------------
  // Coupon redemption bumps used_count, so it must run exactly once — pass the
  // payer so a person-restricted code (Phase 1's redeem_coupon check) validates.
  if (payment.coupon_code) {
    await db.rpc('redeem_coupon', { p_code: payment.coupon_code, p_person_id: personId });
  }
  // Email the REAL payer a receipt (best-effort; never fails fulfillment).
  try {
    await emailReceipt(db, personId, items, payment, number);
  } catch (e) {
    console.error('[stripe-webhook] receipt email failed:', e);
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

  // Only list lines that carry a charge (grouped-membership "included" lines and
  // $0 host-club lines are server-priced to 0 and would just clutter the receipt).
  const rows = items
    .filter((i) => i.amount_cents > 0)
    .map((i) => `<tr><td style="padding:6px 16px 6px 0;color:#1d2a38;">${esc(i.label)}</td>` +
      `<td style="padding:6px 0;text-align:right;white-space:nowrap;color:#1d2a38;">${fmtMoney(i.amount_cents)}</td></tr>`)
    .join('');
  const feeRow = `<tr><td style="padding:6px 16px 6px 0;color:#5b6b7a;">Service fee (card processing)</td>` +
    `<td style="padding:6px 0;text-align:right;white-space:nowrap;color:#5b6b7a;">${fmtMoney(fee)}</td></tr>`;

  const subject = 'Your United Club Gymnastics receipt';
  const html = `<div style="color:#1d2a38;font-size:15px;line-height:1.55;">
<p>Hi ${esc(forName)},</p>
<p>Thanks for your purchase. Here's your receipt for the items below.</p>
<p style="color:#5b6b7a;font-size:13px;margin:0 0 12px;">Receipt ${esc(invoiceNumber)}</p>
<table style="border-collapse:collapse;margin:8px 0;font-size:14px;">
${rows}${feeRow}
<tr><td style="padding:10px 16px 0 0;border-top:2px solid #1d2a38;font-weight:700;color:#1d2a38;">Total paid</td>
<td style="padding:10px 0 0;border-top:2px solid #1d2a38;text-align:right;font-weight:700;color:#1d2a38;">${fmtMoney(total)}</td></tr>
</table>
<p style="color:#5b6b7a;font-size:12px;">Billed to ${esc(forName)} (${esc(toEmail)}). You can re-download a PDF receipt any time from your Purchase History on the platform.</p>
</div>`;

  await sendOne({ to: `${forName} <${toEmail}>`, subject, html });
}
