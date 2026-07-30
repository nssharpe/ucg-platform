---
paths:
  - "src/**/*.tsx"
  - "src/**/*.css"
  - "src/index.css"
  - "src/assets/brand/**"
---

# Brand tokens, layout, and UI traps

Authoritative brand rules + palette + approved fg/bg pairings:
`docs/specs/2026-07-08-ucg-rebrand.md`. Toolkit source (fonts, PDFs, photography):
`C:\Users\nssha\Steinsharpe Dropbox\...\2026 UCG Brand Toolkit`.

The general readable-contrast requirement lives in user-level instructions and is not repeated
here. What follows is UCG-specific.

## Tokens and type

- Exact hexes live as tokens in `src/index.css`. Use tokens, never literal hexes.
- **Pale accents `--bluegreen` / `--purple` / `--gold` are FILLS ONLY — never text on light.**
- Display type = Greed Condensed Bold, ALL CAPS. Body = Suisse Intl.
- **Licensed woff2 files are served from the public `brand` Supabase Storage bucket (prod) and
  must NEVER be committed to this public repo** (EULA — web serving is permitted, repo
  redistribution is not). @fontsource Archivo Black / Instrument Sans stay installed as
  fallbacks.
- Logos and discipline icons: `src/assets/brand/` (`DisciplineIcon.tsx` maps MAG/WAG/TNT).

## Responsive contract

Breakpoint lives in `Layout.tsx` + `index.css` `@media (max-width: 860px)`.

Any layout/CSS/topbar/nav change MUST be verified — the procedure is the **`responsive-sweep`
skill**. Requirements it checks: no horizontal overflow (`scrollWidth` ≤ `clientWidth`) at
375/768/1280 (spot-check 1440), topbar ≤ 2 lines, legible contrast, and below 860px the nav
drawer opens/closes (hamburger → overlay → Esc → link-tap).

## Topbar membership badges

`TopbarMembership` self-fits by **direct layout observation** (ResizeObserver): render inline,
stack only if the user chip wrapped (`name.top - crumb.top > 6`). Width *estimation* was tried
and abandoned — **do NOT reintroduce it.** Stacked pinning is coach-left / athlete-right via CSS
`order`.

With dev auto-login active the badges render normally, so verify directly. Only when
`VITE_DEV_AUTH_*` are blank should you inject a worst-case topbar via `preview_eval`.

## ESLint traps

- No component defined inside another component's render — extract to module scope.
- No synchronous `setState` in a `useEffect` body.

## Launch configs (`.claude/launch.json`)

| Name | Port | Notes |
| --- | --- | --- |
| `ucg-dev` | 5173 | |
| `ucg-preview` | 5176 | `--strictPort`; serves `dist/` |
| `ucg-staging` | 5177 | `--mode staging` → staging Supabase via `.env.staging.local` |

If you run `vite preview` (serves `dist/`): rebuild first and clear the service worker, or it
serves the previous bundle.

`preview_click` can silently miss tiny or tightly-padded buttons — it reports success while the
handler never fires. Confirm with a direct JS `.click()` dispatch before concluding there's an
app bug.
