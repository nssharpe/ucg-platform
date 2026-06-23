// send-sms — broadcast/test SMS sender for the Communicate feature.
//
// Sends through the Telnyx Messaging API (POST https://api.telnyx.com/v2/messages),
// one request per recipient. Like send-email this is gated to signed-in admins and
// capped to a safe recipient count for now. Real carrier delivery additionally
// requires an APPROVED A2P 10DLC campaign on the Telnyx side — until then sends to
// real numbers are filtered/blocked even though the API call succeeds.
//
// Secrets (set via `supabase secrets set`):
//   TELNYX_API_KEY                V2 API key (Bearer auth)
//   TELNYX_FROM_NUMBER            sending number in E.164, e.g. +15125550123
//   TELNYX_MESSAGING_PROFILE_ID   optional — send via profile instead of/with `from`
//   SMS_MAX_SEGMENTS              optional — server-side per-message segment cap (default 3)
// Auto-provided by the platform: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
//
// Auth: requires a signed-in caller (verify_jwt) holding the `admin` role in
// public.user_roles — same gate as send-email / the Communicate page.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { analyzeMessage } from './segments.ts';

interface Recipient { phone: string; name?: string }
interface Payload {
  body?: string;
  recipients?: Recipient[];
}

// Hard cap for this test path — keep low until 10DLC throughput tier is known.
const MAX_RECIPIENTS = 50;

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

// Normalize loose input to E.164 (US default). Returns null if it can't.
function toE164(raw: string): string | null {
  const trimmed = raw.trim();
  if (/^\+[1-9]\d{7,14}$/.test(trimmed)) return trimmed;       // already E.164
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;              // US 10-digit
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const apiKey = Deno.env.get('TELNYX_API_KEY');
  const fromNumber = Deno.env.get('TELNYX_FROM_NUMBER');
  const profileId = Deno.env.get('TELNYX_MESSAGING_PROFILE_ID');
  const maxSegments = Number(Deno.env.get('SMS_MAX_SEGMENTS') ?? '3');

  if (!apiKey || (!fromNumber && !profileId)) {
    return json({ error: 'SMS is not configured: TELNYX_API_KEY and TELNYX_FROM_NUMBER (or TELNYX_MESSAGING_PROFILE_ID) secrets are missing.' }, 500);
  }

  // --- Authenticate + authorize (must be a signed-in admin) ---
  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'Missing Authorization header.' }, 401);

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData.user) return json({ error: 'Invalid or expired session.' }, 401);

  const { data: roles, error: roleErr } = await admin
    .from('user_roles')
    .select('role')
    .eq('user_id', userData.user.id);
  if (roleErr) return json({ error: 'Could not verify permissions.' }, 500);
  const isAdmin = (roles ?? []).some((r: { role: string }) => r.role === 'admin');
  if (!isAdmin) return json({ error: 'Admin role required to send SMS.' }, 403);

  // --- Validate payload ---
  let payload: Payload;
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }

  const text = (payload.body ?? '').trim();
  if (!text) return json({ error: 'Message body is required.' }, 400);

  // Server-side segment guard — reject blasts that would silently cost a fortune
  // (e.g. an emoji slipped in and every message is now 3 UCS-2 segments).
  const seg = analyzeMessage(text);
  if (seg.segments > maxSegments) {
    return json({
      error: `Message is ${seg.segments} ${seg.encoding} segments (max ${maxSegments}). ` +
        `Shorten it${seg.isUnicode ? ' or remove emoji/special characters' : ''} before sending.`,
    }, 400);
  }

  // Map + validate recipient numbers to E.164.
  const valid: { to: string; name?: string }[] = [];
  const invalid: { phone: string; error: string }[] = [];
  for (const r of payload.recipients ?? []) {
    if (!r || typeof r.phone !== 'string') continue;
    const e164 = toE164(r.phone);
    if (e164) valid.push({ to: e164, name: r.name });
    else invalid.push({ phone: r.phone, error: 'Not a valid US phone number.' });
  }

  if (valid.length === 0) return json({ error: 'No valid recipient phone numbers.', invalid }, 400);
  if (valid.length > MAX_RECIPIENTS) {
    return json({
      error: `This sender is capped at ${MAX_RECIPIENTS} recipients (got ${valid.length}). ` +
        `Raise the cap once the 10DLC throughput tier is confirmed.`,
    }, 400);
  }

  // --- Send via Telnyx, one request per recipient ---
  const sent: string[] = [];
  const failed: { phone: string; error: string }[] = [...invalid];
  // Per-message rows for sms_messages so the webhook can attach delivery receipts.
  const sentRows: { id: string; direction: string; phone: string; status: string }[] = [];

  for (const r of valid) {
    const msg: Record<string, unknown> = { to: r.to, text };
    if (fromNumber) msg.from = fromNumber;
    if (profileId) msg.messaging_profile_id = profileId;
    try {
      const resp = await fetch('https://api.telnyx.com/v2/messages', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(msg),
      });
      if (resp.ok) {
        sent.push(r.to);
        const okBody = await resp.json().catch(() => ({}));
        const id = okBody?.data?.id;
        if (typeof id === 'string') sentRows.push({ id, direction: 'outbound', phone: r.to, status: 'sent' });
      } else {
        const errBody = await resp.json().catch(() => ({}));
        const detail = errBody?.errors?.[0]?.detail ?? errBody?.errors?.[0]?.title ?? `HTTP ${resp.status}`;
        failed.push({ phone: r.to, error: detail });
      }
    } catch (e) {
      failed.push({ phone: r.to, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // Best-effort: record sent messages so DLR webhooks can update their status.
  if (sentRows.length) {
    try { await admin.from('sms_messages').insert(sentRows); }
    catch (e) { console.error('[send-sms] sms_messages insert failed:', e); }
  }

  return json({
    ok: failed.length === 0,
    sentCount: sent.length,
    failedCount: failed.length,
    segments: seg.segments,
    encoding: seg.encoding,
    sent,
    failed,
  });
});
