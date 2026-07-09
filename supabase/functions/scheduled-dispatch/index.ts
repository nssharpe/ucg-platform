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

  return json({ ok: failures.length === 0, reminders3d, reminders1d, closures, ownerTaskReminders, failures });
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
