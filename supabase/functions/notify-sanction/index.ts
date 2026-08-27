// notify-sanction — sanction-request lifecycle emails.
//   event 'submitted' → notify Sanctioning Team + admins (a new request is awaiting review —
//     this stays admin-inclusive/informational by design, UAT round 2 2026-08-26; ONLY the
//     scheduled-dispatch repeating vote-chase reminders were narrowed to sanctioning-only,
//     since only that role can actually cast a vote — see sanction_votes_write, 20260826000000).
//   event 'approved' / 'rejected' → notify the host (requester) of the decision.
// The request is re-read server-side by id; the caller only sends { requestId, event }.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendBatch, sendOne, type EmailMessage } from '../_shared/resend.ts';
import { renderEmail } from '../_shared/email-layout.ts';

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

  const { data: sreq } = await db
    .from('sanction_requests')
    .select('id, host_club_id, requester_person_id, payload, sanction_id, created_event_id')
    .eq('id', requestId)
    .maybeSingle();
  if (!sreq) return json({ ok: false, error: 'Sanction request not found.' }, 404);

  const eventName = (sreq.payload as Record<string, unknown>)?.eventName as string | undefined;
  const label = esc(eventName ?? 'event');
  const reqLink = `${appUrl}/#/sanctioning/${requestId}`;

  if (event === 'submitted') {
    // Sanctioning Team + admins.
    const { data: roleRows } = await db.from('user_roles').select('user_id').in('role', ['sanctioning', 'admin']);
    const ids = (roleRows ?? []).map((r: { user_id: string }) => r.user_id);
    if (ids.length === 0) return json({ ok: true, sentCount: 0, note: 'No sanctioning team / admins.' });
    const { data: people } = await db.from('people').select('first_name, last_name, email').in('auth_user_id', ids);
    const seen = new Set<string>();
    const recipients = (people ?? []).filter((p) => {
      const e = (p.email ?? '').trim().toLowerCase();
      if (!EMAIL_RE.test(e) || seen.has(e)) return false; seen.add(e); return true;
    });
    if (recipients.length === 0) return json({ ok: true, sentCount: 0, note: 'No team emails.' });
    const subject = `New sanction request: ${eventName ?? 'event'}`;
    const html = renderEmail({
      heading: 'New sanction request',
      bodyHtml: `<p>Hello,</p>
<p>A new event sanction request (<strong>${label}</strong>) has been submitted and is awaiting the Sanctioning Team's vote.</p>`,
      cta: { text: 'Review & vote', href: reqLink },
    });
    const messages: EmailMessage[] = recipients.map((r) => ({ to: `${r.first_name} ${r.last_name} <${(r.email as string).trim()}>`, subject, html }));
    const result = await sendBatch(messages);
    return json({ ok: result.ok, sentCount: result.sentCount, failedCount: result.failedCount, failed: result.failed });
  }

  // approved / rejected → notify the requester.
  const { data: requester } = sreq.requester_person_id
    ? await db.from('people').select('first_name, last_name, email').eq('id', sreq.requester_person_id).maybeSingle()
    : { data: null };
  const email = (requester?.email ?? '').trim();
  if (!EMAIL_RE.test(email)) return json({ ok: true, sentCount: 0, note: 'Requester has no valid email.' });

  let subject: string; let html: string;
  if (event === 'approved') {
    // Event routes are keyed by slug (/events/:slug/manage), not the event id we store.
    const { data: event } = sreq.created_event_id
      ? await db.from('events').select('slug').eq('id', sreq.created_event_id).maybeSingle()
      : { data: null };
    const eventLink = event?.slug ? `${appUrl}/#/events/${event.slug}/manage` : reqLink;
    subject = `Approved: ${eventName ?? 'your event'} sanction`;
    html = renderEmail({
      heading: 'Sanction approved',
      bodyHtml: `<p>Hi ${esc(requester?.first_name ?? '')},</p>
<p>Your sanction request for <strong>${label}</strong> has been <strong>approved</strong>${sreq.sanction_id ? ` (Sanction ID: ${esc(String(sreq.sanction_id))})` : ''}.</p>
<p>A draft event has been created.</p>`,
      cta: { text: 'Open your event', href: eventLink },
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
  try { await sendOne({ to: `${requester?.first_name ?? ''} ${requester?.last_name ?? ''} <${email}>`.trim(), subject, html }); }
  catch (e) { return json({ ok: false, error: `Email failed: ${e instanceof Error ? e.message : String(e)}` }, 500); }
  return json({ ok: true, sentCount: 1 });
});
