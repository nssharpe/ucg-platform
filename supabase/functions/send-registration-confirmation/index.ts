// send-registration-confirmation — the $0 host-club SELF-registration
// confirmation (UAT E-02-02, owner decision 2026-08-27).
//
// Root cause this closes: a host-club registration is created `paid:true`
// with NO cart line (registrationEntryFee prices it $0 for the event's own
// host club — see registrations-and-camps.md), so it never goes through
// checkout at all. `_shared/fulfill.ts`'s `emailReceipt` — the only place a
// registration confirmation is normally sent — only ever runs from
// stripe-webhook/create-checkout-session fulfillment, so this class of
// registration got NO email whatsoever.
//
// Owner rule (verbatim): send a confirmation when a person registers
// THEMSELVES from My Registrations / Register-Self AND is in the host club;
// a CLUB MANAGER registering via Club Registrations sends NONE. This
// function enforces exactly that as its anti-abuse guard — it is NOT a
// club-manager notification path: the caller must BE the athlete of every
// `regId` passed, full stop (mirrors `withdraw-registration`'s self-only
// shape, which deliberately has no manager branch either). The single
// client call site is `Events.tsx`'s `SelfRegModal.persistRegs` `hostFree`
// branch — `Club.tsx`'s manager-side `saveRegs` never calls this.
//
// The email itself reuses `_shared/registration-confirmation.ts` — the SAME
// subject rule and "A message from your host" card `_shared/fulfill.ts`'s
// paid-receipt path renders — so a host's registrants see one consistent
// look regardless of which path fired. The only structural difference is
// this path has nothing to receipt: no invoice number, no line-item table
// (nothing was purchased).
//
// verify_jwt STAYS TRUE (default) — this is NOT one of the three
// --no-verify-jwt functions (stripe-webhook, sms-webhook,
// notify-manager-access-denied).
//
// Secrets: RESEND_API_KEY, RESEND_FROM, APP_PUBLIC_URL (shared/optional with
// sane fallbacks in _shared/resend.ts). Auto-provided: SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY.
//
// Best-effort by design: the CALLER (Events.tsx) already completed the
// registration write before invoking this — a failure or non-2xx response
// here must never be read as "the registration failed." The client's
// `sendRegistrationConfirmation` wrapper (`src/lib/supabase.ts`) also awaits
// the write queue draining before invoking, since `pushRegistration` is a
// fire-and-forget queue enqueue, not an awaited write — without that wait
// this function could look up `regIds` before the rows actually exist.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendOne } from '../_shared/resend.ts';
import { renderEmail } from '../_shared/email-layout.ts';
import { confirmationSubject, hostMessageCardHtml, registeredForLineHtml } from '../_shared/registration-confirmation.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

interface Payload {
  regIds?: string[];
  eventId?: string;
}

interface RegRow {
  id: string;
  event_id: string;
  athlete_id: string | null;
}

interface EventRow {
  id: string;
  name: string | null;
  confirmation_email: { bodyHtml?: string } | null;
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

  // --- Validate payload ---
  let payload: Payload;
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }
  const regIds = Array.isArray(payload.regIds)
    ? payload.regIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    : [];
  const eventId = typeof payload.eventId === 'string' ? payload.eventId.trim() : '';
  if (!regIds.length && !eventId) return json({ error: 'regIds (or eventId) is required.' }, 400);

  // --- Resolve the caller's own person row (fail closed: no person ⇒ 403) ---
  const { data: caller, error: callerErr } = await db
    .from('people')
    .select('id, email, first_name, last_name')
    .eq('auth_user_id', userData.user.id)
    .maybeSingle();
  if (callerErr) return json({ error: 'Could not verify your account.' }, 403);
  if (!caller) return json({ error: 'No profile is linked to your account.' }, 403);
  const callerRow = caller as { id: string; email: string | null; first_name: string | null; last_name: string | null };

  // --- Resolve the target registrations. `eventId` (no `regIds`) is scoped
  // to the caller's OWN live registrations for that event — never a
  // league-wide lookup — so it carries the exact same authorization shape as
  // the `regIds` path below. ---
  let regRows: RegRow[];
  if (regIds.length) {
    const { data, error } = await db
      .from('registrations')
      .select('id, event_id, athlete_id')
      .in('id', regIds);
    if (error) return json({ error: 'Could not look up the registration(s).' }, 500);
    regRows = (data ?? []) as unknown as RegRow[];
    if (regRows.length === 0) return json({ error: 'Registration(s) not found.' }, 404);
  } else {
    const { data, error } = await db
      .from('registrations')
      .select('id, event_id, athlete_id')
      .eq('event_id', eventId)
      .eq('athlete_id', callerRow.id)
      .eq('refunded', false);
    if (error) return json({ error: 'Could not look up the registration(s).' }, 500);
    regRows = (data ?? []) as unknown as RegRow[];
    if (regRows.length === 0) return json({ error: 'Registration(s) not found.' }, 404);
  }

  // --- Anti-abuse guard: the caller must BE the athlete of EVERY row. No
  // club-manager branch exists here at all — reject outright rather than
  // silently filtering to "just the caller's own rows among these", which
  // would mask a caller passing someone else's regId. ---
  if (regRows.some((r) => r.athlete_id !== callerRow.id)) {
    return json({ error: 'You do not have permission to send a confirmation for this registration.' }, 403);
  }

  const toEmail = (callerRow.email ?? '').trim();
  if (!EMAIL_RE.test(toEmail)) {
    // Not an error condition worth failing loudly over — best-effort email,
    // and a missing/invalid address is a data problem, not a caller error.
    return json({ ok: true, sent: false, note: 'No valid email on file.' });
  }
  const forName = `${callerRow.first_name ?? ''} ${callerRow.last_name ?? ''}`.trim() || 'Member';

  // --- Load the referenced event(s) ---
  const eventIds = [...new Set(regRows.map((r) => r.event_id))];
  const { data: evRows, error: evErr } = await db
    .from('events')
    .select('id, name, confirmation_email')
    .in('id', eventIds);
  if (evErr) return json({ error: 'Could not look up the event(s).' }, 500);
  const events = (evRows ?? []) as unknown as EventRow[];

  const eventNames = events.map((ev) => ev.name);
  const subject = confirmationSubject(eventNames);
  const hostCardsHtml = events.map((ev) => hostMessageCardHtml(ev.confirmation_email?.bodyHtml)).join('');
  const registeredHtml = registeredForLineHtml(eventNames);

  const html = renderEmail({
    heading: "You're registered",
    bodyHtml: `<p>Hi ${esc(forName)},</p>
${hostCardsHtml}${registeredHtml}`,
    cta: { text: 'View Registration Details', href: `${appUrl}/#/me/registrations` },
  });

  try {
    await sendOne({
      to: `${forName} <${toEmail}>`,
      subject,
      html,
    });
  } catch (e) {
    // Best-effort: the registration write already succeeded before this
    // function was ever invoked. Report the failure so it's visible in the
    // function's own logs, but never as a 500 that would read like the
    // registration itself failed.
    console.error('send-registration-confirmation: send failed', e instanceof Error ? e.message : String(e));
    return json({ ok: false, sent: false, error: e instanceof Error ? e.message : String(e) });
  }

  return json({ ok: true, sent: true });
});
