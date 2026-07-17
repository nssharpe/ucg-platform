// send-club-invite — a club manager invites someone by email.
//   kind 'coach'      → invite to join the club as a coach (sign up).
//   kind 'membership' → invite an athlete to purchase their membership.
//
// Auth: any signed-in user who manages the target club (or an admin). Recipient
// address comes from the caller but the club authorization is enforced
// server-side, so a manager can only invite on behalf of clubs they manage.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendOne } from '../_shared/resend.ts';
import { renderEmail } from '../_shared/email-layout.ts';
import { requireAalForEnrolledCaller } from '../_shared/aal-guard.ts';

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

  let body: { clubId?: string; kind?: string; email?: string; name?: string };
  try { body = await req.json(); } catch { return json({ ok: false, error: 'Invalid JSON body.' }, 400); }

  const clubId = (body.clubId ?? '').trim();
  const kind = body.kind === 'membership' ? 'membership' : 'coach';
  const email = (body.email ?? '').trim();
  const name = (body.name ?? '').trim();
  if (!clubId) return json({ ok: false, error: 'clubId is required.' }, 400);
  if (!EMAIL_RE.test(email)) return json({ ok: false, error: 'A valid recipient email is required.' }, 400);

  // Authorize: caller manages this club, OR caller is an admin.
  const { data: caller } = await db.from('people').select('id').eq('auth_user_id', userData.user.id).maybeSingle();
  const { data: adminRole } = await db.from('user_roles').select('role').eq('user_id', userData.user.id).eq('role', 'admin').maybeSingle();
  let authorized = !!adminRole;
  if (!authorized && caller) {
    const { data: mgr } = await db.from('club_managers').select('person_id').eq('club_id', clubId).eq('person_id', caller.id).maybeSingle();
    authorized = !!mgr;
  }
  if (!authorized) return json({ ok: false, error: 'You must manage this club to invite members.' }, 403);

  // Phase-B AAL guard: an MFA-enrolled caller must present an aal2 JWT.
  const aalDenied = await requireAalForEnrolledCaller(db, userData.user.id, token, corsHeaders);
  if (aalDenied) return aalDenied;

  const { data: club } = await db.from('clubs').select('name, short_name').eq('id', clubId).maybeSingle();
  if (!club) return json({ ok: false, error: 'Club not found.' }, 404);

  const greeting = name ? `Hi ${esc(name)},` : 'Hello,';
  let subject: string; let html: string;
  if (kind === 'membership') {
    const link = `${appUrl}/#/membership`;
    subject = `Purchase your ${club.short_name} membership`;
    html = renderEmail({
      heading: 'Purchase your membership',
      bodyHtml: `<p>${greeting}</p>
<p><strong>${esc(club.name)}</strong> has invited you to purchase your United Club Gymnastics membership.</p>`,
      cta: { text: 'Choose & purchase your membership', href: link },
    });
  } else {
    const link = `${appUrl}/#/?signup=1`;
    subject = `You're invited to join ${club.short_name} on United Club Gymnastics`;
    html = renderEmail({
      heading: `You're invited to join ${esc(club.short_name)}`,
      bodyHtml: `<p>${greeting}</p>
<p><strong>${esc(club.name)}</strong> has added you as a coach on the United Club Gymnastics platform.
Sign up using <strong>this email address</strong> (${esc(email)}) to claim your account.</p>`,
      cta: { text: 'Create your account', href: link },
    });
  }

  try {
    await sendOne({ to: name ? `${name} <${email}>` : email, subject, html });
  } catch (e) {
    return json({ ok: false, error: `Email failed: ${e instanceof Error ? e.message : String(e)}` }, 500);
  }
  return json({ ok: true, sentCount: 1 });
});
