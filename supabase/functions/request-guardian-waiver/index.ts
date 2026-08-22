// request-guardian-waiver — create a pending signing token + email the guardian.
//
// Called by a signed-in member to request guardian signature on a minor's waiver.
// Creates a row in waiver_sign_requests with a unique token, then emails the
// guardian a link to the signing page (HashRouter: #/waiver/sign/<token>).
//
// Auth: any signed-in user who owns the athlete record (people.auth_user_id match).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendOne } from '../_shared/resend.ts';
import { renderEmail } from '../_shared/email-layout.ts';
import { randomToken } from '../_shared/token.ts';

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
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const appUrl = Deno.env.get('APP_PUBLIC_URL') ?? 'https://nssharpe.github.io/ucg-platform';

  // --- Authenticate (any signed-in user) ---
  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return json({ ok: false, error: 'Missing Authorization header.' }, 401);

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const { data: userData, error: userErr } = await db.auth.getUser(token);
  if (userErr || !userData.user) return json({ ok: false, error: 'Invalid or expired session.' }, 401);

  // --- Validate payload ---
  let body: {
    personId?: string;
    seasonId?: string;
    waiverType?: string;
    membershipType?: string;
    guardianEmail?: string;
    guardianName?: string;
  };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON body.' }, 400);
  }

  const guardianEmail = (body.guardianEmail ?? '').trim();
  if (!EMAIL_RE.test(guardianEmail)) {
    return json({ ok: false, error: 'Invalid guardian email.' }, 400);
  }

  // --- Caller must own the athlete record ---
  const { data: person } = await db
    .from('people')
    .select('id, first_name, last_name')
    .eq('id', body.personId)
    .eq('auth_user_id', userData.user.id)
    .maybeSingle();
  if (!person) return json({ ok: false, error: 'Not your record.' }, 403);

  // --- Create pending signing token ---
  const signToken = randomToken();
  const { error: insErr } = await db.from('waiver_sign_requests').insert({
    token: signToken,
    person_id: body.personId,
    season_id: body.seasonId,
    waiver_type: body.waiverType,
    membership_type: body.membershipType,
    guardian_email: guardianEmail,
    status: 'pending',
  });
  if (insErr) return json({ ok: false, error: insErr.message }, 500);

  // --- Send email to guardian ---
  const link = `${appUrl}/#/waiver/sign/${signToken}`;
  const athlete = `${person.first_name} ${person.last_name}`;
  const html = renderEmail({
    heading: 'Signature requested',
    bodyHtml: `<p>Hello ${esc(body.guardianName ?? '')},</p>
<p>${esc(athlete)} has requested that you, as parent/guardian, sign the
UCG waiver for United Club Gymnastics.</p>`,
    cta: { text: 'Review & sign the waiver', href: link },
    footnoteHtml: 'This is an electronic signature with timestamp and IP recorded.',
  });

  try {
    await sendOne({ to: guardianEmail, subject: `Sign the UCG waiver for ${athlete}`, html });
  } catch (e) {
    return json({ ok: false, error: `Email failed: ${e instanceof Error ? e.message : String(e)}` }, 500);
  }

  return json({ ok: true });
});
