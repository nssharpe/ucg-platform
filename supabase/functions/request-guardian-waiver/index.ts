// request-guardian-waiver — create a pending signing token + email the guardian.
//
// Called by a signed-in member to request guardian signature on a minor's waiver.
// Creates a row in waiver_sign_requests with a unique token, then emails the
// guardian a link to the signing page (HashRouter: #/waiver/sign/<token>).
//
// Auth: any signed-in user who owns the athlete record (people.auth_user_id match).
// Reuses the same Gmail SMTP transport as send-email.

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
  const signToken = crypto.randomUUID().replace(/-/g, '');
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
  const html = `<p>Hello ${body.guardianName ?? ''},</p>
<p>${athlete} has requested that you, as parent/guardian, sign the
${body.waiverType} waiver for United Club Gymnastics.</p>
<p><a href="${link}">Click here to review and sign the waiver</a>.</p>
<p>This is an electronic signature with timestamp and IP recorded.</p>`;

  const client = new SMTPClient({
    connection: {
      hostname: 'smtp.gmail.com',
      port: 465,
      tls: true,
      auth: { username: gmailUser, password: gmailPass },
    },
  });

  try {
    await client.send({
      from: `${fromName} <${gmailUser}>`,
      to: guardianEmail,
      subject: `Sign the ${body.waiverType} waiver for ${athlete}`,
      html,
    });
  } catch (e) {
    return json({ ok: false, error: `Email failed: ${e instanceof Error ? e.message : String(e)}` }, 500);
  } finally {
    try { await client.close(); } catch { /* ignore close errors */ }
  }

  return json({ ok: true });
});
