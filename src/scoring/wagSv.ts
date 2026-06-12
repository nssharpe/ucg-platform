// USAG Xcel & Development Program (Level 9) start-value engine.
// Ported from public/calculators/wag-sv.html. Produces an SV only — the judge
// applies execution deductions in the score form.
import { round2, type ScoringOutcome } from './types';

export type WagSvLevel = 'Bronze' | 'Silver' | 'Gold' | 'Platinum' | 'Diamond' | 'Level 9';
export type VpPart = 'A' | 'B' | 'C';

const VP_VALUE: Record<VpPart, number> = { A: 0.1, B: 0.3, C: 0.5 };

/** Base SV + required value parts per level. Xcel builds from 10.0; Level 9 from 9.70 + bonus. */
export const LEVELS: Record<WagSvLevel, {
  program: 'Xcel' | 'DP'; base: number; req: Record<VpPart, number>; bonus: boolean; bonusMax?: number;
}> = {
  Bronze: { program: 'Xcel', base: 10.0, req: { A: 4, B: 0, C: 0 }, bonus: false },
  Silver: { program: 'Xcel', base: 10.0, req: { A: 5, B: 0, C: 0 }, bonus: false },
  Gold: { program: 'Xcel', base: 10.0, req: { A: 6, B: 0, C: 0 }, bonus: false },
  Platinum: { program: 'Xcel', base: 10.0, req: { A: 6, B: 1, C: 0 }, bonus: false },
  Diamond: { program: 'Xcel', base: 10.0, req: { A: 5, B: 2, C: 0 }, bonus: false },
  'Level 9': { program: 'DP', base: 9.70, req: { A: 3, B: 4, C: 1 }, bonus: true, bonusMax: 0.30 },
};

/** 4 Special Requirements per event, per level (concise judge-facing labels). */
export const SR: Record<WagSvLevel, Record<'UB' | 'BB' | 'FX', string[]>> = {
  Bronze: {
    UB: ['Mount (low bar)', 'Cast — hips leave bar (not mount/dismount)', '360° circling skill (not mount/dismount)', 'Dismount (low bar, no saltos)'],
    BB: ['Min ½ turn (1 or 2 feet)', 'One jump or leap (no split required)', 'One non-flight acro element', 'Dismount (no saltos/aerials)'],
    FX: ['Min 2 directly-connected acro elements', '2nd acro pass — min 1 acro element', 'Dance: 2 diff. Group 1, leap min 60° split', 'Min ½ turn on one foot'],
  },
  Silver: {
    UB: ['Mount', 'Cast to ≥45° below horizontal (not mount/dismount)', '360° circling skill (not mount/dismount)', 'Dismount (low/high bar, no saltos)'],
    BB: ['Min ½ turn on one foot', 'Jump/leap, min 90° cross/side split', 'One non-flight acro element', 'Dismount'],
    FX: ['Min 2 directly-connected acro, ≥1 with flight', '2nd acro pass (connection or flight element)', 'Dance: 2 diff. Group 1, leap min 90° split', 'Min 1/1 turn on one foot'],
  },
  Gold: {
    UB: ['Skill finishing in clear support ≥ horizontal', '360° circling skill (not mount/dismount)', '2nd 360° circling skill', 'Dismount from high bar'],
    BB: ['Min 1/1 turn on one foot', 'Two diff. Group 2, one min 120° split', 'Two acro elements, one through inverted vertical', 'Dismount'],
    FX: ['Min 2 directly-connected acro flight elements', '2nd acro pass (flight, or aerial/salto)', 'Dance: 2 diff. Group 1, leap min 120° split', 'Min 1/1 turn on one foot'],
  },
  Platinum: {
    UB: ['Skill finishing in clear support above horizontal', '360° circling skill (not mount/dismount)', 'Kip', 'Dismount from high bar (min "A")'],
    BB: ['Min 1/1 turn on one foot', 'Dance series + jump/leap min 120° split', 'Acro flight element or series (one through vertical)', 'Dismount'],
    FX: ['Min 2 connected acro flight w/ "A" or "B" salto', '2nd acro pass (or one "B" salto)', 'Dance: 2 diff. Group 1, leap min 150° split', 'Min 1/1 turn on one foot'],
  },
  Diamond: {
    UB: ['Clear support ≥45° from vertical (not mount/dismount)', 'Min "B" 360° circling skill', 'Additional min "B": release, turn, or 2nd circling', 'Salto/hecht dismount min "A" (or any min "B") from HB'],
    BB: ['Min 1/1 turn on one foot', 'Dance series + jump/leap min 150° split', 'Acro series + one acro flight element', 'Dismount — salto or aerial'],
    FX: ['Two acro flight passes (each 2 connected flight)', 'Two different saltos, one min "B"', 'Dance: 2 diff. Group 1, leap min 150° split', 'Min "B" turn on one foot'],
  },
  'Level 9': {
    UB: ['Min two bar changes', 'Flight element min "B" (excl. dismount)', '2nd diff. flight min "C", or LA turn ≥180° min "B"', 'Salto dismount min "B"'],
    BB: ['Acro series: 2 connected flight, or one min "C" flight, or non-flight "A" + flight "E"', 'Leap/jump req. 180° cross/side split', 'Min 360° turn on one foot', 'Aerial/salto dismount min "B"'],
    FX: ['Acro pass with min 2 saltos (connected w/ flight)', 'Three different saltos (not aerials)', 'Dance passage: 2 diff. Group 1 + leap 180° split', 'Last isolated salto min "B"'],
  },
};

type VaultRow = [name: string, sv: number];

/** Vault tables — value = start value at that level. */
export const L9_VAULTS: VaultRow[] = [
  ['Handspring', 8.5], ['Handspring ½ off', 8.6], ['Yamashita', 8.5], ['Yamashita ½ off', 8.6],
  ['Handspring 1/1', 9.0], ['Handspring 1½', 9.4], ['Yamashita 1/1', 9.0], ['Handspring 2/1', 9.7],
  ['Handspring → front tuck', 10.0], ['Handspring → front pike', 10.0], ['Handspring → front tuck ½', 10.0],
  ['Tsukahara tuck', 9.6], ['Tsukahara pike', 9.7], ['Tsukahara layout', 10.0], ['Tsukahara tuck 1/1', 10.0],
  ['RO, FF → 1/1 twist', 9.1], ['RO, FF → 1½ twist (Allen)', 9.6], ['RO, FF → back tuck', 9.6],
  ['RO, FF → back pike', 9.7], ['RO, FF → back layout', 10.0], ['RO, FF → 2/1 twist', 9.8], ['RO, FF → back tuck 1/1', 10.0],
  ['RO, FF ½ → handspring', 8.9], ['RO, FF ½ → front tuck', 10.0], ['RO, FF ½ → 1/1 twist', 9.2],
];

export const XCEL_VAULTS: Partial<Record<WagSvLevel, VaultRow[]>> = {
  Bronze: [['Stretch jump onto mat stack + kick to handstand, fall to flat back', 9.0], ['Jump to handstand, fall to flat back', 10.0]],
  Silver: [['Handspring over mat stack', 10.0], ['¼–½ turn on → repulsion off, landing facing stack', 10.0]],
  Gold: [['Any allowed Gold vault (handspring/Yamashita family)', 10.0]],
  Platinum: [['Handspring', 9.7], ['Handspring ½ off', 9.9], ['Yamashita', 9.7], ['Yamashita ½ off', 10.0],
    ['½ on → ½ off (or ¼ on → ¾ off)', 9.9], ['Handspring 1/1', 10.0], ['Handspring 1½', 10.0],
    ['Yamashita 1/1', 10.0], ['½ on → 1/1 off', 10.0], ['1/1 on → handspring/Yamashita', 10.0],
    ['1/1 on → ½ off', 10.0], ['RO, FF → repulsion off', 9.7], ['RO, FF → repulsion ½ off', 9.7]],
  Diamond: [['Handspring', 9.4], ['Handspring ½ off', 9.6], ['Yamashita', 9.4], ['Yamashita ½ off', 9.6],
    ['Handspring 1/1', 10.0], ['Handspring 1½', 10.0], ['Handspring 2/1', 10.0], ['Yamashita 1/1', 10.0],
    ['½ on → 1½ off', 10.0], ['½ on → 1/1 off', 9.9], ['1/1 on → handspring/Yamashita', 10.0], ['1/1 on → ½ off', 10.0],
    ['Tsukahara back tuck', 9.4], ['Tsukahara back pike', 9.6], ['Tsukahara back layout', 10.0],
    ['RO, FF → repulsion off', 10.0], ['RO, FF → 1/1 twist', 10.0], ['RO, FF → back tuck', 9.8],
    ['RO, FF → back pike', 10.0], ['RO, FF → back layout', 10.0],
    ['RO, FF ½ → handspring', 9.6], ['RO, FF ½ → ½ off', 10.0], ['RO, FF ½ → 1/1 off', 10.0]],
};

export function wagSvLevel(levelId: string): WagSvLevel {
  switch (levelId) {
    case 'wag-silver': return 'Silver';
    case 'wag-plat': return 'Platinum';
    case 'wag-diamond': return 'Diamond';
    case 'wag-l9': return 'Level 9';
    default: return 'Silver';
  }
}

export function vaultsFor(level: WagSvLevel): VaultRow[] {
  return LEVELS[level].program === 'DP'
    ? L9_VAULTS
    : XCEL_VAULTS[level] ?? [['(no vault table for this level)', 10.0]];
}

/** Which VP rows the panel shows: C appears when required (L9) or allowed (Plat/Diamond). */
export function vpParts(level: WagSvLevel): VpPart[] {
  const showC = LEVELS[level].req.C > 0 || level === 'Diamond' || level === 'Platinum';
  return showC ? ['A', 'B', 'C'] : ['A', 'B'];
}

export interface WagSvState {
  vp: Record<VpPart, number>;
  /** 4 SRs, default fulfilled (judge unchecks what was missed). */
  sr: boolean[];
  noDismount: boolean;
  restricted: number;
  /** L9 CV / D-E bonus, judge-entered (0 / 0.1 / 0.2 / 0.3). */
  bonus: number;
  vaultIndex: number;
}

export function init(_levelId: string, _eventCode: string): WagSvState {
  return {
    vp: { A: 0, B: 0, C: 0 },
    sr: [true, true, true, true],
    noDismount: false,
    restricted: 0,
    bonus: 0,
    vaultIndex: 0,
  };
}

/** Missing value-part deduction: higher performed parts fill lower requirement slots. */
function missingVP(level: WagSvLevel, vp: Record<VpPart, number>): number {
  const req = LEVELS[level].req;
  let miss = 0;
  let avail = vp.C;
  let need = req.C;
  let use = Math.min(need, avail); need -= use; avail -= use; miss += need * VP_VALUE.C;
  avail += vp.B; need = req.B; use = Math.min(need, avail); need -= use; avail -= use; miss += need * VP_VALUE.B;
  avail += vp.A; need = req.A; use = Math.min(need, avail); need -= use; miss += need * VP_VALUE.A;
  return round2(miss);
}

export function compute(state: WagSvState, levelId: string, eventCode: string): ScoringOutcome {
  const level = wagSvLevel(levelId);
  const lvl = LEVELS[level];

  if (eventCode === 'VT') {
    const sv = vaultsFor(level)[state.vaultIndex]?.[1] ?? 0;
    return {
      d: round2(sv), e: null, final: null, produces: 'd',
      breakdown: [{ label: 'Vault table value', value: sv }],
      warnings: [],
    };
  }

  const mvp = missingVP(level, state.vp);
  const srMissing = state.sr.filter((ok) => !ok).length * 0.5;
  const noDis = state.noDismount ? 0.3 : 0;
  const restr = state.restricted * 0.5;
  const bonus = lvl.bonus ? Math.min(state.bonus, lvl.bonusMax ?? 0) : 0;
  const sv = round2(Math.min(10.0, Math.max(0, lvl.base + bonus - mvp - srMissing - noDis - restr)));

  const breakdown = [{ label: 'Base', value: lvl.base }];
  if (bonus) breakdown.push({ label: 'Bonus', value: bonus });
  if (mvp) breakdown.push({ label: 'Missing VP', value: -mvp });
  if (srMissing) breakdown.push({ label: 'Missing SR', value: -srMissing });
  if (noDis) breakdown.push({ label: 'No dismount', value: -noDis });
  if (restr) breakdown.push({ label: 'Restricted', value: -restr });

  return { d: sv, e: null, final: null, produces: 'd', breakdown, warnings: [] };
}
