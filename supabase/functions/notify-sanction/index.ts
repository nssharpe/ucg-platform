// notify-sanction — sanction-request lifecycle emails.
//   event 'submitted' → notifies the Sanctioning Team ONLY (owners' explicit
//     instruction, UAT round 3 E-01-02, OVERRIDING the earlier UAT round 2
//     "stays admin-inclusive/informational by design" call — only the
//     'sanctioning' role can actually cast a vote, see sanction_votes_write,
//     20260826000000) — AND emails the requester a submission confirmation
//     (E-01-01: previously the requester got no acknowledgement at all).
//   event 'approved' → notifies the requester (unchanged) AND the
//     Sanctioning Team (new, E-01-03 — a short "it's been approved" notice).
//   event 'rejected' → notifies the requester only (unchanged).
// The two audiences per event are resolved and sent INDEPENDENTLY — an empty/
// failed team send must never suppress the requester's email or vice versa.
// The request is re-read server-side by id; the caller only sends { requestId, event }.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendBatch, sendOne, type EmailMessage } from '../_shared/resend.ts';
import { renderEmail } from '../_shared/email-layout.ts';
import { dedupeEmailRecipients } from '../_shared/notify-recipients.ts';
import { sanctionSummaryRows, groupSanctionSummary } from '../_shared/sanction-summary.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const appUrl = Deno.env.get('APP_PUBLIC_URL') ?? 'https://nssharpe.github.io/ucg-platform';

  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return json({ ok: false, error: 'Missing Authorization header.' }, 401);

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const { data: userData, error: userErr } = await db.auth.getUser(token);
  if (userErr || !userData.user) return json({ ok: false, error: 'Invalid or expired session.' }, 401);

  let body: { requestId?: string; event?: string };
  try { body = await req.json(); } catch { return json({ ok: false, error: 'Invalid JSON body.' }, 400); }
  const requestId = (body.requestId ?? '').trim();
  const event = body.event;
  if (!requestId) return json({ ok: false, error: 'requestId is required.' }, 400);
  if (event !== 'submitted' && event !== 'approved' && event !== 'rejected') {
    return json({ ok: false, error: 'event must be submitted | approved | rejected.' }, 400);
  }

  /** Levels referenced by the request, id → name, for the summary rows. */
  async function levelNameLookup(payload: Record<string, unknown>): Promise<(id: string) => string | undefined> {
    const ids = [...new Set(['wagLevels', 'magLevels', 'tntLevels']
      .flatMap((k) => (Array.isArray(payload[k]) ? (payload[k] as unknown[]).map(String) : [])))];
    if (ids.length === 0) return () => undefined;
    const { data } = await db.from('levels').select('id, name').in('id', ids);
    const map = new Map((data ?? []).map((l: { id: string; name: string }) => [l.id, l.name]));
    return (id) => map.get(id);
  }

  /** The requester's own answers as a labelled table (UAT E-01-03: the
   *  submission email named only the event + dates, and the requester has no
   *  other way to see what they asked for — the vote page is team-gated).
   *  Same rows the "Details" dialog on Your Sanction Requests renders. */
  function summaryTableHtml(payload: Record<string, unknown>, hostClubName: string | undefined, levelName: (id: string) => string | undefined): string {
    const groups = groupSanctionSummary(sanctionSummaryRows(payload, { hostClubName: hostClubName ?? null, levelName }));
    return groups.map((g) => `<p style="margin:14px 0 4px;font-weight:700;color:#1E2B38;">${esc(g.section)}</p>
<table role="presentation" style="border-collapse:collapse;width:100%;font-size:14px;">${g.rows.map((r) =>
      `<tr><td style="padding:4px 12px 4px 0;color:#5b6b7a;vertical-align:top;white-space:nowrap;">${esc(r.label)}</td><td style="padding:4px 0;color:#1E2B38;">${esc(r.value)}</td></tr>`).join('')}</table>`).join('');
  }

  const { data: sreq } = await db
    .from('sanction_requests')
    .select('id, host_club_id, requester_person_id, payload, sanction_id, created_event_id, status')
    .eq('id', requestId)
    .maybeSingle();
  if (!sreq) return json({ ok: false, error: 'Sanction request not found.' }, 404);

  const payload = (sreq.payload as Record<string, unknown>) ?? {};
  const eventName = payload.eventName as string | undefined;
  const label = esc(eventName ?? 'event');
  // Team members land on the vote page (isSanctioning-gated); the requester is
  // NOT on the Sanctioning Team and that page 404s/blocks them (E-01, reviewed
  // 2026-08-27) — they get a link to their own "Your sanction requests" status
  // section on the request form page instead.
  const teamLink = `${appUrl}/#/sanctioning/${requestId}`;
  const requesterLink = `${appUrl}/#/sanction`;

  /** Resolve the live Sanctioning Team's email recipients. Only `role =
   *  'sanctioning'` — NOT 'admin' — matching the owners' 2026-08-26 decision
   *  that only the role which can actually vote should be the audience. */
  async function sanctioningTeamRecipients() {
    const { data: roleRows } = await db.from('user_roles').select('user_id').eq('role', 'sanctioning');
    const ids = (roleRows ?? []).map((r: { user_id: string }) => r.user_id);
    if (ids.length === 0) return [];
    const { data: people } = await db.from('people').select('first_name, last_name, email').in('auth_user_id', ids);
    return dedupeEmailRecipients(people ?? []);
  }

  if (event === 'submitted') {
    const [teamRecipients, requesterRow, hostClubRow, levelName] = await Promise.all([
      sanctioningTeamRecipients(),
      sreq.requester_person_id
        ? db.from('people').select('first_name, last_name, email').eq('id', sreq.requester_person_id).maybeSingle()
        : Promise.resolve({ data: null }),
      db.from('clubs').select('name').eq('id', sreq.host_club_id).maybeSingle(),
      levelNameLookup(payload),
    ]);
    const requester = requesterRow.data;
    const hostClubName = hostClubRow.data?.name as string | undefined;

    // Team send — independent of whether the requester confirmation below
    // succeeds. An empty team (nobody currently holds the role) is not an
    // error; it just sends nothing on this side.
    let teamSentCount = 0, teamFailedCount = 0, teamOk = true;
    let teamFailed: { email: string; error: string }[] | undefined;
    if (teamRecipients.length > 0) {
      const subject = `New sanction request: ${eventName ?? 'event'}`;
      const html = renderEmail({
        heading: 'New sanction request',
        bodyHtml: `<p>Hello,</p>
<p>A new event sanction request (<strong>${label}</strong>) has been submitted and is awaiting the Sanctioning Team's vote.</p>`,
        cta: { text: 'Review & vote', href: teamLink },
      });
      const messages: EmailMessage[] = teamRecipients.map((r) => ({ to: `${r.name} <${r.email}>`, subject, html }));
      const result = await sendBatch(messages);
      teamSentCount = result.sentCount; teamFailedCount = result.failedCount; teamOk = result.ok; teamFailed = result.failed;
    }

    // Requester confirmation — independent of the team send above (E-01-01:
    // the requester previously got NO acknowledgement at all).
    let requesterSent = false;
    let requesterError: string | undefined;
    const requesterEmail = (requester?.email ?? '').trim();
    if (EMAIL_RE.test(requesterEmail)) {
      const subject = `Sanction request submitted: ${eventName ?? 'your event'}`;
      const html = renderEmail({
        heading: 'Sanction request submitted',
        bodyHtml: `<p>Hi ${esc(requester?.first_name ?? '')},</p>
<p>We've received your sanction request for <strong>${label}</strong>${hostClubName ? ` hosted by <strong>${esc(hostClubName)}</strong>` : ''}.</p>
<p>The Sanctioning Team will review and vote within 7 days. We'll email you again once a decision is made.</p>
<p>Here's a summary of what you submitted. You can also open <strong>Details</strong> on Your Sanction Requests any time; contact a UCG administrator if something needs to change.</p>
${summaryTableHtml(payload, hostClubName, levelName)}`,
        cta: { text: 'Track your request', href: requesterLink },
      });
      try {
        await sendOne({ to: `${requester?.first_name ?? ''} ${requester?.last_name ?? ''} <${requesterEmail}>`.trim(), subject, html });
        requesterSent = true;
      } catch (e) {
        requesterError = `Requester confirmation failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    }

    return json({
      ok: teamOk && !requesterError,
      sentCount: teamSentCount + (requesterSent ? 1 : 0),
      failedCount: teamFailedCount + (requesterError ? 1 : 0),
      failed: teamFailed,
      ...(requesterError ? { requesterError } : {}),
    });
  }

  // approved / rejected → requester email (unchanged decision), PLUS a
  // Sanctioning Team notice on approval only (E-01-03). Independent sends.
  //
  // Guard: only email a decision the database actually holds. The client
  // drains its write queue before calling, so a mismatch here means the
  // decision write failed (e.g. RLS) — refuse rather than send an "approved"
  // email for a request that is still 'voting' (UAT E-01-03, 2026-09-06).
  if (sreq.status !== event) {
    return json({ ok: false, error: `Request is '${sreq.status}', not '${event}' — the decision hasn't been saved yet.` }, 409);
  }
  const { data: requester } = sreq.requester_person_id
    ? await db.from('people').select('first_name, last_name, email').eq('id', sreq.requester_person_id).maybeSingle()
    : { data: null };
  const requesterEmail = (requester?.email ?? '').trim();

  let subject: string; let html: string;
  if (event === 'approved') {
    // Event routes are keyed by slug. The host dashboard is /events/:slug/host
    // — NOT /manage, which 404s (E-01-01, this was a broken link in prod).
    const { data: eventRow } = sreq.created_event_id
      ? await db.from('events').select('slug').eq('id', sreq.created_event_id).maybeSingle()
      : { data: null };
    const eventLink = eventRow?.slug ? `${appUrl}/#/events/${eventRow.slug}/host` : requesterLink;
    // Approval publishes the event LIVE (owners 2026-08-27) — say so, and
    // send the host to their dashboard, not the request summary (E-01-03).
    const regOpens = typeof payload.regOpens === 'string' && payload.regOpens ? payload.regOpens.replace('T', ' ') : '';
    subject = `Approved: ${eventName ?? 'your event'} sanction`;
    html = renderEmail({
      heading: 'Sanction approved',
      bodyHtml: `<p>Hi ${esc(requester?.first_name ?? '')},</p>
<p>Your sanction request for <strong>${label}</strong> has been <strong>approved</strong>${sreq.sanction_id ? ` (Sanction ID: ${esc(String(sreq.sanction_id))})` : ''}.</p>
<p>Your event has been created and is live on the platform${regOpens ? `; registration opens ${esc(regOpens)}` : ''}. Use your host dashboard to set up sessions, scoring, and the rest of the event details.</p>`,
      cta: { text: eventRow?.slug ? 'Open your host dashboard' : 'View your requests', href: eventLink },
    });
  } else {
    subject = `Update on your ${eventName ?? 'event'} sanction request`;
    html = renderEmail({
      heading: 'Sanction not approved',
      bodyHtml: `<p>Hi ${esc(requester?.first_name ?? '')},</p>
<p>After review, your sanction request for <strong>${label}</strong> was <strong>not approved</strong>.</p>
<p>Reply to this email or contact the Sanctioning Team if you have questions.</p>`,
    });
  }

  let requesterSent = false;
  let requesterError: string | undefined;
  if (EMAIL_RE.test(requesterEmail)) {
    try {
      await sendOne({ to: `${requester?.first_name ?? ''} ${requester?.last_name ?? ''} <${requesterEmail}>`.trim(), subject, html });
      requesterSent = true;
    } catch (e) {
      requesterError = `Requester email failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  let teamSentCount = 0, teamFailedCount = 0, teamOk = true;
  let teamFailed: { email: string; error: string }[] | undefined;
  if (event === 'approved') {
    const teamRecipients = await sanctioningTeamRecipients();
    if (teamRecipients.length > 0) {
      const teamSubject = `Sanction approved: ${eventName ?? 'event'}`;
      const teamHtml = renderEmail({
        heading: 'Sanction approved',
        bodyHtml: `<p>Hello,</p>
<p><strong>${label}</strong> has been approved${sreq.sanction_id ? ` (Sanction ID: ${esc(String(sreq.sanction_id))})` : ''}.</p>`,
        cta: { text: 'View request', href: teamLink },
      });
      const messages: EmailMessage[] = teamRecipients.map((r) => ({ to: `${r.name} <${r.email}>`, subject: teamSubject, html: teamHtml }));
      const result = await sendBatch(messages);
      teamSentCount = result.sentCount; teamFailedCount = result.failedCount; teamOk = result.ok; teamFailed = result.failed;
    }
  }

  return json({
    ok: teamOk && !requesterError,
    sentCount: (requesterSent ? 1 : 0) + teamSentCount,
    failedCount: teamFailedCount + (requesterError ? 1 : 0),
    failed: teamFailed,
    ...(requesterError ? { requesterError } : {}),
  });
});
