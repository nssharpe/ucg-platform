# Accessibility audit — WCAG 2.1 AA (+ loading/empty/error-state consistency)

**Date:** 2026-08-04 · **Scope:** `docs/whats-next.md` §3.2 · **Status:** audit complete;
**A1–A6 FIXED and re-verified** (see §0). A7 + the shared state components remain open.

Method: `axe-core` 4.12.1 run in-page against the dev server (`wcag2a, wcag2aa, wcag21a,
wcag21aa`) across 12 routes as athlete AND admin, plus manual keyboard/focus/ARIA probing and a
375px reflow pass. Every finding below was confirmed by hand; three candidate findings were
**rejected as measurement artifacts** and are listed in §6 so nobody re-reports them.

---

## 0. Outcome of this pass

| # | Finding | Status | Evidence (re-run after the fix) |
| --- | --- | --- | --- |
| A1 | `Field` label not associated | **FIXED** | `/me` axe **13 critical → 0**; unnamed controls **19/33 → 3/33** |
| A2 | Nav group label 3.58:1 | **FIXED** | now `rgba(219,235,237,0.6)` = **5.21:1**; contrast violations gone on all 9 routes |
| A3 | Coral validation text 3.66:1 | **FIXED** | new `--coral-text` #bd3f27 = **5.24:1**, 46 call sites migrated |
| A4 | Modal has no dialog semantics | **FIXED** | `role=dialog` + `aria-modal` + title resolves "New club"; focus moves in; Tab from last **wraps to first**; Escape closes |
| A5 | Score stepper focus ring | **FIXED** | `:focus-visible` outline replaces the bare `outline:none` |
| A6 | 375px reflow | **FIXED** | `/admin/communicate` scrollWidth **536 → 375**; no app overflow at 375/768/1280 |
| A7 | Loading states not announced | **OPEN** | 35 sites; needs the shared `LoadingState` below |
| §3 | Shared empty/loading components | **OPEN** | deliberately deferred — cleanup, not a launch gate |

Residual after A1: 3 controls on `/me` (Undergrad graduation year, Training state, Main club)
are still unnamed by strict checking. axe passes them because their `placeholder` supplies a weak
name. They sit inside an extra wrapper `<div>` so `Field` cannot see a labelable child — they need
an explicit `aria-label` at the call site.

---

## 1. Method notes that change how you read these numbers

Two things make a naive axe sweep under-report on this app. Both bit this audit before being
caught, so they are written down rather than left as tribal knowledge.

1. **Pages load data asynchronously.** A 1.2 s settle produced "0 violations" on `/me`; a 3 s
   settle on the same route produced **13 critical violations**. The form simply had not rendered
   yet. Any future sweep must wait for content, not for the route.
2. **CSS transitions poison computed styles.** Sampling during `.nav-link`'s
   `transition: background 0.12s` reported the *Home* link as coral-on-pale (2.45:1) — a defect
   that does not exist. Inject
   `*,*::before,*::after{transition:none!important;animation:none!important}` before auditing.

Reproduce the harness:

```bash
npm run dev
```

Then in the page console: fetch `/ucg-platform/node_modules/axe-core/axe.min.js`, `eval` it, and
run `axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a','wcag2aa','wcag21a','wcag21aa'] } })`.

---

## 2. Findings — ranked by (severity × reach)

### A1 · `Field` renders a label that is not associated with its control — **CRITICAL, systemic**

`src/components/ui.tsx:171`. The `<label>` is a **sibling** of `{children}` and carries no
`htmlFor`; the control gets no `id`. The label is visible but programmatically inert, so screen
readers announce "edit text, blank" for a field the sighted user sees as "First name".

- WCAG **1.3.1 Info and Relationships (A)**, **4.1.2 Name, Role, Value (A)**.
- Measured on `/me`: **19 of 33 controls have no accessible name**, all inside `.field`.
- axe: `label` (7) + `select-name` (6) on `/me`; also `/clubs`, `/membership`,
  `/admin/members`, `/admin/communicate`, `/admin/finance`.
- **Reach: 248 `<Field>` usages across 25 files.** One component fix carries all of them.

Fix: give `Field` a `useId()`, put `htmlFor` on the label, and pass the id down. `Combo` already
accepts an `id` prop (`ui.tsx:94`), so custom children are covered too — but `Field`'s children
are arbitrary, so the id must be injected via `cloneElement` for native controls with a
documented fallback (`aria-label`) for the multi-control cases.

### A2 · Nav group labels fail contrast — **SERIOUS, every page**

`.nav-group-label` (`index.css:153`) is `rgba(219,235,237,0.45)` on `--navy-800` = **3.58:1** at
10px. AA needs 4.5:1. Affects "Browse", "My UCG", "Sanctioning", "League" on every route.

- WCAG **1.4.3 Contrast (Minimum) (AA)**.
- Computed candidates on the real background: alpha `0.55` → 4.66:1, **`0.60` → 5.21:1**,
  `0.65` → 5.88:1. Recommend **0.60** — comfortably clear of AA while still reading as muted.

### A3 · Validation/hint text in `--coral-600` fails contrast — **SERIOUS**

`#e2553b` on `--surface` `#fcfcfc` = **3.66:1** at 12px (seen on `/me`: "Pick a club, or check
'No club'."). This is *error* copy — the text a user most needs to read.

- WCAG **1.4.3 (AA)**.
- Computed: `#c8442c` → 4.74:1 (bare pass), **`#bd3f27` → 5.24:1** (recommended),
  `#b23a22` → 5.81:1. Add a dedicated `--coral-text` token rather than darkening `--coral-600`
  itself, which is used as a **fill** elsewhere and must not shift.

### A4 · `Modal` has no dialog semantics, no focus management, no Esc — **SERIOUS**

`src/components/ui.tsx:64`. Verified live by opening the "+ New club" modal:

| Expectation | Observed |
| --- | --- |
| `role="dialog"` / `aria-modal="true"` | **absent** |
| labelled by its own title | **absent** (`aria-labelledby` null) |
| focus moves into the dialog on open | **no** — focus stayed on `a.brand-mark` outside it |
| Escape closes | **no** — modal still open after a real Escape keypress |
| focus trapped while open | **no** — 3 Tabs put focus on `a.nav-link` "Events" *behind* the modal |

- WCAG **4.1.2 (A)**, **2.4.3 Focus Order (A)**; Esc is 2.1.2-adjacent best practice.
- **Reach: 33 `<Modal>` usages across 18 files.** The drawer in `Layout.tsx:101` already does Esc
  correctly — copy that pattern.

### A5 · Score stepper removes the focus ring with no replacement — **SERIOUS**

`index.css:779` — `.sp-stepper input:focus { outline: none; }` and nothing takes its place. Used
by judge score entry (`src/components/scoring/parts.tsx:31`).

- WCAG **2.4.7 Focus Visible (AA)**.
- Contrast with the other two `outline:none` rules (`index.css:515`, `:721`), which *do* swap in a
  coral border + glow and are therefore acceptable. This one is a plain removal.

### A6 · Two-column compose grid does not reflow at 375px — **SERIOUS**

Confirmed visually at 375×812: the Message card is cut off mid-input (document scrollWidth 536 vs
client 375). Root cause is an **inline** style — `style={{ display:'grid',
gridTemplateColumns:'1fr 1fr' }}` — which the `@media (max-width:860px)` rules cannot override.
`1fr` defaults to `min-width:auto`, so the columns refuse to shrink below their content.

- WCAG **1.4.10 Reflow (AA)**.
- This is the residual logged in §3.1 as "pre-existing 375px overflow on admin Communicate's
  compose card" — now root-caused. It is **not** unique to that card: the same inline pattern
  appears **5 times across 3 files** (`admin/Communicate.tsx:309,557`, `admin/league/Promos.tsx`,
  `EventCommunicate.tsx`).
- Fix: a real CSS class that collapses to one column under the breakpoint, plus `min-width: 0` on
  the grid children.

### A7 · Loading states are invisible to assistive tech — **MODERATE**

`Loading…` appears **35 times**, hand-rolled at every site (`<p>`/`<div>` with a muted inline
style) and **never** wrapped in a live region. A screen-reader user hears nothing when content
swaps in.

- WCAG **4.1.3 Status Messages (AA)**.
- ✅ **Toasts are already correct** and should not be "fixed": `ToastProvider` sets
  `role={variant === 'error' ? 'alert' : 'status'}` (`ui.tsx`). That accounts for 4 of the app's 6
  live-region attributes. Minor note: the role arrives on the same render as the text, which some
  older AT handles less reliably than a pre-existing region — low priority.

---

## 3. Loading / empty / error-state consistency (the §3.2 second half)

There is **no shared state component** — no `EmptyState`, no `Spinner`; only `PageFallback` (5
uses) for route-level suspense. Consequences:

- **Loading:** the *string* is consistent (`Loading…`, 35×) but the *markup* is not — variously
  `<p style={{fontSize:13}}>`, `<p style={{fontSize:13.5}}>`, `<div style={{padding:40}}>`,
  `MUTED_NOTE_STYLE`. No spinner anywhere; no skeleton; no live region (→ A7).
- **Empty:** ~30 distinct hand-written phrasings with no shared voice — terminal punctuation is
  inconsistent ("No athletes" vs "No managers yet." vs "No add-on purchases yet."), and only some
  tell the user what to do next ("No awards yet — enter scores and set cutoffs." is the good
  pattern; "No athletes" is the bare one).
- **Error:** no shared inline-error presentation; `ErrorBoundary` covers crashes, toasts cover
  transient failures, but a failed *section* load has no house style.

**Recommendation (not yet built):** add `EmptyState` / `LoadingState` to `ui.tsx` — `LoadingState`
carrying `role="status"` fixes A7 by construction, and `EmptyState` taking a required
`action`/`hint` prop makes the helpful variant the default. Migrate opportunistically; this is
cleanup, not a launch gate.

---

## 4. What passed

Worth recording so it is not re-litigated: no violations of heading order, landmarks, image alt,
link name, list structure, `html[lang]`, or duplicate ids on any route swept. `/events`,
`/results`, `/cart`, `/me/registrations`, `/me/purchases`, `/admin/clubs`, `/admin/league`,
`/admin/errors`, `/admin/refunds` and the three event-detail routes were clean apart from the
global A2. Toasts (A7) and the mobile drawer's `aria-label`/`aria-expanded`/Esc are correct.

## 5. Tooling

`axe-core` added as a devDependency. **`eslint-plugin-jsx-a11y` could NOT be added:** its latest
release (6.10.2) declares `peer eslint@"^3 || … || ^9"` and this repo is on **eslint 10.8.0**. No
published version supports it. Forcing it with `--legacy-peer-deps` would put an unsupported
plugin in the lint path that CI runs as a deploy gate — not worth it. **Re-check when jsx-a11y
ships eslint-10 support**; it is the cheapest way to stop A1-class regressions at the source.

## 6. Rejected — do not re-report

1. **"Active nav link is coral-on-pale, 2.45:1."** Artifact of sampling mid-transition. The CSS
   (`index.css:177`) is navy-on-coral **4.78:1** and correct; a screenshot confirms it renders
   right. This is the S1 fix from §3.1 working as intended.
2. **"Stripe iframes cause horizontal overflow."** `__privateStripeController*` iframes are
   appended to `<body>` with `min-width:100%` and do inflate `scrollWidth`. They are hidden
   third-party plumbing outside `#root`; the *user-visible* overflow at 375px is A6, proven
   independently by screenshot.
3. **"Enter/Space does not activate buttons."** Not verifiable through this harness and almost
   certainly false. Synthetic keys arrive **trusted** (a `keydown` with `key:"Enter"` was captured
   on the focused button) but do not trigger default activation — the "Return" variant arrived
   with an empty `key`. Tab navigation and `:focus-visible` **do** work, so the §3.1 residual
   "the Browser pane could not deliver OS-level keystrokes" is now **partly** resolved: focus
   movement is testable, activation is not. The controls are real `<button>`s with default
   `tabIndex`, so activation is spec-guaranteed; a human tab-through remains the only way to
   confirm.

---

## 7. Suggested order

1. **A1** — one component, largest reach, unblocks the rest of the form story.
2. **A2 + A3** — token-level contrast, minutes each, zero behavioural risk.
3. **A4** — `Modal`, second-largest reach; needs care (focus restore on close).
4. **A5 + A6** — small and local.
5. **A7 + §3** — the shared `LoadingState`/`EmptyState`; do with, not before, the others.
