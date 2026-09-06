// invite-account — a club manager (or admin) creates a real account for someone
// and emails them a branded set-password link via Resend.
//
// Flow: authorize the caller manages the club → create/claim the person row with
// this club as their main club → create the auth user with an invite link (or a
// recovery link if they already exist) → email the link. The link's redirect
// carries ?setpw=invite so the SPA shows a set-password screen, after which the
// user lands on the membership page.
//
// Auth: any signed-in user who manages the target club, or an admin.
//
// `clubId` is OPTIONAL (UAT round 2 A-07-01) — AdminMembers.tsx's per-person
// "Invite"/"Resend" row action and the "+ New person" flow route through this
// function too now (previously they used a plain-text sendEmail signup-link,
// landing on a generic signup screen instead of a real set-password link).
// Those admin flows can target an Independent Athlete with no club at all, so
// an admin caller may omit clubId entirely; a club-manager caller (Club.tsx's
// "add athlete") must always supply one — that's the only path the
// club-manager authorization branch below can validate against.
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
  // 'invite' (not the old bare `setpw=1`) so SetPassword.tsx can send this
  // flow to /membership specifically, distinct from a password-reset link
  // (Gate.tsx's forgotPassword, `?setpw=reset`), which goes Home instead
  // (UAT A-07-02 / A-06-01).
  const redirectTo = `${appUrl}/?setpw=invite`;

  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return json({ ok: false, error: 'Missing Authorization header.' }, 401);

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const { data: userData, error: userErr } = await db.auth.getUser(token);
  if (userErr || !userData.user) return json({ ok: false, error: 'Invalid or expired session.' }, 401);

  let body: { clubId?: string; email?: string; firstName?: string; lastName?: string; kind?: string; personId?: string };
  try { body = await req.json(); } catch { return json({ ok: false, error: 'Invalid JSON body.' }, 400); }

  const clubId = (body.clubId ?? '').trim();
  const email = (body.email ?? '').trim().toLowerCase();
  const firstName = (body.firstName ?? '').trim();
  const lastName = (body.lastName ?? '').trim();
  const kind = body.kind === 'coach' ? 'coach' : 'athlete';
  // Optional (UAT round 2 A-07-01): when the caller already has a specific
  // person in hand (AdminMembers.tsx's per-row invite/resend), target that
  // EXACT row instead of the default "oldest unclaimed row matching email"
  // lookup below — duplicate-email people are a real, supported case (the
  // schema comment in 20260601000005_account_foundation.sql explicitly calls
  // out unclaimed rows sharing an email, and AdminMembers.tsx ships a "Merge
  // duplicates…" tool for exactly this), so an email-only match could
  // silently stamp auth_user_id onto the WRONG row.
  const personId = (body.personId ?? '').trim();
  if (!EMAIL_RE.test(email)) return json({ ok: false, error: 'A valid recipient email is required.' }, 400);
  if (!firstName || !lastName) return json({ ok: false, error: 'First and last name are required.' }, 400);

  // Authorize: caller manages this club, OR caller is an admin. A club
  // manager MUST supply clubId (that's the only thing their authorization can
  // be checked against); an admin may omit it entirely (independent-athlete
  // invite from AdminMembers.tsx).
  const { data: caller } = await db.from('people').select('id').eq('auth_user_id', userData.user.id).maybeSingle();
  const { data: adminRole } = await db.from('user_roles').select('role').eq('user_id', userData.user.id).eq('role', 'admin').maybeSingle();
  let authorized = !!adminRole;
  if (!authorized) {
    if (!clubId) return json({ ok: false, error: 'clubId is required.' }, 400);
    if (caller) {
      const { data: mgr } = await db.from('club_managers').select('person_id').eq('club_id', clubId).eq('person_id', caller.id).maybeSingle();
      authorized = !!mgr;
    }
  }
  if (!authorized) return json({ ok: false, error: 'You must manage this club to add members.' }, 403);

  // Phase-B AAL guard: an MFA-enrolled caller must present an aal2 JWT.
  const aalDenied = await requireAalForEnrolledCaller(db, userData.user.id, token, corsHeaders);
  if (aalDenied) return aalDenied;

  let club: { name: string; short_name: string } | null = null;
  if (clubId) {
    const { data: clubRow } = await db.from('clubs').select('name, short_name').eq('id', clubId).maybeSingle();
    if (!clubRow) return json({ ok: false, error: 'Club not found.' }, 404);
    club = clubRow;
  }

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

  // Upsert the person row: when a personId was supplied, resolve that EXACT
  // row; otherwise claim the oldest unclaimed row matching this email (the
  // legacy behavior Club.tsx's manager-side "add athlete" still relies on,
  // where no specific person is in hand yet). Never clobber an
  // already-linked person's club.
  const { data: existing } = personId
    ? await db.from('people').select('id, auth_user_id, email').eq('id', personId).maybeSingle()
    : await db.from('people')
        .select('id, auth_user_id, email').eq('email', email).order('created_at', { ascending: true }).limit(1).maybeSingle();
  // Reviewer-added (round 2): a personId-targeted invite must be for that
  // row's OWN email. Without this, any authorized caller (including a club
  // manager, who can pass personId alongside their clubId) could bind a
  // fresh auth account on an ARBITRARY email to someone else's unclaimed
  // person row — cross-club identity capture. Fail closed on mismatch.
  if (personId && existing && (existing.email ?? '').trim().toLowerCase() !== email.trim().toLowerCase()) {
    return json({ ok: false, error: 'That person has a different email on file — update their profile email first, then resend the invite.' }, 409);
  }
  if (personId && !existing) {
    return json({ ok: false, error: 'Person not found.' }, 404);
  }
  // roles must match the invited kind — the people.roles column defaults to
  // athlete-only, so a coach insert that omits it would show as an athlete.
  const roles = kind === 'coach' ? { athlete: false, coach: true } : { athlete: true, coach: false };
  if (!existing) {
    await db.from('people').insert({
      id: crypto.randomUUID(), auth_user_id: authUserId, kind, roles,
      first_name: firstName, last_name: lastName, email, main_club_id: clubId || null,
    });
  } else if (!existing.auth_user_id) {
    // Only touch main_club_id when a clubId was actually supplied — an
    // Independent Athlete admin-invite (no clubId) must never clear an
    // existing club affiliation it doesn't know about.
    await db.from('people').update({
      auth_user_id: authUserId, first_name: firstName, last_name: lastName,
      ...(clubId ? { main_club_id: clubId } : {}),
    }).eq('id', existing.id);
  }

  const fullName = `${firstName} ${lastName}`;
  const subject = `Set up your United Club Gymnastics account${club ? ` (${club.short_name})` : ''}`;
  const html = renderEmail({
    heading: 'Set up your account',
    bodyHtml: `<p>Hi ${esc(firstName)},</p>
<p>${club ? `<strong>${esc(club.name)}</strong> has created a` : 'We have created a'} United Club Gymnastics account for you. Set your
password to get started — you'll land on the membership page where you can purchase your
membership${club?.short_name ? ` or send it to ${esc(club.short_name)}'s club cart` : ''}.</p>`,
    cta: { text: 'Set your password', href: esc(actionLink) },
    footnoteHtml: "If you didn't expect this, you can ignore this email.",
  });

  try {
    await sendOne({ to: `${fullName} <${email}>`, subject, html });
  } catch (e) {
    return json({ ok: false, error: `Email failed: ${e instanceof Error ? e.message : String(e)}` }, 500);
  }
  return json({ ok: true, sentCount: 1 });
});
