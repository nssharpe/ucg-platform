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

/** Pure drop-target resolver for the drag UI's `onDragEnd` (B2 component):
 *  given the CURRENT `sections` (before removal), the dragged `regId`, the
 *  section index being dropped into (`toSection`), and what's under the
 *  pointer (`overId` — either another registration id or a section
 *  container), returns the index to pass to `moveInSections` as `toIndex`.
 *
 *  Container drops (`overIsContainer`) always append (index = post-removal
 *  length). Cross-section item drops use the hovered item's index in the
 *  POST-removal target section (removing `regId` doesn't touch a section it
 *  wasn't in, so pre/post-removal indices already agree there).
 *
 *  Same-section item drops are the tricky case (this is the fix for the
 *  "dragging down snaps back" bug): the hovered item's index must be read
 *  from the ORIGINAL (pre-removal) section, matching dnd-kit's `arrayMove`
 *  semantics (remove, then insert at the target's original slot). Using the
 *  post-removal index instead re-derives the dragged item's OWN original
 *  slot for a downward drag — e.g. `[A,B,C]` dragging A over B: post-removal
 *  is `[B,C]`, `indexOf(B)===0`, which re-inserts A at index 0 ⇒ `[A,B,C]`,
 *  a no-op. Reading B's index in the ORIGINAL `[A,B,C]` (index 1) instead
 *  yields the correct `[B,A,C]`. Upward same-section drags happen to work
 *  either way (removing a LATER item doesn't shift an EARLIER item's index),
 *  which is why only downward drags exhibited the bug. */
export function computeDropIndex(
  sections: string[][],
  regId: string,
  toSection: number,
  overId: string,
  overIsContainer: boolean,
): number {
  const target = sections[toSection] ?? [];
  const postRemoval = target.filter((id) => id !== regId);

  if (overIsContainer) return postRemoval.length;

  const fromSection = sections.findIndex((sec) => sec.includes(regId));
  if (fromSection === toSection) {
    const idx = target.indexOf(overId);
    return idx >= 0 ? idx : postRemoval.length;
  }

  const idx = postRemoval.indexOf(overId);
  return idx >= 0 ? idx : postRemoval.length;
}

/** Reconcile a persisted `sections` shape (or `undefined` — no row saved yet)
 *  against the CURRENT eligible registration-id set for an apparatus column
 *  (B2 UI, spec §E6): drop ids no longer eligible (refunded, apparatus
 *  dropped from the registration, athlete moved level/club), and append
 *  newly-eligible ids (not yet placed anywhere) to the last section — or a
 *  fresh section past `cap` — so a mid-event roster edit never orphans or
 *  silently drops an athlete from their club's competition order. Seeds
 *  fresh via `splitIntoSections` when there's no persisted row yet. Pure so
 *  it's cheap for the UI to recompute on every render (never assume the
 *  persisted shape already matches the current eligible set). */
export function reconcileSections(existing: string[][] | undefined, eligibleRegIds: string[], cap: number): string[][] {
  if (!existing || existing.length === 0) {
    return eligibleRegIds.length > 0 ? splitIntoSections(eligibleRegIds, cap) : [[]];
  }
  const eligibleSet = new Set(eligibleRegIds);
  const kept = existing.map((sec) => sec.filter((id) => eligibleSet.has(id)));
  const placed = new Set(kept.flat());
  const toAdd = eligibleRegIds.filter((id) => !placed.has(id));

  if (toAdd.length === 0) return kept.length > 0 ? kept : [[]];

  const result = kept.length > 0 ? kept.slice(0, -1) : [];
  const last = kept.length > 0 ? kept[kept.length - 1] : [];
  const room = Math.max(cap - last.length, 0);
  const appended = [...last, ...toAdd.slice(0, room)];
  const remaining = toAdd.slice(room);
  result.push(appended);
  if (remaining.length > 0) result.push(...splitIntoSections(remaining, cap));
  return result;
}
