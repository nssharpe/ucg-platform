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
import { fulfillPayment, type PaymentRow } from '../_shared/fulfill.ts';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

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
        const { data: failedRows } = await db.from('payments')
          .update({ status: 'failed', stripe_event_id: event.id })
          .eq('stripe_session_id', session.id)
          .is('fulfilled_at', null)
          .select('id');
        // M1: a session that expires or fails to pay never redeemed its
        // coupon — release the reservation so the slot doesn't sit held for
        // up to its full 60-minute lifetime. Idempotent no-op if there was
        // no coupon (or it was already released/redeemed).
        for (const row of failedRows ?? []) {
          await db.rpc('release_coupon_reservation', { p_payment_id: (row as { id: string }).id })
            .then(() => {}, () => {});
        }
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

/** Complete a cart purchase from a Stripe checkout session: reconciles what
 *  Stripe actually collected against the server-written payment row (M5),
 *  retrieves Stripe's real processing fee from the balance transaction, and
 *  delegates the actual fulfillment (membership activation, registration
 *  flip, invoice, coupon redemption, receipt) to the shared
 *  `fulfillPayment` core (`_shared/fulfill.ts`) — the exact same core the
 *  free ($0-total) checkout path in `create-checkout-session` uses. */
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
  // `fulfillPayment`'s conditional claim at the very end is.
  if (payment.status === 'paid' || payment.fulfilled_at) return;

  // --- M5: reconcile what Stripe actually collected against the server-written
  //     amounts (defense-in-depth against tampering / a pricing bug). Stripe-
  //     session-specific — the free ($0-total) path has no Stripe session and
  //     instead asserts its snapshot total is exactly 0 before fulfilling. ---
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

  await fulfillPayment(db, payment, { piId, stripeFeeCents, eventId });
}
