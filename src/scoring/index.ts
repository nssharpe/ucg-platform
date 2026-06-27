// Kind dispatcher over the native scoring engines.
import type { ScoringOutcome } from './types';
import * as mag from './mag';
import * as masters from './masters';
import * as wagOpen from './wagOpen';
import * as wagVault from './wagVault';
import * as wagSv from './wagSv';
import * as tnt from './tnt';

export type { ScoringOutcome, Breakdown } from './types';

export type CalcKind = 'mag' | 'wag-open' | 'wag-vault' | 'wag-sv' | 'tnt' | 'masters';

const ENGINES: Record<CalcKind, {
  init(levelId: string, apparatusCode: string): unknown;
  compute(state: never, levelId: string, apparatusCode: string): ScoringOutcome;
}> = {
  mag,
  masters,
  'wag-open': wagOpen,
  'wag-vault': wagVault,
  'wag-sv': wagSv,
  tnt,
};

export function initScoring(kind: CalcKind, levelId: string, apparatusCode: string): unknown {
  return ENGINES[kind].init(levelId, apparatusCode);
}

export function computeScoring(kind: CalcKind, state: unknown, levelId: string, apparatusCode: string): ScoringOutcome {
  return ENGINES[kind].compute(state as never, levelId, apparatusCode);
}

/** Versioned calculator state stored on a Score (`calcState`). Older scores
 *  hold the legacy iframe-bridge DOM snapshot `{ fields, selected }` instead. */
export interface CalcStateV2 {
  v: 2;
  kind: CalcKind;
  state: unknown;
}

export function isCalcStateV2(s: unknown): s is CalcStateV2 {
  return !!s && typeof s === 'object' && (s as CalcStateV2).v === 2 && 'state' in (s as object);
}
