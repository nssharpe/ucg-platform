// request-refund — self-serve / club-manager refund REQUEST (event-mgmt v2
// Phase 3, spec §H). Creates a `refund_requests` row (T4 migration; SELECT-only
// RLS — this function, running with the service role, is the ONLY writer) and
// notifies the requester + the league's refund managers. Does NOT itself
// approve/process a refund or call Stripe — that's the review flow (T6),
// reachable from the emailed link at `${APP_PUBLIC_URL}/#/admin/refunds`.
//
// Auth: any signed-in user. Authorization is fail-closed and computed
// server-side from the caller's OWN person row + club_managers membership —
// never trusted from the client:
//   - kind='registration': caller must be the registration's athlete, OR a
//     manager of the registration's club.
//   - kind='addon': caller must be the athlete/self-payer on the parent
//     invoice (invoice.athlete_id, or the linked payment's person_id), OR a
//     manager of the invoice's club.
//
// Eligibility: only events whose HOST club has `clubs.is_league_host = true`
// offer refunds at all (`eventIsRefundEligible`, src/lib/events-core.ts —
// mirrored here since this function can't import client code). A duplicate
// pending/approved request against the same item is rejected (409).
//
// verify_jwt STAYS TRUE (default) — this is NOT one of the three
// --no-verify-jwt functions (stripe-webhook, sms-webhook,
// notify-manager-access-denied). Do not add it to that list.
//
// Secrets: RESEND_API_KEY, RESEND_FROM, APP_PUBLIC_URL (all shared/optional
// with sane fallbacks in _shared/resend.ts). Auto-provided: SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendBatch, sendOne, type EmailMessage } from '../_shared/resend.ts';
import { renderEmail } from '../_shared/email-layout.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REASONS = ['injury', 'illness', 'bereavement', 'other'] as const;
type Reason = (typeof REASONS)[number];
// Only these per-unit add-on lines are §H-refundable via kind='addon'. An
// entry-fee line's refund is requested via kind='registration' (regId), not
// through an invoice_item at all — 'fee'/'membership'/'meet-entry'/'donation'/
// 'discount' invoice_item kinds are never eligible here.
const ADDON_LINE_TYPES = ['tshirt', 'banner', 'banquet', 'leo'];

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

interface Payload {
  kind?: 'registration' | 'addon';
  regId?: string;
  invoiceItemId?: string;
  reason?: string;
  reasonDetail?: string;
  clubId?: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const appUrl = Deno.env.get('APP_PUBLIC_URL') ?? 'https://nssharpe.github.io/ucg-platform';
  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // --- Authenticate ---
  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'Missing Authorization header.' }, 401);
  const { data: userData, error: userErr } = await db.auth.getUser(token);
  if (userErr || !userData.user) return json({ error: 'Invalid or expired session.' }, 401);
  const authUserId = userData.user.id;

  // --- Validate payload shape ---
  let payload: Payload;
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }
  const kind = payload.kind;
  if (kind !== 'registration' && kind !== 'addon') return json({ error: 'kind must be "registration" or "addon".' }, 400);
  const reason = payload.reason as Reason | undefined;
  if (!reason || !REASONS.includes(reason)) return json({ error: 'A valid reason is required.' }, 400);
  const reasonDetail = typeof payload.reasonDetail === 'string' ? payload.reasonDetail.trim() : '';
  if (reason === 'other' && !reasonDetail) return json({ error: 'Please explain the reason for "Other".' }, 400);
  const regId = typeof payload.regId === 'string' ? payload.regId.trim() : '';
  const invoiceItemId = typeof payload.invoiceItemId === 'string' ? payload.invoiceItemId.trim() : '';
  if (kind === 'registration' && !regId) return json({ error: 'regId is required.' }, 400);
  if (kind === 'addon' && !invoiceItemId) return json({ error: 'invoiceItemId is required.' }, 400);

  // --- Resolve the caller's own person row (fail closed: no person ⇒ 403) ---
  const { data: caller, error: callerErr } = await db
    .from('people')
    .select('id, email, first_name, last_name')
    .eq('auth_user_id', authUserId)
    .maybeSingle();
  if (callerErr) return json({ error: 'Could not verify your account.' }, 403);
  if (!caller) return json({ error: 'No profile is linked to your account.' }, 403);

  // --- Resolve the target item + its event + owning club ---
  let eventId: string;
  let targetClubId: string | null;
  let ownerPersonId: string | null; // self-purchase owner, for the self-serve auth branch
  let itemLabel: string;
  let paymentId: string | null;
  // Only meaningful for kind='registration' — the invoice_item the payment
  // lookup below resolved through, stamped on the refund_requests row so T6
  // has the entry line's amount for the refund calc.
  let matchedInvoiceItemId: string | null = null;

  if (kind === 'registration') {
    const { data: reg, error: regErr } = await db
      .from('registrations')
      .select('id, event_id, athlete_id, club_id, discipline, paid, refunded')
      .eq('id', regId)
      .maybeSingle();
    if (regErr) return json({ error: 'Could not look up the registration.' }, 500);
    if (!reg) return json({ error: 'Registration not found.' }, 404);
    if (!reg.paid) return json({ error: 'This registration has not been paid — nothing to refund.' }, 400);
    if (reg.refunded) return json({ error: 'This registration has already been refunded.' }, 400);

    eventId = reg.event_id;
    targetClubId = reg.club_id;
    ownerPersonId = reg.athlete_id;
    itemLabel = `${reg.discipline === 'TNT' ? 'T&T' : reg.discipline} entry`;

    // Best-effort payment lookup: `payments.ref_reg_ids` is never written by
    // create-checkout-session (reg refs live per-line in lines_snapshot, which
    // fulfillment mirrors onto invoice_items, never top-level on the payments
    // row) — so a `.contains('ref_reg_ids', ...)` query against payments would
    // always come back empty. Resolve via invoice_items instead: find the line(s)
    // covering this reg, preferring the ENTRY line (kind='meet-entry',
    // ref_line_type 'entry' or unset) over a change-fee line ('change') so T6
    // has the entry line's amount for the refund calc, then walk invoice_id ->
    // payments. A host-club $0 entry gets no cart line/invoice_item at all, so
    // it correctly stays untraceable (paymentId/matchedInvoiceItemId null).
    const { data: candidateItems } = await db
      .from('invoice_items')
      .select('id, invoice_id, kind, ref_line_type')
      .contains('ref_reg_ids', [regId]);
    const regInvoiceItems = (candidateItems ?? []) as
      { id: string; invoice_id: string; kind: string; ref_line_type: string | null }[];
    const entryItem = regInvoiceItems.find((it) => it.kind === 'meet-entry' && it.ref_line_type !== 'change');
    const chosenItem = entryItem ?? regInvoiceItems[0] ?? null;
    matchedInvoiceItemId = chosenItem?.id ?? null;

    if (chosenItem) {
      const { data: pays } = await db
        .from('payments')
        .select('id, status')
        .eq('invoice_id', chosenItem.invoice_id);
      const payRows = (pays ?? []) as { id: string; status: string }[];
      paymentId = payRows.find((p) => p.status === 'paid')?.id ?? payRows[0]?.id ?? null;
    } else {
      paymentId = null;
    }
  } else {
    const { data: item, error: itemErr } = await db
      .from('invoice_items')
      .select('id, invoice_id, kind, ref_line_type, ref_event_id, refunded, label')
      .eq('id', invoiceItemId)
      .maybeSingle();
    if (itemErr) return json({ error: 'Could not look up the purchased item.' }, 500);
    if (!item) return json({ error: 'Purchased item not found.' }, 404);
    if (item.refunded) return json({ error: 'This item has already been refunded.' }, 400);
    if (item.kind !== 'addon' || !ADDON_LINE_TYPES.includes(item.ref_line_type ?? '')) {
      return json({ error: 'This item is not eligible for a refund request (entry fees are requested via their registration, and membership/fee lines are not refundable here).' }, 400);
    }
    if (!item.ref_event_id) return json({ error: 'This item is not linked to an event.' }, 400);

    const { data: invoice, error: invErr } = await db
      .from('invoices')
      .select('id, athlete_id, club_id')
      .eq('id', item.invoice_id)
      .maybeSingle();
    if (invErr) return json({ error: 'Could not look up the purchase.' }, 500);
    if (!invoice) return json({ error: 'Purchase not found.' }, 404);

    eventId = item.ref_event_id;
    targetClubId = invoice.club_id;
    itemLabel = item.label;

    const { data: pay } = await db
      .from('payments')
      .select('id, person_id')
      .eq('invoice_id', invoice.id)
      .limit(1)
      .maybeSingle();
    paymentId = pay?.id ?? null;
    ownerPersonId = invoice.athlete_id ?? pay?.person_id ?? null;
  }

  // --- Eligibility: event must be hosted by the league's own club ---
  const { data: event, error: eventErr } = await db
    .from('events')
    .select('id, name, host_club_id, last_date_to_edit')
    .eq('id', eventId)
    .maybeSingle();
  if (eventErr) return json({ error: 'Could not look up the event.' }, 500);
  if (!event) return json({ error: 'Event not found.' }, 404);

  let hostIsLeague = false;
  if (event.host_club_id) {
    const { data: hostClub, error: hostErr } = await db
      .from('clubs')
      .select('id, is_league_host')
      .eq('id', event.host_club_id)
      .maybeSingle();
    if (hostErr) return json({ error: 'Could not verify refund eligibility.' }, 500);
    hostIsLeague = coalesceBool(hostClub?.is_league_host);
  }
  if (!hostIsLeague) {
    return json({ error: 'Refund requests are only available for events hosted by United Club Gymnastics.' }, 400);
  }

  // --- Authorize: self-owner OR a manager of the owning club. Fail closed. ---
  const isSelf = !!ownerPersonId && ownerPersonId === caller.id;
  let isClubManager = false;
  if (!isSelf && targetClubId) {
    const { data: mgr, error: mgrErr } = await db
      .from('club_managers')
      .select('club_id')
      .eq('club_id', targetClubId)
      .eq('person_id', caller.id)
      .maybeSingle();
    if (mgrErr) return json({ error: 'Could not verify your permissions.' }, 403);
    isClubManager = !!mgr;
  }
  if (!isSelf && !isClubManager) {
    return json({ error: 'You do not have permission to request a refund for this item.' }, 403);
  }
  // Only stamp club_id on the request when it was actually authorized via the
  // club-manager branch — a self-serve request stays club_id: null (T4 schema
  // comment). Never trust the client-supplied clubId for anything but display.
  const stampedClubId = isClubManager ? targetClubId : null;

  // --- Reject a duplicate pending/approved request against the same item ---
  let dupQuery = db.from('refund_requests').select('id').in('status', ['pending', 'approved']);
  dupQuery = kind === 'registration' ? dupQuery.eq('reg_id', regId) : dupQuery.eq('invoice_item_id', invoiceItemId);
  const { data: dup, error: dupErr } = await dupQuery.limit(1).maybeSingle();
  if (dupErr) return json({ error: 'Could not check for an existing request.' }, 500);
  if (dup) return json({ error: 'A refund request for this item is already pending or approved.' }, 409);

  // --- Insert the request row ---
  const requestId = `rr-${crypto.randomUUID()}`;
  const { error: insertErr } = await db.from('refund_requests').insert({
    id: requestId,
    requester_person_id: caller.id,
    club_id: stampedClubId,
    event_id: eventId,
    kind,
    reg_id: kind === 'registration' ? regId : null,
    invoice_item_id: kind === 'addon' ? invoiceItemId : matchedInvoiceItemId,
    payment_id: paymentId,
    reason,
    reason_detail: reasonDetail || null,
    status: 'pending',
  });
  if (insertErr) return json({ error: insertErr.message }, 500);

  if (kind === 'registration') {
    const { error: flagErr } = await db.from('registrations').update({ refund_requested: true }).eq('id', regId);
    if (flagErr) console.warn('request-refund: failed to flag registration.refund_requested', flagErr.message);
  }

  // --- Emails (best-effort; never fail the request after the insert above) ---
  try {
    await sendRequestEmails(db, {
      appUrl, requester: caller, itemLabel, eventName: event.name, reason, reasonDetail,
      ownerPersonId, isClubManager,
    });
  } catch (e) {
    console.warn('request-refund: email send failed', e instanceof Error ? e.message : String(e));
  }

  return json({ ok: true, requestId });
});

function coalesceBool(v: unknown): boolean {
  return v === true;
}

async function sendRequestEmails(db: ReturnType<typeof createClient>, opts: {
  appUrl: string;
  requester: { id: string; email: string; first_name: string; last_name: string };
  itemLabel: string;
  eventName: string;
  reason: Reason;
  reasonDetail: string;
  ownerPersonId: string | null;
  isClubManager: boolean;
}) {
  const { appUrl, requester, itemLabel, eventName, reason, reasonDetail } = opts;
  const reasonLabel = { injury: 'Injury', illness: 'Illness', bereavement: 'Bereavement', other: 'Other' }[reason];
  const removalWarning = 'If this request is approved, the registration will be fully removed (or the item refunded) — this cannot be undone.';
  const detailLine = reasonDetail ? `<p><strong>Details:</strong> ${esc(reasonDetail)}</p>` : '';

  // (a) Confirmation to the requester.
  if (requester.email && EMAIL_RE.test(requester.email)) {
    const html = renderEmail({
      heading: 'Refund request received',
      bodyHtml: `<p>Hi ${esc(requester.first_name)},</p>
<p>We received your refund request for <strong>${esc(itemLabel)}</strong> — <strong>${esc(eventName)}</strong>.</p>
<p><strong>Reason:</strong> ${esc(reasonLabel)}</p>
${detailLine}
<p>A league refund manager will review it and email you the decision.</p>
<p style="margin-top:16px;">${removalWarning}</p>`,
    });
    try {
      await sendOne({
        to: `${requester.first_name} ${requester.last_name} <${requester.email}>`,
        subject: `Refund request received — ${eventName}`,
        html,
      });
    } catch (e) {
      console.warn('request-refund: requester email failed', e instanceof Error ? e.message : String(e));
    }
  }

  // (b) Summary to refund managers (fallback to admins if none are set up).
  const { data: rmRoles } = await db.from('user_roles').select('user_id').eq('role', 'refund_manager');
  let reviewerAuthIds = ((rmRoles ?? []) as { user_id: string }[]).map((r) => r.user_id);
  if (reviewerAuthIds.length === 0) {
    const { data: adminRoles } = await db.from('user_roles').select('user_id').eq('role', 'admin');
    reviewerAuthIds = ((adminRoles ?? []) as { user_id: string }[]).map((r) => r.user_id);
  }
  if (reviewerAuthIds.length === 0) return;

  const { data: reviewers } = await db
    .from('people')
    .select('email, first_name, last_name')
    .in('auth_user_id', reviewerAuthIds);
  const recipients = ((reviewers ?? []) as { email: string; first_name: string; last_name: string }[])
    .filter((p) => typeof p.email === 'string' && EMAIL_RE.test(p.email.trim()));
  if (recipients.length === 0) return;

  const reviewLink = `${appUrl}/#/admin/refunds`;
  const summaryHtml = renderEmail({
    heading: 'New refund request',
    bodyHtml: `<p><strong>${esc(`${requester.first_name} ${requester.last_name}`)}</strong> requested a refund for:</p>
<p><strong>${esc(itemLabel)}</strong> — ${esc(eventName)}</p>
<p><strong>Reason:</strong> ${esc(reasonLabel)}</p>
${detailLine}`,
    cta: { text: 'Review refund requests', href: reviewLink },
  });
  const messages: EmailMessage[] = recipients.map((r) => ({
    to: `${r.first_name} ${r.last_name} <${r.email.trim()}>`,
    subject: `Refund request — ${eventName}`,
    html: summaryHtml,
  }));
  await sendBatch(messages);
}
