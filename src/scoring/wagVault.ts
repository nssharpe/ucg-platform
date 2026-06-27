// NAIGC WAG Open vault engine — vault table value + deductions.
// Ported from public/calculators/wag-vault.html. Produces a full D/E/Final score.
import { num, round3, type ScoringOutcome } from './types';

export interface WagVault { name: string; fig: number }

/** WAG vault FIG values (from the NAIGC vault values sheet). null = group separator. */
export const VAULT_DATA: (WagVault | null)[] = [
  { name: 'Squat onto table - straight jump down', fig: 0.0 },
  { name: 'Roll onto and over the table', fig: 0.0 },
  { name: 'Straddle hecht over table', fig: 0.6 },
  { name: 'Tuck hecht over table', fig: 0.6 },
  { name: 'Pike hecht over table', fig: 1.1 },
  { name: 'Straight hecht over table', fig: 1.6 },
  null,
  { name: 'Front handspring', fig: 1.6 },
  { name: 'Front handspring with 1/2 twist', fig: 2.0 },
  { name: 'Front handspring with 1/1 twist', fig: 2.6 },
  { name: 'Front handspring with 3/2 twist', fig: 3.2 },
  { name: 'Front handspring with 1/2 twist 1st phase', fig: 1.6 },
  { name: 'Front handspring with 1/2 twist 1st & 2nd phase', fig: 2.4 },
  { name: 'Yamashita', fig: 2.0 },
  { name: 'Yamashita 1/2 twist', fig: 2.4 },
  { name: 'Yamashita 1/1 twist', fig: 2.8 },
  { name: 'Front handspring and salto fwd. tucked', fig: 3.6 },
  { name: 'Front handspring and salto fwd. tucked with 1/2 twist', fig: 3.8 },
  { name: 'Front handspring and salto fwd. piked', fig: 3.8 },
  { name: 'Front handspring and salto fwd. piked with 1/2 twist', fig: 4.0 },
  null,
  { name: 'Front handspring sw with 1/4 twist', fig: 1.6 },
  { name: 'Front handspring sw with 3/4 twist', fig: 2.0 },
  { name: 'Front handspring sw with 5/4 twist', fig: 2.6 },
  { name: 'Yurchenko tucked', fig: 3.0 },
  { name: 'Yurchenko piked', fig: 3.2 },
  { name: 'Yurchenko tucked with 1/2 twist', fig: 3.2 },
  { name: 'Yurchenko tucked with 1/1 twist', fig: 3.6 },
  { name: 'Yurchenko stretched', fig: 3.6 },
  { name: 'Yurchenko stretched with 1/2 twist', fig: 3.8 },
  { name: 'Yurchenko stretched with 1/1 twist', fig: 4.2 },
  { name: 'Tsukahara tucked', fig: 3.2 },
  { name: 'Tsukahara piked', fig: 3.4 },
  { name: 'Tsukahara tucked with 1/2 twist', fig: 3.4 },
  { name: 'Tsukahara tucked with 1/1 twist', fig: 3.8 },
  { name: 'Tsukahara stretched', fig: 3.8 },
  { name: 'Tsukahara stretched with 1/2 twist', fig: 4.0 },
  { name: 'Tsukahara stretched with 1/1 twist', fig: 4.4 },
];

export interface WagVaultState {
  vaultIndex: number; // index into VAULT_DATA (the original defaulted to the first vault)
  deductions: string;
}

export function init(_levelId: string, _apparatusCode: string): WagVaultState {
  return { vaultIndex: 0, deductions: '' };
}

export function compute(state: WagVaultState, _levelId: string, _apparatusCode: string): ScoringOutcome {
  const d = VAULT_DATA[state.vaultIndex]?.fig ?? 0;
  const ded = num(state.deductions, 0, 10);
  const e = round3(10 - ded);
  return {
    d,
    e,
    final: round3(Math.max(0, d + e)),
    produces: 'full',
    breakdown: [
      { label: 'Vault value', value: d },
      { label: 'Deductions', value: -ded },
    ],
    warnings: [],
  };
}
