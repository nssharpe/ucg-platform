import { describe, it, expect } from 'vitest';
import {
  capacityDraftFromEvent,
  capacityConfigFromDraft,
  validateCapacityDraft,
  type CapacityDraft,
  type CapacityUsageForValidation,
} from '../src/lib/capacity-draft';
import { normalizeCapacity } from '../src/lib/capacity';
import { DISCIPLINES } from '../src/lib/types';
import type { CapacityConfigRaw } from '../src/lib/types';

const emptyUsage: CapacityUsageForValidation = { perDiscipline: {}, perDisciplineLevel: {} };

describe('capacityDraftFromEvent / capacityConfigFromDraft round-trip', () => {
  it('round-trips a discipline-mode + perLevel-mode config through the draft unchanged (via normalizeCapacity)', () => {
    const original: CapacityConfigRaw = {
      perDiscipline: {
        TNT: { mode: 'discipline', cap: 40 },
        WAG: { mode: 'perLevel', perLevel: { 'lvl-silver': 12, 'lvl-gold': 8 } },
      },
    };
    const draft = capacityDraftFromEvent(original, DISCIPLINES);
    const roundTripped = capacityConfigFromDraft(draft);
    expect(normalizeCapacity(roundTripped)).toEqual(normalizeCapacity(original));
  });

  it('starts every discipline at mode "none" when the event has no capacity config at all', () => {
    const draft = capacityDraftFromEvent(undefined, DISCIPLINES);
    for (const d of DISCIPLINES) {
      expect(draft[d]).toEqual({ mode: 'none', cap: '', perLevel: {} });
    }
  });

  it('maps the legacy flat shape (total ignored, a legacy perLevel map wins over a bare-number perDiscipline entry)', () => {
    const legacy: CapacityConfigRaw = {
      total: 500, // ignored outright — no replacement (T1)
      perDiscipline: { TNT: 25 },
      perLevel: { 'lvl-a': 10 },
    };
    const draft = capacityDraftFromEvent(legacy, DISCIPLINES);
    // normalizeCapacity's documented rule: a legacy top-level `perLevel` map
    // is discipline-independent, so it fans out to EVERY discipline
    // (including TNT) and wins over TNT's own bare-number entry — the
    // stricter per-level reading is kept (see normalizeCapacity's doc
    // comment). Harmless: usage self-scopes by each reg's own discipline.
    for (const d of DISCIPLINES) {
      expect(draft[d]?.mode).toBe('perLevel');
      expect(draft[d]?.perLevel).toEqual({ 'lvl-a': '10' });
    }
    // The migration notice (rendered by EventWizard) is driven off the RAW
    // `total` field directly, never off this draft — confirm it's simply
    // absent from every discipline draft entry, matching capacityConfigFromDraft's
    // shape (which has no `total` key at all).
    expect(Object.keys(draft)).not.toContain('total');
  });

  it('a legacy bare-number perDiscipline entry survives when there is no legacy perLevel map', () => {
    const legacy: CapacityConfigRaw = { perDiscipline: { TNT: 25 } };
    const draft = capacityDraftFromEvent(legacy, DISCIPLINES);
    expect(draft.TNT).toEqual({ mode: 'discipline', cap: '25', perLevel: {} });
    expect(draft.WAG).toEqual({ mode: 'none', cap: '', perLevel: {} });
  });

  it('capacityConfigFromDraft omits "none"-mode disciplines and drops blank cap inputs', () => {
    const draft: CapacityDraft = {
      TNT: { mode: 'none', cap: '999', perLevel: {} }, // stray leftover value from a mode switch — must not leak
      WAG: { mode: 'discipline', cap: '', perLevel: {} }, // blank cap under 'discipline' mode: dropped, not written as 0/NaN
      MAG: { mode: 'discipline', cap: '30', perLevel: {} },
    };
    const config = capacityConfigFromDraft(draft);
    expect(config).toEqual({ perDiscipline: { MAG: { mode: 'discipline', cap: 30 } } });
  });

  it('capacityConfigFromDraft returns undefined (drop capacity entirely) when every discipline is "none"', () => {
    const draft = capacityDraftFromEvent(undefined, DISCIPLINES);
    expect(capacityConfigFromDraft(draft)).toBeUndefined();
  });
});

describe('validateCapacityDraft — whole-number-only inputs', () => {
  it('rejects 0 for a discipline-mode cap', () => {
    const draft: CapacityDraft = { TNT: { mode: 'discipline', cap: '0', perLevel: {} } };
    const errors = validateCapacityDraft(draft, emptyUsage);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ discipline: 'TNT', kind: 'invalid' });
  });

  it('rejects negative and fractional discipline-mode caps', () => {
    for (const bad of ['-5', '2.5', 'abc', '']) {
      const draft: CapacityDraft = { TNT: { mode: 'discipline', cap: bad, perLevel: {} } };
      const errors = validateCapacityDraft(draft, emptyUsage);
      expect(errors).toHaveLength(1);
      expect(errors[0].kind).toBe('invalid');
    }
  });

  it('accepts a positive whole number with no usage conflict', () => {
    const draft: CapacityDraft = { TNT: { mode: 'discipline', cap: '10', perLevel: {} } };
    expect(validateCapacityDraft(draft, emptyUsage)).toEqual([]);
  });

  it('rejects a 0/negative/fractional per-level cap the same way', () => {
    const draft: CapacityDraft = { WAG: { mode: 'perLevel', cap: '', perLevel: { 'lvl-a': '0' } } };
    const errors = validateCapacityDraft(draft, emptyUsage);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ discipline: 'WAG', levelId: 'lvl-a', kind: 'invalid' });
  });

  it('requires at least one filled level cap when mode is perLevel', () => {
    const draft: CapacityDraft = { WAG: { mode: 'perLevel', cap: '', perLevel: { 'lvl-a': '' } } };
    const errors = validateCapacityDraft(draft, emptyUsage);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ discipline: 'WAG', kind: 'invalid' });
    expect(errors[0].levelId).toBeUndefined();
  });

  it('mode "none" is never validated regardless of stray cap/perLevel values', () => {
    const draft: CapacityDraft = { TNT: { mode: 'none', cap: '0', perLevel: { x: '-1' } } };
    expect(validateCapacityDraft(draft, emptyUsage)).toEqual([]);
  });
});

describe('validateCapacityDraft — below-usage refusal (exact message data)', () => {
  it('refuses a discipline-mode cap set below current usage, with the exact count in the message', () => {
    const draft: CapacityDraft = { TNT: { mode: 'discipline', cap: '5', perLevel: {} } };
    const usage: CapacityUsageForValidation = { perDiscipline: { TNT: 8 }, perDisciplineLevel: {} };
    const errors = validateCapacityDraft(draft, usage);
    expect(errors).toEqual([
      { discipline: 'TNT', kind: 'below-usage', used: 8, message: "Can't set below current 8 registered routines for T&T" },
    ]);
  });

  it('allows a discipline-mode cap set exactly at current usage', () => {
    const draft: CapacityDraft = { TNT: { mode: 'discipline', cap: '8', perLevel: {} } };
    const usage: CapacityUsageForValidation = { perDiscipline: { TNT: 8 }, perDisciplineLevel: {} };
    expect(validateCapacityDraft(draft, usage)).toEqual([]);
  });

  it('refuses a per-level cap set below current usage, resolving the level name via the passed-in resolver', () => {
    const draft: CapacityDraft = { WAG: { mode: 'perLevel', cap: '', perLevel: { 'lvl-silver': '3' } } };
    const usage: CapacityUsageForValidation = {
      perDiscipline: {},
      perDisciplineLevel: { WAG: { 'lvl-silver': 5 } },
    };
    const errors = validateCapacityDraft(draft, usage, (id) => (id === 'lvl-silver' ? 'WAG Silver' : id));
    expect(errors).toEqual([
      { discipline: 'WAG', levelId: 'lvl-silver', kind: 'below-usage', used: 5, message: "Can't set below current 5 registered routines for WAG Silver" },
    ]);
  });

  it('defaults the level resolver to the raw levelId when none is passed', () => {
    const draft: CapacityDraft = { WAG: { mode: 'perLevel', cap: '', perLevel: { 'lvl-x': '1' } } };
    const usage: CapacityUsageForValidation = { perDiscipline: {}, perDisciplineLevel: { WAG: { 'lvl-x': 4 } } };
    const errors = validateCapacityDraft(draft, usage);
    expect(errors[0].message).toBe("Can't set below current 4 registered routines for lvl-x");
  });
});
