/**
 * Nationals finals-qualification & awards engine — pure TypeScript port of the
 * reference tool `jules-pierce/naigc-2024`. Platform-agnostic: works on generic
 * level/category strings + a config object. Validated to byte-for-byte parity
 * against the 2024 & 2025 reference outputs (tests/nationals/*).
 *
 * Spec: docs/specs/2026-06-13-nationals-qual-awards.md.
 */
export * from './types';
export { roundScore } from './round';
export { deriveCategory } from './categories';
export { buildConfig, cutoffFor, type RawConfig } from './config';
export { computeArtistic, type ArtisticComputation, type ArtisticOptions } from './artistic';
export { computeTnt, buildTntCutoffs, type TntCutoffs } from './tnt';
export { computeTeams, type TeamComputation } from './teams';
export { computeDecathlon, computeOmnithon, type DecathlonResult, type OmnithonResult } from './combined';
export { assembleArtisticAwards, type AwardTable, type AwardEntry } from './awards';
export {
  validateArtistic,
  validateTeamFinals,
  validateQualCheck,
  validateSyncro,
  type PrelimQualLookup,
} from './validation';
