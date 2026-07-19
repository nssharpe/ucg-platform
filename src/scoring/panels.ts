// Two-judge-panel averaging (PM decision 2026-07-19): when an event's
// scoring config has `panels: 2`, each judge enters their own execution
// evaluation (deductions or E-score, whichever the entry mode uses) and the
// two are averaged into the effective execution value the final derives
// from. Pure — no React/DOM — so it's directly unit-testable and shared by
// both the signed-in Judge.tsx path and (indirectly, via the same rounding
// convention) the anonymous judge-entry Edge Function's stored raw values.
import { round3 } from './types';

export interface CombinePanelsInput {
  /** Start value / D-score — informational only, NOT averaged (the D-score
   *  is shared across both panels; only execution differs per judge).
   *  Accepted so a caller can pass a score's full raw fields through one
   *  call site without picking them apart first. */
  sv?: number | null;
  deductions?: number | null;
  deductions2?: number | null;
  eScore?: number | null;
  eScore2?: number | null;
}

export interface CombinePanelsResult {
  /** Effective total deductions: the mean of `deductions`/`deductions2` when
   *  both are present, else whichever one is present, else null. */
  deductions: number | null;
  /** Effective E-score: same rule as `deductions`, over `eScore`/`eScore2`. */
  eScore: number | null;
}

/** Round-half-up to 3 decimals — matches the convention used throughout
 *  src/scoring (round3) and Judge.tsx's own final-score rounding. */
function averagePanelValue(a: number | null | undefined, b: number | null | undefined): number | null {
  const av = a ?? null;
  const bv = b ?? null;
  if (av != null && bv != null) return round3((av + bv) / 2);
  if (av != null) return av;
  if (bv != null) return bv;
  return null;
}

/** Combine two judge panels' raw execution inputs into the single effective
 *  value the final score derives from. When only one panel has a value
 *  (`panels: 1`, or a `panels: 2` score still in progress with only one judge
 *  entered), that lone value passes through unchanged. */
export function combinePanels(input: CombinePanelsInput): CombinePanelsResult {
  return {
    deductions: averagePanelValue(input.deductions, input.deductions2),
    eScore: averagePanelValue(input.eScore, input.eScore2),
  };
}
