// Pure helpers for "Set Competition Order" (event-mgmt v2 Phase 5, spec §E6).
// MAG/WAG only — a club manager drags athlete registrations into competing
// order per apparatus, split into capped sections. Zero React/store imports —
// keep this importable from tests and future edge functions alike (mirrors
// the split of src/scoring/* and src/lib/pricing.ts's pure-logic pattern).
//
// No UI here — that's B2. This module only builds/validates/edits the
// `sections: string[][]` shape persisted on `CompetitionOrder.sections`
// (src/lib/types.ts) and the `competition_orders.sections` jsonb column
// (P5 B1 migration).

/** Per-section athlete cap (spec §E6): WAG sections cap at 12, MAG at 15.
 *  Competition order is MAG/WAG only — T&T never calls this. */
export function sectionCap(discipline: 'WAG' | 'MAG'): number {
  return discipline === 'WAG' ? 12 : 15;
}

/** Chunk a flat ordered list of registration ids into sections of at most
 *  `cap` each, preserving order. `cap <= 0` degrades to one id per section
 *  (never produces an empty or over-cap chunk). */
export function splitIntoSections(orderedRegIds: string[], cap: number): string[][] {
  const safeCap = cap > 0 ? Math.floor(cap) : 1;
  const sections: string[][] = [];
  for (let i = 0; i < orderedRegIds.length; i += safeCap) {
    sections.push(orderedRegIds.slice(i, i + safeCap));
  }
  return sections;
}

/** Concatenate sections back into one flat ordered list (inverse of
 *  `splitIntoSections`, modulo the section boundaries themselves). */
export function flattenSections(sections: string[][]): string[] {
  return sections.flat();
}

/** True iff every section has at most `cap` entries and no registration id
 *  appears more than once across all sections (empty sections/list are
 *  valid). */
export function sectionsValid(sections: string[][], cap: number): boolean {
  const seen = new Set<string>();
  for (const section of sections) {
    if (section.length > cap) return false;
    for (const regId of section) {
      if (seen.has(regId)) return false;
      seen.add(regId);
    }
  }
  return true;
}

/** Pure reorder: move `regId` to `sections[toSection][toIndex]`, removing it
 *  from wherever it currently sits first. Total/defensive — a `regId` not
 *  present is simply inserted (nothing to remove); an out-of-range
 *  `toSection`/`toIndex` clamps into range rather than throwing. Returns a
 *  new array (does not mutate the input). */
export function moveInSections(
  sections: string[][],
  regId: string,
  toSection: number,
  toIndex: number,
): string[][] {
  // Deep-ish copy (new outer array + new inner arrays) so callers can treat
  // the result as an independent snapshot.
  const next = sections.map((s) => s.filter((id) => id !== regId));

  if (next.length === 0) {
    // No sections to insert into — create one.
    return [[regId]];
  }

  const clampedSection = Math.min(Math.max(toSection, 0), next.length - 1);
  const target = next[clampedSection];
  const clampedIndex = Math.min(Math.max(toIndex, 0), target.length);
  target.splice(clampedIndex, 0, regId);

  return next;
}
