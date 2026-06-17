# Nationals finals-qualification & awards — implementation status

**Date:** 2026-06-13 (updated 2026-06-14) · **Status:** Phases 0–5 + adapter built. Engine verified to
parity; full app typechecks, 57 tests pass, lint clean on new files, browser pipeline verified. Remaining:
apply migration 0006 to the live DB + interactive admin-UI walkthrough by a signed-in admin.
**Spec (authoritative ruleset):** [`docs/specs/2026-06-13-nationals-qual-awards.md`](../specs/2026-06-13-nationals-qual-awards.md).

## Goal
Fold the Nationals finals-qualification + awards logic — currently run via Jules Pierce's Python
tool (`jules-pierce/naigc-2024`, pandas+pptx) the night before finals — into the platform as a native
TS engine behind an admin-only **"Nationals" meet type**. Approach: port the *logic* natively; Jules's
repo stays a read-only reference (read via `gh`, nothing vendored). Scope = **full parity** incl.
Decathlon/Omnithon, awards deck, and the validation report. Cutoffs ("blue numbers") are admin-editable
config on the meet.

## Done — Phase 0: spec + golden fixtures
- `scripts/extract_nationals_fixtures.py` pulls Jules's **2024 & 2025** inputs + known-good
  `solutions/*.xlsx` + `config.ini` into `tests/fixtures/nationals/*.json` (committed — the parity
  oracle). The `.jtmp/` download cache is gitignored.
- `docs/specs/2026-06-13-nationals-qual-awards.md` distills the full ruleset so the Python never needs
  re-reading.

## Done — Phase 1: data model + migration
- `src/lib/types.ts`: `Meet.kind` ('standard'|'nationals'), `Meet.nationalsConfig`, `MeetSession.phase`
  ('prelim'|'final'), `Score.scratched`, and the `NationalsConfig` / `PlacementCategory` types.
- `supabase/migrations/0006_nationals.sql`: `meets.kind` (enum) + `meets.nationals_config` (jsonb),
  `meet_sessions.phase`, `scores.scratched`. **NOT yet applied to the live DB.** No new RLS needed —
  meets/sessions already carry `admin_all` (is_admin()), so the new columns inherit admin-only writes.
- `src/lib/supabase.ts` row mappers updated (write + read) for all four fields.

## Done — Phase 2: pure engine + parity tests (the core)
- `src/nationals/` (platform-agnostic, node-testable like `src/scoring/`; barrel `index.ts`):
  `round`, `categories`, `placement` (tie-aware 1,2,2,4), `qualification` (blue numbers + 50%
  cross-club rule), `teams` (top-3 + mixed), `artistic` (orchestrator), `tnt`, `combined`
  (decathlon + omnithon), `awards` (assembly), `validation`.
- `tests/nationals/` — **18 parity tests** reproduce Jules's outputs EXACTLY for both years,
  prelims+finals, individual+team, TNT, decathlon/omnithon, and the validation report. Full suite
  **52 tests green**: `node node_modules/vitest/vitest.mjs run`. App typechecks clean.

### Porting gotchas that cost real debugging (keep in mind for the adapter)
1. **AA placement uses the SF-provided `AA_Score` verbatim**, not a recomputed event sum (validation
   flags sum≠provided separately).
2. Jules **strips all string cells on read** — club names have stray trailing spaces; must `.trim()`
   on ingest or team grouping silently breaks.
3. **Finals teams place only if they qualified in prelims** (Team?=Y filter); finals individuals are
   filtered by the per-event place-eligible flag.
4. **Round half-up on the shortest decimal string**, not float math (a 0.0005 diff flips placements).

### Reference-tool quirks to raise with Jules / rules@naigc.org
- **Omnithon has no real composite score** — its "Overall Score/Place" are just an eligibility boolean
  in the reference code. Reproduced for parity; needs a real definition to mean anything.
- The MAG-calculator bugs fixed during the native score-entry port are upstream of this logic and don't
  affect these fixtures.

## Done — adapter + Phases 3–5 (2026-06-14)
- **Adapter** `src/lib/nationals-adapter.ts`: `buildEntries` (Athlete/Registration/Score/MeetSession →
  engine `AthleteEntry`, keyed by platform levelId — no Jules-code map needed for live data),
  `platformCategory` (prefers `Athlete.placement` men+/women+, falls back to gender), `toEngineConfig`,
  `scaffoldNationalsConfig`, `computeArtisticDiscipline`, `computeNationals` (full bundle),
  `computeNationalsValidation`. Platform TNT def = TR/DM/TU (no synch), one level per reg. AA = event sum
  (no provided-AA divergence). Covered by `tests/nationals/adapter.test.ts` (5 tests).
- **Phase 3** `MeetWizard.tsx`: admin-only **Nationals** toggle → per-session prelim/finals selector +
  finals-levels picker; submit scaffolds `nationalsConfig`. `NationalsConfigEditor.tsx`: blue-number grid
  editor (AA/event/team per category per level + mixed + T&T + finals-levels), saves via mutate+pushMeet.
- **Phase 4** `src/pages/Nationals.tsx` (route `/meets/:slug/nationals`, linked from MeetDetail for
  nationals meets, gated to `isMeetHost`): tabs Config / Qualification (finals roster, 50%-rule pull-ins
  highlighted) / Awards (per event·level·category + team + Decathlon/Omnithon) / Validation (issue list).
- **Phase 5** `src/lib/awards-deck.ts`: `exportAwardsDeck` builds a print-ready HTML deck (one landscape
  "slide" per award set, UCG-branded) opened via Blob URL → print/Save-as-PDF. **Dependency-free** (no
  pptxgenjs — the build-fragile path made it not worth the risk; a true `.pptx` via pptxgenjs is a future
  upgrade keeping the same structure).

**Browser verification (Vite dev build):** engine/adapter/deck/page/editor modules all import & run in the
real browser runtime; full synthetic pipeline (computeNationals → roster → awards → deck HTML) works;
`roundScore(9.1255)=9.126` confirms half-up in-browser. Interactive admin-gated clicks NOT walked through
because the dev server runs in Supabase-configured guest mode (no admin sign-in available to the agent).

## Still TODO (handoff)
1. **(Human) Apply `0006_nationals.sql` to the live DB** via the Supabase SQL editor (monaco setValue
   gotcha — type a char before Run) before shipping the UI; without it, kind/nationals_config/phase/
   scratched won't persist remotely.
2. **Interactive admin walkthrough** (needs a signed-in admin — the agent couldn't authenticate): in
   prod-preview or as nssharpe, create a Nationals meet (toggle on, set prelim/finals sessions + finals
   levels), open `/meets/<slug>/nationals`, fill cutoffs in the Config tab, enter prelim + finals scores
   via the Judge flow, then confirm the Qualification roster, Awards tables, Validation list, and the
   awards-deck print export all look right. Cross-check a sample against the legacy tool.
3. **Wire computed quals into `Results.tsx` green highlighting** — currently Results uses the imported
   `Registration.quals`; for Nationals it could instead read the engine's computed quals. Optional polish.
4. **Finals score entry UX** — finals sessions use the existing Judge flow; consider a "scratch" toggle
   in score entry to set `Score.scratched` (the data model + engine already support it).
5. **Optional: true `.pptx` deck** via pptxgenjs (the current deck is print-to-PDF HTML — fully usable).
6. **Excluded-from-team status** — the engine supports an 'Excluded' apparatus status (scored
   individually, not on the team's top set); the platform only models Included/Scratched today. Add if
   Nationals needs the 5th-team-member nuance.

## Verification status
- `node node_modules/vitest/vitest.mjs run` → **57 tests pass** (18 engine parity + 5 adapter + existing).
- `tsc --noEmit -p tsconfig.app.json` clean; eslint clean on all new/changed files.
- Browser (Vite dev): all new modules import & execute; full synthetic compute→deck pipeline verified.

Engine entry points: `import { computeArtistic, computeTnt, computeDecathlon, computeOmnithon,
assembleArtisticAwards, validateArtistic, buildConfig } from 'src/nationals'`.
Adapter entry points: `import { computeNationals, computeNationalsValidation, scaffoldNationalsConfig }
from 'src/lib/nationals-adapter'`. UI: `src/pages/Nationals.tsx`, `src/components/NationalsConfigEditor.tsx`.
