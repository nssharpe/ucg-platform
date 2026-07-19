// judge-entry — codeless judge access (PM decision 2026-07-19). ONE access
// code per event; a device that unlocks with it (URL / 6-digit code / QR —
// three forms of the same access) can enter scores for ANY
// discipline/apparatus at that event, with no per-judge identity.
//
// Two ops, POST JSON `{ op: 'unlock' | 'submit', ... }`:
//   - unlock: `{ code }` (6 digits) or `{ token }` (from the /judge/access/:token
//     link or a scanned QR). Resolves an ACTIVE (revoked_at null)
//     judge_access_codes row and returns `{ eventId, token }` — the device
//     always stores the long token, never the short code. A code that
//     matches more than one active row (cross-event collision — codes are
//     NOT globally unique, only tokens are) is rejected rather than guessed;
//     the caller is told to use the link/QR instead. Failed attempts are
//     logged to error_logs (kind 'judge-unlock-failed') as a brute-force
//     audit trail, plus a soft ~300ms brake.
//   - submit: `{ token, regId, apparatus, sv, deductions, eScore, final,
//     source, calc, calcState, flashed, scratched }`. Validates the token is
//     active, recomputes the score id server-side (never trusts a client
//     id), validates the registration via judge-entry-core.ts, and upserts
//     into `scores` with `entered_by = 'judge-code:' + codeRowId` stamped
//     server-side.
//
// verify_jwt STAYS TRUE (default) — same as record-waiver-signature: the
// browser's anon-key Authorization header passes the gateway fine for an
// unauthenticated caller; this is NOT one of the three --no-verify-jwt
// functions (stripe-webhook, sms-webhook, notify-manager-access-denied) and
// must not be added to that list. No AAL guard — anonymous by design — but
// every write is confined to the token's own event via server-side lookups,
// never a client-supplied event id.
//
// Secrets: auto-provided SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY only.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { validateJudgeSubmit, isValidAccessCode, isValidAccessToken, type JudgeSubmitPayload } from '../_shared/judge-entry-core.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Payload {
  op?: 'unlock' | 'submit';
  code?: string;
  token?: string;
  regId?: string;
  apparatus?: string;
  sv?: number | null;
  deductions?: number | null;
  eScore?: number | null;
  final?: number | null;
  source?: string;
  calc?: string;
  calcState?: unknown;
  flashed?: boolean;
  scratched?: boolean;
}

async function logFailedUnlock(
  db: ReturnType<typeof createClient>,
  detail: Record<string, unknown>,
): Promise<void> {
  await db.from('error_logs').insert({
    context: 'judge-unlock-failed',
    message: 'Judge unlock attempt failed',
    detail,
  }).then(() => {}, () => {});
  // Soft brake against code-guessing — 6 digits is only 1e6 combinations.
  await sleep(300);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const db = createClient(url, serviceKey, { auth: { persistSession: false } });

  let a: Payload;
  try { a = await req.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400); }

  if (a.op === 'unlock') {
    const byToken = isValidAccessToken(a.token);
    const byCode = !byToken && isValidAccessCode(a.code);
    if (!byToken && !byCode) {
      await logFailedUnlock(db, { reason: 'malformed input' });
      return json({ ok: false, error: 'Enter a valid 6-digit code.' }, 400);
    }

    const query = db.from('judge_access_codes').select('id, event_id, code, token').is('revoked_at', null);
    const { data: rows, error } = byToken
      ? await query.eq('token', a.token as string)
      : await query.eq('code', a.code as string);

    if (error) {
      await logFailedUnlock(db, { reason: 'query error', message: error.message });
      return json({ ok: false, error: 'Could not check that code right now.' }, 500);
    }
    if (!rows || rows.length === 0) {
      await logFailedUnlock(db, { reason: 'no match', byToken });
      return json({ ok: false, error: 'Invalid or expired access code.' }, 401);
    }
    if (rows.length > 1) {
      // Only possible on the code path — codes are not globally unique.
      // Never guess which event the judge means; make them use the link/QR.
      await logFailedUnlock(db, { reason: 'ambiguous code', matches: rows.length });
      return json({ ok: false, error: 'This code matches more than one event. Use the link or QR code from the event host instead.' }, 409);
    }

    const row = rows[0] as { id: string; event_id: string; code: string; token: string };
    const { data: event } = await db.from('events').select('id, status').eq('id', row.event_id).maybeSingle();
    if (!event || event.status !== 'live') {
      await logFailedUnlock(db, { reason: 'event not live', eventId: row.event_id });
      return json({ ok: false, error: 'This event is not open for scoring.' }, 403);
    }

    return json({ ok: true, eventId: row.event_id, token: row.token });
  }

  if (a.op === 'submit') {
    if (!isValidAccessToken(a.token)) return json({ ok: false, error: 'Invalid access token.' }, 401);

    const { data: row } = await db.from('judge_access_codes')
      .select('id, event_id').eq('token', a.token).is('revoked_at', null).maybeSingle();
    if (!row) return json({ ok: false, error: 'This access link is no longer valid.' }, 401);

    const { data: event } = await db.from('events').select('id, status').eq('id', row.event_id).maybeSingle();
    if (!event || event.status !== 'live') {
      return json({ ok: false, error: 'This event is not open for scoring.' }, 403);
    }

    const { data: regRow } = await db.from('registrations')
      .select('id, event_id, apparatus, refunded, session_id')
      .eq('id', a.regId ?? '').maybeSingle();
    const reg = regRow
      ? {
        id: regRow.id, eventId: regRow.event_id, sessionId: regRow.session_id ?? '',
        apparatus: (regRow.apparatus ?? []) as string[], refunded: !!regRow.refunded,
      }
      : null;

    const payload: JudgeSubmitPayload = {
      regId: a.regId, apparatus: a.apparatus, sv: a.sv, deductions: a.deductions, eScore: a.eScore,
      final: a.final, source: a.source, calc: a.calc, calcState: a.calcState, flashed: a.flashed, scratched: a.scratched,
    };
    const result = validateJudgeSubmit(row.event_id, payload, reg);
    if (!result.ok) return json({ ok: false, error: result.error }, 400);

    const now = new Date().toISOString();
    const { error: upsertErr } = await db.from('scores').upsert({
      id: result.score.id, event_id: result.score.eventId, session_id: result.score.sessionId,
      reg_id: result.score.regId, apparatus: result.score.apparatus,
      sv: result.score.sv, deductions: result.score.deductions, e_score: result.score.eScore,
      final: result.score.final, source: result.score.source ?? 'manual',
      calc: result.score.calc, calc_state: result.score.calcState,
      entered_by: `judge-code:${row.id}`, entered_at: now, flashed: result.score.flashed,
      scratched: result.score.scratched,
    });
    if (upsertErr) return json({ ok: false, error: upsertErr.message }, 500);

    return json({ ok: true, score: { ...result.score, enteredBy: `judge-code:${row.id}`, enteredAt: now } });
  }

  return json({ ok: false, error: 'Unknown operation.' }, 400);
});
