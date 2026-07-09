// send-event-email — event-scoped communication (event-mgmt v2 §J).
//
// Broader auth surface than send-email: authorized iff the caller is an
// admin, holds the sanctioning role, manages the event's host club, or holds
// an event_admins grant for this event. EMAIL ONLY by controller decision
// (Nate, 2026-07-09) — Julia's spec asked for SMS too, but non-admin hosts
// get no SMS surface here; the existing league SMS path (send-sms) stays
// admin-only and is driven client-side from the EventCommunicate page for
// admins. Revisit if hosts need SMS later.
//
// Recipients are resolved SERVER-SIDE from `registrations`/`people`/
// `club_managers`/`clubs` (service role) — the client never supplies a
// recipient list, so a host can't be fed (or feed) an arbitrary address list
// for real sends. `test: true` is restricted to the caller's OWN auth email
// for the same reason (a host must not get an arbitrary-address test-send
// surface — PII/spam decision).
//
// Sends through the Resend batch API via the shared helper in _shared/resend.ts.
//
// Secrets (set via `supabase secrets set`):
//   RESEND_API_KEY      Resend API key
// Auto-provided by the platform: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
//
// verify_jwt STAYS TRUE for this function (caller must be signed in) — it is
// NOT one of the three --no-verify-jwt functions (stripe-webhook, sms-webhook,
// notify-manager-access-denied). See supabase/README.md's function inventory.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendBatch, type EmailMessage } from '../_shared/resend.ts';
import { dedupeContacts, matchesEventCommFilters, type EventCommFilters, type RegistrationFacetRow } from '../_shared/event-comm.ts';

interface Payload {
  eventId?: string;
  subject?: string;
  html?: string;
  text?: string;
  replyTo?: string;
  fromAlias?: string;
  cc?: string[];
  filters?: EventCommFilters;
  test?: boolean;
}

// Same cap-and-reject shape as send-email/send-sms (mirrored, not invented —
// neither of those actually chunks into multiple Resend batch calls; they
// each hold ONE hard cap and reject over it). Raise this the same way those
// would be raised: once on a paid Resend plan with a higher daily limit.
const MAX_RECIPIENTS = 50;
const MAX_CC = 5;

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // --- Authenticate (any signed-in user) ---
  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'Missing Authorization header.' }, 401);
  const { data: userData, error: userErr } = await db.auth.getUser(token);
  if (userErr || !userData.user) return json({ error: 'Invalid or expired session.' }, 401);
  const authUserId = userData.user.id;
  const callerEmail = userData.user.email ?? null;

  // --- Validate payload ---
  let payload: Payload;
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }

  const eventId = typeof payload.eventId === 'string' ? payload.eventId.trim() : '';
  if (!eventId) return json({ error: 'eventId is required.' }, 400);

  // --- Authorize: admin OR sanctioning OR manages the host club OR an
  //     event_admins grant for this event. Every lookup is fail-closed: any
  //     query error denies rather than silently passing through. ---
  const { data: eventRow, error: eventErr } = await db
    .from('events')
    .select('id, host_club_id')
    .eq('id', eventId)
    .maybeSingle();
  if (eventErr) return json({ error: 'Could not verify event.' }, 403);
  if (!eventRow) return json({ error: 'Event not found.' }, 404);

  const { data: roles, error: roleErr } = await db
    .from('user_roles')
    .select('role')
    .eq('user_id', authUserId);
  if (roleErr) return json({ error: 'Could not verify permissions.' }, 403);
  const roleNames = (roles ?? []).map((r: { role: string }) => r.role);
  const isAdmin = roleNames.includes('admin');
  const isSanctioning = isAdmin || roleNames.includes('sanctioning');

  let isHost = false;
  let isEventAdmin = false;
  if (!isSanctioning) {
    const { data: person, error: personErr } = await db
      .from('people')
      .select('id')
      .eq('auth_user_id', authUserId)
      .maybeSingle();
    if (personErr) return json({ error: 'Could not verify permissions.' }, 403);
    if (person) {
      const { data: mgr, error: mgrErr } = await db
        .from('club_managers')
        .select('club_id')
        .eq('club_id', eventRow.host_club_id)
        .eq('person_id', person.id)
        .maybeSingle();
      if (mgrErr) return json({ error: 'Could not verify permissions.' }, 403);
      isHost = !!mgr;
    }
    if (!isHost) {
      const { data: ea, error: eaErr } = await db
        .from('event_admins')
        .select('event_id')
        .eq('event_id', eventId)
        .eq('user_id', authUserId)
        .maybeSingle();
      if (eaErr) return json({ error: 'Could not verify permissions.' }, 403);
      isEventAdmin = !!ea;
    }
  }

  if (!isSanctioning && !isHost && !isEventAdmin) {
    return json({ error: 'You do not have access to email this event\'s registrants.' }, 403);
  }

  const subject = (payload.subject ?? '').trim();
  const html = payload.html ?? '';
  const text = payload.text ?? '';
  const replyTo = typeof payload.replyTo === 'string' && payload.replyTo.trim() ? payload.replyTo.trim() : undefined;
  const fromAlias = typeof payload.fromAlias === 'string' && payload.fromAlias.trim() ? payload.fromAlias.trim() : undefined;
  const cc = Array.isArray(payload.cc)
    ? payload.cc.filter((c): c is string => typeof c === 'string' && EMAIL_RE.test(c.trim())).slice(0, MAX_CC)
    : [];
  const isTest = payload.test === true;
  const filters: EventCommFilters = {
    roles: Array.isArray(payload.filters?.roles) ? payload.filters!.roles.filter((r): r is EventCommFilters['roles'][number] => r === 'athlete' || r === 'manager' || r === 'clubEmail') : [],
    sessionIds: payload.filters?.sessionIds,
    levelIds: payload.filters?.levelIds,
    disciplines: payload.filters?.disciplines,
  };

  if (!subject) return json({ error: 'Subject is required.' }, 400);
  if (!html && !text) return json({ error: 'Email body is required.' }, 400);

  // --- Test send: caller's own auth email ONLY (never an arbitrary address —
  //     a host must not get a probe-any-address surface). ---
  if (isTest) {
    if (!callerEmail) return json({ error: 'Your account has no email on file to test-send to.' }, 400);
    let result;
    try {
      result = await sendBatch([{
        to: callerEmail,
        subject: `[Test] ${subject}`,
        html: html || undefined,
        text: text || undefined,
        reply_to: replyTo,
        fromName: fromAlias,
        cc: cc.length ? cc : undefined,
      }]);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
    return json({ sent: result.sentCount, failed: result.failedCount, recipientCount: 1 });
  }

  if (filters.roles.length === 0) return json({ error: 'Select at least one recipient role.' }, 400);

  // --- Resolve recipients server-side (service role; never trust a client
  //     recipient list): non-refunded registrations of the event, apply
  //     session/level/discipline filters, then fan out per role. ---
  const { data: regRows, error: regErr } = await db
    .from('registrations')
    .select('athlete_id, club_id, session_id, level_id, discipline, refunded')
    .eq('event_id', eventId);
  if (regErr) return json({ error: 'Could not load registrations.' }, 500);

  const matched = ((regRows ?? []) as (RegistrationFacetRow & { athlete_id: string; club_id: string | null })[])
    .filter((r) => matchesEventCommFilters(r, filters));

  const candidates: { email: string | null | undefined; name?: string | null }[] = [];

  if (filters.roles.includes('athlete')) {
    const athleteIds = [...new Set(matched.map((r) => r.athlete_id))];
    if (athleteIds.length) {
      const { data: people, error: peopleErr } = await db
        .from('people')
        .select('email, first_name, last_name')
        .in('id', athleteIds);
      if (peopleErr) return json({ error: 'Could not load athlete contacts.' }, 500);
      for (const p of people ?? []) candidates.push({ email: p.email, name: `${p.first_name} ${p.last_name}`.trim() });
    }
  }

  const clubIds = [...new Set(matched.map((r) => r.club_id).filter((c): c is string => !!c))];

  if (filters.roles.includes('manager') && clubIds.length) {
    const { data: mgrRows, error: mgrErr } = await db
      .from('club_managers')
      .select('person_id')
      .in('club_id', clubIds);
    if (mgrErr) return json({ error: 'Could not load club manager contacts.' }, 500);
    const managerPersonIds = [...new Set((mgrRows ?? []).map((m: { person_id: string }) => m.person_id))];
    if (managerPersonIds.length) {
      const { data: people, error: peopleErr } = await db
        .from('people')
        .select('email, first_name, last_name')
        .in('id', managerPersonIds);
      if (peopleErr) return json({ error: 'Could not load club manager contacts.' }, 500);
      for (const p of people ?? []) candidates.push({ email: p.email, name: `${p.first_name} ${p.last_name}`.trim() });
    }
  }

  if (filters.roles.includes('clubEmail') && clubIds.length) {
    const { data: clubs, error: clubErr } = await db
      .from('clubs')
      .select('email, name')
      .in('id', clubIds);
    if (clubErr) return json({ error: 'Could not load club contacts.' }, 500);
    for (const c of clubs ?? []) candidates.push({ email: c.email, name: c.name });
  }

  const recipients = dedupeContacts(candidates);
  if (recipients.length === 0) return json({ error: 'No recipients matched the selected filters.' }, 400);
  if (recipients.length > MAX_RECIPIENTS) {
    return json({
      error: `This sender is capped at ${MAX_RECIPIENTS} recipients (got ${recipients.length}). ` +
        `Narrow the filters, or raise MAX_RECIPIENTS once on a paid Resend plan with a higher daily limit.`,
    }, 400);
  }

  // --- Send via Resend batch (one distinct message per recipient) ---
  const messages: EmailMessage[] = recipients.map((r) => ({
    to: r.name ? `${r.name} <${r.email}>` : r.email,
    subject,
    html: html || undefined,
    text: text || undefined,
    reply_to: replyTo,
    fromName: fromAlias,
    cc: cc.length ? cc : undefined,
  }));

  let result;
  try {
    result = await sendBatch(messages);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
  return json({ sent: result.sentCount, failed: result.failedCount, recipientCount: recipients.length });
});
