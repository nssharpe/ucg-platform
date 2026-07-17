// process-refund — refund review/processing (event-mgmt v2 Phase 3, spec §H,
// T6). Approves or rejects a `refund_requests` row (T4 migration; T5's
// request-refund is the only inserter). Approving computes the refund amount,
// calls the Stripe Refunds API against the ORIGINAL payment intent, and
// applies the registration/invoice_item state change.
//
// Auth: any signed-in user with the 'refund_manager' or 'admin' role
// (user_roles), checked server-side and fail-closed — never trusted from the
// client. verify_jwt STAYS TRUE (default) — this is NOT one of the three
// --no-verify-jwt functions (stripe-webhook, sms-webhook,
// notify-manager-access-denied).
//
// Money-critical — ordering matters:
//   1. Load + validate the request/item/event/payment (400s only, no writes).
//   2. Atomically CLAIM the request (status pending -> approved/rejected,
//      conditional on status='pending') BEFORE calling Stripe, so a second
//      concurrent reviewer/retry can't double-process.
//   3. Only THEN call Stripe. On any Stripe failure, best-effort REVERT the
//      claim back to 'pending' so the request can be retried, and log to
//      error_logs (there is no remote function-log access for this project).
//   4. After a successful refund (or a capped-$0 approve with no Stripe call),
//      apply the invoice_item/registration state change and send emails —
//      both best-effort; the money movement (or lack of it) is already final.
//
// Secrets: STRIPE_SECRET_KEY, RESEND_API_KEY, RESEND_FROM, APP_PUBLIC_URL
// (shared/optional with sane fallbacks). Auto-provided: SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getStripe } from '../_shared/stripe.ts';
import { sendBatch, sendOne, type EmailMessage } from '../_shared/resend.ts';
import { renderEmail } from '../_shared/email-layout.ts';
import { requireAalForEnrolledCaller } from '../_shared/aal-guard.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmtMoney = (cents: number) => `$${(cents / 100).toFixed(2)}`;

type DB = ReturnType<typeof createClient>;

interface Payload {
  requestId?: string;
  action?: 'approve' | 'reject';
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

  // --- Authorize: refund_manager or admin only. Fail closed. ---
  const { data: roleRows, error: roleErr } = await db
    .from('user_roles')
    .select('role')
    .eq('user_id', authUserId);
  if (roleErr) return json({ error: 'Could not verify permissions.' }, 403);
  const roles = ((roleRows ?? []) as { role: string }[]).map((r) => r.role);
  if (!roles.includes('refund_manager') && !roles.includes('admin')) {
    return json({ error: 'You do not have permission to review refund requests.' }, 403);
  }

  // Phase-B AAL guard: an MFA-enrolled caller must present an aal2 JWT.
  const aalDenied = await requireAalForEnrolledCaller(db, authUserId, token, corsHeaders);
  if (aalDenied) return aalDenied;

  // --- Resolve the caller's own person row (reviewed_by; fail closed) ---
  const { data: caller, error: callerErr } = await db
    .from('people')
    .select('id, email, first_name, last_name')
    .eq('auth_user_id', authUserId)
    .maybeSingle();
  if (callerErr) return json({ error: 'Could not verify your account.' }, 403);
  if (!caller) return json({ error: 'No profile is linked to your account.' }, 403);

  // --- Validate payload ---
  let payload: Payload;
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }
  const requestId = typeof payload.requestId === 'string' ? payload.requestId.trim() : '';
  const action = payload.action;
  if (!requestId) return json({ error: 'requestId is required.' }, 400);
  if (action !== 'approve' && action !== 'reject') return json({ error: 'action must be "approve" or "reject".' }, 400);

  const { data: reqRow, error: reqErr } = await db
    .from('refund_requests')
    .select('id, kind, reg_id, invoice_item_id, payment_id, event_id, requester_person_id, status')
    .eq('id', requestId)
    .maybeSingle();
  if (reqErr) return json({ error: 'Could not look up the refund request.' }, 500);
  if (!reqRow) return json({ error: 'Refund request not found.' }, 404);
  const request = reqRow as {
    id: string; kind: 'registration' | 'addon'; reg_id: string | null; invoice_item_id: string | null;
    payment_id: string | null; event_id: string; requester_person_id: string; status: string;
  };
  if (request.status !== 'pending') {
    return json({ error: 'This request has already been reviewed.' }, 409);
  }

  if (action === 'reject') return handleReject(db, request, caller);
  return handleApprove(db, request, caller);
});

// ---------------------------------------------------------------------------
// Reject
// ---------------------------------------------------------------------------
async function handleReject(
  db: DB,
  request: { id: string; kind: 'registration' | 'addon'; reg_id: string | null; requester_person_id: string },
  caller: { id: string; email: string; first_name: string; last_name: string },
) {
  const reviewedAt = new Date().toISOString();
  const { data: claimed, error: claimErr } = await db
    .from('refund_requests')
    .update({ status: 'rejected', reviewed_by: caller.id, reviewed_at: reviewedAt })
    .eq('id', request.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();
  if (claimErr) return json({ error: 'Could not record the decision.' }, 500);
  if (!claimed) return json({ error: 'This request has already been reviewed.' }, 409);

  if (request.kind === 'registration' && request.reg_id) {
    const { error: flagErr } = await db.from('registrations').update({ refund_requested: false }).eq('id', request.reg_id);
    if (flagErr) console.warn('process-refund: failed to clear registration.refund_requested', flagErr.message);
  }

  try {
    await sendRejectEmails(db, { requesterId: request.requester_person_id, requestId: request.id });
  } catch (e) {
    console.warn('process-refund: reject email failed', e instanceof Error ? e.message : String(e));
  }

  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Approve
// ---------------------------------------------------------------------------
async function handleApprove(
  db: DB,
  request: {
    id: string; kind: 'registration' | 'addon'; reg_id: string | null; invoice_item_id: string | null;
    payment_id: string | null; event_id: string; requester_person_id: string;
  },
  caller: { id: string; email: string; first_name: string; last_name: string },
) {
  // --- a. Load the invoice item, event, and (if any) payment. No writes yet. ---
  if (!request.invoice_item_id) {
    return json({ error: 'This request has no linked purchase line — cannot auto-process.' }, 400);
  }
  const { data: itemRow, error: itemErr } = await db
    .from('invoice_items')
    .select('id, invoice_id, label, amount, refunded')
    .eq('id', request.invoice_item_id)
    .maybeSingle();
  if (itemErr) return json({ error: 'Could not look up the purchased item.' }, 500);
  if (!itemRow) return json({ error: 'The purchased item no longer exists.' }, 400);
  const item = itemRow as { id: string; invoice_id: string; label: string; amount: number; refunded: boolean };
  if (item.refunded) return json({ error: 'This item has already been refunded.' }, 400);

  const { data: eventRow, error: eventErr } = await db
    .from('events')
    .select('id, name, last_date_to_edit')
    .eq('id', request.event_id)
    .maybeSingle();
  if (eventErr) return json({ error: 'Could not look up the event.' }, 500);
  if (!eventRow) return json({ error: 'Event not found.' }, 404);
  const event = eventRow as { id: string; name: string; last_date_to_edit: string | null };

  let payment: {
    id: string; amount_subtotal: number | null; stripe_payment_intent_id: string | null;
    lines_snapshot: { label?: string; amount_cents?: number; paid_cents?: number }[] | null;
  } | null = null;
  if (request.payment_id) {
    const { data: payRow, error: payErr } = await db
      .from('payments')
      .select('id, amount_subtotal, stripe_payment_intent_id, lines_snapshot')
      .eq('id', request.payment_id)
      .maybeSingle();
    if (payErr) return json({ error: 'Could not look up the payment.' }, 500);
    payment = payRow as typeof payment;
  }

  // --- b. No traceable payment (host-club $0 entry, or a legacy purchase) ---
  if (!request.payment_id || !payment) {
    return json({
      error: 'This item has no traceable payment (likely a $0 host-club entry or a legacy purchase) — cannot auto-process. Handle it manually in the Stripe Dashboard, then reject or leave this request for record-keeping.',
    }, 400);
  }

  // --- c. Compute the refund: mirrors src/lib/pricing.ts refundAmountCents
  //     exactly (100% at-or-before event.last_date_to_edit, else 75%, rounded
  //     to the nearest cent). The service fee is never part of the base, so
  //     it's never refunded either.
  //
  //     Refund BASE: the snapshot line's POST-discount `paid_cents` when the
  //     payment's lines_snapshot carries it (written by create-checkout-session
  //     since T6) — `invoice_items.amount` / snapshot `amount_cents` are the
  //     PRE-coupon list price, and refunding that for a partially-couponed
  //     line would take other lines' money with it (e.g. a $135 entry
  //     discounted to $85 + a $30 shirt → amount_subtotal $115; a $135 base
  //     capped only at the payment level still pays $115 for an $85 line).
  //     Legacy payments without paid_cents keep the invoice_item amount as
  //     the base; the payment-level cap in (d) stays the final guard in ALL
  //     cases. The invoice_item is mapped back to its snapshot line via
  //     fulfill.ts's deterministic id scheme `ii-${payment.id}-${idx}` (idx =
  //     snapshot index), validated in-range + label-matched. ---
  const reviewedAt = new Date().toISOString();
  let baseAmountCents = Math.round(Number(item.amount) * 100);
  const snapshot = payment.lines_snapshot;
  if (snapshot && item.id.startsWith(`ii-${payment.id}-`)) {
    const idxStr = item.id.slice(`ii-${payment.id}-`.length);
    const idx = /^\d+$/.test(idxStr) ? Number(idxStr) : NaN;
    const line = Number.isInteger(idx) && idx >= 0 && idx < snapshot.length ? snapshot[idx] : null;
    if (line && line.label === item.label && typeof line.paid_cents === 'number') {
      baseAmountCents = line.paid_cents;
    }
  }
  const onTime = !event.last_date_to_edit || new Date(reviewedAt).getTime() <= new Date(event.last_date_to_edit).getTime();
  const computedRefundCents = onTime ? baseAmountCents : Math.round(baseAmountCents * 0.75);

  // --- d. Cap at what's actually left on the payment (mirrors
  //     src/lib/pricing.ts capRefundCents — availableCents = amount_subtotal
  //     minus refund_amount_cents already approved against this SAME payment). ---
  const { data: priorApprovedRows, error: priorErr } = await db
    .from('refund_requests')
    .select('refund_amount_cents')
    .eq('payment_id', payment.id)
    .eq('status', 'approved');
  if (priorErr) return json({ error: 'Could not compute the available refund amount.' }, 500);
  const priorRefundedCents = ((priorApprovedRows ?? []) as { refund_amount_cents: number | null }[])
    .reduce((s, r) => s + (r.refund_amount_cents ?? 0), 0);
  const availableCents = (payment.amount_subtotal ?? 0) - priorRefundedCents;
  const refundCents = Math.min(computedRefundCents, Math.max(0, availableCents));

  // --- e. Atomic claim BEFORE Stripe. ---
  const { data: claimed, error: claimErr } = await db
    .from('refund_requests')
    .update({ status: 'approved', reviewed_by: caller.id, reviewed_at: reviewedAt, refund_amount_cents: refundCents })
    .eq('id', request.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();
  if (claimErr) return json({ error: 'Could not record the decision.' }, 500);
  if (!claimed) return json({ error: 'This request has already been reviewed.' }, 409);

  let stripeRefundId: string | null = null;
  if (refundCents > 0) {
    if (!payment.stripe_payment_intent_id) {
      // Revert the claim — nothing was charged/refunded, so this must stay
      // reviewable rather than silently landing as a phantom "approved".
      await revertClaim(db, request.id);
      return json({
        error: 'This payment has no Stripe payment intent on record — cannot auto-process. Handle it manually in the Stripe Dashboard.',
      }, 400);
    }
    try {
      const stripe = getStripe();
      const refund = await stripe.refunds.create({
        payment_intent: payment.stripe_payment_intent_id,
        amount: refundCents,
      });
      stripeRefundId = refund.id;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const reverted = await revertClaim(db, request.id);
      await db.from('error_logs').insert({
        context: 'process-refund',
        message: reverted
          ? `Stripe refund failed, claim reverted to pending: ${message}`
          : `Stripe refund failed AND reverting the claim also failed — request ${request.id} is STUCK in 'approved' with no Stripe refund. Needs manual fix. Underlying error: ${message}`,
        detail: { requestId: request.id, paymentId: payment.id, refundCents },
      }).then(() => {}, () => {});
      return json({ error: `Could not process the Stripe refund: ${message}` }, 500);
    }
  }
  // refundCents === 0 (e.g. a free $0-total order): no Stripe call needed —
  // the participant paid $0, so $0 back is correct. stripeRefundId stays null.

  if (stripeRefundId) {
    const { error: stampErr } = await db.from('refund_requests').update({ stripe_refund_id: stripeRefundId }).eq('id', request.id);
    if (stampErr) console.warn('process-refund: failed to stamp stripe_refund_id', stampErr.message);
  }

  // --- f. Item/registration state change. Best-effort from here on — the
  //     money movement (or deliberate non-movement) above is already final;
  //     a failure here is logged, not surfaced as a request failure. ---
  try {
    const { error: itemUpdErr } = await db.from('invoice_items').update({ refunded: true }).eq('id', item.id);
    if (itemUpdErr) throw new Error(`invoice_items update failed: ${itemUpdErr.message}`);

    if (request.kind === 'registration' && request.reg_id) {
      const { data: regRow, error: regErr } = await db
        .from('registrations')
        .select('id, apparatus')
        .eq('id', request.reg_id)
        .maybeSingle();
      if (regErr) throw new Error(`registration lookup failed: ${regErr.message}`);
      if (regRow) {
        if (onTime) {
          // Fully removed. `scores` cascade-deletes via its `reg_id` FK
          // (on delete cascade); `squad_id` is a plain FK ON registrations
          // itself (not an embedded jsonb list elsewhere), so no separate
          // squad cleanup is needed — the row disappearing IS the cleanup.
          const { error: delErr } = await db.from('registrations').delete().eq('id', request.reg_id);
          if (delErr) throw new Error(`registration delete failed: ${delErr.message}`);
        } else {
          // Kept, blanked (matches MyRegistrations.tsx's "retain-but-blank"
          // shape for a fully-deselected discipline: apparatus: [], no
          // apparatus_levels/partner).
          const { error: updErr } = await db.from('registrations').update({
            refunded: true, keep_listed: true, refund_requested: false,
            apparatus: [], apparatus_levels: null, partner_athlete_id: null,
          }).eq('id', request.reg_id);
          if (updErr) throw new Error(`registration update failed: ${updErr.message}`);
        }
      }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db.from('error_logs').insert({
      context: 'process-refund',
      message: `Refund succeeded (refund ${stripeRefundId ?? '$0/none'}) but the item/registration state update failed: ${message}`,
      detail: { requestId: request.id, itemId: item.id, regId: request.reg_id },
    }).then(() => {}, () => {});
  }

  // --- g. Emails (best-effort). ---
  try {
    await sendApproveEmails(db, {
      requesterId: request.requester_person_id, itemLabel: item.label, eventName: event.name,
      refundCents, onTime, kind: request.kind,
    });
  } catch (e) {
    console.warn('process-refund: approve email failed', e instanceof Error ? e.message : String(e));
  }

  return json({ ok: true, refundAmountCents: refundCents, stripeRefundId });
}

/** Best-effort revert of an approve claim back to 'pending' so it can be
 *  retried. Returns whether the revert itself succeeded (for error_logs). */
async function revertClaim(db: DB, requestId: string): Promise<boolean> {
  const { error } = await db.from('refund_requests').update({
    status: 'pending', reviewed_by: null, reviewed_at: null, refund_amount_cents: null,
  }).eq('id', requestId).eq('status', 'approved');
  return !error;
}

// ---------------------------------------------------------------------------
// Emails
// ---------------------------------------------------------------------------
async function reviewerRecipients(db: DB): Promise<{ email: string; first_name: string; last_name: string }[]> {
  const { data: rmRoles } = await db.from('user_roles').select('user_id').eq('role', 'refund_manager');
  const ids = ((rmRoles ?? []) as { user_id: string }[]).map((r) => r.user_id);
  if (ids.length === 0) return [];
  const { data: reviewers } = await db.from('people').select('email, first_name, last_name').in('auth_user_id', ids);
  return ((reviewers ?? []) as { email: string; first_name: string; last_name: string }[])
    .filter((p) => typeof p.email === 'string' && EMAIL_RE.test(p.email.trim()));
}

async function sendRejectEmails(db: DB, opts: { requesterId: string; requestId: string }) {
  const { data: requester } = await db.from('people').select('email, first_name, last_name')
    .eq('id', opts.requesterId).maybeSingle();
  const r = requester as { email: string; first_name: string; last_name: string } | null;
  if (!r || !r.email || !EMAIL_RE.test(r.email)) return;

  const html = renderEmail({
    heading: 'Refund request reviewed',
    bodyHtml: `<p>Hi ${esc(r.first_name)},</p>
<p>We reviewed your refund request and it was <strong>not approved</strong>. Your registration/item is unchanged.</p>
<p>If you have questions, reply to this email and a league refund manager will follow up.</p>`,
  });
  await sendOne({ to: `${r.first_name} ${r.last_name} <${r.email}>`, subject: 'Refund request — not approved', html })
    .catch((e) => console.warn('process-refund: requester reject email failed', e instanceof Error ? e.message : String(e)));

  const recipients = await reviewerRecipients(db);
  if (recipients.length === 0) return;
  const summaryHtml = renderEmail({
    heading: 'Refund request rejected',
    bodyHtml: `<p><strong>${esc(`${r.first_name} ${r.last_name}`)}</strong>'s refund request was reviewed and rejected. No item/registration change was made.</p>`,
  });
  const messages: EmailMessage[] = recipients.map((p) => ({
    to: `${p.first_name} ${p.last_name} <${p.email.trim()}>`, subject: 'Refund request rejected', html: summaryHtml,
  }));
  await sendBatch(messages);
}

async function sendApproveEmails(db: DB, opts: {
  requesterId: string; itemLabel: string; eventName: string; refundCents: number; onTime: boolean; kind: 'registration' | 'addon';
}) {
  const { requesterId, itemLabel, eventName, refundCents, onTime, kind } = opts;
  const { data: requester } = await db.from('people').select('email, first_name, last_name').eq('id', requesterId).maybeSingle();
  const r = requester as { email: string; first_name: string; last_name: string } | null;

  const retainedLine = !onTime
    ? '<p style="margin-top:12px;">25% was retained per policy for a refund requested after the event\'s edit deadline. The athlete can no longer compete in this discipline — their name may still appear in printed event materials.</p>'
    : (kind === 'registration' ? '<p style="margin-top:12px;">The registration has been fully removed.</p>' : '');
  const bodyHtml = `<p>Hi ${r ? esc(r.first_name) : 'there'},</p>
<p>Your refund request for <strong>${esc(itemLabel)}</strong> — <strong>${esc(eventName)}</strong> was approved.</p>
<p><strong>Amount refunded:</strong> ${fmtMoney(refundCents)}</p>
<p>Refunds return to the original payment method (the club's card for a club-paid entry).</p>
${retainedLine}
<p style="margin-top:12px;">This refund is reflected in your purchase history under MY UCG purchases.</p>`;

  if (r && r.email && EMAIL_RE.test(r.email)) {
    const html = renderEmail({ heading: 'Refund processed', bodyHtml });
    await sendOne({ to: `${r.first_name} ${r.last_name} <${r.email}>`, subject: `Refund processed — ${eventName}`, html })
      .catch((e) => console.warn('process-refund: requester approve email failed', e instanceof Error ? e.message : String(e)));
  }

  const recipients = await reviewerRecipients(db);
  if (recipients.length === 0) return;
  const summaryHtml = renderEmail({
    heading: 'Refund processed',
    bodyHtml: `<p><strong>${r ? esc(`${r.first_name} ${r.last_name}`) : 'A member'}</strong>'s refund request for <strong>${esc(itemLabel)}</strong> — ${esc(eventName)} was approved and processed.</p>
<p><strong>Amount refunded:</strong> ${fmtMoney(refundCents)}</p>`,
  });
  const messages: EmailMessage[] = recipients.map((p) => ({
    to: `${p.first_name} ${p.last_name} <${p.email.trim()}>`, subject: `Refund processed — ${eventName}`, html: summaryHtml,
  }));
  await sendBatch(messages);
}
