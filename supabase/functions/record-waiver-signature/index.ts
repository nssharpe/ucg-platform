// record-waiver-signature — writes the legal signature record, stamping the
// real client IP server-side, then activates the membership.
//
// Two callers:
//  - signed-in member (no token): validated by Authorization Bearer JWT.
//  - no-login link (token present): validated by a pending waiver_sign_requests
//    row. The row carries its own signer_role ('self' for an adult signing their
//    own link, 'guardian' for a parent signing for a minor) — we stamp THAT on
//    the signature rather than trusting the role in the request body.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { statusAfterSigning, welcomeEligible } from '../_shared/membership-signing.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

interface SignaturePayload {
  signerRole?: string;
  token?: string;
  personId?: string;
  seasonId?: string;
  waiverType?: string;
  membershipType?: string;
  waiverDocumentId?: string;
  contentHash?: string;
  consent?: boolean;
  signerName?: string;
  signerEmail?: string;
  signerRelationship?: string;
}

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

  let a: SignaturePayload;
  try { a = await req.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400); }

  // --- Authorize ---
  // A token means the no-login link path (adult-self OR guardian); the stored
  // row is the source of truth for both identity and signer_role. Without a
  // token we require a signed-in member who owns the record (JWT path).
  if (a.token) {
    const { data: reqRow } = await db.from('waiver_sign_requests')
      .select('*').eq('token', a.token).maybeSingle();
    if (!reqRow || reqRow.status !== 'pending') {
      return json({ ok: false, error: 'This signing link is no longer valid.' }, 410);
    }
    a.personId = reqRow.person_id; a.seasonId = reqRow.season_id;
    a.waiverType = reqRow.waiver_type; a.membershipType = reqRow.membership_type;
    // Trust the mint, not the client: the role was fixed when the link was made.
    a.signerRole = reqRow.signer_role === 'self' ? 'self' : 'guardian';
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

  // Check if they already have any active memberships before we activate these.
  const { data: existingActive } = await db.from('memberships')
    .select('id')
    .eq('person_id', a.personId)
    .eq('status', 'active');
  const hadNoActiveBefore = !existingActive || existingActive.length === 0;

  // --- Activate the membership(s) + set convenience pointers ---
  // A single waiver covers ALL of a person's memberships for the season, so this
  // clears every pending-waiver row for (person, season) — not just one type.
  //
  // MEMBERSHIP STATUS NUANCE: the split is on `club_cart_pending` — "is a payment
  // still OUTSTANDING?" — NOT on `paid_via`, which only says who was going to pay.
  // Those come apart whenever a club pays before the guardian signs, and keying on
  // `paid_via` re-asserted a payment hold on an already-paid membership (and left
  // it permanently unable to reach 'active'). Full reasoning, including the
  // `paid_via IS NULL` three-valued-logic hole this also closes:
  // `_shared/membership-signing.ts`, which owns the decision.
  //
  // (On the self path the membership rows don't exist yet — the wizard creates them
  // at the pay step — so these updates match 0 rows and are a harmless no-op.)
  const now = new Date().toISOString();
  const ptrs = { waiver_signed_at: now, waiver_signed_by: a.signerName };
  const { data: activeRows, error: upErr } = await db.from('memberships')
    .update({ status: statusAfterSigning({ clubCartPending: false }), ...ptrs })
    .eq('person_id', a.personId).eq('season_id', a.seasonId).eq('status', 'pending-waiver')
    .eq('club_cart_pending', false)
    .select('id, paid_via');
  if (upErr) return json({ ok: false, error: upErr.message }, 500);
  const { data: clubRows, error: upClubErr } = await db.from('memberships')
    .update({ status: statusAfterSigning({ clubCartPending: true }), ...ptrs })
    .eq('person_id', a.personId).eq('season_id', a.seasonId).eq('status', 'pending-waiver')
    .eq('club_cart_pending', true)
    .select('id');
  if (upClubErr) return json({ ok: false, error: upClubErr.message }, 500);

  if (a.token) {
    await db.from('waiver_sign_requests')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('token', a.token);
  }

  // --- Trigger welcome email if they just became active ---
  // Club-paid rows now reach 'active' through the update above (they previously
  // couldn't reach it at all), so they'd newly qualify here. Exclude them, keeping
  // this email's audience exactly what it was and mirroring `fulfill.ts`'s own
  // `if (signed && !clubId)` gate — see `welcomeEligible`.
  const welcomeRows = (activeRows ?? []).filter((r) =>
    welcomeEligible({ paidVia: (r as { paid_via: string | null }).paid_via }));
  if (hadNoActiveBefore && welcomeRows.length > 0) {
    try {
      const welcomeUrl = `${url}/functions/v1/send-membership-welcome`;
      await fetch(welcomeUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${serviceKey}`,
        },
        body: JSON.stringify({ personId: a.personId }),
      });
    } catch (welcomeErr) {
      console.error('[record-waiver-signature] failed to trigger welcome email:', welcomeErr);
    }
  }

  // pendingPayment = the membership still owes a club payment (not yet active).
  return json({ ok: true, pendingPayment: (clubRows?.length ?? 0) > 0 });
});
