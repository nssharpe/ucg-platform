// Pure profile-editing logic — no React, no store. Kept importable in a plain
// Node test environment (mirrors the capabilities-core.ts split).
import type { Athlete } from './types';

/** Is the in-progress edit draft different from the snapshot taken when edit
 *  mode was entered? Compare against that SNAPSHOT (the draft as initialized
 *  by `enterEdit`), never against the raw loaded person row directly — the
 *  two can differ from unrelated normalization (e.g. a coerced `gradYear` of
 *  0 vs `undefined`, or default role-checkbox derivation) that isn't a real
 *  edit. A structural deep-equal is sufficient here because both sides share
 *  the exact same shape (both are `Athlete` objects produced the same way). */
export function isProfileDirty(snapshot: Athlete, draft: Athlete): boolean {
  return !deepEqual(snapshot, draft);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object') return false; // primitives already covered by ===

  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) return false;

  if (aArr && bArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bObj, key)) return false;
    if (!deepEqual(aObj[key], bObj[key])) return false;
  }
  return true;
}
