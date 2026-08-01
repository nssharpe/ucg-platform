// judge-entry — codeless judge access (PM decision 2026-07-19). ONE access
// code per event; a device that unlocks with it (URL / 6-digit code / QR —
// three forms of the same access) can enter scores for ANY
// discipline/apparatus at that event, with no per-judge identity.
//
// Two ops, POST JSON `{ op: 'unlock' | 'submit', ... }`:
//   - unlock: `{ code }` (6 digits) or `{ token }` (from the /judge/access/:token
//     link or a scanned QR). Resolves an ACTIVE (revoked_at null)
//     judge_access_codes row and returns `{ eventId, token }` — the device
//     always stores the long token, never the short code.
//
//     Rate limited (2026-07-31, review finding §3.3): the 6-digit CODE path is
//     capped at UNLOCK_FAILURE_LIMIT failures per caller per
//     UNLOCK_WINDOW_MINUTES, counted in `judge_unlock_attempts`. The prior
//     defense was a 300ms sleep, which does not throttle concurrent callers at
//     all — 40 simultaneous invalid codes were measured all returning 401,
//     unthrottled. The TOKEN path is deliberately NOT limited (160 bits of
//     CSPRNG — unguessable), so a locked-out judge always has a working way in
//     via the link/QR. A successful unlock CLEARS the caller's counter, which
//     is what keeps a shared-NAT venue from accumulating its judges' fumbles.
//
//     Every failure — no match, cross-event code collision, or event not live —
//     returns the SAME 401 and the same message. Distinguishing them (401 vs
//     403 vs 409, as before) was a validity oracle: it let an attacker confirm
//     which codes were real weeks ahead of an event going live, then use them
//     on meet day. The specific reason is kept server-side in error_logs
//     ('judge-unlock-failed') as the brute-force audit trail.
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
import {
  validateJudgeSubmit, isValidAccessCode, isValidAccessToken, type JudgeSubmitPayload,
  unlockAttemptKey, isUnlockRateLimited, unlockWindowStart, UNLOCK_WINDOW_MINUTES,
} from '../_shared/judge-entry-core.ts';

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
  deductions2?: number | null;
  eScore2?: number | null;
  final?: number | null;
  source?: string;
  calc?: string;
  calcState?: unknown;
  flashed?: boolean;
  scratched?: boolean;
}

// One message and one status for EVERY unlock failure (2026-07-31, review §3.3).
// Previously "no match" returned 401 while "matched, but the event isn't live"
// returned 403 — a validity oracle that let an attacker confirm codes at leisure
// weeks before an event went live, then use them on meet day. The guidance about
// the link/QR is folded in here so the cross-event-collision case (which used to
// get its own 409, and also confirmed validity) still tells a real judge what to
// do without telling an attacker anything.
const UNLOCK_FAILED_MSG =
  'Invalid or expired access code. If your host sent you a link or QR code, use that instead.';

async function logFailedUnlock(
  db: ReturnType<typeof createClient>,
  attemptKey: string,
  detail: Record<string, unknown>,
): Promise<void> {
  // Audit trail (unbounded by design — service_role bypasses the error_logs
  // rate limit) AND the rate-limit counter (bounded, its own table). Kept
  // separate so a log-retention change can never widen the limit.
  await db.from('error_logs').insert({
    context: 'judge-unlock-failed',
    message: 'Judge unlock attempt failed',
    detail: { ...detail, attemptKey },
  }).then(() => {}, () => {});
  await db.from('judge_unlock_attempts').insert({ attempt_key: attemptKey })
    .then(() => {}, () => {});
  // Opportunistic prune of this key's expired rows, so the table stays
  // proportional to ACTIVE callers rather than growing forever. Scoped to the
  // one key (indexed) rather than a table-wide sweep, so it stays cheap on a
  // path that runs per failed attempt.
  await db.from('judge_unlock_attempts').delete()
    .eq('attempt_key', attemptKey)
    .lt('created_at', unlockWindowStart(Date.now()))
    .then(() => {}, () => {});
  // Retained per-request latency. It is NOT the rate limit (concurrency erases
  // it — that was the finding); it just makes serial guessing tedious too.
  await sleep(300);
}

/** Clears a caller's failure counter after a successful unlock.
 *
 *  Load-bearing for shared-NAT venues: a gym where every judge shares one public
 *  IP would otherwise accumulate other people's fumbles toward a common limit.
 *  Because a success wipes the slate, the limit only ever bites a caller who is
 *  failing repeatedly and succeeding never — which is the attacker, not the gym. */
async function clearUnlockFailures(
  db: ReturnType<typeof createClient>,
  attemptKey: string,
): Promise<void> {
  await db.from('judge_unlock_attempts').delete().eq('attempt_key', attemptKey)
    .then(() => {}, () => {});
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
    const attemptKey = unlockAttemptKey(req.headers);

    if (!byToken && !byCode) {
      await logFailedUnlock(db, attemptKey, { reason: 'malformed input' });
      return json({ ok: false, error: 'Enter a valid 6-digit code.' }, 400);
    }

    // Rate limit the CODE path only. A token is 160 bits of CSPRNG output — it
    // cannot be guessed, so throttling it would add no security while making the
    // link/QR (the path a locked-out judge is told to use) fail too. That
    // asymmetry is deliberate: the limit always leaves a working way in for
    // someone holding real credentials.
    if (byCode) {
      const { count, error: countErr } = await db
        .from('judge_unlock_attempts')
        .select('id', { count: 'exact', head: true })
        .eq('attempt_key', attemptKey)
        .gt('created_at', unlockWindowStart(Date.now()));
      // Fail OPEN on a counting error, deliberately: this is availability-vs-
      // brute-force, and locking every judge out of a live meet because a count
      // query hiccuped is the worse failure. The 300ms brake and the audit trail
      // both still apply in that case.
      if (!countErr && isUnlockRateLimited(count ?? 0)) {
        // Write NOTHING here. Once the limit is reached the counter has already
        // made its point, and the audit trail already holds the burst that got
        // us here — appending a row per rejected request would turn the very
        // requests we are refusing back into the unbounded write amplifier this
        // change exists to close. Caps writes at ~UNLOCK_FAILURE_LIMIT per key
        // per window no matter how hard the endpoint is hammered.
        await sleep(300);
        return json({
          ok: false,
          error: `Too many incorrect codes. Wait ${UNLOCK_WINDOW_MINUTES} minutes and try again, `
            + 'or use the link or QR code from your host.',
        }, 429);
      }
    }

    const query = db.from('judge_access_codes').select('id, event_id, code, token').is('revoked_at', null);
    const { data: rows, error } = byToken
      ? await query.eq('token', a.token as string)
      : await query.eq('code', a.code as string);

    if (error) {
      await logFailedUnlock(db, attemptKey, { reason: 'query error', message: error.message });
      return json({ ok: false, error: 'Could not check that code right now.' }, 500);
    }
    // Every failure below returns the SAME status and message. The reason is
    // recorded server-side for the audit trail; the caller learns only "that
    // didn't work", never whether the code exists.
    if (!rows || rows.length === 0) {
      await logFailedUnlock(db, attemptKey, { reason: 'no match', byToken });
      return json({ ok: false, error: UNLOCK_FAILED_MSG }, 401);
    }
    if (rows.length > 1) {
      // Only possible on the code path — codes are not globally unique.
      // Never guess which event the judge means.
      await logFailedUnlock(db, attemptKey, { reason: 'ambiguous code', matches: rows.length });
      return json({ ok: false, error: UNLOCK_FAILED_MSG }, 401);
    }

    const row = rows[0] as { id: string; event_id: string; code: string; token: string };
    const { data: event } = await db.from('events').select('id, status').eq('id', row.event_id).maybeSingle();
    if (!event || event.status !== 'live') {
      await logFailedUnlock(db, attemptKey, { reason: 'event not live', eventId: row.event_id });
      return json({ ok: false, error: UNLOCK_FAILED_MSG }, 401);
    }

    // Success wipes this caller's failure counter — see clearUnlockFailures.
    await clearUnlockFailures(db, attemptKey);
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
      deductions2: a.deductions2, eScore2: a.eScore2,
      final: a.final, source: a.source, calc: a.calc, calcState: a.calcState, flashed: a.flashed, scratched: a.scratched,
    };
    const result = validateJudgeSubmit(row.event_id, payload, reg);
    if (!result.ok) return json({ ok: false, error: result.error }, 400);

    const now = new Date().toISOString();
    const { error: upsertErr } = await db.from('scores').upsert({
      id: result.score.id, event_id: result.score.eventId, session_id: result.score.sessionId,
      reg_id: result.score.regId, apparatus: result.score.apparatus,
      sv: result.score.sv, deductions: result.score.deductions, e_score: result.score.eScore,
      deductions2: result.score.deductions2, e_score2: result.score.eScore2,
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
