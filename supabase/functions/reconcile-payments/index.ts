// reconcile-payments — admin/finance_admin reconciliation actions for two
// known Stripe<->DB drift cases (F4, spec
// docs/specs/2026-07-18-session-queue-e2e-ci-tests-freshness-recon-export-seasons.md
// §F4):
//   (a) `payments` rows stuck 'pending' (the webhook was missed/failed —
//       previously surfaced only by the daily digest, with no in-app fix).
//   (b) a refund issued directly in the Stripe Dashboard, which never
//       reflects into `payments.status` (a known, documented gap — see
//       CLAUDE.md "Refunds" section).
//
// Auth: any signed-in user with the 'admin' or 'finance_admin' role
// (user_roles), checked server-side and fail-closed — mirrors process-refund/
// manage-waitlist's authorization shape. verify_jwt STAYS TRUE (default) —
// this is NOT one of the three --no-verify-jwt functions.
//
// Three ops (single function, `op` discriminator in the body):
//   - 'scan': read-only. Returns (1) stuck-pending payments (status='pending',
//     older than 1h) and (2) refund-drift rows — `payments` status='paid'
//     within the last `days` (default 90, capped 365) whose Stripe-side
//     refund total doesn't match our `refund_requests` records
//     (`classifyPaymentDrift`, `_shared/reconciliation.ts`). Capped at ~100
//     Stripe lookups per call; sets `truncated: true` if more exist.
//   - 'refulfill': for a stuck-pending payment. WITH a Stripe session, the
//     session is re-checked server-side FIRST — fulfillment only proceeds if
//     Stripe says the session is actually paid (never trusts the stale local
//     'pending' status to imply anything about Stripe's side). Delegates to
//     the shared, idempotent `fulfillPayment` core — safe to call even if the
//     webhook actually succeeded moments before this runs (fast-path no-op).
//     For a free-order row (`stripe_session_id` null), runs the core
//     directly — there's no Stripe session to check.
//   - 'mark-refunded': reflects a CONFIRMED Stripe-side refund into the
//     payments row (`status` -> 'refunded' only for a FULL drift; `recon_note`
//     otherwise/always) after RE-VERIFYING against Stripe server-side (never
//     trusts the client's claim). Bookkeeping alignment ONLY — does not touch
//     registrations/memberships/invoices/invoice_items/refund_requests.
//
// Secrets: STRIPE_SECRET_KEY (shared). Auto-provided: SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getStripe } from '../_shared/stripe.ts';
import { fulfillPayment, type PaymentRow } from '../_shared/fulfill.ts';
import { requireAalForEnrolledCaller } from '../_shared/aal-guard.ts';
import { classifyPaymentDrift, isActionableDrift, isStuckPending, type ReconVerdict } from '../_shared/reconciliation.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

type DB = ReturnType<typeof createClient>;

const MAX_STRIPE_LOOKUPS = 100;
const DEFAULT_SCAN_DAYS = 90;
const MAX_SCAN_DAYS = 365;

interface Payload {
  op?: 'scan' | 'refulfill' | 'mark-refunded';
  days?: number;
  paymentId?: string;
  note?: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // --- Authenticate ---
  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'Missing Authorization header.' }, 401);
  const { data: userData, error: userErr } = await db.auth.getUser(token);
  if (userErr || !userData.user) return json({ error: 'Invalid or expired session.' }, 401);
  const authUserId = userData.user.id;

  // --- Authorize: admin or finance_admin only. Fail closed. ---
  const { data: roleRows, error: roleErr } = await db
    .from('user_roles')
    .select('role')
    .eq('user_id', authUserId);
  if (roleErr) return json({ error: 'Could not verify permissions.' }, 403);
  const roles = ((roleRows ?? []) as { role: string }[]).map((r) => r.role);
  if (!roles.includes('admin') && !roles.includes('finance_admin')) {
    return json({ error: 'You do not have permission to reconcile payments.' }, 403);
  }

  // Phase-B AAL guard: an MFA-enrolled caller must present an aal2 JWT.
  const aalDenied = await requireAalForEnrolledCaller(db, authUserId, token, corsHeaders);
  if (aalDenied) return aalDenied;

  let payload: Payload;
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }

  let stripe;
  try { stripe = getStripe(); } catch (e) {
    console.error('[reconcile-payments]', e);
    return json({ error: 'Payments are not configured.' }, 500);
  }

  if (payload.op === 'scan') return handleScan(db, stripe, payload.days);
  if (payload.op === 'refulfill') return handleRefulfill(db, stripe, payload.paymentId);
  if (payload.op === 'mark-refunded') return handleMarkRefunded(db, stripe, payload.paymentId, payload.note);
  return json({ error: 'op must be "scan", "refulfill", or "mark-refunded".' }, 400);
});

// ---------------------------------------------------------------------------
// scan
// ---------------------------------------------------------------------------

interface StuckPendingRow {
  id: string;
  createdAt: string;
  amountSubtotal: number | null;
  serviceFee: number | null;
  currency: string;
  personId: string | null;
  clubId: string | null;
  stripeSessionId: string | null;
}

interface DriftRow {
  id: string;
  createdAt: string;
  personId: string | null;
  totalChargedCents: number;
  ourApprovedRefundedCents: number;
  stripeRefundedCents: number;
  verdict: ReconVerdict;
}

async function handleScan(db: DB, stripe: ReturnType<typeof getStripe>, daysParam?: number) {
  const days = Math.min(MAX_SCAN_DAYS, Math.max(1, Number.isFinite(daysParam) && daysParam ? Number(daysParam) : DEFAULT_SCAN_DAYS));

  // --- (1) Stuck-pending ---
  const oneHourAgoISO = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { data: pendingRows, error: pendingErr } = await db
    .from('payments')
    .select('id, created_at, status, amount_subtotal, service_fee, currency, person_id, stripe_session_id, lines_snapshot')
    .eq('status', 'pending')
    .lt('created_at', oneHourAgoISO)
    .order('created_at', { ascending: true });
  if (pendingErr) return json({ error: 'Could not scan for stuck-pending payments.' }, 500);

  const nowMs = Date.now();
  const stuckPending: StuckPendingRow[] = ((pendingRows ?? []) as {
    id: string; created_at: string; status: string; amount_subtotal: number | null; service_fee: number | null;
    currency: string; person_id: string | null; stripe_session_id: string | null;
    lines_snapshot: { club_id?: string | null }[] | null;
  }[])
    .filter((r) => isStuckPending(r.status, r.created_at, nowMs))
    .map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      amountSubtotal: r.amount_subtotal,
      serviceFee: r.service_fee,
      currency: r.currency,
      personId: r.person_id,
      clubId: (r.lines_snapshot ?? []).find((l) => l.club_id)?.club_id ?? null,
      stripeSessionId: r.stripe_session_id,
    }));

  // --- (2) Refund drift ---
  const sinceISO = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { data: paidRows, error: paidErr } = await db
    .from('payments')
    .select('id, created_at, person_id, amount_subtotal, service_fee, stripe_payment_intent_id')
    .eq('status', 'paid')
    .gte('created_at', sinceISO)
    .not('stripe_payment_intent_id', 'is', null)
    .order('created_at', { ascending: false });
  if (paidErr) return json({ error: 'Could not scan for refund drift.' }, 500);

  const candidates = (paidRows ?? []) as {
    id: string; created_at: string; person_id: string | null;
    amount_subtotal: number | null; service_fee: number | null; stripe_payment_intent_id: string;
  }[];

  const truncated = candidates.length > MAX_STRIPE_LOOKUPS;
  const toCheck = candidates.slice(0, MAX_STRIPE_LOOKUPS);

  // Our approved-refund totals, batched in one query rather than N.
  const paymentIds = toCheck.map((c) => c.id);
  const approvedByPayment = new Map<string, number>();
  if (paymentIds.length) {
    const { data: rrRows, error: rrErr } = await db
      .from('refund_requests')
      .select('payment_id, refund_amount_cents')
      .in('payment_id', paymentIds)
      .eq('status', 'approved');
    if (rrErr) return json({ error: 'Could not load refund records for comparison.' }, 500);
    for (const rr of (rrRows ?? []) as { payment_id: string | null; refund_amount_cents: number | null }[]) {
      if (!rr.payment_id) continue;
      approvedByPayment.set(rr.payment_id, (approvedByPayment.get(rr.payment_id) ?? 0) + (rr.refund_amount_cents ?? 0));
    }
  }

  const driftRows: DriftRow[] = [];
  for (const c of toCheck) {
    let stripeRefundedCents: number;
    try {
      const charge = await retrieveChargeForPI(stripe, c.stripe_payment_intent_id);
      stripeRefundedCents = charge?.amount_refunded ?? 0;
    } catch (e) {
      console.warn('[reconcile-payments] scan: could not retrieve Stripe charge for', c.id, e instanceof Error ? e.message : String(e));
      continue; // skip — can't classify without Stripe's side; not a false positive
    }
    const totalChargedCents = (c.amount_subtotal ?? 0) + (c.service_fee ?? 0);
    const ourApprovedRefundedCents = approvedByPayment.get(c.id) ?? 0;
    const verdict = classifyPaymentDrift({ totalChargedCents, ourApprovedRefundedCents, stripeRefundedCents });
    if (verdict === 'consistent') continue;
    driftRows.push({
      id: c.id, createdAt: c.created_at, personId: c.person_id,
      totalChargedCents, ourApprovedRefundedCents, stripeRefundedCents, verdict,
    });
  }

  return json({ ok: true, stuckPending, driftRows, truncated, scannedDays: days, scannedCount: toCheck.length });
}

/** Retrieve the Charge behind a PaymentIntent (for `amount_refunded`). */
async function retrieveChargeForPI(
  stripe: ReturnType<typeof getStripe>,
  paymentIntentId: string,
): Promise<import('npm:stripe@17.7.0').Stripe.Charge | null> {
  const intent = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge'] });
  const charge = intent.latest_charge;
  if (!charge || typeof charge === 'string') return null;
  return charge;
}

// ---------------------------------------------------------------------------
// refulfill
// ---------------------------------------------------------------------------
async function handleRefulfill(db: DB, stripe: ReturnType<typeof getStripe>, paymentIdRaw?: string) {
  const paymentId = typeof paymentIdRaw === 'string' ? paymentIdRaw.trim() : '';
  if (!paymentId) return json({ error: 'paymentId is required.' }, 400);

  const { data: payRow, error: payErr } = await db
    .from('payments')
    .select('id, person_id, status, amount_subtotal, service_fee, currency, cart_item_ids, lines_snapshot, invoice_id, stripe_event_id, fulfilled_at, coupon_code, stripe_session_id')
    .eq('id', paymentId)
    .maybeSingle();
  if (payErr) return json({ error: 'Could not look up the payment.' }, 500);
  if (!payRow) return json({ error: 'Payment not found.' }, 404);
  const row = payRow as PaymentRow & { stripe_session_id: string | null };

  if (row.status !== 'pending' || row.fulfilled_at) {
    return json({ error: `This payment is not stuck-pending (status '${row.status}').` }, 409);
  }

  if (row.stripe_session_id) {
    let session;
    try {
      session = await stripe.checkout.sessions.retrieve(row.stripe_session_id, { expand: ['payment_intent.latest_charge.balance_transaction'] });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await logError(db, 'reconcile-payments:refulfill', `Could not retrieve Stripe session for payment ${paymentId}: ${message}`, { paymentId });
      return json({ error: `Could not retrieve the Stripe session: ${message}` }, 500);
    }
    if (session.payment_status !== 'paid') {
      return json({
        ok: true,
        fulfilled: false,
        verdict: session.status === 'expired' ? 'stripe-expired' : 'stripe-unpaid',
        stripePaymentStatus: session.payment_status,
        stripeSessionStatus: session.status,
      });
    }
    // M5 (mirrors stripe-webhook's `fulfill()`): reconcile what Stripe actually
    // collected against the server-written amounts before fulfilling — defense-
    // in-depth against tampering/a pricing bug. Do NOT skip this just because
    // this is a manual admin re-run; the invariant is the same either way.
    const expectedTotal = (row.amount_subtotal ?? 0) + (row.service_fee ?? 0);
    if (typeof session.amount_total === 'number' && session.amount_total !== expectedTotal) {
      await logError(
        db, 'reconcile-payments:refulfill',
        `amount mismatch: Stripe collected ${session.amount_total} but the payment row expects ${expectedTotal} (subtotal ${row.amount_subtotal} + fee ${row.service_fee})`,
        { paymentId, sessionId: row.stripe_session_id },
      );
      return json({ ok: true, fulfilled: false, verdict: 'amount-mismatch', stripeAmountTotal: session.amount_total, expectedTotal });
    }
    const piId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id ?? null;
    let stripeFeeCents: number | null = null;
    if (piId && typeof session.payment_intent !== 'string') {
      const charge = session.payment_intent?.latest_charge;
      if (charge && typeof charge !== 'string') {
        const bt = charge.balance_transaction;
        if (bt && typeof bt !== 'string') stripeFeeCents = bt.fee;
      }
    }
    try {
      await fulfillPayment(db, row, { piId, stripeFeeCents, eventId: null });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await logError(db, 'reconcile-payments:refulfill', `fulfillPayment threw for payment ${paymentId}: ${message}`, { paymentId });
      return json({ error: `Fulfillment failed: ${message}` }, 500);
    }
    return json({ ok: true, fulfilled: true });
  }

  // Free-order row (no Stripe session) — mirrors create-checkout-session's own
  // free-path guard: only ever fulfill a row that is ACTUALLY $0 total. A
  // pending row with no session but a non-zero amount is not a free order —
  // it's a broken/incomplete row, and must not be silently "fulfilled" for $0.
  const freeOrderTotal = (row.amount_subtotal ?? 0) + (row.service_fee ?? 0);
  if (freeOrderTotal !== 0) {
    return json({ error: `This payment has no Stripe session but a non-zero amount ($${(freeOrderTotal / 100).toFixed(2)}) — not a free order; cannot auto-fulfill.` }, 400);
  }
  try {
    await fulfillPayment(db, row, { piId: null, stripeFeeCents: null, eventId: null });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await logError(db, 'reconcile-payments:refulfill', `fulfillPayment (free order) threw for payment ${paymentId}: ${message}`, { paymentId });
    return json({ error: `Fulfillment failed: ${message}` }, 500);
  }
  return json({ ok: true, fulfilled: true });
}

// ---------------------------------------------------------------------------
// mark-refunded
// ---------------------------------------------------------------------------
async function handleMarkRefunded(db: DB, stripe: ReturnType<typeof getStripe>, paymentIdRaw?: string, noteRaw?: string) {
  const paymentId = typeof paymentIdRaw === 'string' ? paymentIdRaw.trim() : '';
  if (!paymentId) return json({ error: 'paymentId is required.' }, 400);
  const note = typeof noteRaw === 'string' ? noteRaw.trim().slice(0, 2000) : '';

  const { data: payRow, error: payErr } = await db
    .from('payments')
    .select('id, status, amount_subtotal, service_fee, stripe_payment_intent_id, recon_note')
    .eq('id', paymentId)
    .maybeSingle();
  if (payErr) return json({ error: 'Could not look up the payment.' }, 500);
  if (!payRow) return json({ error: 'Payment not found.' }, 404);
  const row = payRow as {
    id: string; status: string; amount_subtotal: number | null; service_fee: number | null;
    stripe_payment_intent_id: string | null; recon_note: string | null;
  };
  if (!row.stripe_payment_intent_id) {
    return json({ error: 'This payment has no Stripe payment intent on record — nothing to verify against Stripe.' }, 400);
  }

  // Re-verify against Stripe — never trust the client's claim.
  let stripeRefundedCents: number;
  try {
    const charge = await retrieveChargeForPI(stripe, row.stripe_payment_intent_id);
    stripeRefundedCents = charge?.amount_refunded ?? 0;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await logError(db, 'reconcile-payments:mark-refunded', `Could not retrieve Stripe charge for payment ${paymentId}: ${message}`, { paymentId });
    return json({ error: `Could not verify against Stripe: ${message}` }, 500);
  }

  const { data: rrRows, error: rrErr } = await db
    .from('refund_requests')
    .select('refund_amount_cents')
    .eq('payment_id', paymentId)
    .eq('status', 'approved');
  if (rrErr) return json({ error: 'Could not load refund records for comparison.' }, 500);
  const ourApprovedRefundedCents = ((rrRows ?? []) as { refund_amount_cents: number | null }[])
    .reduce((s, r) => s + (r.refund_amount_cents ?? 0), 0);

  const totalChargedCents = (row.amount_subtotal ?? 0) + (row.service_fee ?? 0);
  const verdict = classifyPaymentDrift({ totalChargedCents, ourApprovedRefundedCents, stripeRefundedCents });

  if (!isActionableDrift(verdict)) {
    return json({
      ok: false,
      error: verdict === 'consistent'
        ? 'Stripe and our records already agree — nothing to mark.'
        : 'Our records show MORE refunded than Stripe does — this needs manual investigation, not a bookkeeping note.',
      verdict,
    }, 409);
  }

  const nowISO = new Date().toISOString();
  const stamp = `[${nowISO}] Stripe shows $${(stripeRefundedCents / 100).toFixed(2)} refunded` +
    ` (our records: $${(ourApprovedRefundedCents / 100).toFixed(2)}) — reconciliation alignment only,` +
    ` registrations/memberships/invoices NOT touched.` + (note ? ` Note: ${note}` : '');
  const nextNote = row.recon_note ? `${row.recon_note}\n${stamp}` : stamp;

  const updates: Record<string, unknown> = { recon_note: nextNote };
  if (verdict === 'dashboard-refund-drift-full') updates.status = 'refunded';

  const { error: updErr } = await db.from('payments').update(updates).eq('id', paymentId);
  if (updErr) {
    await logError(db, 'reconcile-payments:mark-refunded', `Failed to write recon_note/status for payment ${paymentId}: ${updErr.message}`, { paymentId });
    return json({ error: 'Could not record the reconciliation note.' }, 500);
  }

  return json({ ok: true, verdict, statusChanged: verdict === 'dashboard-refund-drift-full', stripeRefundedCents, ourApprovedRefundedCents });
}

async function logError(db: DB, context: string, message: string, detail: Record<string, unknown>) {
  await db.from('error_logs').insert({ context, message, detail }).then(() => {}, () => {});
}
