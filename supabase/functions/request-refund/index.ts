// request-refund — self-serve / club-manager refund REQUEST (event-mgmt v2
// Phase 3, spec §H; grouped-per-registration rewrite: UAT Z-04-01/02/03 +
// Nate's Z-04 note, 2026-08-21). Creates one or more `refund_requests` rows
// (T4 migration `20260710212356`; T4b `20260821150000` added
// `request_group_id`/`rejection_reason`) tied together by ONE
// `request_group_id`, and notifies the requester + the league's refund
// managers. Does NOT itself approve/process a refund or call Stripe — that's
// the review flow (T6, `process-refund`), reachable from the emailed link at
// `${APP_PUBLIC_URL}/#/admin/refunds`.
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
// offer refunds at all — OR a UCG-hosted event (`events.ucg_hosted` set;
// FlipFest/Nationals need no host club at all as of PM feedback 2026-07-22)
// (`eventIsRefundEligible`, src/lib/events-core.ts — mirrored here since this
// function can't import client code; keep both sides in exact lockstep). A
// duplicate pending/approved request against the same registration/item is
// rejected (409).
//
// UAT Z-04 confirmed business rules implemented here:
//   1. One refund REQUEST per REGISTRATION, covering every paid line for
//      that registration across ALL invoices/payments that funded it (a reg
//      paid by an original invoice + a later "add discipline" invoice has
//      TWO Stripe payments — both are enumerated and grouped under one
//      `request_group_id`, one row per resolved (payment, invoice_item)).
//   2. Refundable base = entry-fee + extra-discipline-fee lines only.
//      Change-fee lines (`ref_line_type = 'change'`) are NEVER refundable —
//      excluded from enumeration entirely, not just discounted.
//   3. The UCG service fee is never refunded (enforced downstream by
//      `claim_refund_approval`'s `amount_subtotal` cap) — the request/receipt
//      emails say so explicitly.
//   5. Add-ons: full refund while `now <= that add-on type's
//      lastPurchaseAt` (`addonLastPurchaseAt`/`addonPurchaseOpen`,
//      `_shared/stripe.ts`); refused outright at REQUEST time after that —
//      no partial/75% add-on refund exists.
//
// verify_jwt STAYS TRUE (default) — this is NOT one of the three
// --no-verify-jwt functions (stripe-webhook, sms-webhook,
// notify-manager-access-denied).
//
// Secrets: RESEND_API_KEY, RESEND_FROM, APP_PUBLIC_URL (all shared/optional
// with sane fallbacks in _shared/resend.ts). Auto-provided: SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendBatch, sendOne, type EmailMessage } from '../_shared/resend.ts';
import { renderEmail } from '../_shared/email-layout.ts';
import { addonLastPurchaseAt, addonPurchaseOpen, type RegFeeEvent } from '../_shared/stripe.ts';

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
const SERVICE_FEE_SENTENCE = 'Service fees are non-refundable.';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmtMoney = (dollars: number) => `$${dollars.toFixed(2)}`;

interface Payload {
  kind?: 'registration' | 'addon';
  regId?: string;
  invoiceItemId?: string;
  reason?: string;
  reasonDetail?: string;
  clubId?: string;
}

type EligibilityEvent = RegFeeEvent & { name: string; ucg_hosted: boolean | null; last_date_to_edit: string | null };

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

  // --- Resolve the target + its event + owning club ---
  let eventId: string;
  let targetClubId: string | null;
  let ownerPersonId: string | null; // self-purchase owner, for the self-serve auth branch
  // Registration kind only: every candidate refundable invoice_items row
  // (kind='meet-entry', ref_line_type distinct from 'change') that references
  // regId, each already resolved to its succeeded payment. Populated below,
  // after eligibility/authorization pass, since resolving payments is only
  // needed once we know the request will actually be inserted.
  let addonItem: { id: string; invoice_id: string; label: string; amount: number; ref_line_type: string | null } | null = null;
  let addonPaymentId: string | null = null;

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
  } else {
    const { data: item, error: itemErr } = await db
      .from('invoice_items')
      .select('id, invoice_id, kind, ref_line_type, ref_event_id, refunded, label, amount')
      .eq('id', invoiceItemId)
      .maybeSingle();
    if (itemErr) return json({ error: 'Could not look up the purchased item.' }, 500);
    if (!item) return json({ error: 'Purchased item not found.' }, 404);
    if (item.refunded) return json({ error: 'This item has already been refunded.' }, 400);
    if (item.kind !== 'addon' || !ADDON_LINE_TYPES.includes(item.ref_line_type ?? '')) {
      return json({ error: 'This item is not eligible for a refund request (entry fees are requested via their registration, and membership/fee lines are not refundable here).' }, 400);
    }
    if (!item.ref_event_id) return json({ error: 'This item is not linked to an event.' }, 400);
    addonItem = item;

    const { data: invoice, error: invErr } = await db
      .from('invoices')
      .select('id, athlete_id, club_id')
      .eq('id', item.invoice_id)
      .maybeSingle();
    if (invErr) return json({ error: 'Could not look up the purchase.' }, 500);
    if (!invoice) return json({ error: 'Purchase not found.' }, 404);

    eventId = item.ref_event_id;
    targetClubId = invoice.club_id;

    const { data: pay } = await db
      .from('payments')
      .select('id, person_id')
      .eq('invoice_id', invoice.id)
      .limit(1)
      .maybeSingle();
    addonPaymentId = pay?.id ?? null;
    ownerPersonId = invoice.athlete_id ?? pay?.person_id ?? null;
  }

  // --- Eligibility: event must be hosted by the league's own club, OR be a
  // UCG-hosted event (FlipFest/Nationals — no host club required as of PM
  // feedback 2026-07-22). Mirrors `eventIsRefundEligible` (events-core.ts).
  // Also carries the RegFeeEvent columns needed for the add-on
  // lastPurchaseAt refusal check (rule 5) — cheaper to select once than to
  // branch the query on kind. ---
  const { data: eventRow, error: eventErr } = await db
    .from('events')
    .select('id, name, host_club_id, last_date_to_edit, ucg_hosted, entry_fee, second_discipline_fee, change_fee, tshirt_addon, banner_addon, banquet, camp_config, reg_closes, late_reg')
    .eq('id', eventId)
    .maybeSingle();
  if (eventErr) return json({ error: 'Could not look up the event.' }, 500);
  if (!eventRow) return json({ error: 'Event not found.' }, 404);
  const event = eventRow as unknown as EligibilityEvent;

  let refundEligible = !!event.ucg_hosted;
  if (!refundEligible && event.host_club_id) {
    const { data: hostClub, error: hostErr } = await db
      .from('clubs')
      .select('id, is_league_host')
      .eq('id', event.host_club_id)
      .maybeSingle();
    if (hostErr) return json({ error: 'Could not verify refund eligibility.' }, 500);
    refundEligible = coalesceBool(hostClub?.is_league_host);
  }
  if (!refundEligible) {
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

  // --- Rule 5: an add-on past its own purchase deadline is refused outright,
  // before ever creating a request row. Falls back to `event.reg_closes` when
  // the line type has no `lastPurchaseAt` of its own — same convention
  // `addonPurchaseOpen` uses for the PURCHASE gate, reused here unmodified so
  // the refund gate and the purchase gate can never drift apart. ---
  if (kind === 'addon' && addonItem) {
    const deadline = addonLastPurchaseAt(event, addonItem.ref_line_type);
    const stillOpen = addonPurchaseOpen(deadline, event.reg_closes, new Date());
    if (!stillOpen) {
      const deadlineIso = deadline ?? event.reg_closes;
      return json({
        error: `The order deadline for this item (${new Date(deadlineIso).toLocaleDateString('en-US')}) has passed — it can no longer be refunded.`,
      }, 400);
    }
  }

  // --- Dup check: reject a duplicate pending/approved request against the
  // same registration/item. ---
  let dupQuery = db.from('refund_requests').select('id').in('status', ['pending', 'approved']);
  dupQuery = kind === 'registration' ? dupQuery.eq('reg_id', regId) : dupQuery.eq('invoice_item_id', invoiceItemId);
  const { data: dup, error: dupErr } = await dupQuery.limit(1).maybeSingle();
  if (dupErr) return json({ error: 'Could not check for an existing request.' }, 500);
  if (dup) return json({ error: 'A refund request for this item is already pending or approved.' }, 409);

  // Registration kind: one GROUP of N rows (one per resolved payment/invoice
  // item), so `groupId` is a separate id from any individual row.
  // Add-on kind: a single-row group, so `groupId` IS that row's own id
  // (matches the T4b migration comment: "an add-on request stays a one-row
  // group, request_group_id = id").
  const groupId = kind === 'registration' ? `rg-${crypto.randomUUID()}` : `rr-${crypto.randomUUID()}`;
  // One row per (payment, invoice_item) inserted below, plus what the
  // confirmation/summary emails need to describe. Always assigned by exactly
  // one branch of the kind === 'registration' / else split below.
  let lineDescriptions: { label: string; amountDollars: number }[];

  if (kind === 'registration') {
    // --- Rule 1+2: enumerate EVERY refundable invoice_items row for this
    // registration — entry / extra-discipline fee lines only, across every
    // invoice that ever paid for it (an "add discipline" edit is a SEPARATE
    // invoice/payment from the original entry). A change-fee line
    // (ref_line_type='change') is excluded outright per rule 2, even for a
    // "mixed" line that also carries an added discipline's entry-total
    // combined with the change fee (M-10-01) — the combined line is tagged
    // 'change' (see money-invariants.md), so it is NOT refundable under this
    // rule; a known consequence, documented in the wrap-up notes. ---
    const { data: candidateItems, error: candErr } = await db
      .from('invoice_items')
      .select('id, invoice_id, kind, ref_line_type, label, amount')
      .contains('ref_reg_ids', [regId]);
    if (candErr) return json({ error: 'Could not look up this registration\'s purchase lines.' }, 500);
    const refundableItems = ((candidateItems ?? []) as
      { id: string; invoice_id: string; kind: string; ref_line_type: string | null; label: string; amount: number }[])
      .filter((it) => it.kind === 'meet-entry' && it.ref_line_type !== 'change');

    if (refundableItems.length === 0) {
      return json({ error: 'This registration has no refundable paid lines — there is nothing to request a refund for.' }, 400);
    }

    // Resolve each item's invoice -> a SUCCEEDED payment. One query per
    // distinct invoice (usually 1, occasionally 2 for the add-discipline case).
    const invoiceIds = Array.from(new Set(refundableItems.map((it) => it.invoice_id)));
    const paymentByInvoice = new Map<string, string>();
    for (const invId of invoiceIds) {
      const { data: pays } = await db.from('payments').select('id, status').eq('invoice_id', invId);
      const payRows = (pays ?? []) as { id: string; status: string }[];
      const paid = payRows.find((p) => p.status === 'paid');
      if (paid) paymentByInvoice.set(invId, paid.id);
    }

    const resolvedRows = refundableItems
      .map((it) => ({ item: it, paymentId: paymentByInvoice.get(it.invoice_id) ?? null }))
      .filter((r): r is { item: typeof refundableItems[number]; paymentId: string } => !!r.paymentId);

    if (resolvedRows.length === 0) {
      return json({ error: 'This registration has no succeeded payment to refund — there is nothing to request a refund for.' }, 400);
    }

    const insertRows = resolvedRows.map((r) => ({
      id: `rr-${crypto.randomUUID()}`,
      request_group_id: groupId,
      requester_person_id: caller.id,
      club_id: stampedClubId,
      event_id: eventId,
      kind: 'registration' as const,
      reg_id: regId,
      invoice_item_id: r.item.id,
      payment_id: r.paymentId,
      reason,
      reason_detail: reasonDetail || null,
      status: 'pending' as const,
    }));
    const { error: insertErr } = await db.from('refund_requests').insert(insertRows);
    if (insertErr) return json({ error: insertErr.message }, 500);

    lineDescriptions = resolvedRows.map((r) => ({ label: r.item.label, amountDollars: r.item.amount }));

    const { error: flagErr } = await db.from('registrations').update({ refund_requested: true }).eq('id', regId);
    if (flagErr) console.warn('request-refund: failed to flag registration.refund_requested', flagErr.message);
  } else {
    // --- Add-on: unchanged one-row shape, just now stamped with a
    // (single-row) request_group_id so process-refund can look up any
    // request generically by group. ---
    const { error: insertErr } = await db.from('refund_requests').insert({
      id: groupId,
      request_group_id: groupId,
      requester_person_id: caller.id,
      club_id: stampedClubId,
      event_id: eventId,
      kind: 'addon',
      reg_id: null,
      invoice_item_id: invoiceItemId,
      payment_id: addonPaymentId,
      reason,
      reason_detail: reasonDetail || null,
      status: 'pending',
    });
    if (insertErr) return json({ error: insertErr.message }, 500);
    lineDescriptions = addonItem ? [{ label: addonItem.label, amountDollars: addonItem.amount }] : [];
  }

  // --- Estimate for the emails: 100%/75% by the event's lastDateToEdit (the
  // 75% rule applies to registrations; add-ons are always 100% by the time
  // they reach here, since a past-deadline add-on was already refused
  // above). Display-only — the exact amount is computed server-side at
  // approval time, same disclaimer the review UI already carries. ---
  const totalDollars = lineDescriptions.reduce((s, l) => s + l.amountDollars, 0);
  const now = new Date().toISOString();
  const onTime = kind === 'addon' || !event.last_date_to_edit || Date.parse(now) <= Date.parse(event.last_date_to_edit);
  const estimateDollars = onTime ? totalDollars : Math.round(totalDollars * 0.75 * 100) / 100;

  // --- Emails (best-effort; never fail the request after the insert above) ---
  try {
    await sendRequestEmails(db, {
      appUrl, requester: caller, lineDescriptions, estimateDollars, isPastDeadline: !onTime,
      eventName: event.name, reason, reasonDetail,
    });
  } catch (e) {
    console.warn('request-refund: email send failed', e instanceof Error ? e.message : String(e));
  }

  return json({ ok: true, requestId: groupId, groupId });
});

function coalesceBool(v: unknown): boolean {
  return v === true;
}

async function sendRequestEmails(db: ReturnType<typeof createClient>, opts: {
  appUrl: string;
  requester: { id: string; email: string; first_name: string; last_name: string };
  lineDescriptions: { label: string; amountDollars: number }[];
  estimateDollars: number;
  isPastDeadline: boolean;
  eventName: string;
  reason: Reason;
  reasonDetail: string;
}) {
  const { appUrl, requester, lineDescriptions, estimateDollars, isPastDeadline, eventName, reason, reasonDetail } = opts;
  const reasonLabel = { injury: 'Injury', illness: 'Illness', bereavement: 'Bereavement', other: 'Other' }[reason];
  const removalWarning = 'If this request is approved, the registration will be fully removed (or the item refunded) — this cannot be undone.';
  const detailLine = reasonDetail ? `<p><strong>Details:</strong> ${esc(reasonDetail)}</p>` : '';
  const linesHtml = lineDescriptions.length
    ? `<ul>${lineDescriptions.map((l) => `<li>${esc(l.label)} — ${fmtMoney(l.amountDollars)}</li>`).join('')}</ul>`
    : '';
  const estimateLine = `<p><strong>Estimated refund:</strong> up to ${fmtMoney(estimateDollars)}${isPastDeadline ? ' (75% — past the edit deadline)' : ''}. ${SERVICE_FEE_SENTENCE} The exact amount is computed when the request is reviewed.</p>`;

  // (a) Confirmation to the requester.
  if (requester.email && EMAIL_RE.test(requester.email)) {
    const html = renderEmail({
      heading: 'Refund request received',
      bodyHtml: `<p>Hi ${esc(requester.first_name)},</p>
<p>We received your refund request for <strong>${esc(eventName)}</strong>:</p>
${linesHtml}
${estimateLine}
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
    bodyHtml: `<p><strong>${esc(`${requester.first_name} ${requester.last_name}`)}</strong> requested a refund for <strong>${esc(eventName)}</strong>:</p>
${linesHtml}
${estimateLine}
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
