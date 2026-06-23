// invite-account — a club manager (or admin) creates a real account for someone
// and emails them a branded set-password link via Resend.
//
// Flow: authorize the caller manages the club → create/claim the person row with
// this club as their main club → create the auth user with an invite link (or a
// recovery link if they already exist) → email the link. The link's redirect
// carries ?setpw=1 so the SPA shows a set-password screen, after which the user
// lands on the membership page.
//
// Auth: any signed-in user who manages the target club, or an admin.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendOne } from '../_shared/resend.ts';

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
  const redirectTo = `${appUrl}/?setpw=1`;

  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return json({ ok: false, error: 'Missing Authorization header.' }, 401);

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const { data: userData, error: userErr } = await db.auth.getUser(token);
  if (userErr || !userData.user) return json({ ok: false, error: 'Invalid or expired session.' }, 401);

  let body: { clubId?: string; email?: string; firstName?: string; lastName?: string; kind?: string };
  try { body = await req.json(); } catch { return json({ ok: false, error: 'Invalid JSON body.' }, 400); }

  const clubId = (body.clubId ?? '').trim();
  const email = (body.email ?? '').trim().toLowerCase();
  const firstName = (body.firstName ?? '').trim();
  const lastName = (body.lastName ?? '').trim();
  const kind = body.kind === 'coach' ? 'coach' : 'athlete';
  if (!clubId) return json({ ok: false, error: 'clubId is required.' }, 400);
  if (!EMAIL_RE.test(email)) return json({ ok: false, error: 'A valid recipient email is required.' }, 400);
  if (!firstName || !lastName) return json({ ok: false, error: 'First and last name are required.' }, 400);

  // Authorize: caller manages this club, OR caller is an admin.
  const { data: caller } = await db.from('people').select('id').eq('auth_user_id', userData.user.id).maybeSingle();
  const { data: adminRole } = await db.from('user_roles').select('role').eq('user_id', userData.user.id).eq('role', 'admin').maybeSingle();
  let authorized = !!adminRole;
  if (!authorized && caller) {
    const { data: mgr } = await db.from('club_managers').select('person_id').eq('club_id', clubId).eq('person_id', caller.id).maybeSingle();
    authorized = !!mgr;
  }
  if (!authorized) return json({ ok: false, error: 'You must manage this club to add members.' }, 403);

  const { data: club } = await db.from('clubs').select('name, short_name').eq('id', clubId).maybeSingle();
  if (!club) return json({ ok: false, error: 'Club not found.' }, 404);

  // Create the auth user + invite link. If they already exist, fall back to a
  // recovery (set-password) link so existing users aren't blocked.
  let actionLink: string | null;
  let authUserId: string | null;
  const invite = await db.auth.admin.generateLink({ type: 'invite', email, options: { redirectTo } });
  if (invite.error) {
    const recovery = await db.auth.admin.generateLink({ type: 'recovery', email, options: { redirectTo } });
    if (recovery.error) return json({ ok: false, error: recovery.error.message }, 500);
    actionLink = recovery.data.properties?.action_link ?? null;
    authUserId = recovery.data.user?.id ?? null;
  } else {
    actionLink = invite.data.properties?.action_link ?? null;
    authUserId = invite.data.user?.id ?? null;
  }
  if (!actionLink) return json({ ok: false, error: 'Could not generate a sign-in link.' }, 500);

  // Upsert the person row: claim an existing unclaimed row with this email,
  // else create a new one. Never clobber an already-linked person's club.
  const { data: existing } = await db.from('people')
    .select('id, auth_user_id').eq('email', email).order('created_at', { ascending: true }).limit(1).maybeSingle();
  if (!existing) {
    await db.from('people').insert({
      id: crypto.randomUUID(), auth_user_id: authUserId, kind,
      first_name: firstName, last_name: lastName, email, main_club_id: clubId,
    });
  } else if (!existing.auth_user_id) {
    await db.from('people').update({
      auth_user_id: authUserId, first_name: firstName, last_name: lastName, main_club_id: clubId,
    }).eq('id', existing.id);
  }

  const fullName = `${firstName} ${lastName}`;
  const subject = `Set up your United Club Gymnastics account (${club.short_name})`;
  const html = `<p>Hi ${esc(firstName)},</p>
<p><strong>${esc(club.name)}</strong> has created a United Club Gymnastics account for you.</p>
<p><a href="${esc(actionLink)}">Click here to set your password</a>. Once set, you'll be taken
to the membership page where you can purchase your membership${club.short_name ? ` or send it to ${esc(club.short_name)}'s club cart` : ''}.</p>
<p>If you didn't expect this, you can ignore this email.</p>`;

  try {
    await sendOne({ to: `${fullName} <${email}>`, subject, html });
  } catch (e) {
    return json({ ok: false, error: `Email failed: ${e instanceof Error ? e.message : String(e)}` }, 500);
  }
  return json({ ok: true, sentCount: 1 });
});
