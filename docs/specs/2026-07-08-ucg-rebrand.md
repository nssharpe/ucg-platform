# UCG Rebrand — 2026 Brand Toolkit integration

Source: `C:\Users\nssha\Steinsharpe Dropbox\Nate Sharpe\Documents\Misc\Gymnastics\NAIGC\2026 UCG Brand Toolkit`
(Design Guide PDF, Cheat Sheet, color swatches, licensed webfonts, logo/icon SVGs).
Approved by Nate 2026-07-08: real fonts hosted on Supabase Storage; scope = app UI +
email template + jsPDF docs + event icons. No B&W-photography treatment this pass.

## Palette (exact brand hexes)

Primary:
| Name | Hex | Notes |
|---|---|---|
| Navy Blue | `#1E2B38` | core dark; text on light surfaces; dark fills |
| Blue Green | `#A5C8CF` | muted accent fill (never text) |
| Light Blue | `#DBEBEE` | page background (current `--ice-200` ≈ this) |

Secondary:
| Name | Hex | Notes |
|---|---|---|
| Purple | `#ADBAE9` | pale accent fill (never text) |
| Red Orange | `#F4694A` | CTA/accent (current coral ≈ this) |
| Dark Blue Green | `#184B56` | dark accent; OK as text on white/light-blue |
| Golden Yellow | `#F6C328` | accent fill; never on light backgrounds as text |

### Approved color pairings (Design Guide 3.3.4/3.3.5) — HARD RULES
- Small text sizes, ONLY these: navy bg + (yellow | red-orange | white/light-blue);
  (yellow | purple | red-orange) bg + navy; white bg + (red-orange | dark-blue-green);
  light-blue bg + navy.
- Larger text additionally allowed: navy bg + (purple | blue-green);
  (blue-green | light-blue) bg + navy; white bg + (yellow | purple | blue-green) as
  graphics only — treat as fills, not text.
- NOT approved (any size): purple+yellow, yellow+anything-light, red-orange+purple,
  red-orange+dark-blue-green, red-orange+yellow, red-orange+blue-green, navy+dark-blue-green,
  blue-green bg + white/navy small text, light-blue + white, white + light colors.
- WCAG AA still applies on top of brand rules (CLAUDE.md hard requirement). The pale
  accents (blue-green, purple, yellow) are FILL colors: put navy text on them, never
  use them as text on light surfaces.
- **Applied 2026-07-19 — status badges/banners now use the `(yellow | purple |
  red-orange) bg + navy` small-text rule above** (previously ad hoc green-100/
  green-600, amber-100/amber-600, coral-100/coral-700 pairs unrelated to the brand
  palette): `.badge.ok`/`.member-banner.ok` → purple `--purple` (`#ADBAE9`) bg +
  navy `--navy-800` text (~7.5:1); `.badge.warn` → gold `--gold` (`#F6C328`) bg +
  navy text (~8.8:1); `.badge.err`/`.member-banner.warn` → red-orange `--coral-500`
  (`#F4694A`) bg + navy text (~4.8:1). All three AA-pass. See `src/index.css`.
- **Applied 2026-07-19 (second pass) — the remaining off-palette warning/success
  colors** (`--amber-100`/`--amber-600`, `--green-100`/`--green-600`, both retired,
  plus one `--coral-100`/`--coral-700` pairing) aligned to brand:
  - **New token `--gold-100` (`#FAEBBC`)** — a Golden Yellow tint, paired with
    default `--ink` (navy) text, ~12.2:1. Used for warning callout cards (season-
    mismatch notices in Club.tsx/Membership.tsx) and the scoring-panel warning box
    (`.sp-warn`, was coral-100/coral-600 at a failing 3.1:1 — now fixed).
  - **New token `--leaf` (`#C0E388`)**, from the Expressive palette (not the core
    guide), paired with `--teal-900` (Dark Blue Green) text, ~6.6:1. Used for the
    results qualification highlight (`.res-tbl td.res-qual`, `.res-qual-dot`) — was
    a failing 4.2:1 link-on-green; chosen deliberately as the one "add energy" case
    per the guide's own framing of the Expressive range, with the core-palette
    alternative (`--ice-200` + `--teal-900`, 7.8:1, loses the green "qualified"
    connotation) considered and declined by Nate.
  - **`--teal-900` (already-approved Dark Blue Green on white)** extended to every
    plain-text positive/success usage previously on the retired `--green-600`
    (`.sp-chip.contrib` fill+white-text flipped to teal-900 too; ~9.3:1).
  - RegistrationEditor's "registration refunded" alert: kept the `--coral-100`
    fill, swapped `--coral-700` text → `--navy-800` (~11.9:1) for consistency with
    the rest of the coral-100-fill callouts, which already used default ink text.
  - `Membership.tsx`'s admin-override button also had a pre-existing undefined-
    token bug (`var(--amber-700)`, never defined) discovered while retiring the
    amber family — fixed to `var(--warn)` (the kept freestanding-warning-text
    token, row 7 below) rather than left dangling.
- **Kept as a documented functional deviation:** `--warn` (`#B45309`) as
  freestanding warning TEXT with no fill (inline sentences on white cards) — no
  brand color passes AA as text-on-white at that role (Golden Yellow is ~1.6:1),
  and filling every such usage into a `--gold-100` card isn't always layout-
  appropriate. Revisit per-site if the guide's palette grows a usable amber.

## Typography

- **Display**: Greed Condensed Bold — headlines/subheads, ALL CAPS
  (`text-transform: uppercase`), tracking ≈ `0.02em`. Single weight (700).
- **Body**: Suisse Intl Regular/Bold (+ italics). (Cheat sheet mentions Semibold; web
  cuts shipped are Regular/Bold — use Bold for emphasis.)
- Licensed webfonts self-hosted on Supabase Storage (public `brand` bucket, prod
  project `wkyerxlgricfphopocoz`) — files must NEVER be committed to the repo (EULA
  redistribution). URLs:
  `https://wkyerxlgricfphopocoz.supabase.co/storage/v1/object/public/brand/fonts/<file>`
  where `<file>` ∈ `GreedCondensed-Bold.woff2`, `SuisseIntl-Regular.woff2`,
  `SuisseIntl-Bold.woff2`, `SuisseIntl-RegularIt.woff2`, `SuisseIntl-BoldIt.woff2`.
- `@font-face` in `index.css` with `font-display: swap`; preload links in `index.html`.
- Fallback stacks (from toolkit's "Comparable Google Font Options"):
  display `'Greed Condensed', 'Anton', 'Archivo Black', 'Arial Black', sans-serif`
  (keep @fontsource Archivo Black installed as offline/dev fallback);
  body `'Suisse Intl', 'Instrument Sans Variable', 'Instrument Sans', 'Helvetica Neue', sans-serif`.
- Emails and jsPDF documents do NOT embed the licensed fonts (client support /
  bundle-redistribution): emails keep system font stack, PDFs keep Helvetica.

## Logos & icons (staged in `src/assets/brand/`)

- `primary-logo[-white].svg` — stacked mark + UNITED CLUB GYMNASTICS.
- `secondary-logo[-white].svg` — UCG block + wordmark.
- `logotype[-white].svg` — horizontal UNITED CLUB GYMNASTICS wordmark.
- `mark[-white].svg` — standalone figure mark (favicon, small chrome).
- `event-icons/{mag1,mag2,wag1,wag2,tnt}.svg` — discipline icons, single-fill navy
  `#1E2B38` (recolor via CSS mask/currentColor if needed).
- Navy variants fill `#1e2b38`, white variants `#ffffff`.

## Design features to apply (Design Guide §2.2)

- ALL CAPS display type for headers; strong hierarchy (Greed 36–60pt headlines,
  10–24pt subheads scale ratio, Suisse 9–14pt body — web: keep current px scale,
  swap faces).
- Color fills as section/card accents; rounded corners (existing `--radius` idiom).
- Brand messaging available: tagline "For the love of the sport." / "Join the club".

## Existing → new token mapping (`src/index.css`)

- `--navy-800: #1d2a38` → `#1E2B38` (exact brand navy); keep the 900/700/600 ramp,
  re-derive from `#1E2B38`.
- `--ice-200: #dbebed` → `#DBEBEE` Light Blue; re-derive ice ramp.
- `--coral-500: #f46949` → `#F4694A` Red Orange; keep 600/700/100 ramp re-derived.
- NEW: `--bluegreen: #A5C8CF`, `--purple: #ADBAE9`, `--teal-900: #184B56`,
  `--gold: #F6C328` (+ any needed AA-safe text variants, e.g. dark-blue-green is the
  only new color usable as text on light).
- Keep all semantic tokens (`--bg`, `--surface`, `--ink`, `--warn`, `--line`, radii,
  shadows) — update values only where the brand changes them.

## Out of scope / preserved

- No dark mode. No photography treatment this pass.
- `_shared/email-layout.ts`: colors updated to exact palette (navy header, red-orange
  CTA), system fonts stay.
- jsPDF (receipt.ts etc.): brand colors, Helvetica stays.
- Supabase Auth email templates: initially left as a Nate/Dashboard action, then
  brought into the repo the same day — `scripts/render-auth-email-templates.mts`
  renders them from `_shared/email-layout.ts` and `supabase config push` applies
  (prod only; staging free-tier rejects template pushes). Runbook + traps:
  `supabase/README.md` "Auth email templates".
