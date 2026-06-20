// send-email — broadcast/test email sender for the Communicate feature.
//
// Sends through Gmail SMTP (smtp.gmail.com:465) using an app password, for now.
// This is test-grade infrastructure: a recipient cap guards against accidentally
// blasting the full ~2,600-person list through a personal Gmail account (Gmail's
// daily recipient limits are well under that). Swap the transport for Resend /
// Workspace SMTP relay before doing real production sends.
//
// Secrets (set via `supabase secrets set`):
//   GMAIL_USER          e.g. nate.sharpe@naigc.org
//   GMAIL_APP_PASSWORD  16-char Google app password (requires 2FA on the account)
//   GMAIL_FROM_NAME     optional display name (default "United Club Gymnastics")
// Auto-provided by the platform: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
//
// Auth: requires a signed-in caller (verify_jwt) who holds the `admin` role in
// public.user_roles — the same gate as the Communicate page (RequireAdmin).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SMTPClient } from 'https://deno.land/x/denomailer@1.6.0/mod.ts';

interface Recipient { email: string; name?: string }
interface Payload {
  subject?: string;
  html?: string;
  text?: string;
  recipients?: Recipient[];
}

// Hard cap for this Gmail test path — keep well under Gmail's daily limits.
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
  const gmailUser = Deno.env.get('GMAIL_USER');
  const gmailPass = Deno.env.get('GMAIL_APP_PASSWORD');
  const fromName = Deno.env.get('GMAIL_FROM_NAME') ?? 'United Club Gymnastics';

  if (!gmailUser || !gmailPass) {
    return json({ error: 'Email is not configured: GMAIL_USER / GMAIL_APP_PASSWORD secrets are missing.' }, 500);
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
      error: `This test sender is capped at ${MAX_RECIPIENTS} recipients (got ${recipients.length}). ` +
        `Switch to Resend or Workspace SMTP relay for full-list sends.`,
    }, 400);
  }

  // --- Send via Gmail SMTP, one message per recipient (no leaked recipient list) ---
  const client = new SMTPClient({
    connection: {
      hostname: 'smtp.gmail.com',
      port: 465,
      tls: true,
      auth: { username: gmailUser, password: gmailPass },
    },
  });

  const sent: string[] = [];
  const failed: { email: string; error: string }[] = [];

  try {
    for (const r of recipients) {
      const to = r.name ? `${r.name} <${r.email.trim()}>` : r.email.trim();
      try {
        await client.send({
          from: `${fromName} <${gmailUser}>`,
          to,
          subject,
          content: text || undefined,
          html: html || undefined,
        });
        sent.push(r.email.trim());
      } catch (e) {
        failed.push({ email: r.email.trim(), error: e instanceof Error ? e.message : String(e) });
      }
    }
  } finally {
    try { await client.close(); } catch { /* ignore close errors */ }
  }

  return json({ ok: failed.length === 0, sentCount: sent.length, failedCount: failed.length, sent, failed });
});
