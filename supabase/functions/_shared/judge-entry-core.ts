// _shared/judge-entry-core.ts — pure validation for a codeless-judge score
// submission (`judge-entry` Edge Function's `submit` op). Kept dependency-free
// (no Deno/Supabase imports) so it's directly unit-testable, mirroring
// digest-logic.ts/season-lifecycle.ts. No `src/lib` counterpart exists: unlike
// season-lifecycle (consumed by BOTH the client and a scheduled edge
// function), this validation only ever needs to run server-side -- the
// browser never decides whether a score is valid, it just calls the Edge
// Function and shows whatever comes back.

/** What the client sends for a score submission. Deliberately does NOT
 *  include an `id` -- the score id is always recomputed server-side from the
 *  token's event + this payload's regId/apparatus, never trusted from the
 *  client (CLAUDE.md create-checkout-session precedent: never trust
 *  client-supplied identifiers that determine what a write affects). */
export interface JudgeSubmitPayload {
  regId: unknown;
  apparatus: unknown;
  sv?: unknown;
  deductions?: unknown;
  eScore?: unknown;
  final?: unknown;
  source?: unknown;
  calc?: unknown;
  calcState?: unknown;
  flashed?: unknown;
  scratched?: unknown;
}

/** The minimal registration slice the validator needs, already scoped to the
 *  token's event by the caller's own query (`.eq('event_id', eventId)`) --
 *  this module re-checks `eventId` anyway as defense in depth. */
export interface JudgeRegistrationLite {
  id: string;
  eventId: string;
  sessionId: string;
  apparatus: string[];
  refunded?: boolean;
}

export interface ValidatedJudgeScore {
  id: string;
  eventId: string;
  sessionId: string;
  regId: string;
  apparatus: string;
  sv: number | null;
  deductions: number | null;
  eScore: number | null;
  final: number | null;
  source: string | null;
  calc: string | null;
  calcState: unknown;
  flashed: boolean;
  scratched: boolean;
}

export type JudgeSubmitResult =
  | { ok: true; score: ValidatedJudgeScore }
  | { ok: false; error: string };

/** Numeric score fields (SV/deductions/E-score/final) must be finite,
 *  non-negative, and under a generous sanity cap -- a typo'd extra digit
 *  (e.g. 950 instead of 9.50) should reject rather than silently post a
 *  nonsense score. No real UCG score approaches this on any level/apparatus. */
const MAX_SCORE_FIELD = 50;

/** Cap on free-form string fields (`source`/`calc`) — real values are short
 *  enum-ish labels ('manual', 'wag-open-calc', …). */
const MAX_LABEL_LENGTH = 40;
/** Cap on the serialized `calcState` jsonb an anonymous submit may store. */
const MAX_CALC_STATE_CHARS = 20_000;

function isValidScoreNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= MAX_SCORE_FIELD;
}
function isValidNullableScoreNumber(n: unknown): boolean {
  return n == null || isValidScoreNumber(n);
}

/** Validate + normalize a codeless-judge score submission against the
 *  registration it claims to score. `eventId` and `reg` both come from
 *  server-side lookups (the active access-code row's event, and a DB read of
 *  `regId` scoped to that event) -- never from the client payload directly,
 *  so a forged/mismatched id can only ever fail these checks, not slip
 *  through them. */
export function validateJudgeSubmit(
  eventId: string,
  payload: JudgeSubmitPayload,
  reg: JudgeRegistrationLite | null | undefined,
): JudgeSubmitResult {
  if (!payload || typeof payload.regId !== 'string' || !payload.regId) {
    return { ok: false, error: 'Missing registration id.' };
  }
  if (typeof payload.apparatus !== 'string' || !payload.apparatus) {
    return { ok: false, error: 'Missing apparatus.' };
  }
  if (!reg) {
    return { ok: false, error: 'Registration not found.' };
  }
  if (reg.eventId !== eventId) {
    return { ok: false, error: 'That registration does not belong to this event.' };
  }
  if (reg.refunded) {
    return { ok: false, error: 'This registration has been refunded.' };
  }
  if (!reg.apparatus.includes(payload.apparatus)) {
    return { ok: false, error: 'This athlete is not registered for that apparatus.' };
  }
  if (!isValidNullableScoreNumber(payload.sv)) return { ok: false, error: 'Invalid start value.' };
  if (!isValidNullableScoreNumber(payload.deductions)) return { ok: false, error: 'Invalid deductions.' };
  if (!isValidNullableScoreNumber(payload.eScore)) return { ok: false, error: 'Invalid E-score.' };
  if (!isValidNullableScoreNumber(payload.final)) return { ok: false, error: 'Invalid final score.' };
  if (payload.source != null && (typeof payload.source !== 'string' || payload.source.length > MAX_LABEL_LENGTH)) return { ok: false, error: 'Invalid source.' };
  if (payload.calc != null && (typeof payload.calc !== 'string' || payload.calc.length > MAX_LABEL_LENGTH)) return { ok: false, error: 'Invalid calc.' };
  // calcState is stored verbatim (jsonb) on an anonymous submit — cap its
  // serialized size so a code holder can't bloat the scores table with
  // megabyte payloads. Real CalcStateV2 blobs are well under this.
  if (payload.calcState != null) {
    let serialized: string;
    try { serialized = JSON.stringify(payload.calcState); } catch { return { ok: false, error: 'Invalid calculator state.' }; }
    if (serialized === undefined || serialized.length > MAX_CALC_STATE_CHARS) {
      return { ok: false, error: 'Invalid calculator state.' };
    }
  }

  // The id is ALWAYS recomputed here -- any `id` the client sent is ignored
  // (not even read above), so it can never steer a write onto a different
  // score row than the one implied by (eventId, regId, apparatus).
  const id = `${eventId}|${reg.id}|${payload.apparatus}`;

  return {
    ok: true,
    score: {
      id, eventId, sessionId: reg.sessionId, regId: reg.id, apparatus: payload.apparatus,
      sv: (payload.sv as number | null | undefined) ?? null,
      deductions: (payload.deductions as number | null | undefined) ?? null,
      eScore: (payload.eScore as number | null | undefined) ?? null,
      final: (payload.final as number | null | undefined) ?? null,
      source: typeof payload.source === 'string' ? payload.source : null,
      calc: typeof payload.calc === 'string' ? payload.calc : null,
      calcState: payload.calcState ?? null,
      flashed: payload.flashed !== false,
      scratched: payload.scratched === true,
    },
  };
}

/** A 6-digit access code, exactly as typed on the judge unlock screen. */
export function isValidAccessCode(code: unknown): code is string {
  return typeof code === 'string' && /^\d{6}$/.test(code);
}

/** A long opaque access token, exactly as it appears in the unlock URL. */
export function isValidAccessToken(token: unknown): token is string {
  return typeof token === 'string' && token.length >= 16 && /^[a-f0-9]+$/i.test(token);
}
