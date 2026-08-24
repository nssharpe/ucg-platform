// withdraw-registration — athlete self-serve WITHDRAWAL (product owners'
// decision, 2026-08-23). An authenticated athlete withdraws THEMSELVES from
// an event: resolves every one of their own non-refunded, non-waitlisted,
// not-yet-withdrawn registration rows for the same (event, club) as `regId`
// — matching request-refund's per-registration GROUPING (a multi-discipline
// athlete withdraws from the whole event in one call, not one discipline at
// a time) — and applies one of two shapes depending on the event's
// `last_date_to_edit` (`withdrawalPlan`, `_shared/withdrawal.ts`):
//
//   - Before the deadline (or the event has none): every matched row is
//     DELETED outright — the exact same full-removal shape an on-time
//     refund approval uses (`process-refund`, ~L393-450); `scores` cascades
//     via its `reg_id` FK, same as there.
//   - At/after the deadline: every matched row is KEPT with `apparatus: []`
//     (+ `apparatus_levels`/`partner_athlete_id` cleared) and
//     `withdrawn_at` stamped — NEVER `refunded: true`, since no money moved
//     (money-invariants.md: `refunded` means a Stripe refund happened).
//     `registrations.withdrawn_at` (migration `20260824100000`) is what
//     lets rosters/results tell "withdrew late" apart from an ordinary
//     blanked row or a post-deadline REFUND approval.
//
// Ownership: the caller must BE the registration's own athlete — mirrors
// request-refund's self-serve branch but deliberately DROPS its
// club-manager branch: a club manager cannot withdraw an athlete on their
// behalf, only the athlete themselves.
//
// Idempotent: a regId that's already been fully removed (prior withdrawal
// or a refund approval) 404s; one that's already been scratched/refunded/
// has a pending refund request 409s with a clear message — never a silent
// no-op 200.
//
// Emails (best-effort; never block the write above):
//   (a) confirmation to the athlete — refund-mention varies by
//       `withdrawalEmailVariant` (rule 6): a refund-eligible event never
//       mentions a refund (a withdrawable reg there is by construction the
//       $0 case — see rule 2, request-refund's eligibility mirror below);
//       a non-eligible event points the athlete at the host club's contact
//       email UNLESS they compete for that same club.
//   (b) notification to the event host — resolved the same way
//       `_shared/fulfill.ts`'s per-event confirmation cc resolves a
//       director: `events.director.email` first, falling back to the host
//       club's own `clubs.email`.
//
// verify_jwt STAYS TRUE (default) — this is NOT one of the three
// --no-verify-jwt functions (stripe-webhook, sms-webhook,
// notify-manager-access-denied).
//
// Secrets: RESEND_API_KEY, RESEND_FROM, APP_PUBLIC_URL (all shared/optional
// with sane fallbacks in _shared/resend.ts). Auto-provided: SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendOne } from '../_shared/resend.ts';
import { renderEmail } from '../_shared/email-layout.ts';
import { withdrawalPlan, withdrawalEmailVariant, type WithdrawalPlan } from '../_shared/withdrawal.ts';

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

type DB = ReturnType<typeof createClient>;

interface Payload {
  regId?: string;
}

interface RegRow {
  id: string;
  event_id: string;
  athlete_id: string;
  club_id: string | null;
  discipline: string;
  refunded: boolean;
  refund_requested: boolean;
  withdrawn_at: string | null;
  waitlisted: boolean;
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

  // --- Validate payload ---
  let payload: Payload;
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }
  const regId = typeof payload.regId === 'string' ? payload.regId.trim() : '';
  if (!regId) return json({ error: 'regId is required.' }, 400);

  // --- Resolve the caller's own person row (fail closed: no person ⇒ 403) ---
  const { data: caller, error: callerErr } = await db
    .from('people')
    .select('id, email, first_name, last_name')
    .eq('auth_user_id', authUserId)
    .maybeSingle();
  if (callerErr) return json({ error: 'Could not verify your account.' }, 403);
  if (!caller) return json({ error: 'No profile is linked to your account.' }, 403);

  // --- Resolve the target row. A regId that no longer exists (already
  // removed by a prior withdrawal, or a refund approval deleting it) is the
  // idempotent "already handled" case — 404, not a silent success. ---
  const { data: regRow, error: regErr } = await db
    .from('registrations')
    .select('id, event_id, athlete_id, club_id, discipline, refunded, refund_requested, withdrawn_at, waitlisted')
    .eq('id', regId)
    .maybeSingle();
  if (regErr) return json({ error: 'Could not look up the registration.' }, 500);
  if (!regRow) return json({ error: 'Registration not found — it may already have been withdrawn.' }, 404);
  const reg = regRow as unknown as RegRow;

  // --- Ownership: the caller must BE the athlete. No club-manager branch —
  // withdrawal is athlete-only, unlike request-refund. Fail closed. ---
  if (reg.athlete_id !== caller.id) {
    return json({ error: 'You do not have permission to withdraw this registration.' }, 403);
  }
  if (reg.waitlisted) {
    return json({ error: 'This registration is on the waitlist — use "Leave waitlist" instead.' }, 400);
  }
  if (reg.refunded) {
    return json({ error: 'This registration has already been refunded.' }, 409);
  }
  if (reg.refund_requested) {
    return json({ error: 'A refund request is already pending for this registration — withdrawal is unavailable until it is resolved.' }, 409);
  }
  if (reg.withdrawn_at) {
    return json({ error: 'This registration has already been withdrawn.' }, 409);
  }

  // --- Resolve the whole group: every one of this athlete's non-refunded,
  // non-waitlisted, not-yet-withdrawn, non-refund-requested rows for the
  // same (event, club) — matching request-refund's per-registration
  // grouping (a multi-discipline athlete withdraws from the whole event in
  // one call). ---
  let groupQuery = db
    .from('registrations')
    .select('id, event_id, athlete_id, club_id, discipline, refunded, refund_requested, withdrawn_at, waitlisted')
    .eq('event_id', reg.event_id)
    .eq('athlete_id', reg.athlete_id)
    .eq('refunded', false)
    .eq('waitlisted', false)
    .eq('refund_requested', false)
    .is('withdrawn_at', null);
  // `.eq('club_id', null)` compiles to `club_id = NULL`, which never matches
  // — a nullable FK needs `.is()` instead when the reference row's own value
  // is null (registrations.club_id is nullable in the schema even though
  // every client-created row stamps a string, possibly '').
  groupQuery = reg.club_id === null ? groupQuery.is('club_id', null) : groupQuery.eq('club_id', reg.club_id);
  const { data: groupRows, error: groupErr } = await groupQuery;
  if (groupErr) return json({ error: 'Could not look up this event\'s registrations.' }, 500);
  const group = (groupRows ?? []) as unknown as RegRow[];
  if (group.length === 0) {
    return json({ error: 'Registration not found — it may already have been withdrawn.' }, 404);
  }
  const groupIds = group.map((r) => r.id);

  // --- Event + host club (for the plan cutoff, the refund-eligibility
  // mirror, and the email variant/host notification). ---
  const { data: eventRow, error: eventErr } = await db
    .from('events')
    .select('id, name, host_club_id, last_date_to_edit, ucg_hosted, director')
    .eq('id', reg.event_id)
    .maybeSingle();
  if (eventErr) return json({ error: 'Could not look up the event.' }, 500);
  if (!eventRow) return json({ error: 'Event not found.' }, 500);
  const event = eventRow as unknown as {
    id: string; name: string; host_club_id: string | null;
    last_date_to_edit: string | null; ucg_hosted: string | null;
    director: { name?: string; email?: string; ccOnConfirmation?: boolean } | null;
  };

  let hostClub: { id: string; name: string; email: string | null; is_league_host: boolean | null } | null = null;
  if (event.host_club_id) {
    const { data: clubRow } = await db
      .from('clubs')
      .select('id, name, email, is_league_host')
      .eq('id', event.host_club_id)
      .maybeSingle();
    hostClub = (clubRow as typeof hostClub) ?? null;
  }

  // Mirrors `eventIsRefundEligible` (events-core.ts) / request-refund's
  // identical block: whichever events show the in-app "Request a refund"
  // flow at all. "UCG-hosted" in the withdrawal spec means exactly this —
  // see `_shared/withdrawal.ts`'s `withdrawalEmailVariant` doc comment.
  const refundEligible = !!event.ucg_hosted || hostClub?.is_league_host === true;

  const now = new Date();
  const plan: WithdrawalPlan = withdrawalPlan({ now, lastDateToEdit: event.last_date_to_edit });

  // --- Apply. Scoped by the SAME conditions as the group read above, so a
  // concurrent duplicate call (double-click, retry) can claim at most once —
  // a second writer matches zero rows and reports the same 409 a plain
  // re-read would. ---
  if (plan === 'remove') {
    const { data: deleted, error: delErr } = await db
      .from('registrations')
      .delete()
      .in('id', groupIds)
      .eq('refunded', false)
      .is('withdrawn_at', null)
      .select('id');
    if (delErr) return json({ error: 'Could not withdraw this registration.' }, 500);
    if (!deleted || deleted.length === 0) {
      return json({ error: 'This registration has already been withdrawn.' }, 409);
    }
  } else {
    const { data: updated, error: updErr } = await db
      .from('registrations')
      .update({ apparatus: [], apparatus_levels: null, partner_athlete_id: null, withdrawn_at: now.toISOString() })
      .in('id', groupIds)
      .eq('refunded', false)
      .is('withdrawn_at', null)
      .select('id');
    if (updErr) return json({ error: 'Could not withdraw this registration.' }, 500);
    if (!updated || updated.length === 0) {
      return json({ error: 'This registration has already been withdrawn.' }, 409);
    }
  }

  // --- Emails (best-effort; never fail the withdrawal after the write above). ---
  try {
    await sendWithdrawalEmails(db, {
      appUrl,
      athlete: caller as { id: string; email: string; first_name: string; last_name: string },
      disciplines: group.map((r) => r.discipline),
      eventName: event.name,
      plan,
      lastDateToEdit: event.last_date_to_edit,
      refundEligible,
      athleteClubId: reg.club_id,
      director: event.director,
      hostClub,
    });
  } catch (e) {
    console.warn('withdraw-registration: email send failed', e instanceof Error ? e.message : String(e));
  }

  return json({ ok: true, plan, regIds: groupIds });
});

async function sendWithdrawalEmails(_db: DB, opts: {
  appUrl: string;
  athlete: { id: string; email: string; first_name: string; last_name: string };
  disciplines: string[];
  eventName: string;
  plan: WithdrawalPlan;
  lastDateToEdit: string | null;
  refundEligible: boolean;
  athleteClubId: string | null;
  director: { name?: string; email?: string; ccOnConfirmation?: boolean } | null;
  hostClub: { id: string; name: string; email: string | null } | null;
}) {
  const { athlete, disciplines, eventName, plan, lastDateToEdit, refundEligible, athleteClubId, director, hostClub } = opts;
  const discLabel = disciplines.map((d) => (d === 'TNT' ? 'T&T' : d)).join(', ');

  // --- (a) Confirmation to the athlete ---
  const variant = withdrawalEmailVariant({
    ucgHosted: refundEligible,
    athleteClubId,
    hostClubId: hostClub?.id ?? null,
  });
  // Refund-contact points at whichever host contact `_shared/fulfill.ts`'s
  // cc-director resolution would use: the event's director email first,
  // falling back to the host club's own contact email.
  const refundContactEmail = (director?.email ?? '').trim() || (hostClub?.email ?? '').trim();
  const refundSentence = variant === 'refund-contact' && EMAIL_RE.test(refundContactEmail)
    ? `<p>If you would like to request a refund, contact the host club at <a href="mailto:${esc(refundContactEmail)}">${esc(refundContactEmail)}</a>.</p>`
    : '';

  const planLine = plan === 'remove'
    ? `<p>You've been removed from <strong>${esc(eventName)}</strong> (${esc(discLabel)}).</p>`
    : `<p>Because this is after the event's edit deadline${lastDateToEdit ? ` (${new Date(lastDateToEdit).toLocaleDateString('en-US')})` : ''}, you remain listed in <strong>${esc(eventName)}</strong> (${esc(discLabel)}) with all apparatus scratched — you will not compete, but you (or a friend who attends) can still pick up any event freebies tied to your registration.</p>`;

  if (athlete.email && EMAIL_RE.test(athlete.email)) {
    const html = renderEmail({
      heading: plan === 'remove' ? "You've been withdrawn" : 'Withdrawal received',
      bodyHtml: `<p>Hi ${esc(athlete.first_name)},</p>
${planLine}
${refundSentence}
<p style="margin-top:16px;">This can't be undone from your end — contact the event host if this was a mistake.</p>`,
    });
    try {
      await sendOne({
        to: `${athlete.first_name} ${athlete.last_name} <${athlete.email}>`,
        subject: `Withdrawn — ${eventName}`,
        html,
      });
    } catch (e) {
      console.warn('withdraw-registration: athlete email failed', e instanceof Error ? e.message : String(e));
    }
  }

  // --- (b) Notification to the event host: director's email first
  // (mirrors _shared/fulfill.ts's per-event confirmation cc-director
  // resolution), falling back to the host club's own contact email. Skipped
  // silently (like request-refund's reviewer summary) when neither resolves
  // to a usable address — e.g. a UCG-hosted event with no director set and
  // no host club. ---
  const hostEmail = (director?.email ?? '').trim() || (hostClub?.email ?? '').trim();
  if (EMAIL_RE.test(hostEmail)) {
    const hostName = (director?.name ?? '').trim() || hostClub?.name || 'Event host';
    const statusLine = plan === 'remove'
      ? 'Their registration has been removed.'
      : 'They remain listed with all apparatus scratched (withdrew after the edit deadline) — refunded stays false since no money moved.';
    const html = renderEmail({
      heading: 'Athlete withdrawal',
      bodyHtml: `<p><strong>${esc(`${athlete.first_name} ${athlete.last_name}`)}</strong> withdrew from <strong>${esc(eventName)}</strong> (${esc(discLabel)}).</p>
<p>${statusLine}</p>`,
    });
    try {
      await sendOne({ to: `${hostName} <${hostEmail}>`, subject: `Athlete withdrawal — ${eventName}`, html });
    } catch (e) {
      console.warn('withdraw-registration: host notification failed', e instanceof Error ? e.message : String(e));
    }
  }
}
