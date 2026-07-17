// create-waiver-link — an admin or club manager mints a no-login waiver signing
// link for a member, tied to their athlete record. Used by the League → member
// "Activate" flow: a manually-activated membership stays "pending-waiver" until
// the member (or their guardian) signs via this link, at which point
// record-waiver-signature flips it to active — exactly like the minor flow.
//
// Returns { ok, token, link }. Emailing is done client-side via send-email, so
// the same minted token can be both copied and emailed.
//
// Auth: a signed-in admin, OR a manager of the person's main club.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { requireAalForEnrolledCaller } from '../_shared/aal-guard.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const appUrl = Deno.env.get('APP_PUBLIC_URL') ?? 'https://nssharpe.github.io/ucg-platform';

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return json({ ok: false, error: 'Missing Authorization header.' }, 401);

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const { data: userData, error: userErr } = await db.auth.getUser(token);
  if (userErr || !userData.user) return json({ ok: false, error: 'Invalid or expired session.' }, 401);

  let body: { personId?: string; seasonId?: string; waiverType?: string; membershipType?: string; signerRole?: string };
  try { body = await req.json(); } catch { return json({ ok: false, error: 'Invalid JSON body.' }, 400); }

  const personId = (body.personId ?? '').trim();
  const seasonId = (body.seasonId ?? '').trim();
  const waiverType = (body.waiverType ?? '').trim();
  const membershipType = (body.membershipType ?? 'all').trim();
  // 'self' (adult signs their own) or 'guardian' (parent signs for a minor).
  // Default 'guardian' for back-compat with the original minor flow.
  const signerRole = body.signerRole === 'self' ? 'self' : 'guardian';
  if (!personId || !seasonId || !waiverType) {
    return json({ ok: false, error: 'personId, seasonId and waiverType are required.' }, 400);
  }

  // --- Look up the target person (+ their main club) ---
  const { data: person } = await db.from('people')
    .select('id, email, main_club_id').eq('id', personId).maybeSingle();
  if (!person) return json({ ok: false, error: 'Member not found.' }, 404);

  // --- Authorize: admin, or a manager of the person's main club ---
  const { data: adminRole } = await db.from('user_roles')
    .select('role').eq('user_id', userData.user.id).eq('role', 'admin').maybeSingle();
  let authorized = !!adminRole;
  if (!authorized && person.main_club_id) {
    const { data: caller } = await db.from('people').select('id').eq('auth_user_id', userData.user.id).maybeSingle();
    if (caller) {
      const { data: mgr } = await db.from('club_managers')
        .select('person_id').eq('club_id', person.main_club_id).eq('person_id', caller.id).maybeSingle();
      authorized = !!mgr;
    }
  }
  if (!authorized) return json({ ok: false, error: 'You must be an admin or a manager of this member’s club.' }, 403);

  // Phase-B AAL guard: an MFA-enrolled caller must present an aal2 JWT.
  const aalDenied = await requireAalForEnrolledCaller(db, userData.user.id, token, corsHeaders);
  if (aalDenied) return aalDenied;

  // --- Mint a pending signing token (guardian_email is NOT NULL; default to the
  // member's own address — the link works regardless of which is recorded) ---
  const signToken = crypto.randomUUID().replace(/-/g, '');
  const { error: insErr } = await db.from('waiver_sign_requests').insert({
    token: signToken,
    person_id: personId,
    season_id: seasonId,
    waiver_type: waiverType,
    membership_type: membershipType,
    guardian_email: person.email ?? '',
    signer_role: signerRole,
    status: 'pending',
  });
  if (insErr) return json({ ok: false, error: insErr.message }, 500);

  return json({ ok: true, token: signToken, link: `${appUrl}/#/waiver/sign/${signToken}`, signerRole });
});
