// Pure wizard-side editable-state <-> Event.capacity mapping for the
// per-discipline capacity editor (capacity rework, 2026-08-24 — T2). No
// React/store/Supabase imports — unit-tested in tests/capacity-draft.test.ts.
// Companion to src/lib/capacity.ts (the engine T1 built): this module only
// concerns the EventWizard's editable draft state and its round-trip to/from
// `CapacityConfigRaw`; enforcement itself still lives entirely in capacity.ts.
import { DISCIPLINES, type CapacityConfigRaw, type CapacityDisciplineConfig, type Discipline } from './types';
import { normalizeCapacity } from './capacity';

const disciplineLabel = (d: Discipline) => (d === 'TNT' ? 'T&T' : d);

/** One discipline's editable capacity draft. `cap` and `perLevel` are BOTH
 *  always present regardless of `mode` — switching the radio between modes
 *  must never discard whichever value the admin already typed into the
 *  other mode's input(s). Values are the raw string input contents; '' means
 *  blank/not-entered. */
export interface DisciplineCapacityDraft {
  mode: 'none' | 'discipline' | 'perLevel';
  cap: string;
  perLevel: Record<string, string>;
}

export type CapacityDraft = Partial<Record<Discipline, DisciplineCapacityDraft>>;

function blankDraft(): DisciplineCapacityDraft {
  return { mode: 'none', cap: '', perLevel: {} };
}

/**
 * Builds the wizard's editable capacity draft from an event's stored
 * capacity (legacy or new shape — always normalized first via
 * `normalizeCapacity`). Every discipline in `disciplines` gets an entry;
 * one absent from the normalized config (or explicitly `mode: 'none'`)
 * starts as `{mode: 'none', cap: '', perLevel: {}}` — "No cap" is the
 * explicit default for an unconfigured discipline.
 */
export function capacityDraftFromEvent(
  capacity: CapacityConfigRaw | null | undefined,
  disciplines: readonly Discipline[],
): CapacityDraft {
  const cfg = normalizeCapacity(capacity);
  const draft: CapacityDraft = {};
  for (const d of disciplines) {
    const entry = cfg.perDiscipline?.[d];
    if (entry?.mode === 'discipline') {
      draft[d] = { mode: 'discipline', cap: entry.cap != null ? String(entry.cap) : '', perLevel: {} };
    } else if (entry?.mode === 'perLevel') {
      draft[d] = {
        mode: 'perLevel',
        cap: '',
        perLevel: Object.fromEntries(
          Object.entries(entry.perLevel ?? {}).map(([id, v]) => [id, v != null ? String(v) : '']),
        ),
      };
    } else {
      draft[d] = blankDraft();
    }
  }
  return draft;
}

/**
 * Converts the wizard's editable capacity draft into the `CapacityConfigRaw`
 * to write onto `Event.capacity`. Writes ONLY the new per-discipline shape —
 * never a `total` key (that cap type is gone, T1).
 *
 * A discipline whose mode is 'none' is OMITTED from the written
 * `perDiscipline` map entirely, rather than written as an explicit
 * `{mode:'none'}` object. Both read identically through `normalizeCapacity`
 * (an object with `mode:'none'` passes through unchanged; a discipline
 * simply absent from the map also resolves to no configured cap) — omitting
 * keeps the persisted config minimal and avoids writing a stale `{mode:
 * 'none'}` object for a discipline nobody ever touched.
 *
 * Returns `undefined` (meaning: drop `capacity` from the event entirely)
 * when every discipline resolves to no cap, matching the pre-T2 wizard's
 * behavior of clearing `capacity` when every input was left blank.
 */
export function capacityConfigFromDraft(draft: CapacityDraft): CapacityConfigRaw | undefined {
  const perDiscipline: Partial<Record<Discipline, CapacityDisciplineConfig>> = {};
  for (const d of DISCIPLINES) {
    const entry = draft[d];
    if (!entry || entry.mode === 'none') continue;

    if (entry.mode === 'discipline') {
      if (!entry.cap.trim()) continue;
      const n = Number(entry.cap);
      if (Number.isFinite(n)) perDiscipline[d] = { mode: 'discipline', cap: n };
      continue;
    }

    // mode === 'perLevel'
    const perLevel: Record<string, number> = {};
    for (const [levelId, v] of Object.entries(entry.perLevel)) {
      if (!v.trim()) continue;
      const n = Number(v);
      if (Number.isFinite(n)) perLevel[levelId] = n;
    }
    if (Object.keys(perLevel).length > 0) perDiscipline[d] = { mode: 'perLevel', perLevel };
  }
  return Object.keys(perDiscipline).length > 0 ? { perDiscipline } : undefined;
}

/** The subset of `CapacityUsage` (src/lib/capacity.ts) this validator needs.
 *  Callers MUST pass the ENFORCEMENT tally — `capacityUsage()` (paid + live
 *  holds) — never `paidUsage()`. Validating against paid-only usage would let
 *  a save under-cut a spot already promised by a live cart hold or a
 *  promoted waitlist group, which then 409s that athlete's own checkout. */
export interface CapacityUsageForValidation {
  perDiscipline: Partial<Record<Discipline, number>>;
  perDisciplineLevel: Partial<Record<Discipline, Record<string, number>>>;
}

export interface CapacityDraftError {
  discipline: Discipline;
  levelId?: string;
  /** 'invalid': not a positive whole number (or missing where one is
   *  required). 'below-usage': a positive whole number, but lower than
   *  current registered usage. */
  kind: 'invalid' | 'below-usage';
  used?: number;
  message: string;
}

/** True (and returns the parsed number) only for a positive integer string —
 *  mirrors `capOf` in capacity.ts: rejects '', 0, negatives, and fractions. */
function wholeNumberOrUndefined(v: string): number | undefined {
  if (!v.trim()) return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * Validates the wizard's capacity draft. For each discipline not in mode
 * 'none':
 *  - 'discipline' mode requires a positive-whole-number cap.
 *  - 'perLevel' mode requires at least one level with a positive-whole-number
 *    cap (other levels may stay blank — that level simply stays uncapped,
 *    same as the pre-T2 per-level grid).
 *  - Any filled-in cap that IS a positive whole number is then checked
 *    against `usage` — lowering a cap below currently-registered routines is
 *    refused with the exact current count.
 *
 * `levelName` resolves a levelId to its display name for messages (the
 * wizard passes one backed by `db.levels`; tests can pass a stub). Returns
 * every violation found — empty means the draft is safe to save.
 */
export function validateCapacityDraft(
  draft: CapacityDraft,
  usage: CapacityUsageForValidation,
  levelName: (levelId: string) => string = (id) => id,
): CapacityDraftError[] {
  const errors: CapacityDraftError[] = [];

  for (const d of DISCIPLINES) {
    const entry = draft[d];
    if (!entry || entry.mode === 'none') continue;

    if (entry.mode === 'discipline') {
      const cap = wholeNumberOrUndefined(entry.cap);
      if (cap === undefined) {
        errors.push({
          discipline: d,
          kind: 'invalid',
          message: `Enter a whole-number cap (routines) for ${disciplineLabel(d)}, or choose No cap.`,
        });
        continue;
      }
      const used = usage.perDiscipline[d] ?? 0;
      if (cap < used) {
        errors.push({
          discipline: d,
          kind: 'below-usage',
          used,
          message: `Can't set below current ${used} registered routines for ${disciplineLabel(d)}`,
        });
      }
      continue;
    }

    // mode === 'perLevel'
    const filled = Object.entries(entry.perLevel).filter(([, v]) => v.trim() !== '');
    if (filled.length === 0) {
      errors.push({
        discipline: d,
        kind: 'invalid',
        message: `Enter at least one level cap for ${disciplineLabel(d)}, or choose No cap.`,
      });
      continue;
    }
    for (const [levelId, v] of filled) {
      const cap = wholeNumberOrUndefined(v);
      if (cap === undefined) {
        errors.push({
          discipline: d,
          levelId,
          kind: 'invalid',
          message: `${levelName(levelId)} cap must be a whole number greater than 0.`,
        });
        continue;
      }
      const used = usage.perDisciplineLevel[d]?.[levelId] ?? 0;
      if (cap < used) {
        errors.push({
          discipline: d,
          levelId,
          kind: 'below-usage',
          used,
          message: `Can't set below current ${used} registered routines for ${levelName(levelId)}`,
        });
      }
    }
  }

  return errors;
}
