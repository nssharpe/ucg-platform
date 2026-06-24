# Topbar responsive layout, mobile drawer nav, and mobile dev pipeline

Date: 2026-06-24
Status: Design (approved for spec review)

## Problem

Three issues, all in `src/components/Layout.tsx` + `src/index.css`:

1. **Topbar wraps to two lines for dual-role users.** The membership-status badges
   (athlete + coach) render in a `flexDirection: column` wrapper at the far right of
   the topbar, so a person who is *both* an athlete and a coach gets two stacked
   badges that push the topbar to two lines. They should sit to the **left of the
   Cart** and stay on one line when there's room.
2. **Badges don't fit on narrow/mobile widths.** Rather than hide them outright, the
   topbar should shed detail progressively as space tightens (see Degradation).
3. **Sidebar is unusable on mobile.** Below 860px the sidebar collapses into a large
   wrapping horizontal block at the top of the page — especially tall for admins with
   every nav group. It should become an off-canvas **drawer** behind a hamburger
   button.

A fourth, process issue: **the dev workflow doesn't verify mobile/tablet**, so
regressions like the above ship unnoticed.

## Goals

- Topbar stays one line whenever the real content fits; badges sit left of the Cart.
- When it doesn't fit, degrade **content-awarely** (measured, not fixed breakpoints)
  because user-name length varies widely and changes the available room.
- Mobile nav is hidden by default and opens as a drawer.
- Establish a repeatable way to catch mobile/tablet regressions.

## Non-goals

- No redesign of the badge visuals, colors, or copy (beyond shedding pieces).
- No change to *what* membership statuses are shown or how they're computed
  (`membershipBannerItems` logic in `Layout.tsx` stays as-is).
- No Playwright/CI automation built now — only a written follow-up plan (Part 4).

## Part 1 — Topbar reorder + measurement-driven degradation

### Layout order

New left-to-right order on a roomy screen:

```
← Back · {crumb} ···········(flex spacer)··········· [Coach][Athlete] · 🛒 Cart · NS Name
```

The membership badge group moves from last child to **before** the Cart link in the
DOM, and its wrapper changes from `flexDirection: column` to a horizontal row.

### Why measurement, not breakpoints

Fixed `@media` breakpoints can't account for name length: "Nate Sharpe" leaves less
room than "Bo Li", so the width at which the topbar overflows is content-dependent.
Pure CSS `flex-wrap` could drop the badges to a second line content-awarely, but only
if the badges are the *last* flex item — which conflicts with the "badges left of
Cart when inline" requirement. So the fit decision is measured in JS.

### The fitter component

Extract the topbar's membership area into a self-contained component (working name
`TopbarMembership`) that owns its own fit logic:

- Renders the badge group plus refs to the topbar row and the badge row.
- A `ResizeObserver` on the topbar element re-runs the fit calc whenever the topbar's
  width changes (window resize, rotation, drawer open). It does **not** run on scroll
  or idle.
- Fit calc runs in `useLayoutEffect` (before paint → no flicker) and is throttled
  with `requestAnimationFrame` so a drag-resize coalesces to one measurement/frame.
- Guard: skip recomputation when neither the measured width nor the badge content
  (name, badge set) has changed since the last run.

### Degradation ladder

Computed each fit pass, escalating only while the real pixels still overflow:

1. **Inline.** Badges left of Cart, single line, full detail. Chosen when
   `topbar.scrollWidth <= topbar.clientWidth`.
2. **Stacked.** Overflow → badge group moves to its own full-width second row,
   **coach pinned left, athlete pinned right** via `justify-content: space-between`.
   The athlete badge also carries `margin-left: auto` so it pins right even when it's
   the *only* badge.
3. **Shed link.** If the stacked badge row itself overflows
   (`row.scrollWidth > row.clientWidth`), drop the trailing `· purchase now` /
   `· details` link from each badge (status text remains). Re-measure.
4. **Shed season.** Still overflowing → drop the season name (`2025–26`) from the
   badge text. Re-measure.

Each step is gated on actual overflow, so a single-badge user with a short name may
never leave step 1, while a dual-role user with a long name on a phone reaches step 4.
No badge is ever removed entirely.

### Markup hooks needed

To shed pieces, the existing badge JSX wraps two spans the fitter can hide via a
state-driven class/`data-` attribute:

- `season.name` → `<span class="mb-season">2025–26 </span>`
- the trailing `· <Link>purchase now</Link>` / `· <Link>details</Link>` →
  `<span class="mb-link"> · …</span>`

Stack vs inline and the two shed levels are applied as classes/data attributes on the
fitter root; CSS toggles `display` on `.mb-season` / `.mb-link` and switches the badge
row between inline and full-width-`space-between`.

### Performance note

Measurement cost is negligible (a few layout reads on one small element, only on
resize). Caching thresholds per user was considered and rejected: the outcome depends
on viewport width *and* name width, so a cache would still have to compare the live
viewport on every resize — i.e. the observer's existing work plus extra state to
invalidate. Premature optimization; not included.

## Part 2 — Mobile drawer nav

Replace the current `@media (max-width: 860px)` rule that turns `.sidebar` into a
wrapping horizontal block.

- **Below 860px:** `.sidebar` becomes `position: fixed`, full-height, off-screen
  (`transform: translateX(-100%)`), above content (`z-index` over the topbar). A
  hamburger button appears at the **far left of the topbar** (before Back/crumb),
  shown only below 860px.
- **Open state** lives in `Layout` (`useState`). Opening sets `translateX(0)` and
  renders a dimmed full-screen overlay behind the drawer.
- **Closes on:** overlay click, `Esc` key, and route change (`useLocation` effect) so
  tapping any nav link dismisses it.
- The existing sidebar markup (brand block, nav groups, role card) is reused
  unchanged — only positioning, the `open` class, the overlay, and the toggle are new.
- **Accessibility:** hamburger has `aria-label="Open menu"` /
  `aria-expanded={open}` and controls the sidebar via `aria-controls`. `Esc` closes.
  Body scroll lock while open is optional polish (include if cheap).
- Desktop (≥860px) is unchanged: static sidebar, no hamburger, no overlay.

## Part 3 — Mobile dev pipeline (convention now)

Adopt canonical viewports and bake a responsive check into the verification workflow:

- **Phone 375px**, **Tablet 768px**, **Laptop 1280px**.
- After any change that touches layout/CSS/topbar/nav, verify at all three via
  `preview_resize` + a `preview_screenshot`, and confirm: no horizontal overflow,
  topbar is one line (or degrades cleanly), text stays legible (contrast), and the
  drawer opens/closes on mobile widths.
- Document this as a short "Responsive verification" subsection in `CLAUDE.md` (Build
  / tooling or a new Responsive section) so it's part of the standing process, not a
  one-off.

## Part 4 — Playwright responsive tests (follow-up plan, not built)

Write a short plan to `docs/plans/` (do **not** implement now) covering: add Playwright
with a `chromium` project at the three canonical viewports; screenshot the high-traffic
pages (Home, Profile, a club page, an admin page) at each; wire into the GitHub Actions
deploy workflow as a non-blocking (initially) job; decide snapshot-baseline storage.
Flag the cost: first browser-based tests in a currently node-only suite (Playwright
download, CI time, baseline churn).

## Files touched

- `src/components/Layout.tsx` — extract `TopbarMembership` fitter; reorder topbar;
  add hamburger + drawer open state + overlay + close-on-route/Esc.
- `src/index.css` — topbar badge row (inline/stacked/shed classes), drawer positioning
  + overlay, hamburger button, replace the 860px sidebar block rule.
- `CLAUDE.md` — Responsive verification convention.
- `docs/plans/2026-06-24-playwright-responsive-tests.md` — Part 4 follow-up plan.
- `docs/README.md` / this spec index as needed.

## Testing

No pure-logic changes, so no new Vitest coverage. Verification is the Part 3
responsive sweep at 375 / 768 / 1280, plus a dual-role + long-name manual check to
exercise all four degradation steps, and a drawer open/close check on mobile widths.
```
