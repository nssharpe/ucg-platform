// Pure helpers for the Nationals summary dashboard (event-mgmt v2 Phase 5,
// spec §L.3) — reused by NationalsDashboard here (D1), the finals-lineup
// editor (C2), and mirrored by the scheduler (C3). Zero React/store imports,
// mirroring src/lib/finals-lineup.ts and src/lib/competition-order.ts.
//
// `platformCategory`/`DISCIPLINE_DEFS` are imported from `./nationals-adapter`
// rather than replicated — that module only imports from `./types` and the
// pure `../nationals` engine, so it drags no store/React deps and is safe to
// reuse here.
import type { Athlete, Discipline, Registration } from './types';
import { DISCIPLINE_DEFS, platformCategory } from './nationals-adapter';

/** A team needs at least this many athletes registered for the SAME
 *  apparatus (same club + level + placement category) to be finals-eligible. */
export const TEAM_MIN_PER_APPARATUS = 3;

/** A grouped nationals team: one (club, discipline, level, category) bucket,
 *  with per-apparatus registration ids and the subset of apparatus that meet
 *  `TEAM_MIN_PER_APPARATUS`. This is where the C2 finals-lineup editor
 *  attaches — this module only builds/groups, it doesn't pick a lineup. */
export type NationalsTeam = {
  clubId: string;
  discipline: Discipline;
  levelId: string;
  category: string;
  apparatusRegIds: Record<string, string[]>;
  eligibleApparatus: string[];
};

/** True iff `reg` is registered for EVERY apparatus in `discipline` (mirrors
 *  `RegistrationEditor.tsx`'s `isAA`: same length AND every discipline
 *  apparatus code present in `reg.apparatus`). */
export function isAllAround(reg: Registration, discipline: Discipline): boolean {
  const codes = DISCIPLINE_DEFS[discipline].apparatus;
  return reg.apparatus.length === codes.length && codes.every((code) => reg.apparatus.includes(code));
}

/**
 * Group registrations into nationals teams: same clubId + discipline +
 * levelId + placement category. `apparatusRegIds[apparatus]` collects the reg
 * ids registered for that apparatus code within the group; `eligibleApparatus`
 * is the subset with at least `TEAM_MIN_PER_APPARATUS` registrants.
 * Refunded and waitlisted registrations are excluded. Category is derived via
 * `platformCategory` (the athlete's per-discipline placement override, else
 * gender + student status) — a registration whose athlete can't be found is
 * skipped (nothing to categorize).
 */
export function eligibleTeams(regs: Registration[], peopleById: Map<string, Athlete>): NationalsTeam[] {
  const groups = new Map<string, NationalsTeam>();

  for (const reg of regs) {
    if (reg.refunded || reg.waitlisted) continue;
    const athlete = peopleById.get(reg.athleteId);
    if (!athlete) continue;

    const category = platformCategory(athlete.placement?.[reg.discipline], athlete.gender ?? '', athlete.studentStatus || 'Non-Student');
    const key = `${reg.clubId}|${reg.discipline}|${reg.levelId}|${category}`;

    let team = groups.get(key);
    if (!team) {
      team = {
        clubId: reg.clubId,
        discipline: reg.discipline,
        levelId: reg.levelId,
        category,
        apparatusRegIds: {},
        eligibleApparatus: [],
      };
      groups.set(key, team);
    }

    for (const apparatus of reg.apparatus) {
      (team.apparatusRegIds[apparatus] ??= []).push(reg.id);
    }
  }

  for (const team of groups.values()) {
    team.eligibleApparatus = Object.entries(team.apparatusRegIds)
      .filter(([, regIds]) => regIds.length >= TEAM_MIN_PER_APPARATUS)
      .map(([apparatus]) => apparatus);
  }

  return [...groups.values()];
}
