// request-manager-access — a signed-in member asks to manage a club ("Request
// Club Admin Role"). Records a manager_access_requests row with a secret token,
// then emails the club's current managers a no-login review link. The first
// manager to approve or deny decides it (idempotent). If the club has NO
// managers yet (e.g. a brand-new club), we fall back to emailing league admins
// so the request isn't lost. Recipients are resolved server-side so the caller
// never sees them.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendBatch, type EmailMessage } from '../_shared/resend.ts';
import { renderEmail } from '../_shared/email-layout.ts';

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
  if (!caller) return json({ ok: false, error: 'No member record for this account.' }, 400);
  const requester = `${caller.first_name} ${caller.last_name}`.trim() || 'A member';
  const requesterEmail = caller.email ?? userData.user.email ?? '';

  // Already a manager? Nothing to request.
  const { data: alreadyMgr } = await db.from('club_managers')
    .select('person_id').eq('club_id', clubId).eq('person_id', caller.id).maybeSingle();
  if (alreadyMgr) return json({ ok: false, error: 'You already manage this club.' }, 400);

  // Record a pending request with a secret review token (reuse an existing
  // pending one for this requester+club so repeated clicks don't pile up).
  let reviewToken: string;
  const { data: existingReq } = await db.from('manager_access_requests')
    .select('token').eq('club_id', clubId).eq('requester_person_id', caller.id).eq('status', 'pending').maybeSingle();
  if (existingReq) {
    reviewToken = existingReq.token;
  } else {
    reviewToken = crypto.randomUUID().replace(/-/g, '');
    const { error: insErr } = await db.from('manager_access_requests').insert({
      token: reviewToken, requester_person_id: caller.id, club_id: clubId, status: 'pending',
    });
    if (insErr) return json({ ok: false, error: insErr.message }, 500);
  }

  // Recipients: the requested club's managers ONLY. If the club has no managers
  // yet, fall back to league admins so the request isn't lost.
  const { data: mgrRows } = await db.from('club_managers').select('person_id').eq('club_id', clubId);
  const managerIds = (mgrRows ?? []).map((r: { person_id: string }) => r.person_id);

  const byManager = managerIds.length
    ? (await db.from('people').select('first_name, last_name, email').in('id', managerIds)).data ?? []
    : [];

  let people = byManager;
  if (people.length === 0) {
    // No-managers fallback: a brand-new club with no managers — email league
    // admins so the request still reaches someone who can act on it.
    const { data: adminRoleRows } = await db.from('user_roles').select('user_id').eq('role', 'admin');
    const adminUserIds = (adminRoleRows ?? []).map((r: { user_id: string }) => r.user_id);
    people = adminUserIds.length
      ? (await db.from('people').select('first_name, last_name, email').in('auth_user_id', adminUserIds)).data ?? []
      : [];
  }

  const seen = new Set<string>();
  const recipients = people.filter((p) => {
    const e = (p.email ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(e) || seen.has(e)) return false;
    seen.add(e);
    return true;
  });
  if (recipients.length === 0) return json({ ok: true, sentCount: 0, note: 'No managers or admins with valid emails.' });

  const link = `${appUrl}/#/manager-access/${reviewToken}`;
  const subject = `Manager access requested for ${club.short_name}`;
  const html = renderEmail({
    heading: 'Manager access requested',
    bodyHtml: `<p>Hello,</p>
<p><strong>${esc(requester)}</strong>${requesterEmail ? ` (${esc(requesterEmail)})` : ''} has requested admin/manager access to <strong>${esc(club.name)}</strong> on the United Club Gymnastics platform.</p>
<p>Review and approve or deny — no login required.</p>`,
    cta: { text: 'Review this request', href: link },
    footnoteHtml: 'The first manager or admin to respond decides the request.',
  });

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
