// stripe-webhook — the SOLE source of truth that completes a payment (Phase S4,
// generalized: memberships, club memberships, meet entries, change fees, addons;
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
  invoice_id: string | null;
  stripe_event_id: string | null;
  fulfilled_at: string | null;
}
interface CartItemRow {
  id: string;
  club_id: string | null;
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
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

/** Complete a cart purchase (memberships, registrations, addons). Idempotent on
 *  the Stripe event id and on the payment row's `fulfilled_at` — a redelivered
 *  event is a no-op. */
async function fulfill(
  db: DB,
  stripe: ReturnType<typeof getStripe>,
  session: import('npm:stripe@17.7.0').Stripe.Checkout.Session,
  eventId: string,
): Promise<void> {
  const { data: payRow } = await db.from('payments')
    .select('id, person_id, status, amount_subtotal, service_fee, currency, cart_item_ids, invoice_id, stripe_event_id, fulfilled_at')
    .eq('stripe_session_id', session.id)
    .maybeSingle();
  const payment = payRow as PaymentRow | null;
  if (!payment) {
    // No row we created — nothing to fulfill (still 2xx so Stripe stops retrying).
    console.warn('[stripe-webhook] no payments row for session', session.id);
    return;
  }
  if (payment.fulfilled_at || payment.status === 'paid' || payment.stripe_event_id === eventId) {
    return; // already handled
  }
  const personId = payment.person_id;
  if (!personId) { console.warn('[stripe-webhook] payment has no person', payment.id); return; }

  // --- Stripe's actual processing fee, from the balance transaction ---
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

  // --- Load the exact cart items this payment covers ---
  const cartItemIds = payment.cart_item_ids ?? [];
  const { data: itemRows } = cartItemIds.length
    ? await db.from('cart_items')
      .select('id, club_id, label, amount, kind, ref_user_id, ref_season_id, ref_type, ref_reg_ids, ref_meet_id, ref_line_type')
      .in('id', cartItemIds)
    : { data: [] as CartItemRow[] };
  const items = (itemRows ?? []) as CartItemRow[];
  // A club cart ⇒ any item carries the club_id (person carts have it null).
  const clubId = items.find((i) => i.club_id)?.club_id ?? null;
  const now = new Date().toISOString();

  // --- Fulfill memberships + club memberships -------------------------------
  // Waiver state is resolved server-side from waiver_signatures for the TARGET
  // person: signed ⇒ active, else pending-waiver. paid_via reflects who paid
  // (card for a self cart, club for a club cart); the club-cart hold is cleared.
  for (const item of items) {
    if (item.kind !== 'membership' || !item.ref_season_id) continue;
    const seasonId = item.ref_season_id;

    if (item.ref_type === 'club') {
      if (!clubId) continue;
      const { data: existingCm } = await db.from('club_memberships')
        .select('id').eq('club_id', clubId).eq('season_id', seasonId).eq('status', 'active').maybeSingle();
      if (!existingCm) {
        await db.from('club_memberships').insert({
          id: crypto.randomUUID(),
          club_id: clubId, season_id: seasonId,
          status: 'active', granted_by_admin: false, created_at: now,
        });
      }
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
    }
  }

  // --- Flip the paid registrations (meet entries + change fees) -------------
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
  if (!payment.invoice_id) {
    const { count } = await db.from('invoices').select('id', { count: 'exact', head: true });
    number = `UCG-2026-${String((count ?? 0) + 1).padStart(4, '0')}`;
  } else {
    const { data: existingInv } = await db.from('invoices').select('number').eq('id', invoiceId).maybeSingle();
    number = (existingInv as { number?: string } | null)?.number ?? `UCG-${payment.id}`;
  }
  await db.from('invoices').upsert({
    id: invoiceId, number,
    club_id: clubId, athlete_id: clubId ? null : personId,
    coupon_code: null, created_at: now, paid_at: now,
    stripe_payment_intent_id: piId, stripe_fee: stripeFeeCents,
  }, { onConflict: 'id' });
  // Invoice lines mirror ALL paid cart items (human-readable detail). The
  // financial source of truth stays the payment row (server-recomputed subtotal
  // + Stripe's real fee) — these per-line amounts are display.
  if (items.length) {
    await db.from('invoice_items').upsert(
      items.map((i, idx) => ({
        id: `ii-${payment.id}-${idx}`, invoice_id: invoiceId,
        label: i.label, amount: i.amount, kind: i.kind,
        ref_user_id: i.ref_user_id ?? null,
        ref_season_id: i.ref_season_id, ref_type: i.ref_type,
        ref_reg_ids: i.ref_reg_ids, ref_meet_id: i.ref_meet_id, ref_line_type: i.ref_line_type,
        refunded: false,
      })),
      { onConflict: 'id' },
    );
  }

  // --- Clear the paid cart lines ---
  if (cartItemIds.length) {
    await db.from('cart_items').delete().in('id', cartItemIds);
  }

  // --- Flip the payment row to paid (records the event id for idempotency) ---
  await db.from('payments').update({
    status: 'paid',
    stripe_payment_intent_id: piId,
    stripe_fee: stripeFeeCents,
    invoice_id: invoiceId,
    stripe_event_id: eventId,
    fulfilled_at: now,
  }).eq('id', payment.id);

  // --- Email the REAL payer a receipt (best-effort; never fails fulfillment) ---
  // Payer = payment.person_id (the manager for a club cart).
  try {
    await emailReceipt(db, personId, items, payment, number);
  } catch (e) {
    console.error('[stripe-webhook] receipt email failed:', e);
  }
}

/** Email the payer their confirmation + HTML receipt. Recipient is the payer's
 *  own people.email (resolved server-side). Mirrors `send-receipt`'s template. */
async function emailReceipt(
  db: DB,
  personId: string,
  items: CartItemRow[],
  payment: PaymentRow,
  invoiceNumber: string,
): Promise<void> {
  const { data: p } = await db.from('people')
    .select('first_name, last_name, email').eq('id', personId).maybeSingle();
  const person = p as { first_name?: string; last_name?: string; email?: string } | null;
  const toEmail = (person?.email ?? '').trim();
  if (!EMAIL_RE.test(toEmail)) return;
  const forName = `${person?.first_name ?? ''} ${person?.last_name ?? ''}`.trim() || 'Member';

  const subtotal = payment.amount_subtotal ?? items.reduce((s, i) => s + Math.round(i.amount * 100), 0);
  const fee = payment.service_fee ?? 0;
  const total = subtotal + fee;

  const rows = items
    .map((i) => `<tr><td style="padding:6px 16px 6px 0;color:#1d2a38;">${esc(i.label)}</td>` +
      `<td style="padding:6px 0;text-align:right;white-space:nowrap;color:#1d2a38;">${fmtMoney(Math.round(i.amount * 100))}</td></tr>`)
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
