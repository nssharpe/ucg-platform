// Codeless judge access — local storage of unlocked (eventId → token) pairs
// (2026-07-19). A device can unlock multiple events over its lifetime (e.g. a
// tablet reused across meets), so this is a MAP, not a single value. Split
// into pure parse/serialize/merge functions (directly unit-testable, no DOM)
// plus thin localStorage wrappers — same split as capabilities-core.ts.

export type JudgeAccessMap = Record<string, string>; // eventId -> token

const STORAGE_KEY = 'ucg-judge-access';

/** Parse a raw localStorage value into a clean eventId->token map. Tolerates
 *  missing/corrupt/wrong-shaped input by returning an empty map — a bad
 *  stored value should never crash the judge page, just show the unlock
 *  prompt again. */
export function parseJudgeAccessMap(raw: string | null | undefined): JudgeAccessMap {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: JudgeAccessMap = {};
    for (const [eventId, token] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof eventId === 'string' && eventId && typeof token === 'string' && token) out[eventId] = token;
    }
    return out;
  } catch {
    return {};
  }
}

export function serializeJudgeAccessMap(map: JudgeAccessMap): string {
  return JSON.stringify(map);
}

/** Merge one (eventId, token) unlock into a map, returning a NEW map
 *  (immutable — matches the rest of the codebase's mutate() discipline). */
export function withJudgeAccess(map: JudgeAccessMap, eventId: string, token: string): JudgeAccessMap {
  return { ...map, [eventId]: token };
}

// ---------------------------------------------------------------------------
// localStorage wrappers — thin, no logic of their own beyond try/catch
// (storage can be unavailable in private-browsing/some embedded contexts).
// ---------------------------------------------------------------------------
export function loadJudgeAccessMap(): JudgeAccessMap {
  try { return parseJudgeAccessMap(localStorage.getItem(STORAGE_KEY)); } catch { return {}; }
}

export function saveJudgeAccess(eventId: string, token: string): void {
  try {
    const next = withJudgeAccess(loadJudgeAccessMap(), eventId, token);
    localStorage.setItem(STORAGE_KEY, serializeJudgeAccessMap(next));
  } catch { /* storage unavailable — the unlock still works for this session */ }
}

/** The stored token for one event, or null if this device hasn't unlocked it. */
export function judgeTokenFor(eventId: string): string | null {
  return loadJudgeAccessMap()[eventId] ?? null;
}
