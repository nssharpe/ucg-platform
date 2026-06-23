// sms-webhook — inbound Telnyx Messaging webhook (Phase 4).
//
// Receives Telnyx delivery receipts (DLRs) and inbound replies. Deploy with
// `--no-verify-jwt` (Telnyx cannot send a Supabase JWT); authenticity is instead
// proven by Telnyx's Ed25519 request signature, verified here against the portal
// public key. Paste this function's URL into the messaging profile's Webhook URL:
//   https://wkyerxlgricfphopocoz.supabase.co/functions/v1/sms-webhook
//
// Secrets (set via `supabase secrets set`):
//   TELNYX_PUBLIC_KEY   base64 Ed25519 public key from the Telnyx portal (required)
// Auto-provided: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Email (reused from the Resend infra): RESEND_API_KEY, RESEND_FROM, APP_PUBLIC_URL.
//
// Behavior:
//   - DLR (outbound)  -> update sms_messages.status by Telnyx message id.
//   - inbound reply   -> store in sms_messages + best-effort email league admins
//                        (we never reply over SMS — admins follow up by email).
//   - STOP keyword    -> set people.sms_consent = false for the sender (STOP only;
//                        re-opt-in is manual via the member's profile).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendBatch, type EmailMessage } from '../_shared/resend.ts';
import { parseTelnyxWebhook, isStopKeyword, normalizePhone } from './parse.ts';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Verify Telnyx's Ed25519 signature over `${timestamp}|${rawBody}`. */
async function verifySignature(rawBody: string, sigB64: string, timestamp: string, publicKeyB64: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('raw', b64(publicKeyB64), { name: 'Ed25519' }, false, ['verify']);
    const signed = new TextEncoder().encode(`${timestamp}|${rawBody}`);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, b64(sigB64), signed);
  } catch (e) {
    console.error('[sms-webhook] signature verify error:', e);
    return false;
  }
}

/** Page through people(id, phone) so STOP matching works past PostgREST's 1000-row cap. */
async function findPeopleByPhone(
  db: ReturnType<typeof createClient>,
  last10: string,
): Promise<string[]> {
  const ids: string[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.from('people').select('id, phone').range(from, from + PAGE - 1);
    if (error || !data || data.length === 0) break;
    for (const r of data as { id: string; phone: string | null }[]) {
      if (r.phone && normalizePhone(r.phone) === last10) ids.push(r.id);
    }
    if (data.length < PAGE) break;
  }
  return ids;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const publicKey = Deno.env.get('TELNYX_PUBLIC_KEY');
  if (!publicKey) {
    console.error('[sms-webhook] TELNYX_PUBLIC_KEY is not set — rejecting (fail closed).');
    return json({ error: 'Webhook is not configured.' }, 500);
  }

  // Raw body is required verbatim for signature verification.
  const rawBody = await req.text();
  const sig = req.headers.get('telnyx-signature-ed25519') ?? '';
  const timestamp = req.headers.get('telnyx-timestamp') ?? '';
  if (!sig || !timestamp) return json({ error: 'Missing signature headers.' }, 401);

  // Reject stale requests (replay protection): 5-minute tolerance.
  const tsNum = Number(timestamp);
  if (!tsNum || Math.abs(Date.now() / 1000 - tsNum) > 300) return json({ error: 'Stale or invalid timestamp.' }, 401);

  if (!(await verifySignature(rawBody, sig, timestamp, publicKey))) {
    return json({ error: 'Invalid signature.' }, 401);
  }

  let payload: unknown;
  try { payload = JSON.parse(rawBody); }
  catch { return json({ error: 'Invalid JSON.' }, 400); }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const ev = parseTelnyxWebhook(payload);

  if (ev.kind === 'dlr') {
    // Delivery receipt — update the message-level status. Mark the row's error
    // when the carrier reports a failure so it surfaces in the admin log.
    const failed = /fail|undeliver|expired|rejected/i.test(ev.status);
    await db.from('sms_messages')
      .update({ status: ev.status, error: failed ? ev.status : null, updated_at: new Date().toISOString() })
      .eq('id', ev.messageId);
    return json({ ok: true, handled: 'dlr', status: ev.status });
  }

  if (ev.kind === 'inbound') {
    // Store the inbound reply (idempotent on the Telnyx message id).
    await db.from('sms_messages').upsert({
      id: ev.messageId, direction: 'inbound', phone: ev.from, status: 'received', body: ev.text,
      updated_at: new Date().toISOString(),
    });

    let consentRevoked = false;
    if (isStopKeyword(ev.text)) {
      const ids = await findPeopleByPhone(db, normalizePhone(ev.from));
      if (ids.length) {
        await db.from('people').update({ sms_consent: false }).in('id', ids);
        consentRevoked = true;
      }
    }

    // Notify league admins by email (best-effort) — we never reply over SMS.
    try {
      const { data: adminRoleRows } = await db.from('user_roles').select('user_id').eq('role', 'admin');
      const adminUserIds = (adminRoleRows ?? []).map((r: { user_id: string }) => r.user_id);
      const admins = adminUserIds.length
        ? (await db.from('people').select('first_name, last_name, email').in('auth_user_id', adminUserIds)).data ?? []
        : [];
      const seen = new Set<string>();
      const recipients = (admins as { first_name: string; last_name: string; email: string | null }[]).filter((p) => {
        const e = (p.email ?? '').trim().toLowerCase();
        if (!EMAIL_RE.test(e) || seen.has(e)) return false;
        seen.add(e);
        return true;
      });
      if (recipients.length) {
        const subject = `Inbound text from ${ev.from}${consentRevoked ? ' (opted out)' : ''}`;
        const html = `<p>An inbound SMS reply was received on the UCG number:</p>
<p><strong>From:</strong> ${esc(ev.from)}<br/>
<strong>Message:</strong> ${esc(ev.text || '(no text)')}</p>
${consentRevoked ? '<p>This was a STOP keyword — their SMS consent has been turned off.</p>' : ''}
<p>We do not reply over SMS. If a response is needed, follow up by email.</p>`;
        const messages: EmailMessage[] = recipients.map((r) => ({
          to: `${r.first_name} ${r.last_name} <${(r.email as string).trim()}>`, subject, html,
        }));
        await sendBatch(messages);
      }
    } catch (e) {
      console.error('[sms-webhook] admin notify failed:', e);
    }

    return json({ ok: true, handled: 'inbound', consentRevoked });
  }

  return json({ ok: true, handled: 'ignored', eventType: ev.eventType });
});
