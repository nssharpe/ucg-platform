// Maps UCG levels to scoring calculators. New entry uses the native engines in
// src/scoring (ScoringPanel); the iframe `path` + bridge message types remain
// only to restore legacy DOM-snapshot calcState on old scores (CalcPanel).
import type { Score } from './types';
import type { ScoringOutcome } from '../scoring';

export type CalcKind = 'mag' | 'wag-open' | 'wag-vault' | 'wag-sv' | 'tnt' | 'masters';

export interface CalcConfig {
  kind: CalcKind;
  /** Path to the calculator HTML, relative to the app base. */
  path: string;
  ruleset?: string; // MAG ruleset preset
  level?: string;   // Xcel/Level 9 level preset (e.g. 'Silver', 'Level 9')
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

/** Route to a score's detail page (score ids contain `|`, so encode). */
export const scoreDetailPath = (scoreId: string) => `/scores/${encodeURIComponent(scoreId)}`;

/** Returns the calculator config for a given level + event, or null if none exists yet.
 *  Vault is scored differently from other apparatus, so the event matters. */
export function calcForLevel(levelId: string, eventCode?: string): CalcConfig | null {
  const isVault = eventCode === 'VT';
  switch (levelId) {
    case 'mag-dev':
      return { kind: 'mag', path: `${BASE}calculators/mag/index.html`, ruleset: 'NAIGC Developmental', produces: 'd', label: 'NAIGC MAG SV Calculator — Developmental' };
    case 'mag-int':
      return { kind: 'mag', path: `${BASE}calculators/mag/index.html`, ruleset: 'NAIGC Intermediate', produces: 'd', label: 'NAIGC MAG SV Calculator — Intermediate' };
    case 'mag-adv':
      return { kind: 'mag', path: `${BASE}calculators/mag/index.html`, ruleset: 'NAIGC Advanced', produces: 'd', label: 'NAIGC MAG SV Calculator — Advanced (GymACT)' };
    case 'mag-masters':
    case 'wag-masters':
      // The Masters calculator handles every apparatus (incl. vault) internally.
      return { kind: 'masters', path: `${BASE}calculators/masters.html`, produces: 'full', label: 'NAIGC Masters Scoring Calculator' };
    case 'wag-open':
      // WAG Open vault uses the vault-value table; bars/beam/floor use the routine builder.
      return isVault
        ? { kind: 'wag-vault', path: `${BASE}calculators/wag-vault.html`, produces: 'full', label: 'NAIGC WAG Open Vault Calculator' }
        : { kind: 'wag-open', path: `${BASE}calculators/wag-open.html`, produces: 'full', label: 'NAIGC WAG Open Scoring Calculator' };
    // USAG Xcel & Development Program (Level 9) — start-value builders (judge adds deductions).
    case 'wag-silver':
      return { kind: 'wag-sv', path: `${BASE}calculators/wag-sv.html`, level: 'Silver', produces: 'd', label: 'USAG Xcel Silver — Start Value' };
    case 'wag-plat':
      return { kind: 'wag-sv', path: `${BASE}calculators/wag-sv.html`, level: 'Platinum', produces: 'd', label: 'USAG Xcel Platinum — Start Value' };
    case 'wag-diamond':
      return { kind: 'wag-sv', path: `${BASE}calculators/wag-sv.html`, level: 'Diamond', produces: 'd', label: 'USAG Xcel Diamond — Start Value' };
    case 'wag-l9':
      return { kind: 'wag-sv', path: `${BASE}calculators/wag-sv.html`, level: 'Level 9', produces: 'd', label: 'USAG Level 9 — Start Value' };
    // NAIGC T&T — one calculator, level preset; computes D + E + Final per the NAIGC COP.
    case 'tnt-new':
      return { kind: 'tnt', path: `${BASE}calculators/tnt.html`, level: 'New Flyers', produces: 'full', label: 'NAIGC T&T — New Flyers' };
    case 'tnt-int':
      return { kind: 'tnt', path: `${BASE}calculators/tnt.html`, level: 'Intermediate Flyers', produces: 'full', label: 'NAIGC T&T — Intermediate Flyers' };
    case 'tnt-high':
      return { kind: 'tnt', path: `${BASE}calculators/tnt.html`, level: 'High Flyers', produces: 'full', label: 'NAIGC T&T — High Flyers' };
    default:
      return null;
  }
}

/** Builds the iframe src with apparatus / ruleset presets. */
export function calcUrl(cfg: CalcConfig, eventCode: string): string {
  const p = new URLSearchParams();
  p.set('apparatus', eventCode);
  if (cfg.ruleset) p.set('ruleset', cfg.ruleset);
  if (cfg.level) p.set('level', cfg.level);
  return `${cfg.path}?${p.toString()}`;
}

export function calcSource(kind: CalcKind): Score['source'] {
  switch (kind) {
    case 'masters': return 'masters-calc';
    case 'tnt': return 'tnt-calc';
    case 'wag-open': case 'wag-vault': return 'wag-open-calc';
    case 'wag-sv': return 'wag-sv-calc';
    default: return 'mag-calc';
  }
}

/** Translates a native engine outcome into the fields stored on a Score. */
export function scoreFromOutcome(cfg: CalcConfig, oc: ScoringOutcome): Partial<Score> {
  if (cfg.produces === 'full') {
    return {
      sv: oc.d,
      eScore: oc.e,
      deductions: oc.e != null ? Math.round((10 - oc.e) * 1000) / 1000 : null,
      final: oc.final,
      source: calcSource(cfg.kind),
    };
  }
  return { sv: oc.d, source: calcSource(cfg.kind) };
}
