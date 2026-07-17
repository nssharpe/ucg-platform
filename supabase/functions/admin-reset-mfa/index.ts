// admin-reset-mfa — league-admin break-glass: deletes ALL of a target auth
// user's MFA factors (docs/research/2026-06-22-auth-2fa-passkeys.md Phase B
// "Admin reset path"). For a user who lost their authenticator/passkey — the
// platform has no recovery-code story, so this is the only in-app recovery.
//
// Auth: caller must be signed in and hold the `admin` role in public.user_roles
// (same gate as send-email — service-role client, no RLS reliance).
//
// NOTE — last-admin lockout: if the ONLY remaining admin loses their own
// factor and no other admin can run this function for them, the break-glass
// is the Supabase dashboard (Auth → Users → find the user → delete their MFA
// factor there). See supabase/README.md.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendOne } from '../_shared/resend.ts';
import { renderEmail } from '../_shared/email-layout.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

interface Payload {
  targetUserId?: string;
  targetEmail?: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return json({ ok: false, error: 'Missing Authorization header.' }, 401);

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const { data: callerData, error: callerErr } = await admin.auth.getUser(token);
  if (callerErr || !callerData.user) return json({ ok: false, error: 'Invalid or expired session.' }, 401);

  const { data: roles, error: roleErr } = await admin
    .from('user_roles')
    .select('role')
    .eq('user_id', callerData.user.id);
  if (roleErr) return json({ ok: false, error: 'Could not verify permissions.' }, 500);
  const isAdmin = (roles ?? []).some((r: { role: string }) => r.role === 'admin');
  if (!isAdmin) return json({ ok: false, error: 'Admin role required to reset two-factor authentication.' }, 403);

  let payload: Payload;
  try { payload = await req.json(); } catch { return json({ ok: false, error: 'Invalid JSON body.' }, 400); }

  const targetUserId = (payload.targetUserId ?? '').trim();
  const targetEmail = (payload.targetEmail ?? '').trim().toLowerCase();
  if (!targetUserId && !targetEmail) return json({ ok: false, error: 'targetUserId or targetEmail is required.' }, 400);

  // Resolve + validate the target exists.
  let userId = targetUserId;
  if (!userId) {
    const { data: found, error: findErr } = await admin.auth.admin.listUsers();
    if (findErr) return json({ ok: false, error: 'Could not look up the target user.' }, 500);
    const match = found.users.find((u) => (u.email ?? '').toLowerCase() === targetEmail);
    if (!match) return json({ ok: false, error: 'No account found for that email.' }, 404);
    userId = match.id;
  }
  const { data: targetUserData, error: targetErr } = await admin.auth.admin.getUserById(userId);
  if (targetErr || !targetUserData.user) return json({ ok: false, error: 'Target user not found.' }, 404);
  const targetUser = targetUserData.user;

  // Delete every factor (Supabase's admin API deletes one at a time).
  const { data: factorData, error: listErr } = await admin.auth.admin.mfa.listFactors({ userId });
  if (listErr) return json({ ok: false, error: `Could not list factors: ${listErr.message}` }, 500);
  const factors = factorData?.factors ?? [];
  const failures: string[] = [];
  for (const f of factors) {
    const { error: delErr } = await admin.auth.admin.mfa.deleteFactor({ id: f.id, userId });
    if (delErr) failures.push(`${f.id}: ${delErr.message}`);
  }
  if (failures.length > 0) {
    return json({ ok: false, error: `Removed some factors but failed on: ${failures.join('; ')}` }, 500);
  }

  // Notify the target — best-effort; the reset itself already succeeded.
  let emailed = false;
  if (targetUser.email) {
    try {
      const html = renderEmail({
        heading: 'Two-factor authentication reset',
        bodyHtml: `<p>A league administrator reset two-factor authentication on your United Club Gymnastics
account. You can sign in with just your password now, and set up a new authenticator app or passkey
from your Profile page whenever you're ready.</p>
<p>If you didn't expect this, contact a league admin right away.</p>`,
      });
      await sendOne({ to: targetUser.email, subject: 'Your two-factor authentication was reset', html });
      emailed = true;
    } catch { /* factor deletion already succeeded — email failure is non-fatal */ }
  }

  return json({ ok: true, removedCount: factors.length, emailed });
});
