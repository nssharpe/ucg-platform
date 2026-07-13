// scheduled-dispatch — the platform's scheduled-jobs entry point, invoked
// every 15 minutes by the `scheduled-dispatch-15min` pg_cron job (see
// supabase/migrations/20260706192445_scheduled_dispatch_cron.sql). First (and
// currently only) consumer: sanction-request voting reminder emails.
//
// Auth (critical, fail-closed): the gateway config keeps `verify_jwt = true`,
// but that only checks the token is *a* valid JWT — it does not restrict
// *who* can call this function. So this function additionally requires the
// bearer token to be exactly SUPABASE_SERVICE_ROLE_KEY (string equality).
// There is no user-JWT path at all; any other token (including a real signed-
// in user's JWT) gets 403. Do NOT deploy this with --no-verify-jwt.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendBatch, type EmailMessage } from '../_shared/resend.ts';
import { renderEmail } from '../_shared/email-layout.ts';
import { sanctionReminderStage, notificationLogId } from '../_shared/reminder-logic.ts';
import { OWNER_TASKS, ownerTaskDueDate, ownerReminderStage, ownerTaskStageWording, type OwnerChecklist } from '../_shared/owner-checklist.ts';
import {
  checkCapacity, regRoutines, PROMOTION_HOLD_HOURS,
  type RegRow, type SessionRow, type GroupRow, type CapacityEventRow, type CapacityViolation,
} from '../_shared/capacity.ts';
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
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

interface Recipient {
  firstName: string;
  lastName: string;
  email: string; // already lowercased + validated
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const appUrl = Deno.env.get('APP_PUBLIC_URL') ?? 'https://nssharpe.github.io/ucg-platform';

  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  // Fail-closed caller restriction. The gateway's verify_jwt=true only
  // confirms the token is *some* valid JWT (including a signed-in user's own
  // JWT), so the function must pin the caller itself. Two accepted proofs:
  //  1. bearer token === the runtime's SUPABASE_SERVICE_ROLE_KEY, OR
  //  2. `x-cron-secret` header === the CRON_SECRET function secret.
  // (2) exists because on projects with new-style API keys the Edge runtime's
  // SUPABASE_SERVICE_ROLE_KEY does NOT equal the legacy service-role JWT the
  // vault/cron sends as the bearer — observed live 2026-07-08 (403s in both
  // envs). The cron job supplies BOTH headers (bearer for the gateway,
  // x-cron-secret for this check). Missing CRON_SECRET env ⇒ that path is
  // rejected, never open.
  const cronSecret = Deno.env.get('CRON_SECRET') ?? '';
  const cronHeader = req.headers.get('x-cron-secret') ?? '';
  const viaServiceKey = !!token && token === serviceKey;
  const viaCronSecret = !!cronSecret && !!cronHeader && cronHeader === cronSecret;
  if (!viaServiceKey && !viaCronSecret) {
    return json({ ok: false, error: 'Forbidden' }, 403);
  }

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // a. Active-voting sanction requests with a deadline set. The app treats
  // both 'submitted' and 'voting' as "voting is open" (see Sanction.tsx's
  // `active = requests.filter(r => r.status === 'voting' || r.status === 'submitted')`).
  const { data: requests, error: reqErr } = await db
    .from('sanction_requests')
    .select('id, payload, deadline_at')
    .in('status', ['submitted', 'voting'])
    .not('deadline_at', 'is', null);

  if (reqErr) {
    console.error('scheduled-dispatch: failed to load sanction_requests', reqErr);
    return json({ ok: false, error: reqErr.message }, 500);
  }

  const nowISO = new Date().toISOString();
  let reminders3d = 0;
  let reminders1d = 0;
  let closures = 0;
  const failures: string[] = [];

  // Sanctioning Team + admin recipients (same resolution as notify-sanction's
  // 'submitted' branch) — fetched once and reused across all requests/stages.
  const teamRecipients = await resolveSanctioningTeam(db);

  for (const req of requests ?? []) {
    const requestId = req.id as string;
    const deadlineAt = req.deadline_at as string | null;
    const stage = sanctionReminderStage(nowISO, deadlineAt);
    if (!stage) continue;

    const eventName = (req.payload as Record<string, unknown> | null)?.eventName as string | undefined;
    const label = esc(eventName ?? 'event');
    const reqLink = `${appUrl}/#/sanctioning/${requestId}`;

    if (stage === '3d' || stage === '1d') {
      if (teamRecipients.length === 0) continue;

      // Recipients who haven't voted yet on this request.
      const { data: voteRows, error: voteErr } = await db
        .from('sanction_votes')
        .select('voter_user_id')
        .eq('request_id', requestId);
      if (voteErr) {
        console.error(`scheduled-dispatch: failed to load votes for ${requestId}`, voteErr);
        failures.push(`votes:${requestId}`);
        continue;
      }
      const votedUserIds = new Set((voteRows ?? []).map((v: { voter_user_id: string }) => v.voter_user_id));
      const pending = teamRecipients.filter((r) => !votedUserIds.has(r.userId));
      if (pending.length === 0) continue;

      const kind = stage === '3d' ? 'sanction-reminder-3d' : 'sanction-reminder-1d';
      const claimed = await claimNotifications(db, kind, requestId, pending.map((r) => r.email));
      if (claimed.length === 0) continue;

      const whenPhrase = stage === '3d' ? 'in 3 days' : 'in 1 day';
      const subject = `Reminder: sanction vote for "${eventName ?? 'event'}" closes ${whenPhrase}`;
      const html = renderEmail({
        heading: 'Sanction vote reminder',
        bodyHtml: `<p>Hello,</p>
<p>Voting on the sanction request for <strong>${label}</strong> closes <strong>${whenPhrase}</strong>. You have not yet cast a vote.</p>`,
        cta: { text: 'Review & vote', href: reqLink },
      });
      const claimedSet = new Set(claimed);
      const messages: EmailMessage[] = pending
        .filter((r) => claimedSet.has(r.email))
        .map((r) => ({ to: `${r.firstName} ${r.lastName} <${r.email}>`, subject, html }));
      const result = await sendBatch(messages);
      if (!result.ok) {
        console.error(`scheduled-dispatch: send failed for ${kind}:${requestId}`, result.failed);
        failures.push(`${kind}:${requestId}`);
        await releaseClaims(db, kind, requestId, claimed);
      }
      if (stage === '3d') reminders3d += result.sentCount;
      else reminders1d += result.sentCount;
    } else if (stage === 'closed') {
      if (teamRecipients.length === 0) continue;

      const kind = 'sanction-voting-closed';
      const claimed = await claimNotifications(db, kind, requestId, teamRecipients.map((r) => r.email));
      if (claimed.length === 0) continue;

      const subject = `Voting closed: sanction request for "${eventName ?? 'event'}"`;
      const html = renderEmail({
        heading: 'Sanction voting has closed',
        // Auto-finalization is deliberately out of scope for this task: the vote
        // page's tallyVotes() resolves at-deadline outcomes only when the page
        // is opened (Sanction.tsx), so this nudge exists to get a Sanctioning
        // Team member / admin to open the vote page and finalize the decision.
        bodyHtml: `<p>Hello,</p>
<p>Voting has closed for <strong>${label}</strong>. Open the vote page to finalize the decision.</p>`,
        cta: { text: 'Open vote page', href: reqLink },
      });
      const claimedSet = new Set(claimed);
      const messages: EmailMessage[] = teamRecipients
        .filter((r) => claimedSet.has(r.email))
        .map((r) => ({ to: `${r.firstName} ${r.lastName} <${r.email}>`, subject, html }));
      const result = await sendBatch(messages);
      if (!result.ok) {
        console.error(`scheduled-dispatch: send failed for ${kind}:${requestId}`, result.failed);
        failures.push(`${kind}:${requestId}`);
        await releaseClaims(db, kind, requestId, claimed);
      }
      closures += result.sentCount;
    }
  }

  // b. Event-owner task escalation emails (spec §B4). Isolated in its own
  // try/catch so a failure here (e.g. a query error) cannot take down the
  // sanction-vote consumer above, mirroring the per-request isolation that
  // consumer already has via `failures`/`continue`.
  let ownerTaskReminders = 0;
  try {
    const { data: ownerEvents, error: ownerEvErr } = await db
      .from('events')
      .select('id, slug, name, event_type, created_at, reg_opens, start_date, end_date, owner, owner_checklist');
    if (ownerEvErr) throw ownerEvErr;

    for (const ev of ownerEvents ?? []) {
      const eventId = ev.id as string;
      try {
        const owner = ev.owner as { userId?: string; name?: string; email?: string } | null;
        if (!owner) continue; // unassigned — nothing to remind
        // Camps are individual-only registration events with no host to
        // shepherd via this checklist; only competitions get owner tasks.
        const eventType = (ev.event_type as string | null) ?? 'competition';
        if (eventType === 'camp') continue;

        const ownerEmail = (owner.email ?? '').trim().toLowerCase();
        if (!EMAIL_RE.test(ownerEmail)) continue;

        const checklist = (ev.owner_checklist as OwnerChecklist | null) ?? undefined;
        const eventForDue = {
          createdAt: (ev.created_at as string | null) ?? undefined,
          regOpens: (ev.reg_opens as string | null) ?? '',
          startDate: (ev.start_date as string | null) ?? '',
          endDate: (ev.end_date as string | null) ?? '',
        };
        const eventName = (ev.name as string) ?? 'event';
        const eventLink = `${appUrl}/#/events/${ev.slug as string}`;

        for (const task of OWNER_TASKS) {
          if (checklist?.[task.id]?.done) continue;

          const dueISO = ownerTaskDueDate(task.id, eventForDue, checklist);
          if (!dueISO) continue;

          const stage = ownerReminderStage(new Date(nowISO), new Date(dueISO));
          if (!stage) continue;

          const kind = 'owner-task';
          const refId = `${eventId}:${task.id}:${stage}`;
          const claimed = await claimNotifications(db, kind, refId, [ownerEmail]);
          if (claimed.length === 0) continue;

          const wording = ownerTaskStageWording(stage);
          const dueLabel = new Date(dueISO).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
          const subject = `[UCG] Event task ${wording}: ${task.label} — ${eventName}`;
          const html = renderEmail({
            heading: `Event task ${esc(wording)}`,
            bodyHtml: `<p>Hello${owner.name ? ` ${esc(owner.name)}` : ''},</p>
<p>The task <strong>${esc(task.label)}</strong> for <strong>${esc(eventName)}</strong> is <strong>${esc(wording)}</strong>.</p>
<p>Due date: ${esc(dueLabel)}</p>`,
            cta: { text: 'Open event', href: eventLink },
          });
          const messages: EmailMessage[] = [{ to: owner.name ? `${owner.name} <${ownerEmail}>` : ownerEmail, subject, html }];
          const result = await sendBatch(messages);
          if (!result.ok) {
            console.error(`scheduled-dispatch: send failed for ${kind}:${refId}`, result.failed);
            failures.push(`${kind}:${refId}`);
            await releaseClaims(db, kind, refId, claimed);
            continue;
          }
          ownerTaskReminders += result.sentCount;
        }
      } catch (err) {
        console.error(`scheduled-dispatch: owner-task consumer failed for event ${eventId}`, err);
        failures.push(`owner-task:event:${eventId}`);
      }
    }
  } catch (err) {
    console.error('scheduled-dispatch: owner-task consumer failed to load events', err);
    failures.push('owner-task:query');
  }

  // c. Waitlist promotion sweep (event-mgmt v2 P4 T7): requeue/complete
  // lapsed or finished `notified` holds, then FIFO-promote `waiting` groups
  // that now fit. Isolated in its own try/catch for the same reason as (b).
  let waitlistPromoted = 0;
  let waitlistRequeued = 0;
  let waitlistCompleted = 0;
  try {
    const sweep = await runWaitlistSweep(db, appUrl);
    waitlistPromoted = sweep.promoted;
    waitlistRequeued = sweep.requeued;
    waitlistCompleted = sweep.completed;
    failures.push(...sweep.failures);
  } catch (err) {
    console.error('scheduled-dispatch: waitlist sweep failed', err);
    failures.push('waitlist:sweep');
  }

  return json({
    ok: failures.length === 0,
    reminders3d, reminders1d, closures, ownerTaskReminders,
    waitlistPromoted, waitlistRequeued, waitlistCompleted,
    failures,
  });
});

/** Sanctioning Team + admin people, deduped by lowercased email (mirrors
 *  notify-sanction's 'submitted' recipient resolution). Includes each
 *  person's auth user id so callers can filter out those who've already
 *  voted on a given request. */
async function resolveSanctioningTeam(
  db: SupabaseClient,
): Promise<Array<Recipient & { userId: string }>> {
  const { data: roleRows } = await db.from('user_roles').select('user_id').in('role', ['sanctioning', 'admin']);
  const ids = (roleRows ?? []).map((r: { user_id: string }) => r.user_id);
  if (ids.length === 0) return [];
  const { data: people } = await db
    .from('people')
    .select('auth_user_id, first_name, last_name, email')
    .in('auth_user_id', ids);
  const seen = new Set<string>();
  const out: Array<Recipient & { userId: string }> = [];
  for (const p of people ?? []) {
    const email = (p.email ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(email) || seen.has(email) || !p.auth_user_id) continue;
    seen.add(email);
    out.push({ userId: p.auth_user_id as string, firstName: p.first_name ?? '', lastName: p.last_name ?? '', email });
  }
  return out;
}

/** Atomically claims notification_log rows for (kind, refId, recipient) pairs
 *  via insert ... on conflict do nothing, returning which recipients THIS
 *  call actually claimed (i.e. were not already logged by an earlier/
 *  overlapping run). Only claimed recipients should be emailed. */
async function claimNotifications(
  db: SupabaseClient,
  kind: string,
  refId: string,
  recipients: string[],
): Promise<string[]> {
  if (recipients.length === 0) return [];
  const rows = recipients.map((recipient) => ({
    id: notificationLogId(kind, refId, recipient),
    kind,
    ref_id: refId,
    recipient,
  }));
  // upsert + ignoreDuplicates (not plain insert — supabase-js has no
  // ignoreDuplicates option on insert()) with onConflict on the unique
  // (kind, ref_id, recipient) triple. PostgREST's ignore-duplicates
  // resolution + `.select()` (return=representation) returns ONLY the rows
  // that were newly inserted — a row already logged by an earlier/
  // overlapping run is silently omitted from the response, which is exactly
  // the "did THIS run claim it" signal we need.
  const { data, error } = await db
    .from('notification_log')
    .upsert(rows, { onConflict: 'kind,ref_id,recipient', ignoreDuplicates: true })
    .select('recipient');
  if (error) {
    console.error(`scheduled-dispatch: notification_log claim failed for ${kind}:${refId}`, error);
    return [];
  }
  return (data ?? []).map((r: { recipient: string }) => r.recipient);
}

/** Releases claims after a failed send so the next run retries them. Safe
 *  because sendBatch is all-or-nothing at submit time: a non-2xx means Resend
 *  delivered nothing, so deleting the claims cannot cause duplicate emails. */
async function releaseClaims(db: SupabaseClient, kind: string, refId: string, recipients: string[]): Promise<void> {
  if (recipients.length === 0) return;
  const ids = recipients.map((r) => notificationLogId(kind, refId, r));
  const { error } = await db.from('notification_log').delete().in('id', ids);
  if (error) console.error(`scheduled-dispatch: failed to release claims for ${kind}:${refId}`, error);
}

// ---------------------------------------------------------------------------
// d. Waitlist promotion sweep (event-mgmt v2 P4 T7)
// ---------------------------------------------------------------------------
// Two passes per event with any live (waiting/notified) waitlist_groups row:
//
//  Pass 1 — resolve `notified` groups: a group whose regs are no longer
//  waitlisted (checkout completed, client-side) is marked 'promoted'; a group
//  whose 24h hold lapsed before checkout is REQUEUED to the back of the line
//  (queued_at bumped to now, hold/notified_at cleared) and emailed.
//
//  Pass 2 — promote `waiting` groups in strict queued_at FIFO order: each
//  group's own waitlisted regs are tested via the shared `checkCapacity`
//  engine (same one create-checkout-session uses) against the event's live
//  registrations, with groups already notified THIS sweep folded into
//  `groupsById` so their reservations count against capacity for subsequent
//  groups. A group that doesn't fit records which cap DIMENSIONS its
//  violations named as "blocked" for the rest of this event's sweep — any
//  later group touching one of those same dimensions is skipped without
//  being re-evaluated, but a group on an entirely disjoint dimension (e.g. a
//  different level with its own uncontended cap) may still promote. This
//  avoids an unfair "one group jams the whole queue" outcome while still
//  respecting strict admission order within any single contended dimension.
//  Promotion is skipped ENTIRELY for an event whose `last_date_to_edit` has
//  already passed (no more checkout window to offer).
//
// All status transitions are atomic conditional updates (`.eq('status', …)`)
// so a concurrent invocation (or an admin's manage-waitlist override running
// at the same moment) can't double-claim a group; only the winner emails.

interface WaitlistGroupFullRow extends WaitlistGroupRow {
  id: string;
  discipline: string;
  level_id: string | null;
  session_id: string | null;
  status: string;
  queued_at: string;
  notified_at: string | null;
  hold_expires_at: string | null;
}

interface SweepResult { promoted: number; requeued: number; completed: number; failures: string[] }

async function runWaitlistSweep(db: SupabaseClient, appUrl: string): Promise<SweepResult> {
  const failures: string[] = [];
  let promoted = 0, requeued = 0, completed = 0;

  const { data: groupRows, error: groupErr } = await db
    .from('waitlist_groups')
    .select('id, event_id, club_id, person_id, discipline, level_id, session_id, status, queued_at, notified_at, hold_expires_at')
    .in('status', ['waiting', 'notified']);
  if (groupErr) {
    console.error('scheduled-dispatch: waitlist sweep failed to load waitlist_groups', groupErr);
    return { promoted, requeued, completed, failures: ['waitlist:groups:query'] };
  }
  const groups = (groupRows ?? []) as WaitlistGroupFullRow[];
  if (groups.length === 0) return { promoted, requeued, completed, failures };

  const eventIds = [...new Set(groups.map((g) => g.event_id))];
  const nowMs = Date.now();
  const nowISO = new Date(nowMs).toISOString();

  for (const eventId of eventIds) {
    try {
      const result = await sweepEvent(db, eventId, groups.filter((g) => g.event_id === eventId), nowMs, nowISO, appUrl);
      promoted += result.promoted;
      requeued += result.requeued;
      completed += result.completed;
    } catch (err) {
      console.error(`scheduled-dispatch: waitlist sweep failed for event ${eventId}`, err);
      failures.push(`waitlist:event:${eventId}`);
    }
  }
  return { promoted, requeued, completed, failures };
}

async function sweepEvent(
  db: SupabaseClient,
  eventId: string,
  groups: WaitlistGroupFullRow[],
  nowMs: number,
  nowISO: string,
  appUrl: string,
): Promise<{ promoted: number; requeued: number; completed: number }> {
  let promoted = 0, requeued = 0, completed = 0;

  const { data: eventRow, error: eventErr } = await db
    .from('events')
    .select('id, name, capacity, last_date_to_edit')
    .eq('id', eventId)
    .maybeSingle();
  if (eventErr) throw new Error(`event load failed: ${eventErr.message}`);
  if (!eventRow) return { promoted, requeued, completed }; // event deleted since group creation — nothing to do
  const event = eventRow as CapacityEventRow & { name: string; last_date_to_edit: string | null };

  const { data: sessionRows, error: sessErr } = await db
    .from('event_sessions')
    .select('id, max_routines')
    .eq('event_id', eventId);
  if (sessErr) throw new Error(`sessions load failed: ${sessErr.message}`);
  const sessions = (sessionRows ?? []) as SessionRow[];

  const { data: regRows, error: regErr } = await db
    .from('registrations')
    .select('id, event_id, athlete_id, discipline, level_id, apparatus, apparatus_levels, session_id, paid, updated_pending, refunded, waitlisted, waitlist_group_id, hold_expires_at')
    .eq('event_id', eventId);
  if (regErr) throw new Error(`registrations load failed: ${regErr.message}`);
  const regs = (regRows ?? []) as RegRow[];

  const groupsById: Record<string, GroupRow> = {};
  for (const g of groups) groupsById[g.id] = { id: g.id, status: g.status, hold_expires_at: g.hold_expires_at };

  // ---- Pass 1: resolve `notified` groups ----
  for (const g of groups.filter((x) => x.status === 'notified')) {
    const groupRegs = regs.filter((r) => r.waitlist_group_id === g.id);
    const stillWaitlisted = groupRegs.some((r) => r.waitlisted);

    if (!stillWaitlisted) {
      const { data: claimed, error } = await db
        .from('waitlist_groups')
        .update({ status: 'promoted' })
        .eq('id', g.id).eq('status', 'notified')
        .select('id').maybeSingle();
      if (error) { console.error(`scheduled-dispatch: waitlist promoted-claim failed for ${g.id}`, error); continue; }
      if (claimed) {
        completed++;
        groupsById[g.id] = { id: g.id, status: 'promoted', hold_expires_at: null };
      }
      continue;
    }

    const holdMs = g.hold_expires_at ? new Date(g.hold_expires_at).getTime() : null;
    if (holdMs !== null && holdMs < nowMs) {
      const { data: claimed, error } = await db
        .from('waitlist_groups')
        .update({ status: 'waiting', queued_at: nowISO, hold_expires_at: null, notified_at: null })
        .eq('id', g.id).eq('status', 'notified')
        .select('id').maybeSingle();
      if (error) { console.error(`scheduled-dispatch: waitlist requeue-claim failed for ${g.id}`, error); continue; }
      if (claimed) {
        requeued++;
        // Keep the in-memory copy in sync so pass 2 below sees it as a fresh
        // 'waiting' group (at the back — later queued_at than anything that
        // was already 'waiting' before this sweep started).
        g.status = 'waiting';
        g.queued_at = nowISO;
        g.hold_expires_at = null;
        g.notified_at = null;
        groupsById[g.id] = { id: g.id, status: 'waiting', hold_expires_at: null };
        await emailBestEffort(() => emailRequeue(db, g, event, appUrl));
      }
    }
    // else: still notified, hold still live — awaiting checkout, do nothing.
  }

  // ---- Pass 2: FIFO-promote `waiting` groups ----
  const deadlinePassed = !!event.last_date_to_edit && new Date(event.last_date_to_edit).getTime() < nowMs;
  if (deadlinePassed) return { promoted, requeued, completed };

  const waiting = groups
    .filter((x) => x.status === 'waiting')
    .sort((a, b) => a.queued_at.localeCompare(b.queued_at) || a.id.localeCompare(b.id));

  const blockedDims = new Set<string>();

  for (const g of waiting) {
    const groupRegs = regs.filter((r) => r.waitlist_group_id === g.id && r.waitlisted);
    if (groupRegs.length === 0) continue; // nothing left to promote (shouldn't normally happen)

    const dims = groupDimensionKeys(groupRegs);
    if ([...dims].some((d) => blockedDims.has(d))) continue; // a prior group in a shared dimension didn't fit

    const violations = checkCapacity(event, sessions, regs, groupRegs, groupsById, nowMs);
    if (violations.length > 0) {
      for (const v of violations) blockedDims.add(violationDimensionKey(v));
      continue;
    }

    const holdExpiresAt = clampPromotionHold(nowMs, event.last_date_to_edit);
    const { data: claimed, error } = await db
      .from('waitlist_groups')
      .update({ status: 'notified', notified_at: nowISO, hold_expires_at: holdExpiresAt })
      .eq('id', g.id).eq('status', 'waiting')
      .select('id').maybeSingle();
    if (error) { console.error(`scheduled-dispatch: waitlist promote-claim failed for ${g.id}`, error); continue; }
    if (claimed) {
      promoted++;
      // Fold into groupsById immediately so subsequent groups in THIS sweep
      // see this group's regs as occupying (live 'notified' hold).
      groupsById[g.id] = { id: g.id, status: 'notified', hold_expires_at: holdExpiresAt };
      await emailBestEffort(() => emailPromotion(db, g, event, holdExpiresAt, appUrl));
    }
  }

  return { promoted, requeued, completed };
}

/** The cap DIMENSIONS a group's own (waitlisted) regs touch: 'total' always
 *  (a global cap applies to every group), plus a `discipline:<code>` key per
 *  reg's discipline, a `level:<id>` key per routine's attributed level, and a
 *  `session:<id>:<apparatus>` key per routine with a session assigned. Mirrors
 *  `regTouchesViolation`'s attribution rules in src/lib/capacity.ts /
 *  _shared/capacity.ts (kept in sync by hand — that function isn't exported). */
function groupDimensionKeys(groupRegs: RegRow[]): Set<string> {
  const keys = new Set<string>(['total']);
  for (const r of groupRegs) {
    keys.add(`discipline:${r.discipline}`);
    for (const routine of regRoutines(r)) {
      keys.add(`level:${routine.levelId}`);
      if (r.session_id) keys.add(`session:${r.session_id}:${routine.apparatus}`);
    }
  }
  return keys;
}

function violationDimensionKey(v: CapacityViolation): string {
  if (v.scope === 'total') return 'total';
  if (v.scope === 'level') return `level:${v.levelId}`;
  if (v.scope === 'discipline') return `discipline:${v.discipline}`;
  return `session:${v.sessionId}:${v.apparatus}`;
}

/** `now + 24h`, clamped to the event's `last_date_to_edit` when that's
 *  sooner (a promotion hold must never outlive the checkout-edit window). */
function clampPromotionHold(nowMs: number, lastDateToEdit: string | null): string {
  const plus24h = nowMs + PROMOTION_HOLD_HOURS * 60 * 60 * 1000;
  if (!lastDateToEdit) return new Date(plus24h).toISOString();
  const deadlineMs = new Date(lastDateToEdit).getTime();
  return new Date(Math.min(plus24h, deadlineMs)).toISOString();
}

/** Runs an email step, swallowing ANY failure (missing RESEND_API_KEY throws
 *  synchronously from sendBatch/sendOne, a Resend API error resolves ok:false)
 *  so a misconfigured or absent email provider (e.g. staging with no Resend
 *  secrets) never breaks the sweep's actual state transitions — those are
 *  already committed by the time this runs. */
async function emailBestEffort(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.warn('scheduled-dispatch: waitlist email failed (sweep unaffected)', err instanceof Error ? err.message : String(err));
  }
}

async function emailPromotion(
  db: SupabaseClient,
  group: WaitlistGroupFullRow,
  event: { name: string },
  holdExpiresAt: string,
  appUrl: string,
): Promise<void> {
  const contacts = await resolveGroupContacts(db, group);
  if (contacts.length === 0) return;
  const link = groupLandingUrl(appUrl, group);
  const html = promotionEmailHtml({ eventName: event.name, holdExpiresAt, link });
  const messages: EmailMessage[] = contacts.map((c) => ({ to: c.name ? `${c.name} <${c.email}>` : c.email, subject: promotionSubject(event.name), html }));
  const result = await sendBatch(messages);
  if (!result.ok) console.warn(`scheduled-dispatch: waitlist promotion email send failed for group ${group.id}`, result.failed);
}

async function emailRequeue(
  db: SupabaseClient,
  group: WaitlistGroupFullRow,
  event: { name: string },
  appUrl: string,
): Promise<void> {
  const contacts = await resolveGroupContacts(db, group);
  if (contacts.length === 0) return;
  const link = groupLandingUrl(appUrl, group);
  const html = requeueEmailHtml({ eventName: event.name, link });
  const messages: EmailMessage[] = contacts.map((c) => ({ to: c.name ? `${c.name} <${c.email}>` : c.email, subject: requeueSubject(event.name), html }));
  const result = await sendBatch(messages);
  if (!result.ok) console.warn(`scheduled-dispatch: waitlist requeue email send failed for group ${group.id}`, result.failed);
}
