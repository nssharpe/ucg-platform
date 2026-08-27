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
import { toE164, sendSmsBatch } from '../_shared/telnyx.ts';
import { digestDateKey, isDigestFireWindow, digestWindowStart, isStuckPayment } from '../_shared/digest-logic.ts';
import { nextSeasonNagState, type SeasonRow, type SeasonNagTier } from '../_shared/season-lifecycle.ts';

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

// Daily "anything wrong?" digest recipients — hardcoded, update-in-place (same
// idiom as report-problem's ROUTES map). Not derived from any DB role.
const DIGEST_RECIPIENTS: string[] = ['nssharpe@gmail.com'];

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

  // Sanctioning Team recipients ONLY (role = 'sanctioning' — see
  // resolveSanctioningTeam's doc comment for why this no longer includes
  // admins) — fetched once and reused across all requests/stages.
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
        // Team member to open the vote page and finalize the decision (only a
        // sanctioning voter can trigger this — see resolveSanctioningTeam).
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

  // d. Nationals finals-lineup deadline nag + hard lock (event-mgmt v2 Phase 5
  // Task C3, spec §L.3). Isolated in its own try/catch (loading the event
  // list) with a PER-EVENT try/catch inside, mirroring (b)'s owner-task
  // pattern, so one event's failure can't take down another's.
  //
  // DEFERRED (spec §L.3): the per-team reminder "5 min after the team's
  // session ends" (incl. the special-cased Friday-10am-last-session wording)
  // and the day-1 8pm "lineups are now open" nudge both depend on SESSION
  // ASSIGNMENTS from the §L.2 assignment tool, which Julia marked
  // incomplete/skip-for-now (2026-07-16 kickoff). This consumer implements
  // only the two pieces that depend solely on the admin-set
  // `finals_lineup_deadline_at` instant (a timestamptz — no timezone math
  // needed, just compare to `now()`): the deadline nag to club managers with
  // missing finals lineups, and the deadline+1h hard lock.
  let finalsNagEmailCount = 0;
  let finalsNagSmsCount = 0;
  let finalsLocked = 0;
  try {
    const { data: natEvents, error: natErr } = await db
      .from('events')
      .select('id, slug, name, finals_roster_locked, finals_lineup_deadline_at')
      .eq('kind', 'nationals')
      .not('finals_lineup_deadline_at', 'is', null)
      .lte('finals_lineup_deadline_at', nowISO);
    if (natErr) throw natErr;

    for (const ev of natEvents ?? []) {
      const eventId = ev.id as string;
      try {
        const result = await processFinalsDeadline(db, {
          id: eventId,
          slug: ev.slug as string,
          name: ev.name as string,
          finalsRosterLocked: !!ev.finals_roster_locked,
          finalsLineupDeadlineAt: ev.finals_lineup_deadline_at as string,
        }, nowISO, appUrl);
        finalsNagEmailCount += result.emailsSent;
        finalsNagSmsCount += result.smsSent;
        if (result.locked) finalsLocked++;
        failures.push(...result.failures);
      } catch (err) {
        console.error(`scheduled-dispatch: finals-deadline consumer failed for event ${eventId}`, err);
        failures.push(`finals-deadline:event:${eventId}`);
      }
    }
  } catch (err) {
    console.error('scheduled-dispatch: finals-deadline consumer failed to load events', err);
    failures.push('finals-deadline:query');
  }

  // f. Daily "anything wrong?" digest (whats-next §3): a single daily email of
  // new error_logs rows since the last digest + any payments stuck 'pending'
  // for more than 1h. Isolated in its own try/catch for the same reason as
  // (b)/(d) above.
  let digestSent = false;
  let digestErrorCount = 0;
  let digestStuckPaymentCount = 0;
  try {
    const result = await runDailyDigest(db, nowISO, appUrl);
    digestSent = result.sent;
    digestErrorCount = result.errorCount;
    digestStuckPaymentCount = result.stuckPaymentCount;
    failures.push(...result.failures);
  } catch (err) {
    console.error('scheduled-dispatch: daily digest failed', err);
    failures.push('daily-digest:run');
  }

  // g. Season lifecycle: escalating admin nag to CREATE the next season row
  // (P3 2026-07-20 — the old automatic `current` rollover is gone; "current"
  // is now derived from dates, there's no flag left to flip). Isolated in its
  // own try/catch for the same reason as (b)/(d)/(f).
  let seasonNagTier: SeasonNagTier = 'none';
  let seasonNagSent = false;
  try {
    const result = await runSeasonLifecycle(db, nowISO, appUrl);
    seasonNagTier = result.nagTier;
    seasonNagSent = result.nagSent;
    failures.push(...result.failures);
  } catch (err) {
    console.error('scheduled-dispatch: season lifecycle failed', err);
    failures.push('season-lifecycle:run');
  }

  return json({
    ok: failures.length === 0,
    reminders3d, reminders1d, closures, ownerTaskReminders,
    waitlistPromoted, waitlistRequeued, waitlistCompleted,
    finalsNagEmailCount, finalsNagSmsCount, finalsLocked,
    digestSent, digestErrorCount, digestStuckPaymentCount,
    seasonNagTier, seasonNagSent,
    failures,
  });
});

/** Sanctioning Team members ONLY (role = 'sanctioning'), deduped by
 *  lowercased email. Includes each person's auth user id so callers can
 *  filter out those who've already voted on a given request.
 *
 *  Was 'sanctioning' + 'admin' (mirroring notify-sanction's 'submitted'
 *  recipient resolution) until UAT round 2 (2026-08-26): the owners decided
 *  only the 'sanctioning' role may cast a vote (`sanction_votes_write`,
 *  20260826000000), so an admin without that role literally cannot act on
 *  either a "you haven't voted" nag (3d/1d) OR a "voting closed, open the
 *  page to finalize" nudge (finalization only happens as a side effect of
 *  (re)casting a vote in Sanction.tsx's castVote — an admin-only viewer has
 *  no vote control to do that with). Narrowed to sanctioning-only for ALL
 *  THREE reminder stages this function sends, not just the 3d/1d nag.
 *  notify-sanction's 'submitted' email (a different, one-time "new request"
 *  notice, not a repeating vote-chase) is UNCHANGED and still includes
 *  admins — informational, not an unactionable nag. */
async function resolveSanctioningTeam(
  db: SupabaseClient,
): Promise<Array<Recipient & { userId: string }>> {
  const { data: roleRows } = await db.from('user_roles').select('user_id').eq('role', 'sanctioning');
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

/** admin-role people only (not Sanctioning Team) — season launch/rollover is
 *  an admin-only concern. Same dedupe-by-lowercased-email idiom as
 *  resolveSanctioningTeam, minus the userId (no caller needs it here). */
async function resolveAdminRecipients(db: SupabaseClient): Promise<Recipient[]> {
  const { data: roleRows } = await db.from('user_roles').select('user_id').eq('role', 'admin');
  const ids = (roleRows ?? []).map((r: { user_id: string }) => r.user_id);
  if (ids.length === 0) return [];
  const { data: people } = await db
    .from('people')
    .select('auth_user_id, first_name, last_name, email')
    .in('auth_user_id', ids);
  const seen = new Set<string>();
  const out: Recipient[] = [];
  for (const p of people ?? []) {
    const email = (p.email ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(email) || seen.has(email)) continue;
    seen.add(email);
    out.push({ firstName: p.first_name ?? '', lastName: p.last_name ?? '', email });
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
    .select('id, name, capacity, registration_mode, last_date_to_edit')
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

/** The cap DIMENSIONS a group's own (waitlisted) regs touch: a
 *  `discipline:<code>` key per reg's discipline, a `level:<discipline>:<id>`
 *  key per routine's attributed level (capacity rework, 2026-08-24 — T1: a
 *  level cap is now scoped to its discipline, and there is no more
 *  event-wide 'total' dimension — the athlete cap it backed was removed
 *  outright), and a `session:<id>:<apparatus>` key per routine with a session
 *  assigned. Mirrors `regTouchesViolation`'s attribution rules in
 *  src/lib/capacity.ts / _shared/capacity.ts (kept in sync by hand — that
 *  function isn't exported). */
function groupDimensionKeys(groupRegs: RegRow[]): Set<string> {
  const keys = new Set<string>();
  for (const r of groupRegs) {
    keys.add(`discipline:${r.discipline}`);
    for (const routine of regRoutines(r)) {
      keys.add(`level:${r.discipline}:${routine.levelId}`);
      if (r.session_id) keys.add(`session:${r.session_id}:${routine.apparatus}`);
    }
  }
  return keys;
}

function violationDimensionKey(v: CapacityViolation): string {
  if (v.scope === 'level') return `level:${v.discipline}:${v.levelId}`;
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

// ---------------------------------------------------------------------------
// e. Nationals finals-lineup deadline nag + hard lock (event-mgmt v2 Phase 5
//    Task C3, spec §L.3)
// ---------------------------------------------------------------------------
// See the DEFERRED note on the inline "d." consumer above for what this does
// NOT do (per-team session-timed reminders — blocked on the §L.2 session-
// assignment tool). What it DOES do, for every `kind = 'nationals'` event
// whose `finals_lineup_deadline_at` has passed:
//
//  1. Derive missing finals lineups. This mirrors src/lib/nationals-teams.ts's
//     `eligibleTeams` (group registrations by club+discipline+level+category,
//     an apparatus is "eligible" at >=3 registrants) and
//     src/lib/nationals-adapter.ts's `platformCategory` (placement override,
//     else gender + student status) — replicated inline because edge
//     functions can't import from `src/`. A team-apparatus is "missing" when
//     no `finals_lineups` row exists for that exact
//     (club_id, level_id, category, apparatus) key with a non-empty `reg_ids`.
//  2. For every club with >=1 missing lineup, email + SMS that club's
//     managers, idempotently (claimNotifications/releaseClaims, same idiom as
//     the sanction/owner-task consumers above) under kinds
//     'finals-lineup-nag-email'/'finals-lineup-nag-sms'. SMS respects the
//     opt-out consent model (`sms_consent !== false`, mirrors
//     `partitionByConsent` in src/lib/sms-send.ts) and is skipped entirely if
//     Telnyx isn't configured.
//  3. Hard-lock: once `now >= deadline + 1h`, idempotently flip
//     `finals_roster_locked` to `true` (a conditional
//     `where finals_roster_locked = false` update IS the idempotency guard —
//     no notification_log claim needed since the write itself is a no-op on
//     re-run).

interface FinalsEventRow {
  id: string;
  slug: string;
  name: string;
  finalsRosterLocked: boolean;
  finalsLineupDeadlineAt: string;
}

interface FinalsRegRow {
  id: string;
  athlete_id: string;
  club_id: string | null;
  discipline: string;
  level_id: string | null;
  apparatus: string[] | null;
  refunded: boolean | null;
  waitlisted: boolean | null;
}

interface FinalsPersonRow {
  id: string;
  gender: string | null;
  student_status: string | null;
  placement: Record<string, string> | null;
}

interface FinalsLineupRow {
  club_id: string;
  level_id: string;
  category: string;
  apparatus: string;
  reg_ids: unknown;
}

interface ManagerRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  sms_consent: boolean | null;
}

interface MissingLineup {
  levelId: string;
  levelName: string;
  category: string;
  apparatus: string;
}

const TEAM_MIN_PER_APPARATUS = 3;
const APPARATUS_NAMES: Record<string, string> = {
  FX: 'Floor', PH: 'Pommel Horse', SR: 'Still Rings', VT: 'Vault', PB: 'Parallel Bars', HB: 'High Bar',
  UB: 'Uneven Bars', BB: 'Balance Beam', TR: 'Trampoline', DM: 'Double Mini', TU: 'Tumbling', SY: 'Synchro Trampoline',
};

interface FinalsDeadlineResult {
  emailsSent: number;
  smsSent: number;
  locked: boolean;
  failures: string[];
}

async function processFinalsDeadline(
  db: SupabaseClient,
  event: FinalsEventRow,
  nowISO: string,
  appUrl: string,
): Promise<FinalsDeadlineResult> {
  const failures: string[] = [];
  let emailsSent = 0;
  let smsSent = 0;
  let locked = false;
  const nowMs = new Date(nowISO).getTime();
  const deadlineMs = new Date(event.finalsLineupDeadlineAt).getTime();

  // --- 1. Derive missing finals lineups ---
  const missingByClub = await missingFinalsLineupsByClub(db, event.id);

  if (missingByClub.size > 0) {
    const clubIds = [...missingByClub.keys()];
    const { data: mgrRows, error: mgrErr } = await db
      .from('club_managers')
      .select('club_id, person_id')
      .in('club_id', clubIds);
    if (mgrErr) {
      console.error(`scheduled-dispatch: finals-deadline club_managers load failed for ${event.id}`, mgrErr);
      failures.push(`finals-deadline:managers:${event.id}`);
    } else {
      const personIds = [...new Set((mgrRows ?? []).map((r) => r.person_id as string))];
      const managerByPersonId = new Map<string, ManagerRow>();
      if (personIds.length > 0) {
        const { data: peopleRows } = await db
          .from('people')
          .select('id, first_name, last_name, email, phone, sms_consent')
          .in('id', personIds);
        for (const p of (peopleRows ?? []) as ManagerRow[]) managerByPersonId.set(p.id, p);
      }
      const managersByClub = new Map<string, ManagerRow[]>();
      for (const r of mgrRows ?? []) {
        const clubId = r.club_id as string;
        const manager = managerByPersonId.get(r.person_id as string);
        if (!manager) continue;
        const arr = managersByClub.get(clubId) ?? [];
        arr.push(manager);
        managersByClub.set(clubId, arr);
      }

      for (const [clubId, missing] of missingByClub) {
        const managers = managersByClub.get(clubId) ?? [];
        if (managers.length === 0) continue;
        const eventLink = `${appUrl}/#/events/${event.slug}/nationals`;

        // --- Email ---
        const emailCandidates = managers
          .map((m) => ({ ...m, email: (m.email ?? '').trim().toLowerCase() }))
          .filter((m) => EMAIL_RE.test(m.email));
        if (emailCandidates.length > 0) {
          const kind = 'finals-lineup-nag-email';
          const claimed = await claimNotifications(db, kind, event.id, emailCandidates.map((m) => m.email));
          if (claimed.length > 0) {
            const claimedSet = new Set(claimed);
            const rows = missing.map((m) => `<li>${esc(m.levelName)} · ${esc(m.category)} · ${esc(APPARATUS_NAMES[m.apparatus] ?? m.apparatus)}</li>`).join('');
            const html = renderEmail({
              heading: 'Finals lineup deadline has passed',
              bodyHtml: `<p>Hello,</p>
<p>The finals-lineup submission deadline for <strong>${esc(event.name)}</strong> has passed, and your club still has missing finals lineups:</p>
<ul>${rows}</ul>
<p>Lineups hard-lock 1 hour after the deadline — submit as soon as possible.</p>`,
              cta: { text: 'Submit finals lineups', href: eventLink },
            });
            const subject = `Action needed: missing finals lineups for ${event.name}`;
            const messages: EmailMessage[] = emailCandidates
              .filter((m) => claimedSet.has(m.email))
              .map((m) => ({ to: `${m.first_name ?? ''} ${m.last_name ?? ''}`.trim() ? `${m.first_name} ${m.last_name} <${m.email}>` : m.email, subject, html }));
            const result = await sendBatch(messages);
            if (!result.ok) {
              console.error(`scheduled-dispatch: finals-lineup-nag-email send failed for ${event.id}:${clubId}`, result.failed);
              failures.push(`finals-lineup-nag-email:${event.id}:${clubId}`);
              await releaseClaims(db, kind, event.id, claimed);
            }
            emailsSent += result.sentCount;
          }
        }

        // --- SMS (best-effort — skipped entirely if Telnyx isn't configured) ---
        const apiKey = Deno.env.get('TELNYX_API_KEY');
        const fromNumber = Deno.env.get('TELNYX_FROM_NUMBER');
        const profileId = Deno.env.get('TELNYX_MESSAGING_PROFILE_ID');
        if (apiKey && (fromNumber || profileId)) {
          const smsCandidates = managers
            .filter((m) => m.sms_consent !== false && typeof m.phone === 'string' && m.phone.trim())
            .map((m) => ({ ...m, e164: toE164(m.phone as string) }))
            .filter((m): m is ManagerRow & { e164: string } => !!m.e164);
          if (smsCandidates.length > 0) {
            const kind = 'finals-lineup-nag-sms';
            const claimed = await claimNotifications(db, kind, event.id, smsCandidates.map((m) => m.e164));
            if (claimed.length > 0) {
              const claimedSet = new Set(claimed);
              const summary = missing.map((m) => `${m.levelName} ${m.category} ${APPARATUS_NAMES[m.apparatus] ?? m.apparatus}`).join('; ');
              const text = `UCG: The finals-lineup deadline for ${event.name} has passed. Missing: ${summary}. Lineups lock in 1 hour — submit now: ${eventLink}`;
              const recipients = smsCandidates
                .filter((m) => claimedSet.has(m.e164))
                .map((m) => ({ to: m.e164, name: `${m.first_name ?? ''} ${m.last_name ?? ''}`.trim() || undefined }));
              const result = await sendSmsBatch({ apiKey, fromNumber, profileId }, recipients, text);
              if (result.sentRows.length) {
                try { await db.from('sms_messages').insert(result.sentRows); }
                catch (e) { console.error(`scheduled-dispatch: finals-lineup-nag-sms sms_messages insert failed for ${event.id}:${clubId}`, e); }
              }
              if (result.failed.length > 0) {
                console.error(`scheduled-dispatch: finals-lineup-nag-sms send failed for ${event.id}:${clubId}`, result.failed);
                failures.push(`finals-lineup-nag-sms:${event.id}:${clubId}`);
                await releaseClaims(db, kind, event.id, result.failed.map((f) => f.phone));
              }
              smsSent += result.sent.length;
            }
          }
        }
      }
    }
  }

  // --- 3. Hard lock (idempotent: the `eq('finals_roster_locked', false)`
  // clause IS the guard — a re-run after the row already flipped is a no-op) ---
  if (!event.finalsRosterLocked && nowMs >= deadlineMs + 60 * 60 * 1000) {
    const { data: claimed, error: lockErr } = await db
      .from('events')
      .update({ finals_roster_locked: true })
      .eq('id', event.id)
      .eq('finals_roster_locked', false)
      .select('id')
      .maybeSingle();
    if (lockErr) {
      console.error(`scheduled-dispatch: finals-roster hard-lock failed for ${event.id}`, lockErr);
      failures.push(`finals-lock:${event.id}`);
    } else if (claimed) {
      locked = true;
    }
  }

  return { emailsSent, smsSent, locked, failures };
}

/** Groups this event's currently-missing finals lineups by club id (mirrors
 *  src/lib/nationals-teams.ts's `eligibleTeams` grouping + `platformCategory`
 *  category derivation — see the section-header comment above for why this
 *  is replicated rather than imported). */
async function missingFinalsLineupsByClub(db: SupabaseClient, eventId: string): Promise<Map<string, MissingLineup[]>> {
  const { data: regRows, error: regErr } = await db
    .from('registrations')
    .select('id, athlete_id, club_id, discipline, level_id, apparatus, refunded, waitlisted')
    .eq('event_id', eventId);
  if (regErr) throw regErr;
  const regs = ((regRows ?? []) as FinalsRegRow[]).filter((r) => !r.refunded && !r.waitlisted);
  if (regs.length === 0) return new Map();

  const athleteIds = [...new Set(regs.map((r) => r.athlete_id))];
  const peopleById = new Map<string, FinalsPersonRow>();
  if (athleteIds.length > 0) {
    const { data: peopleRows, error: peopleErr } = await db
      .from('people')
      .select('id, gender, student_status, placement')
      .in('id', athleteIds);
    if (peopleErr) throw peopleErr;
    for (const p of (peopleRows ?? []) as FinalsPersonRow[]) peopleById.set(p.id, p);
  }

  // teamKey (clubId|discipline|levelId|category) -> apparatus -> reg count
  const teamApparatusCounts = new Map<string, Map<string, number>>();
  for (const r of regs) {
    if (!r.club_id || !r.level_id) continue;
    const person = peopleById.get(r.athlete_id);
    if (!person) continue; // nothing to categorize
    const placement = (person.placement ?? {})[r.discipline];
    const women = placement ? placement === 'women+' : person.gender === 'Female';
    const collegiate = person.student_status === 'Student';
    const category = `${collegiate ? 'Collegiate' : 'Community'} ${women ? 'Women+' : 'Men+'}`;
    const teamKey = `${r.club_id}|${r.discipline}|${r.level_id}|${category}`;
    let apparatusCounts = teamApparatusCounts.get(teamKey);
    if (!apparatusCounts) { apparatusCounts = new Map(); teamApparatusCounts.set(teamKey, apparatusCounts); }
    for (const apparatus of r.apparatus ?? []) {
      apparatusCounts.set(apparatus, (apparatusCounts.get(apparatus) ?? 0) + 1);
    }
  }

  const eligible: { clubId: string; levelId: string; category: string; apparatus: string }[] = [];
  for (const [teamKey, apparatusCounts] of teamApparatusCounts) {
    const [clubId, , levelId, category] = teamKey.split('|');
    for (const [apparatus, count] of apparatusCounts) {
      if (count >= TEAM_MIN_PER_APPARATUS) eligible.push({ clubId, levelId, category, apparatus });
    }
  }
  if (eligible.length === 0) return new Map();

  const { data: lineupRows, error: lineupErr } = await db
    .from('finals_lineups')
    .select('club_id, level_id, category, apparatus, reg_ids')
    .eq('event_id', eventId);
  if (lineupErr) throw lineupErr;
  const haveKeys = new Set(
    ((lineupRows ?? []) as FinalsLineupRow[])
      .filter((r) => Array.isArray(r.reg_ids) && (r.reg_ids as unknown[]).length > 0)
      .map((r) => `${r.club_id}|${r.level_id}|${r.category}|${r.apparatus}`),
  );

  const levelIds = [...new Set(eligible.map((e) => e.levelId))];
  const levelNameById = new Map<string, string>();
  if (levelIds.length > 0) {
    const { data: levelRows } = await db.from('levels').select('id, name').in('id', levelIds);
    for (const l of levelRows ?? []) levelNameById.set(l.id as string, l.name as string);
  }

  const missingByClub = new Map<string, MissingLineup[]>();
  for (const e of eligible) {
    const key = `${e.clubId}|${e.levelId}|${e.category}|${e.apparatus}`;
    if (haveKeys.has(key)) continue;
    const arr = missingByClub.get(e.clubId) ?? [];
    arr.push({ levelId: e.levelId, levelName: levelNameById.get(e.levelId) ?? e.levelId, category: e.category, apparatus: e.apparatus });
    missingByClub.set(e.clubId, arr);
  }
  return missingByClub;
}

// ---------------------------------------------------------------------------
// f. Daily "anything wrong?" digest (whats-next §3)
// ---------------------------------------------------------------------------
// Sends at most one email per UTC day, gated on the FIRST cron run at or
// after 13:00 UTC (`isDigestFireWindow`). Once-per-day enforcement reuses the
// existing `notification_log` (kind, ref_id, recipient) dedupe idiom rather
// than a new table: `ref_id` is the UTC calendar date (`digestDateKey`), so a
// claim can succeed at most once per day per recipient — the same atomic
// insert-on-conflict-do-nothing race protection every other consumer above
// gets for free. The window reported (new error_logs) spans since the
// PREVIOUS digest's recorded `sent_at` (falls back to 24h). Stuck payments
// are NOT windowed — every currently-stuck row is listed every time, since
// each one represents unreconciled money until it resolves. The email is
// skipped entirely (no claim, no send) when there is nothing to report, so a
// quiet day never emails and never consumes the day's one-digest claim
// (letting a later run the same day still fire if something shows up).

const DIGEST_KIND = 'daily-digest';
const ERROR_ROW_CAP = 20;
const ERROR_MESSAGE_TRUNC = 120;

interface DigestErrorRow {
  id: string;
  created_at: string;
  email: string | null;
  context: string | null;
  message: string;
}

interface DigestPaymentRow {
  id: string;
  created_at: string;
  person_id: string | null;
  amount_subtotal: number | null;
  service_fee: number | null;
  stripe_session_id: string | null;
  status: string;
}

interface DigestResult {
  sent: boolean;
  errorCount: number;
  stuckPaymentCount: number;
  failures: string[];
}

async function runDailyDigest(db: SupabaseClient, nowISO: string, appUrl: string): Promise<DigestResult> {
  const failures: string[] = [];
  if (!isDigestFireWindow(nowISO)) {
    return { sent: false, errorCount: 0, stuckPaymentCount: 0, failures };
  }
  // Staging guard (2026-07-18): staging's APP_PUBLIC_URL points at the local
  // staging dev server (http://localhost:5177), so its digest would email a
  // dead link daily — and staging's error_logs fill with E2E-run noise, so it
  // WOULD fire near-daily. A digest whose CTA can't be opened is not an ops
  // signal; skip on any localhost app URL. (To ever re-enable on staging,
  // point its APP_PUBLIC_URL secret at a reachable URL.)
  if (/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(appUrl)) {
    return { sent: false, errorCount: 0, stuckPaymentCount: 0, failures };
  }

  // Previous digest's send time (most recent notification_log row for this
  // kind, across any recipient/day) drives the reporting window.
  const { data: lastSentRow, error: lastSentErr } = await db
    .from('notification_log')
    .select('sent_at')
    .eq('kind', DIGEST_KIND)
    .order('sent_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lastSentErr) {
    console.error('scheduled-dispatch: daily digest failed to load last sent_at', lastSentErr);
    return { sent: false, errorCount: 0, stuckPaymentCount: 0, failures: ['daily-digest:last-sent-query'] };
  }
  const windowStart = digestWindowStart(nowISO, (lastSentRow?.sent_at as string | undefined) ?? null);

  // New error_logs rows since the window start, most-recent-first, capped for
  // the email body; the true total count drives "and N more".
  const { count: errorTotal, error: errCountErr } = await db
    .from('error_logs')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', windowStart);
  if (errCountErr) {
    console.error('scheduled-dispatch: daily digest failed to count error_logs', errCountErr);
    return { sent: false, errorCount: 0, stuckPaymentCount: 0, failures: ['daily-digest:error-count-query'] };
  }
  const errorCount = errorTotal ?? 0;

  const { data: errorRows, error: errRowsErr } = await db
    .from('error_logs')
    .select('id, created_at, email, context, message')
    .gte('created_at', windowStart)
    .order('created_at', { ascending: false })
    .limit(ERROR_ROW_CAP);
  if (errRowsErr) {
    console.error('scheduled-dispatch: daily digest failed to load error_logs', errRowsErr);
    return { sent: false, errorCount: 0, stuckPaymentCount: 0, failures: ['daily-digest:error-rows-query'] };
  }

  // Every currently-stuck pending payment (created_at < now-1h), regardless
  // of the digest window. The `.lt('created_at', cutoffISO)` clause does the
  // heavy lifting server-side; `isStuckPayment` is re-applied client-side as
  // a defense-in-depth check against the same predicate (unit-tested).
  const cutoffISO = new Date(Date.parse(nowISO) - 60 * 60 * 1000).toISOString();
  const { data: pendingRows, error: pendingErr } = await db
    .from('payments')
    .select('id, created_at, person_id, amount_subtotal, service_fee, stripe_session_id, status')
    .eq('status', 'pending')
    .lt('created_at', cutoffISO)
    .order('created_at', { ascending: true });
  if (pendingErr) {
    console.error('scheduled-dispatch: daily digest failed to load stuck payments', pendingErr);
    return { sent: false, errorCount: 0, stuckPaymentCount: 0, failures: ['daily-digest:payments-query'] };
  }
  const stuckRows = ((pendingRows ?? []) as DigestPaymentRow[])
    .filter((r) => isStuckPayment(nowISO, r.created_at, r.status));

  if (errorCount === 0 && stuckRows.length === 0) {
    return { sent: false, errorCount: 0, stuckPaymentCount: 0, failures };
  }

  const claimed = await claimNotifications(db, DIGEST_KIND, digestDateKey(nowISO), DIGEST_RECIPIENTS);
  if (claimed.length === 0) {
    // Already sent today (or every recipient already claimed) — nothing new
    // to do this run.
    return { sent: false, errorCount, stuckPaymentCount: stuckRows.length, failures };
  }

  // Cheap person-email resolution for stuck payments (id + amount alone is
  // acceptable per spec; a lookup is included here since it's a single batch
  // query, not per-row).
  const personIds = [...new Set(stuckRows.map((r) => r.person_id).filter((id): id is string => !!id))];
  const emailByPersonId = new Map<string, string>();
  if (personIds.length > 0) {
    const { data: peopleRows } = await db.from('people').select('id, email').in('id', personIds);
    for (const p of peopleRows ?? []) {
      if (p.email) emailByPersonId.set(p.id as string, p.email as string);
    }
  }

  const html = renderEmail({
    heading: 'Daily digest',
    bodyHtml: digestBodyHtml(errorRows as DigestErrorRow[], errorCount, stuckRows, emailByPersonId),
    footnoteHtml: `<a href="${appUrl}/#/admin/errors" style="color:#5b6b7a;">Open the admin Error Log</a>`,
  });
  const subject = `UCG daily digest — ${errorCount} new error${errorCount === 1 ? '' : 's'}, ${stuckRows.length} stuck payment${stuckRows.length === 1 ? '' : 's'}`;
  const messages: EmailMessage[] = claimed.map((recipient) => ({ to: recipient, subject, html }));
  const result = await sendBatch(messages);
  if (!result.ok) {
    console.error('scheduled-dispatch: daily digest send failed', result.failed);
    failures.push('daily-digest:send');
    await releaseClaims(db, DIGEST_KIND, digestDateKey(nowISO), claimed);
    return { sent: false, errorCount, stuckPaymentCount: stuckRows.length, failures };
  }

  return { sent: true, errorCount, stuckPaymentCount: stuckRows.length, failures };
}

// g. Season lifecycle nag (P3 2026-07-20, was F6 2026-07-18): escalating
// admin nags while the season starting the upcoming July 1 has no row yet
// (June 1 → june1-tier, June 16 → june16-tier, June 24 through
// daily-past-July-1 → daily-tier — see `nextSeasonNagState`). "Current" and
// "launched" are no longer stored flags — the app derives everything from
// dates — so the old automatic `current` rollover (`rolloverTarget`) is
// GONE: there's no flag left to flip. The nag now instructs the admin to
// CREATE the row (via "Copy → next year" in League Controls → Seasons &
// fees) and review its fees/waivers, not to "launch" it. Isolated in its own
// try/catch at the call site, same as (b)/(d)/(f) above.
const SEASON_NAG_KIND = 'season-launch-nag';

interface SeasonLifecycleResult {
  nagTier: SeasonNagTier;
  nagSent: boolean;
  failures: string[];
}

async function runSeasonLifecycle(db: SupabaseClient, nowISO: string, appUrl: string): Promise<SeasonLifecycleResult> {
  const failures: string[] = [];
  const { data: seasonRows, error: seasonErr } = await db
    .from('seasons')
    .select('id, name, starts_on, ends_on');
  if (seasonErr) {
    console.error('scheduled-dispatch: season-lifecycle failed to load seasons', seasonErr);
    return { nagTier: 'none', nagSent: false, failures: ['season-lifecycle:query'] };
  }
  const seasons = (seasonRows ?? []) as SeasonRow[];
  const seasonAdminUrl = `${appUrl}/#/admin/league/seasons`;

  let adminEmails: string[] | null = null;
  const getAdminEmails = async (): Promise<string[]> => {
    if (adminEmails === null) adminEmails = (await resolveAdminRecipients(db)).map((r) => r.email);
    return adminEmails;
  };

  // --- Escalating nag --------------------------------------------------
  const tier = nextSeasonNagState(seasons, nowISO);
  let nagSent = false;
  if (tier !== 'none') {
    const year = nowISO.slice(0, 4);
    // june1/june16 fire ONCE per fiscal-year cycle (ref_id keyed by year);
    // daily fires once per UTC day (ref_id keyed by calendar date) — mirrors
    // the daily-digest date-key dedupe idiom.
    const refId = tier === 'daily' ? `daily:${digestDateKey(nowISO)}` : `${tier}:${year}`;
    const recipients = await getAdminEmails();
    const claimed = await claimNotifications(db, SEASON_NAG_KIND, refId, recipients);
    if (claimed.length > 0) {
      // The nag only fires while no row exists for this July 1 (see
      // `nextSeasonNagState`), so there's never a season row to name here —
      // always the generic label.
      const label = `the ${year}–${String(Number(year) + 1).slice(2)} season`;
      const subjectByTier: Record<'june1' | 'june16' | 'daily', string> = {
        june1: `[UCG] Set up the ${label} soon`,
        june16: `[UCG] Reminder: set up the ${label}`,
        daily: `[UCG] ACTION NEEDED: set up the ${label}`,
      };
      const html = renderEmail({
        heading: 'Next season needs to be created',
        bodyHtml: `<p>The <strong>${esc(label)}</strong> starts July 1 and hasn't been created yet.</p>
<p>Until it's created, events can't be created in it and its memberships aren't purchasable. Use <strong>Copy → next year</strong> in League Controls → Seasons &amp; fees to create it, then review its fees and waivers.</p>`,
        cta: { text: 'Open season admin', href: seasonAdminUrl },
      });
      const messages: EmailMessage[] = claimed.map((recipient) => ({ to: recipient, subject: subjectByTier[tier as 'june1' | 'june16' | 'daily'], html }));
      const result = await sendBatch(messages);
      if (!result.ok) {
        console.error(`scheduled-dispatch: season nag send failed for ${refId}`, result.failed);
        failures.push(`${SEASON_NAG_KIND}:${refId}`);
        await releaseClaims(db, SEASON_NAG_KIND, refId, claimed);
      } else {
        nagSent = true;
      }
    }
  }

  return { nagTier: tier, nagSent, failures };
}

function formatCents(cents: number | null): string {
  return `$${((cents ?? 0) / 100).toFixed(2)}`;
}

function digestBodyHtml(
  errorRows: DigestErrorRow[],
  errorTotal: number,
  stuckRows: DigestPaymentRow[],
  emailByPersonId: Map<string, string>,
): string {
  const sections: string[] = [];

  sections.push(`<h2 style="font-size:15px;margin:20px 0 8px;">New errors (${errorTotal})</h2>`);
  if (errorRows.length === 0) {
    sections.push('<p>None.</p>');
  } else {
    const rows = errorRows.map((r) => {
      const time = esc(r.created_at.replace('T', ' ').slice(0, 19)) + ' UTC';
      const who = esc(r.email ?? 'guest');
      const context = esc(r.context ?? '—');
      const msg = esc(r.message.length > ERROR_MESSAGE_TRUNC ? `${r.message.slice(0, ERROR_MESSAGE_TRUNC)}…` : r.message);
      return `<tr><td style="padding:4px 8px 4px 0;white-space:nowrap;">${time}</td><td style="padding:4px 8px 4px 0;">${who}</td><td style="padding:4px 8px 4px 0;">${context}</td><td style="padding:4px 0;">${msg}</td></tr>`;
    }).join('');
    sections.push(`<table role="presentation" style="border-collapse:collapse;font-size:13px;width:100%;">${rows}</table>`);
    const more = errorTotal - errorRows.length;
    if (more > 0) sections.push(`<p style="font-size:13px;">…and ${more} more.</p>`);
  }

  sections.push(`<h2 style="font-size:15px;margin:20px 0 8px;">Stuck payments — pending &gt;1h (${stuckRows.length})</h2>`);
  if (stuckRows.length === 0) {
    sections.push('<p>None.</p>');
  } else {
    const rows = stuckRows.map((r) => {
      const time = esc(r.created_at.replace('T', ' ').slice(0, 19)) + ' UTC';
      const who = r.person_id ? esc(emailByPersonId.get(r.person_id) ?? r.person_id) : '—';
      const amount = esc(formatCents((r.amount_subtotal ?? 0) + (r.service_fee ?? 0)));
      const session = esc(r.stripe_session_id ?? '—');
      return `<tr><td style="padding:4px 8px 4px 0;white-space:nowrap;">${time}</td><td style="padding:4px 8px 4px 0;">${esc(r.id)}</td><td style="padding:4px 8px 4px 0;">${who}</td><td style="padding:4px 8px 4px 0;">${amount}</td><td style="padding:4px 0;">${session}</td></tr>`;
    }).join('');
    sections.push(`<table role="presentation" style="border-collapse:collapse;font-size:13px;width:100%;">${rows}</table>`);
  }

  return sections.join('');
}
