// notify-club-cart — email a club's managers when a member pushes fees to the cart.
//
// Called by a signed-in member (or manager) right after items are added to a
// club's cart. Looks up every manager of that club and emails each one a summary
// of what was added, by whom, and a link to the club cart so they can pay.
//
// Auth: any signed-in user. The "added by" name is derived server-side from the
// caller's own people record (auth_user_id match) so it can't be spoofed; if the
// caller has no linked person, we fall back to the addedByName in the payload.
// Reuses the same Gmail SMTP transport as send-email / request-guardian-waiver.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SMTPClient } from 'https://deno.land/x/denomailer@1.6.0/mod.ts';

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

// Amounts are stored in whole dollars (e.g. 35 → "$35.00"), matching the app's fmtMoney.
const fmtMoney = (dollars: number) =>
  `$${dollars.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

interface Item { label?: string; amount?: number }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const gmailUser = Deno.env.get('GMAIL_USER');
  const gmailPass = Deno.env.get('GMAIL_APP_PASSWORD');
  const fromName = Deno.env.get('GMAIL_FROM_NAME') ?? 'United Club Gymnastics';
  const appUrl = Deno.env.get('APP_PUBLIC_URL') ?? 'https://nssharpe.github.io/ucg-platform';

  if (!gmailUser || !gmailPass) {
    return json({ ok: false, error: 'Email not configured: GMAIL_USER / GMAIL_APP_PASSWORD secrets are missing.' }, 500);
  }

  // --- Authenticate (any signed-in user) ---
  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return json({ ok: false, error: 'Missing Authorization header.' }, 401);

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const { data: userData, error: userErr } = await db.auth.getUser(token);
  if (userErr || !userData.user) return json({ ok: false, error: 'Invalid or expired session.' }, 401);

  // --- Validate payload ---
  let body: { clubId?: string; items?: Item[]; addedByName?: string };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON body.' }, 400);
  }

  const clubId = (body.clubId ?? '').trim();
  if (!clubId) return json({ ok: false, error: 'clubId is required.' }, 400);

  const items = (body.items ?? []).filter((i) => i && typeof i.label === 'string');
  if (items.length === 0) return json({ ok: false, error: 'No items to notify about.' }, 400);

  // --- Resolve the club ---
  const { data: club } = await db
    .from('clubs')
    .select('id, name, short_name')
    .eq('id', clubId)
    .maybeSingle();
  if (!club) return json({ ok: false, error: 'Club not found.' }, 404);

  // --- "Added by": trust the caller's own person record over the payload ---
  const { data: caller } = await db
    .from('people')
    .select('id, first_name, last_name')
    .eq('auth_user_id', userData.user.id)
    .maybeSingle();
  const addedBy = caller
    ? `${caller.first_name} ${caller.last_name}`.trim()
    : (body.addedByName ?? '').trim() || 'a member';

  // --- Look up the club's managers and their emails ---
  const { data: mgrRows, error: mgrErr } = await db
    .from('club_managers')
    .select('person_id')
    .eq('club_id', clubId);
  if (mgrErr) return json({ ok: false, error: mgrErr.message }, 500);

  const managerIds = (mgrRows ?? []).map((r: { person_id: string }) => r.person_id);
  if (managerIds.length === 0) {
    return json({ ok: true, sentCount: 0, note: 'Club has no managers to notify.' });
  }

  const { data: managers, error: mErr } = await db
    .from('people')
    .select('id, first_name, last_name, email')
    .in('id', managerIds);
  if (mErr) return json({ ok: false, error: mErr.message }, 500);

  // Notify every manager except the person who added the items (no self-ping).
  const recipients = (managers ?? [])
    .filter((m) => m.id !== caller?.id && typeof m.email === 'string' && EMAIL_RE.test(m.email.trim()));

  if (recipients.length === 0) {
    return json({ ok: true, sentCount: 0, note: 'No other managers with valid emails to notify.' });
  }

  // --- Compose the email ---
  const total = items.reduce((s, i) => s + (typeof i.amount === 'number' ? i.amount : 0), 0);
  const cartLink = `${appUrl}/#/club/${clubId}/cart`;
  const rows = items
    .map((i) => `<tr><td style="padding:4px 12px 4px 0;">${esc(i.label!)}</td>` +
      `<td style="padding:4px 0;text-align:right;white-space:nowrap;">${fmtMoney(i.amount ?? 0)}</td></tr>`)
    .join('');
  const subject = `${addedBy} added ${items.length} item${items.length > 1 ? 's' : ''} to the ${club.short_name} club cart`;
  const html = `<p>Hello,</p>
<p><strong>${esc(addedBy)}</strong> added the following to <strong>${esc(club.name)}</strong>'s club cart:</p>
<table style="border-collapse:collapse;margin:8px 0;font-size:14px;">${rows}
<tr><td style="padding:8px 12px 0 0;border-top:2px solid #1d2a38;font-weight:700;">Total</td>
<td style="padding:8px 0 0;border-top:2px solid #1d2a38;text-align:right;font-weight:700;">${fmtMoney(total)}</td></tr>
</table>
<p>These memberships stay pending until a club manager pays the cart.</p>
<p><a href="${cartLink}">View &amp; pay the club cart &rarr;</a></p>
<p style="color:#5b6b7a;font-size:12px;">You're receiving this because you manage ${esc(club.short_name)} on the United Club Gymnastics platform.</p>`;

  // --- Send one message per manager (no leaked recipient list) ---
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
      const to = `${r.first_name} ${r.last_name} <${r.email.trim()}>`;
      try {
        await client.send({ from: `${fromName} <${gmailUser}>`, to, subject, html });
        sent.push(r.email.trim());
      } catch (e) {
        failed.push({ email: r.email.trim(), error: e instanceof Error ? e.message : String(e) });
      }
    }
  } finally {
    try { await client.close(); } catch { /* ignore close errors */ }
  }

  return json({ ok: failed.length === 0, sentCount: sent.length, failedCount: failed.length, failed });
});
