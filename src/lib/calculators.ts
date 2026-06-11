// Maps UCG levels to the embedded NAIGC scoring calculators and bridges their output.
import type { Score } from './types';

export type CalcKind = 'mag' | 'wag-open' | 'masters';

export interface CalcConfig {
  kind: CalcKind;
  /** Path to the calculator HTML, relative to the app base. */
  path: string;
  ruleset?: string; // MAG ruleset preset
  /** Which scores the calculator produces. */
  produces: 'd' | 'full'; // 'd' = start value only; 'full' = D + E + final
  label: string;
}

/** Message the bridge posts up from the iframe. */
export interface CalcMessage {
  type: 'ucg-calc';
  calc: CalcKind;
  d: number | null;
  e: number | null;
  final: number | null;
}

const BASE = import.meta.env.BASE_URL; // e.g. "/ucg-platform/"

/** Returns the calculator config for a given level id, or null if none exists yet. */
export function calcForLevel(levelId: string): CalcConfig | null {
  switch (levelId) {
    case 'mag-dev':
      return { kind: 'mag', path: `${BASE}calculators/mag/index.html`, ruleset: 'NAIGC Developmental', produces: 'd', label: 'NAIGC MAG SV Calculator — Developmental' };
    case 'mag-int':
      return { kind: 'mag', path: `${BASE}calculators/mag/index.html`, ruleset: 'NAIGC Intermediate', produces: 'd', label: 'NAIGC MAG SV Calculator — Intermediate' };
    case 'mag-adv':
      return { kind: 'mag', path: `${BASE}calculators/mag/index.html`, ruleset: 'NAIGC Advanced', produces: 'd', label: 'NAIGC MAG SV Calculator — Advanced (GymACT)' };
    case 'mag-masters':
      return { kind: 'masters', path: `${BASE}calculators/masters.html`, produces: 'full', label: 'NAIGC Masters Scoring Calculator' };
    case 'wag-open':
      return { kind: 'wag-open', path: `${BASE}calculators/wag-open.html`, produces: 'full', label: 'NAIGC WAG Open Scoring Calculator' };
    default:
      return null; // other WAG levels & T&T: calculators not built yet
  }
}

/** Builds the iframe src with apparatus / ruleset presets. */
export function calcUrl(cfg: CalcConfig, eventCode: string): string {
  const p = new URLSearchParams();
  p.set('apparatus', eventCode);
  if (cfg.ruleset) p.set('ruleset', cfg.ruleset);
  return `${cfg.path}?${p.toString()}`;
}

/** Translates a calculator message into the fields stored on a Score. */
export function scoreFromCalc(cfg: CalcConfig, msg: CalcMessage): Partial<Score> {
  if (cfg.produces === 'full') {
    // Open scoring: final = D + E. Store D as sv, E as eScore, and keep the
    // judge's "deductions" field in sync (10 - E) so the manual view still reads.
    const d = msg.d ?? null;
    const e = msg.e ?? null;
    const final = msg.final ?? (d != null && e != null ? Math.round((d + e) * 1000) / 1000 : null);
    return {
      sv: d,
      eScore: e,
      deductions: e != null ? Math.round((10 - e) * 1000) / 1000 : null,
      final,
      source: cfg.kind === 'masters' ? 'masters-calc' : 'wag-open-calc',
    };
  }
  // MAG: the calculator's start value already bakes in the 10.0 execution base.
  // Judge still applies execution deductions; final = sv - deductions.
  return { sv: msg.d ?? null, source: 'mag-calc' };
}
