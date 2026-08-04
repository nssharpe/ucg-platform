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

## Accessibility invariants (a11y audit 2026-08-04 — don't regress these)

Full report + method: `docs/specs/2026-08-04-accessibility-audit-wcag-aa.md`.

- **`Field` owns label association.** It generates a `useId()` and wires `htmlFor` → the first
  labelable child (native `input`/`select`/`textarea`, or `Combo`, which forwards `id`), including
  when `children` is an ARRAY (control + conditional "Required" divs). **A control NOT rendered
  through `Field` needs its own `aria-label`** — that's the only remaining gap class.
- **`Modal` is a real dialog:** `role="dialog"`, `aria-modal`, labelled by its own title, moves
  focus in, traps Tab at both ends, closes on Escape, restores focus to the opener. Don't
  hand-roll a veil+card; use `Modal`.
- **`--coral-text` (#bd3f27) is for coral TEXT on light surfaces** (5.24:1). `--coral-600` is
  3.66:1 there and must stay a **fill** — do not "unify" the two. On coral *fills*, text is
  `--navy-800`.
- **Never set `gridTemplateColumns` inline for a page layout.** A media query cannot override an
  inline style, which is exactly how admin Communicate stayed two-up at 375px. Use `.pane-2`, and
  prefer `minmax(0, 1fr)` over `1fr` — a bare `1fr` keeps `min-width:auto`, so columns refuse to
  shrink below their content and overflow anyway.
- **Removing a focus ring requires a replacement.** `outline: none` is only acceptable alongside a
  visible substitute (the coral border+glow on `.input:focus`), never bare.
- **Loading text still needs a live region** (open item A7) — 35 hand-rolled `Loading…` sites
  announce nothing. Toasts already handle this correctly via `role="alert"`/`"status"`.

Auditing: `axe-core` is a devDependency. Two traps that make a naive sweep lie — wait ~3s for
async page data (1.2s reported "0 violations" on a page that actually had 13), and disable
transitions first (`*{transition:none!important}`) or you'll measure mid-animation colors and
invent contrast failures. `eslint-plugin-jsx-a11y` is NOT installed: no release supports
eslint 10.

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
