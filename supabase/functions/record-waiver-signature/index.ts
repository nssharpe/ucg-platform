// record-waiver-signature — writes the legal signature record, stamping the
// real client IP server-side, then activates the membership.
//
// Two callers:
//  - self  (signed-in member): validated by Authorization Bearer JWT.
//  - guardian (anon): validated by a pending waiver_sign_requests token.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return req.headers.get('x-real-ip') ?? 'unknown';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const db = createClient(url, serviceKey, { auth: { persistSession: false } });

  let a: any;
  try { a = await req.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400); }

  // --- Authorize ---
  if (a.signerRole === 'guardian') {
    if (!a.token) return json({ ok: false, error: 'Missing token' }, 401);
    const { data: reqRow } = await db.from('waiver_sign_requests')
      .select('*').eq('token', a.token).maybeSingle();
    if (!reqRow || reqRow.status !== 'pending') {
      return json({ ok: false, error: 'This signing link is no longer valid.' }, 410);
    }
    a.personId = reqRow.person_id; a.seasonId = reqRow.season_id;
    a.waiverType = reqRow.waiver_type; a.membershipType = reqRow.membership_type;
  } else {
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: u, error } = await db.auth.getUser(token);
    if (error || !u.user) return json({ ok: false, error: 'Invalid session' }, 401);
    // Ensure the caller owns the person row they claim to sign for.
    const { data: person } = await db.from('people').select('id')
      .eq('id', a.personId).eq('auth_user_id', u.user.id).maybeSingle();
    if (!person) return json({ ok: false, error: 'Not your record' }, 403);
  }

  // --- Validate the doc + hash (never record against a stale version) ---
  const { data: doc } = await db.from('waiver_documents')
    .select('*').eq('id', a.waiverDocumentId).eq('published', true).maybeSingle();
  if (!doc) return json({ ok: false, error: 'Waiver document not found.' }, 404);
  if (doc.content_hash !== a.contentHash) {
    return json({ ok: false, error: 'The waiver was updated. Please re-read and sign again.' }, 409);
  }
  if (!a.consent) return json({ ok: false, error: 'Consent is required.' }, 400);

  // --- Insert the signature record ---
  const { error: insErr } = await db.from('waiver_signatures').insert({
    person_id: a.personId, season_id: a.seasonId, waiver_type: a.waiverType,
    waiver_document_id: a.waiverDocumentId, content_hash: a.contentHash,
    signer_name: a.signerName, signer_email: a.signerEmail, signer_role: a.signerRole,
    signer_relationship: a.signerRelationship ?? null, consent: true,
    ip: clientIp(req), user_agent: req.headers.get('user-agent') ?? null,
  });
  if (insErr) return json({ ok: false, error: insErr.message }, 500);

  // --- Activate the membership + set convenience pointers ---
  // MEMBERSHIP STATUS NUANCE: read the existing row first. If it exists and
  // paid_via === 'club', the next state is 'pending-club-payment' (the club still
  // owes the fee); otherwise 'active'. (For the self path the membership row may
  // not exist yet — the wizard creates it at the pay step — so a 0-row update is
  // a harmless no-op.)
  const { data: existing } = await db.from('memberships').select('paid_via')
    .eq('person_id', a.personId).eq('season_id', a.seasonId).eq('type', a.membershipType).maybeSingle();
  const nextStatus = existing?.paid_via === 'club' ? 'pending-club-payment' : 'active';
  const { error: upErr } = await db.from('memberships')
    .update({ status: nextStatus, waiver_signed_at: new Date().toISOString(), waiver_signed_by: a.signerName })
    .eq('person_id', a.personId).eq('season_id', a.seasonId).eq('type', a.membershipType);
  if (upErr) return json({ ok: false, error: upErr.message }, 500);

  if (a.signerRole === 'guardian') {
    await db.from('waiver_sign_requests')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('token', a.token);
  }
  return json({ ok: true });
});
