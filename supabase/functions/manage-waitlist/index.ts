// manage-waitlist — admin/sanctioning override for waitlist_groups (event-mgmt
// v2 P4 T7). Two actions:
//   - 'promote': force-notify a 'waiting' group RIGHT NOW, IGNORING capacity
//     (the approved "admit past cap" override) — same 24h/deadline-clamped
//     hold + email as the automatic scheduled-dispatch sweep.
//   - 'requeue': force a 'notified' group back to 'waiting' at the back of
//     the queue (queued_at bumped to now), same email as an automatic lapsed-
//     hold requeue.
//
// Auth: any signed-in user with the 'admin' or 'sanctioning' role
// (user_roles), checked server-side and fail-closed — mirrors process-refund's
// authorization shape (CLAUDE.md: money/auth-adjacent edge functions get this
// pattern, not the broader send-event-email host/event-admin surface — the
// brief for this task names admin OR sanctioning specifically). verify_jwt
// STAYS TRUE (default) — this is NOT one of the three --no-verify-jwt
// functions.
//
// Writes go through service role — waitlist_groups' RLS only lets a client
// UPDATE its own `status` column to 'cancelled' (20260711135842_emv2_p4_capacity_schema.sql),
// so a promote/requeue transition could never happen client-side even for an
// admin's own session; this function is the one legitimate path.
//
// Secrets: RESEND_API_KEY, RESEND_FROM, APP_PUBLIC_URL (shared/optional with
// sane fallbacks, same as scheduled-dispatch). Auto-provided: SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendBatch, type EmailMessage } from '../_shared/resend.ts';
import { PROMOTION_HOLD_HOURS } from '../_shared/capacity.ts';
import {
  resolveGroupContacts, groupLandingUrl, promotionEmailHtml, requeueEmailHtml, promotionSubject, requeueSubject,
  type WaitlistGroupRow,
} from '../_shared/waitlist-contacts.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

type DB = ReturnType<typeof createClient>;

interface Payload {
  groupId?: string;
  eventId?: string;
  action?: 'promote' | 'requeue' | 'list';
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

  // --- Roles (shared by both authz branches below). Fail closed. ---
  const { data: roleRows, error: roleErr } = await db.from('user_roles').select('role').eq('user_id', authUserId);
  if (roleErr) return json({ error: 'Could not verify permissions.' }, 403);
  const roles = ((roleRows ?? []) as { role: string }[]).map((r) => r.role);
  const isOverrider = roles.includes('admin') || roles.includes('sanctioning');

  // --- Validate payload ---
  let payload: Payload;
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }
  const action = payload.action;

  // 'list' — read-only queue visibility. Broader authz than promote/requeue
  // (mirrors send-event-email's host surface): admin, sanctioning, the
  // event's host-club managers, or an event_admins grantee. Exists because
  // waitlist_groups' client RLS deliberately only exposes a group to its OWN
  // club/person (plus admins) — hosts get the queue through this
  // service-role read instead of an RLS relaxation.
  if (action === 'list') {
    const eventId = typeof payload.eventId === 'string' ? payload.eventId.trim() : '';
    if (!eventId) return json({ error: 'eventId is required.' }, 400);

    const { data: evRow, error: evErr } = await db
      .from('events').select('id, host_club_id').eq('id', eventId).maybeSingle();
    if (evErr) return json({ error: 'Could not verify event.' }, 403);
    if (!evRow) return json({ error: 'Event not found.' }, 404);

    let allowed = isOverrider;
    if (!allowed) {
      const { data: person, error: personErr } = await db
        .from('people').select('id').eq('auth_user_id', authUserId).maybeSingle();
      if (personErr) return json({ error: 'Could not verify permissions.' }, 403);
      if (person) {
        const { data: mgr, error: mgrErr } = await db
          .from('club_managers').select('club_id')
          .eq('club_id', (evRow as { host_club_id: string }).host_club_id)
          .eq('person_id', (person as { id: string }).id)
          .maybeSingle();
        if (mgrErr) return json({ error: 'Could not verify permissions.' }, 403);
        allowed = !!mgr;
      }
      if (!allowed) {
        const { data: ea, error: eaErr } = await db
          .from('event_admins').select('event_id')
          .eq('event_id', eventId).eq('user_id', authUserId).maybeSingle();
        if (eaErr) return json({ error: 'Could not verify permissions.' }, 403);
        allowed = !!ea;
      }
    }
    if (!allowed) return json({ error: 'You do not have access to this event\'s waitlist.' }, 403);

    return handleList(db, eventId, isOverrider);
  }

  // 'promote' / 'requeue' — admin or sanctioning only. Fail closed.
  if (!isOverrider) {
    return json({ error: 'You do not have permission to manage waitlists.' }, 403);
  }

  const groupId = typeof payload.groupId === 'string' ? payload.groupId.trim() : '';
  if (!groupId) return json({ error: 'groupId is required.' }, 400);
  if (action !== 'promote' && action !== 'requeue') return json({ error: 'action must be "promote", "requeue", or "list".' }, 400);

  const { data: groupRow, error: groupErr } = await db
    .from('waitlist_groups')
    .select('id, event_id, club_id, person_id, discipline, level_id, session_id, status, queued_at, hold_expires_at')
    .eq('id', groupId)
    .maybeSingle();
  if (groupErr) return json({ error: 'Could not look up the waitlist group.' }, 500);
  if (!groupRow) return json({ error: 'Waitlist group not found.' }, 404);
  const group = groupRow as WaitlistGroupRow & { status: string; queued_at: string; hold_expires_at: string | null };

  const { data: eventRow, error: eventErr } = await db
    .from('events')
    .select('id, name, last_date_to_edit')
    .eq('id', group.event_id)
    .maybeSingle();
  if (eventErr) return json({ error: 'Could not look up the event.' }, 500);
  if (!eventRow) return json({ error: 'Event not found.' }, 404);
  const event = eventRow as { id: string; name: string; last_date_to_edit: string | null };

  if (action === 'promote') return handlePromote(db, group, event, appUrl);
  return handleRequeue(db, group, event, appUrl);
});

/** Live (waiting/notified) waitlist groups for an event, FIFO-ordered, with
 *  server-side-resolved club/person display names + reg counts. `canManage`
 *  echoes whether the caller may promote/requeue (drives button rendering
 *  client-side; the write actions re-check server-side regardless). */
async function handleList(db: DB, eventId: string, canManage: boolean) {
  const { data: groupRows, error: groupErr } = await db
    .from('waitlist_groups')
    .select('id, event_id, club_id, person_id, discipline, level_id, session_id, status, queued_at, notified_at, hold_expires_at')
    .eq('event_id', eventId)
    .in('status', ['waiting', 'notified'])
    .order('queued_at', { ascending: true });
  if (groupErr) return json({ error: 'Could not load the waitlist.' }, 500);
  const groups = (groupRows ?? []) as {
    id: string; event_id: string; club_id: string | null; person_id: string | null;
    discipline: string; level_id: string | null; session_id: string | null;
    status: string; queued_at: string; notified_at: string | null; hold_expires_at: string | null;
  }[];

  const clubIds = [...new Set(groups.map((g) => g.club_id).filter((x): x is string => !!x))];
  const personIds = [...new Set(groups.map((g) => g.person_id).filter((x): x is string => !!x))];
  const clubNames = new Map<string, string>();
  const personNames = new Map<string, string>();
  if (clubIds.length > 0) {
    const { data } = await db.from('clubs').select('id, name').in('id', clubIds);
    for (const c of (data ?? []) as { id: string; name: string }[]) clubNames.set(c.id, c.name);
  }
  if (personIds.length > 0) {
    const { data } = await db.from('people').select('id, first_name, last_name').in('id', personIds);
    for (const p of (data ?? []) as { id: string; first_name: string; last_name: string }[]) {
      personNames.set(p.id, `${p.first_name} ${p.last_name}`.trim());
    }
  }

  const regCounts = new Map<string, number>();
  if (groups.length > 0) {
    const { data: regRows } = await db
      .from('registrations')
      .select('waitlist_group_id')
      .in('waitlist_group_id', groups.map((g) => g.id))
      .eq('waitlisted', true);
    for (const r of (regRows ?? []) as { waitlist_group_id: string }[]) {
      regCounts.set(r.waitlist_group_id, (regCounts.get(r.waitlist_group_id) ?? 0) + 1);
    }
  }

  return json({
    ok: true,
    canManage,
    groups: groups.map((g) => ({
      id: g.id,
      clubId: g.club_id,
      personId: g.person_id,
      name: g.club_id ? (clubNames.get(g.club_id) ?? g.club_id) : (g.person_id ? personNames.get(g.person_id) ?? g.person_id : '—'),
      discipline: g.discipline,
      levelId: g.level_id,
      sessionId: g.session_id,
      status: g.status,
      queuedAt: g.queued_at,
      notifiedAt: g.notified_at,
      holdExpiresAt: g.hold_expires_at,
      regCount: regCounts.get(g.id) ?? 0,
    })),
  });
}

async function handlePromote(
  db: DB,
  group: WaitlistGroupRow & { status: string },
  event: { name: string; last_date_to_edit: string | null },
  appUrl: string,
) {
  if (group.status !== 'waiting') {
    return json({ error: `Only a 'waiting' group can be promoted (this one is '${group.status}').` }, 409);
  }

  const nowMs = Date.now();
  const nowISO = new Date(nowMs).toISOString();
  // Admin override IGNORES capacity by design (the approved "admit past cap"
  // action) — same hold clamp as the automatic sweep: 24h, or the event's
  // edit deadline if sooner.
  const plus24h = nowMs + PROMOTION_HOLD_HOURS * 60 * 60 * 1000;
  const holdExpiresAt = event.last_date_to_edit
    ? new Date(Math.min(plus24h, new Date(event.last_date_to_edit).getTime())).toISOString()
    : new Date(plus24h).toISOString();

  const { data: claimed, error: claimErr } = await db
    .from('waitlist_groups')
    .update({ status: 'notified', notified_at: nowISO, hold_expires_at: holdExpiresAt })
    .eq('id', group.id).eq('status', 'waiting')
    .select('id').maybeSingle();
  if (claimErr) return json({ error: 'Could not update the waitlist group.' }, 500);
  if (!claimed) return json({ error: 'This group is no longer waiting — someone else may have just acted on it.' }, 409);

  try {
    const contacts = await resolveGroupContacts(db, group);
    if (contacts.length > 0) {
      const link = groupLandingUrl(appUrl, group);
      const html = promotionEmailHtml({ eventName: event.name, holdExpiresAt, link });
      const messages: EmailMessage[] = contacts.map((c) => ({ to: c.name ? `${c.name} <${c.email}>` : c.email, subject: promotionSubject(event.name), html }));
      const result = await sendBatch(messages);
      if (!result.ok) console.warn(`manage-waitlist: promote email failed for group ${group.id}`, result.failed);
    }
  } catch (err) {
    console.warn('manage-waitlist: promote email threw', err instanceof Error ? err.message : String(err));
  }

  return json({ ok: true, status: 'notified', holdExpiresAt });
}

async function handleRequeue(
  db: DB,
  group: WaitlistGroupRow & { status: string },
  event: { name: string; last_date_to_edit: string | null },
  appUrl: string,
) {
  if (group.status !== 'notified') {
    return json({ error: `Only a 'notified' group can be requeued (this one is '${group.status}').` }, 409);
  }

  const nowISO = new Date().toISOString();
  const { data: claimed, error: claimErr } = await db
    .from('waitlist_groups')
    .update({ status: 'waiting', queued_at: nowISO, hold_expires_at: null, notified_at: null })
    .eq('id', group.id).eq('status', 'notified')
    .select('id').maybeSingle();
  if (claimErr) return json({ error: 'Could not update the waitlist group.' }, 500);
  if (!claimed) return json({ error: 'This group is no longer notified — someone else may have just acted on it.' }, 409);

  try {
    const contacts = await resolveGroupContacts(db, group);
    if (contacts.length > 0) {
      const link = groupLandingUrl(appUrl, group);
      const html = requeueEmailHtml({ eventName: event.name, link });
      const messages: EmailMessage[] = contacts.map((c) => ({ to: c.name ? `${c.name} <${c.email}>` : c.email, subject: requeueSubject(event.name), html }));
      const result = await sendBatch(messages);
      if (!result.ok) console.warn(`manage-waitlist: requeue email failed for group ${group.id}`, result.failed);
    }
  } catch (err) {
    console.warn('manage-waitlist: requeue email threw', err instanceof Error ? err.message : String(err));
  }

  return json({ ok: true, status: 'waiting', queuedAt: nowISO });
}
