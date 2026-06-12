# Native score entry — design & plan (2026-06-12)

Replaces the iframe+postMessage calculators with a fully integrated, UCG-branded
score-entry experience. The scoring logic of all six calculators is absorbed into
pure TypeScript engines; the judge UI renders native React panels styled with the
app's design system.

## Why

The bundled calculators (jQuery/Bootstrap, NAIGC-branded, each with its own look)
were embedded verbatim via iframes + a DOM-scraping bridge. That was the right
architecture while they were treated as opaque legacy artifacts; this task ports
the *logic* so the UI can be redesigned. Wins: one visual language, no iframe
height/scroll awkwardness on tablets, no apparatus/level selectors (the judge
context pins them), typed state instead of DOM-index serialization, testable
pure scoring functions.

## Architecture

```
src/scoring/                     pure TS, no React
  types.ts        ScoringOutcome, Breakdown, shared helpers (round3)
  mag.ts          MAG SV engine (rulesets: FIG, NAIGC Dev/Int/Adv; VT value table)
  masters.ts      Masters engine (WAG+MAG, age decades, vault tables) — full D/E/Final
  wagOpen.ts      WAG Open routine engine (top-8 skills, EG bonus) — full
  wagVault.ts     WAG Open vault table engine — full
  wagSv.ts        Xcel/L9 start-value engine — SV only
  tnt.ts          T&T engine (TR/DM/TU, level rules, CJP) — full
  ttSkills.ts     T&T DD chart data (ported from public/calculators/tt-skills.js)
  index.ts        kind dispatcher: initScoring / computeScoring

src/components/scoring/
  parts.tsx       shared UCG primitives: Stepper, ChipGroup, ScoreStrip, WarnBox
  MagPanel.tsx ... TntPanel.tsx   one controlled panel per engine
  ScoringPanel.tsx                kind → panel dispatcher
```

### Engine contract

Each engine exports a JSON-serializable `State`, plus:

- `init(levelId, eventCode): State`
- `compute(state, levelId, eventCode): ScoringOutcome`

```ts
interface ScoringOutcome {
  d: number | null;        // SV / D-score
  e: number | null;        // E-score (full producers only)
  final: number | null;    // full producers only
  produces: 'd' | 'full';
  breakdown: { label: string; value: number }[]; // signed values, for review UI
  warnings: string[];      // rule violations / cap notices
}
```

Panels are controlled components: `{ levelId, eventCode, value, onChange }` —
no internal scoring state. The parent computes the outcome via `computeScoring`
and renders the score strip + post button, so Judge and ScoreDetail share the
exact same panel.

### calcState v2 + legacy compatibility

Posted scores store `calcState = { v: 2, kind, state }`. Old scores hold the
bridge's `{ fields, selected }` DOM snapshot; ScoreDetail keeps the iframe
`CalcPanel` path for those (read/adjust exactly as before), and uses the native
panel when `calcState.v === 2` (or when there is no state and the level maps to
an engine). `public/calculators/` stays in place for legacy scores and
standalone use; nothing else embeds it for new entry.

### Judge flow

- Same meet/session/event pickers and roster table.
- Scoring card: athlete header → native panel → score strip (D / E / Final or
  SV + deductions inputs) → "Post & flash".
- `produces: 'd'` engines (MAG, Xcel/L9 SV) stream SV into the judge form;
  the judge types total deductions as today. `produces: 'full'` engines own
  deductions internally (Open, Masters, T&T, vaults).
- Manual override unchanged: hides the panel, judge types SV/deductions; source
  is then `'manual'`.
- Masters: discipline pinned MAG (the only masters level is `mag-masters`;
  engine retains WAG for future), age-decade selector in the panel, prefilled
  from athlete DOB when ≥30.

## Fidelity & intentional divergences

Engines replicate the originals' math, including rounding, with these fixes
(all are bugs in the originals, worth reporting to rules@naigc.org):

1. **MAG 4-per-EG rule double count** — original adds an EG's top-4 skill
   values a second time when >4 skills share an EG. Engine counts each
   included skill once and excludes beyond-4 skills (the rule's clear intent;
   excluded chips still shown red).
2. **MAG FIG short-exercise** — `count === 0 → 10` branch is unreachable
   (8 was applied). Engine applies 10 at zero skills under FIG.
3. **MAG vault no-credit checkbox** — original sets a flag it never reads.
   Engine zeroes the vault SV and warns.
4. Display precision standardized (3dp finals via `fmtScore`) instead of the
   originals' type-three-decimals-to-see-three behavior.

## Plan

1. Spec + scaffolding (this doc, `src/scoring/types.ts` + `index.ts` stubs,
   `parts.tsx`, CSS additions) — coordinator.
2. Four parallel porting agents (no file overlap):
   A: `mag.ts` + `MagPanel.tsx`
   B: `masters.ts` + `MastersPanel.tsx`
   C: `wagOpen.ts`/`wagVault.ts`/`wagSv.ts` + their panels
   D: `ttSkills.ts`/`tnt.ts` + `TntPanel.tsx`
3. Integration — coordinator: `ScoringPanel.tsx`, rework `src/lib/calculators.ts`
   (kind/label/produces only; keep legacy iframe config for old calcState),
   Judge.tsx, ScoreDetail.tsx.
4. Verify: tsc + build, then prod-preview sweep across every level × event
   comparing native panels against the legacy calculators on sample routines.
5. Commit, push, confirm deploy.
