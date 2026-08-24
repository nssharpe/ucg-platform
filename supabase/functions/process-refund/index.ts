// process-refund — refund review/processing (event-mgmt v2 Phase 3, spec §H,
// T6; grouped-per-registration rewrite: UAT Z-04-01/02/03 + Nate's Z-04 note,
// 2026-08-21). Approves or rejects an entire `request_group_id` GROUP of
// `refund_requests` rows (T4 migration `20260710212356`; T4b
// `20260821150000` added `request_group_id`/`rejection_reason` — T5's
// request-refund is the only inserter). Approving computes the refund
// amount PER PAYMENT the group references, calls the Stripe Refunds API
// against each payment's own PaymentIntent, and applies ONE
// registration/invoice_item state change for the whole group.
//
// Auth: any signed-in user with the 'refund_manager' or 'admin' role
// (user_roles), checked server-side and fail-closed — never trusted from the
// client. verify_jwt STAYS TRUE (default) — this is NOT one of the three
// --no-verify-jwt functions (stripe-webhook, sms-webhook,
// notify-manager-access-denied).
//
// UAT Z-04 confirmed business rules implemented here:
//   1+2. A registration refund can span MULTIPLE payments (an original entry
//        invoice + a later "add discipline" invoice) — every payment in the
//        group is refunded, sequentially, each capped/claimed independently
//        via `claim_refund_approval` (never batched into one claim call).
//   3.   The service fee is never refunded — `claim_refund_approval` caps at
//        `amount_subtotal`, unchanged.
//   4.   75% after the event's `last_date_to_edit`, applied PER PAYMENT via
//        `allocateRegistrationRefund` (`_shared/refund-allocation.ts`).
//   5.   Add-ons are always 100% here — a past-deadline add-on was already
//        refused at REQUEST time (request-refund), so by construction every
//        pending add-on request that reaches approval is still in-window.
//   6.   Reject requires a free-text `rejectionReason`, stored and emailed.
//
// Money-critical — ordering matters, same shape as before but per-payment:
//   1. Load every row in the group (400s only, no writes).
//   2. For EACH payment the group's still-pending rows reference: atomically
//      CLAIM one representative ("carrier") row for that payment via
//      `claim_refund_approval` (status pending -> approved, capped at the
//      payment's remaining subtotal) BEFORE calling Stripe for that payment.
//      Any OTHER pending row sharing the same payment is then flipped to
//      'approved' with refund_amount_cents=0 (the money is fully attributed
//      to the carrier row; `claim_refund_approval` itself is never asked to
//      claim more than one row at a time — "call it once per distinct
//      payment", unchanged).
//   3. Only THEN call Stripe for that payment. On Stripe failure, best-effort
//      REVERT that payment's claim (carrier + any zero-cost siblings) back to
//      'pending' so it can be retried, log to error_logs, and CONTINUE to the
//      next payment — one payment's Stripe failure must not abandon the
//      others.
//   4. Only once EVERY payment in the group succeeded: apply the
//      registration/invoice_item state change (remove/blank), matching the
//      pre-existing on-time/past-deadline behavior. A partial failure leaves
//      the registration untouched and its still-pending rows retryable by a
//      later approve call on the same group.
//
// Secrets: STRIPE_SECRET_KEY, RESEND_API_KEY, RESEND_FROM, APP_PUBLIC_URL
// (shared/optional with sane fallbacks). Auto-provided: SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getStripe } from '../_shared/stripe.ts';
import { sendBatch, sendOne, type EmailMessage } from '../_shared/resend.ts';
import { renderEmail } from '../_shared/email-layout.ts';
import { requireAalForEnrolledCaller } from '../_shared/aal-guard.ts';
import { allocateRegistrationRefund, type RefundAllocationLine } from '../_shared/refund-allocation.ts';

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
  groupId?: string;
  action?: 'approve' | 'reject';
  rejectionReason?: string;
}

interface GroupRow {
  id: string;
  kind: 'registration' | 'addon';
  reg_id: string | null;
  invoice_item_id: string | null;
  payment_id: string | null;
  event_id: string;
  requester_person_id: string;
  status: 'pending' | 'approved' | 'rejected';
  request_group_id: string;
  created_at: string;
}

interface RefundedEntry { paymentId: string; cents: number; stripeRefundId: string | null }
interface FailedEntry { paymentId: string; error: string }

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
  const action = payload.action;
  if (action !== 'approve' && action !== 'reject') return json({ error: 'action must be "approve" or "reject".' }, 400);
  const rejectionReason = typeof payload.rejectionReason === 'string' ? payload.rejectionReason.trim() : '';
  if (action === 'reject' && !rejectionReason) {
    return json({ error: 'A rejection reason is required.' }, 400);
  }

  // --- Resolve the group id (either passed directly, or via a single row's
  // own id — kept for any caller that still only knows a row id). ---
  let groupId = typeof payload.groupId === 'string' ? payload.groupId.trim() : '';
  const requestId = typeof payload.requestId === 'string' ? payload.requestId.trim() : '';
  if (!groupId && !requestId) return json({ error: 'groupId (or requestId) is required.' }, 400);
  if (!groupId) {
    const { data: byId, error: byIdErr } = await db
      .from('refund_requests')
      .select('request_group_id')
      .eq('id', requestId)
      .maybeSingle();
    if (byIdErr) return json({ error: 'Could not look up the refund request.' }, 500);
    if (!byId) return json({ error: 'Refund request not found.' }, 404);
    groupId = (byId as { request_group_id: string }).request_group_id;
  }

  const { data: groupRows, error: groupErr } = await db
    .from('refund_requests')
    .select('id, kind, reg_id, invoice_item_id, payment_id, event_id, requester_person_id, status, request_group_id, created_at')
    .eq('request_group_id', groupId);
  if (groupErr) return json({ error: 'Could not look up the refund request.' }, 500);
  const rows = (groupRows ?? []) as GroupRow[];
  if (rows.length === 0) return json({ error: 'Refund request not found.' }, 404);
  const kind = rows[0].kind;

  if (action === 'reject') return handleReject(db, groupId, rows, kind, rejectionReason, caller);
  return handleApprove(db, groupId, rows, kind, caller);
});

// ---------------------------------------------------------------------------
// Reject
// ---------------------------------------------------------------------------
async function handleReject(
  db: DB,
  groupId: string,
  rows: GroupRow[],
  kind: 'registration' | 'addon',
  rejectionReason: string,
  caller: { id: string; email: string; first_name: string; last_name: string },
) {
  const pending = rows.filter((r) => r.status === 'pending');
  if (pending.length === 0) return json({ error: 'This request has already been reviewed.' }, 409);

  const reviewedAt = new Date().toISOString();
  const { data: claimed, error: updErr } = await db
    .from('refund_requests')
    .update({ status: 'rejected', reviewed_by: caller.id, reviewed_at: reviewedAt, rejection_reason: rejectionReason })
    .eq('request_group_id', groupId)
    .eq('status', 'pending')
    .select('id');
  if (updErr) return json({ error: 'Could not record the decision.' }, 500);
  if (!claimed || claimed.length === 0) return json({ error: 'This request has already been reviewed.' }, 409);

  const regId = rows.find((r) => r.reg_id)?.reg_id ?? null;
  if (kind === 'registration' && regId) {
    const { error: flagErr } = await db.from('registrations').update({ refund_requested: false }).eq('id', regId);
    if (flagErr) console.warn('process-refund: failed to clear registration.refund_requested', flagErr.message);
  }

  try {
    await sendRejectEmails(db, { requesterId: rows[0].requester_person_id, rejectionReason });
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
  groupId: string,
  rows: GroupRow[],
  kind: 'registration' | 'addon',
  caller: { id: string; email: string; first_name: string; last_name: string },
) {
  const pending = rows.filter((r) => r.status === 'pending');
  if (pending.length === 0) return json({ error: 'This request has already been reviewed.' }, 409);

  const { data: eventRow, error: eventErr } = await db
    .from('events')
    .select('id, name, last_date_to_edit')
    .eq('id', rows[0].event_id)
    .maybeSingle();
  if (eventErr) return json({ error: 'Could not look up the event.' }, 500);
  if (!eventRow) return json({ error: 'Event not found.' }, 404);
  const event = eventRow as { id: string; name: string; last_date_to_edit: string | null };
  const reviewedAt = new Date().toISOString();
  // Rule 5: add-ons are always 100% here (a past-deadline add-on never gets
  // this far — request-refund refuses it up front). Rule 4: registrations
  // scale to 75% after the event's edit deadline.
  // The 100%-vs-75% cutoff is judged at REQUEST time, not review time (Nate,
  // 2026-08-23): the athlete controls when they ask, not how fast the review
  // happens — a slow review must not cost them 25%. The group's earliest
  // created_at is the request moment (all rows in a group are inserted
  // together by request-refund).
  const requestedAt = rows.reduce((min, r) => (r.created_at < min ? r.created_at : min), rows[0].created_at);
  const onTime = kind === 'addon'
    || !event.last_date_to_edit
    || new Date(requestedAt).getTime() <= new Date(event.last_date_to_edit).getTime();

  // --- Load every pending row's invoice_item + payment (no writes yet). ---
  const itemIds = pending.map((r) => r.invoice_item_id).filter((id): id is string => !!id);
  const paymentIds = Array.from(new Set(pending.map((r) => r.payment_id).filter((id): id is string => !!id)));
  if (itemIds.length === 0 || paymentIds.length === 0) {
    return json({ error: 'This request has no linked purchase line — cannot auto-process.' }, 400);
  }
  const { data: itemRows, error: itemErr } = await db
    .from('invoice_items')
    .select('id, invoice_id, label, amount, ref_line_type, refunded')
    .in('id', itemIds);
  if (itemErr) return json({ error: 'Could not look up the purchased item(s).' }, 500);
  const itemsById = new Map(((itemRows ?? []) as
    { id: string; invoice_id: string; label: string; amount: number; ref_line_type: string | null; refunded: boolean }[])
    .map((i) => [i.id, i]));

  const { data: payRows, error: payErr } = await db
    .from('payments')
    .select('id, amount_subtotal, stripe_payment_intent_id, lines_snapshot')
    .in('id', paymentIds);
  if (payErr) return json({ error: 'Could not look up the payment(s).' }, 500);
  const paymentsById = new Map(((payRows ?? []) as
    { id: string; amount_subtotal: number | null; stripe_payment_intent_id: string | null; lines_snapshot: { label?: string; amount_cents?: number; paid_cents?: number }[] | null }[])
    .map((p) => [p.id, p]));

  if (paymentsById.size === 0) {
    return json({
      error: 'This item has no traceable payment (likely a $0 host-club entry or a legacy purchase) — cannot auto-process. Handle it manually in the Stripe Dashboard, then reject or leave this request for record-keeping.',
    }, 400);
  }

  // --- Build the allocation lines: base = post-coupon paid_cents (snapshot),
  // falling back to invoice_items.amount for a legacy payment with no
  // snapshot. Mirrors process-refund's pre-existing single-payment
  // resolution, generalized to N rows. ---
  const allocationLines: (RefundAllocationLine & { rowId: string })[] = [];
  for (const row of pending) {
    if (!row.invoice_item_id || !row.payment_id) continue;
    const item = itemsById.get(row.invoice_item_id);
    const payment = paymentsById.get(row.payment_id);
    if (!item || !payment) continue;
    let paidCents = Math.round(Number(item.amount) * 100);
    const snapshot = payment.lines_snapshot;
    if (snapshot && item.id.startsWith(`ii-${row.payment_id}-`)) {
      const idxStr = item.id.slice(`ii-${row.payment_id}-`.length);
      const idx = /^\d+$/.test(idxStr) ? Number(idxStr) : NaN;
      const line = Number.isInteger(idx) && idx >= 0 && idx < snapshot.length ? snapshot[idx] : null;
      if (line && line.label === item.label && typeof line.paid_cents === 'number') {
        paidCents = line.paid_cents;
      }
    }
    allocationLines.push({ rowId: row.id, paymentId: row.payment_id, refLineType: item.ref_line_type, paidCents });
  }
  if (allocationLines.length === 0) {
    return json({ error: 'Could not resolve any refundable line for this request.' }, 400);
  }

  const allocation = kind === 'addon'
    // Add-ons are never split across payments (single-row group) and never
    // scaled to 75% (rule 5) — but still routed through the same allocator so
    // there is exactly one code path, not two, for "compute what to refund".
    ? allocateRegistrationRefund(allocationLines, { afterDeadline: false })
    : allocateRegistrationRefund(allocationLines, { afterDeadline: !onTime });

  const refunded: RefundedEntry[] = [];
  const failed: FailedEntry[] = [];

  for (const { paymentId, cents } of allocation) {
    const payment = paymentsById.get(paymentId)!;
    const rowsForPayment = pending.filter((r) => r.payment_id === paymentId);
    const [carrier, ...siblings] = rowsForPayment;

    // --- Cap AND claim, atomically, BEFORE Stripe — `claim_refund_approval`
    // (20260731210000) locks the payments row, sums prior approvals, caps,
    // and claims ONE row, all inside one transaction. Called once per
    // DISTINCT payment (never re-entered for a sibling row of the same
    // payment) — unchanged from the pre-grouping shape per money-invariants.md. ---
    const { data: claimRes, error: claimErr } = await db.rpc('claim_refund_approval', {
      p_request_id: carrier.id,
      p_payment_id: paymentId,
      p_computed_cents: cents,
      p_reviewed_by: caller.id,
      p_reviewed_at: reviewedAt,
    });
    if (claimErr) { failed.push({ paymentId, error: 'Could not record the decision.' }); continue; }
    const claim = claimRes as
      | { ok: true; refund_cents: number; available_cents: number; prior_refunded_cents: number }
      | { ok: false; reason: string }
      | null;
    if (!claim || !claim.ok) {
      failed.push({ paymentId, error: !claim ? 'Could not record the decision.' : claim.reason });
      continue;
    }
    const refundCents = claim.refund_cents;

    // Any sibling row (a second invoice_item on the SAME payment, e.g. an
    // entry line + a separate extra-discipline line in one invoice) is
    // claimed too, but carries $0 — the whole payment's money is attributed
    // to the carrier row above, so the sum of refund_amount_cents across the
    // group per payment always equals exactly what was refunded once.
    if (siblings.length) {
      await db.from('refund_requests').update({
        status: 'approved', reviewed_by: caller.id, reviewed_at: reviewedAt, refund_amount_cents: 0,
      }).eq('request_group_id', carrier.request_group_id).eq('payment_id', paymentId).eq('status', 'pending');
    }

    if (refundCents > 0) {
      if (!payment.stripe_payment_intent_id) {
        await revertClaim(db, paymentId, [carrier.id, ...siblings.map((s) => s.id)]);
        failed.push({ paymentId, error: 'This payment has no Stripe payment intent on record — handle it manually in the Stripe Dashboard.' });
        continue;
      }
      try {
        const stripe = getStripe();
        const refund = await stripe.refunds.create({
          payment_intent: payment.stripe_payment_intent_id,
          amount: refundCents,
        });
        refunded.push({ paymentId, cents: refundCents, stripeRefundId: refund.id });
        await db.from('refund_requests').update({ stripe_refund_id: refund.id }).eq('id', carrier.id);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const reverted = await revertClaim(db, paymentId, [carrier.id, ...siblings.map((s) => s.id)]);
        await db.from('error_logs').insert({
          context: 'process-refund',
          message: reverted
            ? `Stripe refund failed, claim reverted to pending: ${message}`
            : `Stripe refund failed AND reverting the claim also failed — payment ${paymentId} (group ${groupId}) is STUCK approved with no Stripe refund. Needs manual fix. Underlying error: ${message}`,
          detail: { groupId, paymentId, refundCents },
        }).then(() => {}, () => {});
        failed.push({ paymentId, error: `Could not process the Stripe refund: ${message}` });
        continue;
      }
    } else {
      // $0-capped approval (e.g. a free $0-total order, or the payment's
      // subtotal was already fully refunded elsewhere): no Stripe call
      // needed, and this payment counts as successfully processed.
      refunded.push({ paymentId, cents: 0, stripeRefundId: null });
    }
  }

  // --- Item/registration state change — ONLY once every payment in this
  // approve call succeeded. A partial failure leaves the registration alone
  // and its still-pending rows retryable by a later approve on this group. ---
  const allSucceeded = failed.length === 0;
  if (allSucceeded) {
    try {
      const { error: itemUpdErr } = await db.from('invoice_items').update({ refunded: true }).in('id', itemIds);
      if (itemUpdErr) throw new Error(`invoice_items update failed: ${itemUpdErr.message}`);

      const regId = rows.find((r) => r.reg_id)?.reg_id ?? null;
      if (kind === 'registration' && regId) {
        const { data: regRow, error: regErr } = await db
          .from('registrations')
          .select('id, apparatus')
          .eq('id', regId)
          .maybeSingle();
        if (regErr) throw new Error(`registration lookup failed: ${regErr.message}`);
        if (regRow) {
          if (onTime) {
            // Fully removed. `scores` cascade-deletes via its `reg_id` FK
            // (on delete cascade); `squad_id` is a plain FK ON registrations
            // itself (not an embedded jsonb list elsewhere), so no separate
            // squad cleanup is needed — the row disappearing IS the cleanup.
            const { error: delErr } = await db.from('registrations').delete().eq('id', regId);
            if (delErr) throw new Error(`registration delete failed: ${delErr.message}`);
          } else {
            // Kept, blanked (matches MyRegistrations.tsx's "retain-but-blank"
            // shape for a fully-deselected discipline: apparatus: [], no
            // apparatus_levels/partner).
            const { error: updErr } = await db.from('registrations').update({
              refunded: true, keep_listed: true, refund_requested: false,
              apparatus: [], apparatus_levels: null, partner_athlete_id: null,
            }).eq('id', regId);
            if (updErr) throw new Error(`registration update failed: ${updErr.message}`);
          }
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await db.from('error_logs').insert({
        context: 'process-refund',
        message: `Refund(s) succeeded but the item/registration state update failed: ${message}`,
        detail: { groupId, itemIds, regId: rows.find((r) => r.reg_id)?.reg_id ?? null },
      }).then(() => {}, () => {});
    }
  } else {
    // Partial failure: only mark the invoice_items whose payment actually
    // succeeded refunded — the rest stay unrefunded, matching their rows
    // staying 'pending' for retry.
    const succeededPaymentIds = new Set(refunded.map((r) => r.paymentId));
    const succeededItemIds = pending
      .filter((r) => r.payment_id && succeededPaymentIds.has(r.payment_id) && r.invoice_item_id)
      .map((r) => r.invoice_item_id!);
    if (succeededItemIds.length) {
      const { error: itemUpdErr } = await db.from('invoice_items').update({ refunded: true }).in('id', succeededItemIds);
      if (itemUpdErr) console.warn('process-refund: partial invoice_items.refunded update failed', itemUpdErr.message);
    }
  }

  // --- Emails (best-effort). ---
  try {
    const totalRefundedCents = refunded.reduce((s, r) => s + r.cents, 0);
    await sendApproveEmails(db, {
      requesterId: rows[0].requester_person_id,
      itemLabel: itemsById.get(pending[0].invoice_item_id ?? '')?.label ?? (kind === 'registration' ? 'Registration entry' : 'Add-on'),
      eventName: event.name, refundCents: totalRefundedCents, onTime, kind, failedCount: failed.length,
    });
  } catch (e) {
    console.warn('process-refund: approve email failed', e instanceof Error ? e.message : String(e));
  }

  return json({ ok: true, refunded, failed });
}

/** Reverts a payment's claim (carrier + any $0 siblings) back to 'pending' so
 *  it can be retried. Deliberately OUTSIDE `claim_refund_approval`'s lock — by
 *  the time this runs the claim has already committed, and re-entering the
 *  lock buys nothing since the money demonstrably did not move. Same accepted
 *  interaction as before grouping (2026-07-31): a concurrent approval against
 *  the same payment can count this not-yet-reverted amount and be
 *  UNDER-refunded, which self-resolves and errs in the safe direction. */
async function revertClaim(db: DB, paymentId: string, rowIds: string[]): Promise<boolean> {
  const { error } = await db.from('refund_requests').update({
    status: 'pending', reviewed_by: null, reviewed_at: null, refund_amount_cents: null,
  }).eq('payment_id', paymentId).in('id', rowIds).eq('status', 'approved');
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

async function sendRejectEmails(db: DB, opts: { requesterId: string; rejectionReason: string }) {
  const { data: requester } = await db.from('people').select('email, first_name, last_name')
    .eq('id', opts.requesterId).maybeSingle();
  const r = requester as { email: string; first_name: string; last_name: string } | null;
  const reasonHtml = `<p><strong>Reason given:</strong> ${esc(opts.rejectionReason)}</p>`;

  if (r && r.email && EMAIL_RE.test(r.email)) {
    const html = renderEmail({
      heading: 'Refund request reviewed',
      bodyHtml: `<p>Hi ${esc(r.first_name)},</p>
<p>We reviewed your refund request and it was <strong>not approved</strong>. Your registration/item is unchanged.</p>
${reasonHtml}
<p>If you have questions, reply to this email and a league refund manager will follow up.</p>`,
    });
    await sendOne({ to: `${r.first_name} ${r.last_name} <${r.email}>`, subject: 'Refund request — not approved', html })
      .catch((e) => console.warn('process-refund: requester reject email failed', e instanceof Error ? e.message : String(e)));
  }

  const recipients = await reviewerRecipients(db);
  if (recipients.length === 0) return;
  const summaryHtml = renderEmail({
    heading: 'Refund request rejected',
    bodyHtml: `<p><strong>${r ? esc(`${r.first_name} ${r.last_name}`) : 'A member'}</strong>'s refund request was reviewed and rejected. No item/registration change was made.</p>
${reasonHtml}`,
  });
  const messages: EmailMessage[] = recipients.map((p) => ({
    to: `${p.first_name} ${p.last_name} <${p.email.trim()}>`, subject: 'Refund request rejected', html: summaryHtml,
  }));
  await sendBatch(messages);
}

async function sendApproveEmails(db: DB, opts: {
  requesterId: string; itemLabel: string; eventName: string; refundCents: number; onTime: boolean;
  kind: 'registration' | 'addon'; failedCount: number;
}) {
  const { requesterId, itemLabel, eventName, refundCents, onTime, kind, failedCount } = opts;
  const { data: requester } = await db.from('people').select('email, first_name, last_name').eq('id', requesterId).maybeSingle();
  const r = requester as { email: string; first_name: string; last_name: string } | null;

  const retainedLine = !onTime
    ? '<p style="margin-top:12px;">25% was retained per policy for a refund requested after the event\'s edit deadline. The athlete can no longer compete in this discipline — their name may still appear in printed event materials.</p>'
    : (kind === 'registration' ? '<p style="margin-top:12px;">The registration has been fully removed.</p>' : '');
  const failedLine = failedCount > 0
    ? `<p style="margin-top:12px;color:#8a4b12;">${failedCount} payment${failedCount === 1 ? '' : 's'} on this request could not be refunded automatically and will be retried by a refund manager.</p>`
    : '';
  const bodyHtml = `<p>Hi ${r ? esc(r.first_name) : 'there'},</p>
<p>Your refund request for <strong>${esc(itemLabel)}</strong> — <strong>${esc(eventName)}</strong> was approved.</p>
<p><strong>Amount refunded:</strong> ${fmtMoney(refundCents)}</p>
<p>Service fees are non-refundable. Refunds return to the original payment method (the club's card for a club-paid entry).</p>
${retainedLine}
${failedLine}
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
<p><strong>Amount refunded:</strong> ${fmtMoney(refundCents)}</p>
${failedLine}`,
  });
  const messages: EmailMessage[] = recipients.map((p) => ({
    to: `${p.first_name} ${p.last_name} <${p.email.trim()}>`, subject: `Refund processed — ${eventName}`, html: summaryHtml,
  }));
  await sendBatch(messages);
}
