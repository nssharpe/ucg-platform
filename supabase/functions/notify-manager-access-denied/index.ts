// notify-manager-access-denied — emails the requester that their "Request Club
// Admin Role" request was NOT approved.
//
// Called from the no-login review page (ManagerAccessReview) right after a
// reviewer denies a request. The reviewer is anonymous (token-gated review
// link), so this function takes no auth — it is gated purely by the secret
// request token. It resolves the requester + club server-side with the service
// role and only sends if the request is actually in the 'denied' state (fails
// closed: no token, unknown token, or non-denied status → no email). Deploy with
// --no-verify-jwt.
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
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  let body: { token?: string };
  try { body = await req.json(); } catch { return json({ ok: false, error: 'Invalid JSON body.' }, 400); }
  const token = (body.token ?? '').trim();
  if (!token) return json({ ok: false, error: 'token is required.' }, 400);

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // Resolve the request by its secret token. Only email a request that has
  // actually been denied (fails closed for pending/approved/unknown tokens).
  const { data: reqRow } = await db.from('manager_access_requests')
    .select('status, requester_person_id, club_id')
    .eq('token', token)
    .maybeSingle();
  if (!reqRow) return json({ ok: false, error: 'Request not found.' }, 404);
  if (reqRow.status !== 'denied') {
    return json({ ok: true, sentCount: 0, note: `Request is '${reqRow.status}', not denied — no email sent.` });
  }

  const { data: person } = await db.from('people')
    .select('first_name, last_name, email')
    .eq('id', reqRow.requester_person_id)
    .maybeSingle();
  const { data: club } = await db.from('clubs')
    .select('name')
    .eq('id', reqRow.club_id)
    .maybeSingle();
  if (!person || !club) return json({ ok: false, error: 'Requester or club not found.' }, 404);

  const email = (person.email ?? '').trim();
  if (!EMAIL_RE.test(email)) {
    return json({ ok: true, sentCount: 0, note: 'Requester has no valid email — no email sent.' });
  }

  const name = `${person.first_name} ${person.last_name}`.trim();
  const clubName = club.name as string;
  const subject = `Your Club Admin request for ${clubName} was not approved`;
  const html = `<p>Hello${name ? ` ${esc(name)}` : ''},</p>
<p>Your request for Club Admin access to <strong>${esc(clubName)}</strong> on the United Club Gymnastics platform was reviewed and <strong>not approved</strong>.</p>
<p>If you have questions, please contact a UCG administrator or one of the club's existing managers.</p>
<p style="color:#475569;font-size:13px;">&mdash; United Club Gymnastics</p>`;

  try {
    await sendOne({ to: name ? `${name} <${email}>` : email, subject, html });
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
  return json({ ok: true, sentCount: 1 });
});
