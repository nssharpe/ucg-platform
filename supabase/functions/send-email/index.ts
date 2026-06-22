// send-email — broadcast/test email sender for the Communicate feature.
//
// Sends through the Resend batch API via the shared helper in _shared/resend.ts.
//
// Secrets (set via `supabase secrets set`):
//   RESEND_API_KEY      Resend API key
// Auto-provided by the platform: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
//
// Auth: requires a signed-in caller (verify_jwt) who holds the `admin` role in
// public.user_roles — the same gate as the Communicate page (RequireAdmin).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendBatch, type EmailMessage } from '../_shared/resend.ts';

interface Recipient { email: string; name?: string }
interface Payload {
  subject?: string;
  html?: string;
  text?: string;
  recipients?: Recipient[];
}

// Hard cap — raise once on a paid Resend plan with a higher daily limit.
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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
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
  if (!isAdmin) return json({ error: 'Admin role required to send email.' }, 403);

  // --- Validate payload ---
  let payload: Payload;
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }

  const subject = (payload.subject ?? '').trim();
  const html = payload.html ?? '';
  const text = payload.text ?? '';
  const recipients = (payload.recipients ?? [])
    .filter((r) => r && typeof r.email === 'string' && EMAIL_RE.test(r.email.trim()));

  if (!subject) return json({ error: 'Subject is required.' }, 400);
  if (!html && !text) return json({ error: 'Email body is required.' }, 400);
  if (recipients.length === 0) return json({ error: 'No valid recipients.' }, 400);
  if (recipients.length > MAX_RECIPIENTS) {
    return json({
      error: `This sender is capped at ${MAX_RECIPIENTS} recipients (got ${recipients.length}). ` +
        `Raise MAX_RECIPIENTS once on a paid Resend plan with a higher daily limit.`,
    }, 400);
  }

  // --- Send via Resend batch (one distinct message per recipient) ---
  const messages: EmailMessage[] = recipients.map((r) => ({
    to: r.name ? `${r.name} <${r.email.trim()}>` : r.email.trim(),
    subject,
    html: html || undefined,
    text: text || undefined,
  }));

  let result;
  try {
    result = await sendBatch(messages);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
  return json({
    ok: result.ok,
    sentCount: result.sentCount,
    failedCount: result.failedCount,
    sent: result.sent,
    failed: result.failed,
  });
});
