// request-manager-access — a signed-in member asks to manage a club.
// Emails the club's current managers + all league admins. No DB record (email
// only); recipients are resolved server-side so the caller never sees them.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendBatch, type EmailMessage } from '../_shared/resend.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const appUrl = Deno.env.get('APP_PUBLIC_URL') ?? 'https://nssharpe.github.io/ucg-platform';

  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return json({ ok: false, error: 'Missing Authorization header.' }, 401);

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const { data: userData, error: userErr } = await db.auth.getUser(token);
  if (userErr || !userData.user) return json({ ok: false, error: 'Invalid or expired session.' }, 401);

  let body: { clubId?: string };
  try { body = await req.json(); } catch { return json({ ok: false, error: 'Invalid JSON body.' }, 400); }
  const clubId = (body.clubId ?? '').trim();
  if (!clubId) return json({ ok: false, error: 'clubId is required.' }, 400);

  const { data: club } = await db.from('clubs').select('name, short_name').eq('id', clubId).maybeSingle();
  if (!club) return json({ ok: false, error: 'Club not found.' }, 404);

  const { data: caller } = await db.from('people').select('id, first_name, last_name, email').eq('auth_user_id', userData.user.id).maybeSingle();
  const requester = caller ? `${caller.first_name} ${caller.last_name}`.trim() : 'A member';
  const requesterEmail = caller?.email ?? userData.user.email ?? '';

  // Recipients: club managers + league admins.
  const { data: mgrRows } = await db.from('club_managers').select('person_id').eq('club_id', clubId);
  const managerIds = (mgrRows ?? []).map((r: { person_id: string }) => r.person_id);
  const { data: adminRoleRows } = await db.from('user_roles').select('user_id').eq('role', 'admin');
  const adminUserIds = (adminRoleRows ?? []).map((r: { user_id: string }) => r.user_id);

  const byManager = managerIds.length
    ? (await db.from('people').select('first_name, last_name, email').in('id', managerIds)).data ?? []
    : [];
  const byAdmin = adminUserIds.length
    ? (await db.from('people').select('first_name, last_name, email').in('auth_user_id', adminUserIds)).data ?? []
    : [];

  const seen = new Set<string>();
  const recipients = [...byManager, ...byAdmin].filter((p) => {
    const e = (p.email ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(e) || seen.has(e)) return false;
    seen.add(e);
    return true;
  });
  if (recipients.length === 0) return json({ ok: true, sentCount: 0, note: 'No managers or admins with valid emails.' });

  const link = `${appUrl}/#/club/${clubId}`;
  const subject = `Manager access requested for ${club.short_name}`;
  const html = `<p>Hello,</p>
<p><strong>${esc(requester)}</strong>${requesterEmail ? ` (${esc(requesterEmail)})` : ''} has requested manager access to <strong>${esc(club.name)}</strong> on the United Club Gymnastics platform.</p>
<p>If this is legitimate, add them as a manager from the club page:</p>
<p><a href="${link}">Open ${esc(club.short_name)} &rarr;</a></p>`;

  const messages: EmailMessage[] = recipients.map((r) => ({
    to: `${r.first_name} ${r.last_name} <${(r.email as string).trim()}>`,
    subject,
    html,
  }));
  let result;
  try { result = await sendBatch(messages); }
  catch (e) { return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500); }
  return json({ ok: result.ok, sentCount: result.sentCount, failedCount: result.failedCount, failed: result.failed });
});
