// Shared contract for the native scoring engines (pure TS — no React, no DOM).
// Each engine module exports a JSON-serializable State plus:
//   init(levelId, apparatusCode): State
//   compute(state, levelId, apparatusCode): ScoringOutcome

/** One signed line of the score build-up, for the review/breakdown UI. */
export interface Breakdown {
  label: string;
  /** Signed contribution (deductions negative). */
  value: number;
}

export interface ScoringOutcome {
  /** Start value / D-score. */
  d: number | null;
  /** E-score out of 10 (full producers only). */
  e: number | null;
  /** Final score (full producers only — 'd' producers leave this to the judge form). */
  final: number | null;
  produces: 'd' | 'full';
  breakdown: Breakdown[];
  /** Rule violations / cap notices to surface to the judge. */
  warnings: string[];
}

/** Round to 3 decimals, killing float noise (0.30000000000000004 → 0.3). */
export const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Round to 2 decimals. */
export const round2 = (n: number) => Math.round(n * 100) / 100;

/** Parse a judge-typed numeric field; '' / garbage → 0, clamped to [min, max]. */
export function num(raw: string | number, min = 0, max = Infinity): number {
  const v = typeof raw === 'number' ? raw : parseFloat(raw);
  if (isNaN(v)) return min > 0 ? min : 0;
  return Math.min(max, Math.max(min, v));
}
