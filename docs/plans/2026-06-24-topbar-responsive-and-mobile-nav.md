# Topbar Responsive Layout + Mobile Drawer Nav Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the topbar to one line by moving membership badges left of the Cart and shedding detail content-awarely as space tightens; replace the oversized mobile sidebar with an off-canvas drawer; and establish a mobile responsive-verification convention.

**Architecture:** A self-contained `TopbarMembership` component measures real element widths via a `ResizeObserver` and forced synchronous layout, then picks one of four states (inline → stacked → shed-link → shed-season) by writing `data-mode`/`data-shed` attributes that CSS keys off. The sidebar becomes a fixed off-canvas drawer below 860px, toggled by a hamburger button with an overlay. No unit tests are added (the suite is node-only with no jsdom); verification is a `preview_resize` sweep at 375 / 768 / 1280 px.

**Tech Stack:** React + TypeScript + Vite, plain CSS in `src/index.css`, `ResizeObserver` (no new deps).

**Spec:** `docs/specs/2026-06-24-topbar-responsive-and-mobile-nav-design.md`

---

## File Structure

- `src/components/TopbarMembership.tsx` — **new.** Owns the membership-badge fit logic (measurement + degradation ladder) and badge rendering. One responsibility: render the membership status area and keep it fitting.
- `src/components/Layout.tsx` — **modify.** Reorder topbar (badges before Cart), mount `TopbarMembership` with a ref to the `<header>`, add hamburger button + drawer open state + overlay + close-on-route/Esc + body-scroll-lock.
- `src/index.css` — **modify.** Badge inline/stacked/shed CSS, drawer positioning + overlay + hamburger, replace the 860px sidebar-block rule.
- `CLAUDE.md` — **modify.** Add a "Responsive verification" convention.
- `docs/plans/2026-06-24-playwright-responsive-tests.md` — **new.** Part 4 follow-up plan (written, not executed).
- `docs/README.md` — **modify.** Index the new spec + plans.

A note on verification steps: this codebase has **no DOM/React test harness** (Vitest runs in a node environment, per `CLAUDE.md`), so these UI tasks are verified by build + lint + a browser `preview` sweep rather than unit tests. Each task ends by confirming a clean build and `eslint` on touched files; the final task runs the responsive preview sweep that exercises every state.

---

## Task 1: Extract `TopbarMembership` with static inline layout (no measurement yet)

Move the badge JSX out of `Layout.tsx` into a new component, badges placed **before** the Cart, rendered as a single inline row (kills the `flexDirection: column` stacking). No measurement logic yet — this task just relocates + reorders and adds the markup hooks (`.mb-season`, `.mb-link`) the fitter will toggle later.

**Files:**
- Create: `src/components/TopbarMembership.tsx`
- Modify: `src/components/Layout.tsx` (topbar JSX ~lines 169-227; remove the `membershipBannerItems` inline render block at 212-226, keep the `membershipBannerItems` computation at 70-76)
- Modify: `src/index.css` (add `.topbar-membership` block near the `.member-banner` rules ~195-206)

- [ ] **Step 1: Create the component with static rendering**

Create `src/components/TopbarMembership.tsx`:

```tsx
import { Link } from 'react-router-dom';

export interface MembershipBannerItem {
  type: 'athlete' | 'coach';
  label: string;
  status: string;
}

/** One status badge. `mb-season` / `mb-link` spans are the pieces the fitter sheds. */
function Badge({ item, seasonName, clubShort }: {
  item: MembershipBannerItem;
  seasonName: string;
  clubShort: string;
}) {
  const season = <span className="mb-season">{seasonName} </span>;
  const cls = (tone: 'ok' | 'warn') => `member-banner ${tone} is-${item.type}`;
  switch (item.status) {
    case 'active':
      return <span className={cls('ok')}>✓ {season}{item.label} membership active</span>;
    case 'pending-club-payment':
      return (
        <span className={cls('warn')}>
          ⏳ {season}{item.label} membership — pending payment by {clubShort}
          <span className="mb-link"> · <Link to="/membership">details</Link></span>
        </span>
      );
    case 'pending-waiver':
      return (
        <span className={cls('warn')}>
          ⏳ {season}{item.label} membership — pending guardian waiver
          <span className="mb-link"> · <Link to="/membership">details</Link></span>
        </span>
      );
    default:
      return (
        <span className={cls('warn')}>
          ✕ No {season}{item.label} membership
          <span className="mb-link"> · <Link to="/membership">purchase now</Link></span>
        </span>
      );
  }
}

export function TopbarMembership({ items, seasonName, clubShort }: {
  items: MembershipBannerItem[];
  seasonName: string;
  clubShort: string;
}) {
  if (items.length === 0) return null;
  return (
    <div className="topbar-membership" data-mode="inline" data-shed="0">
      {items.map((it) => (
        <Badge key={it.type} item={it} seasonName={seasonName} clubShort={clubShort} />
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Wire it into `Layout.tsx` before the Cart**

In `src/components/Layout.tsx`, add the import near the other component imports (line 8 area):

```tsx
import { TopbarMembership } from './TopbarMembership';
```

Delete the old badge render block (lines 212-226, the `{me && membershipBannerItems.length > 0 && (…)}` `<span>` with the `flexDirection: 'column'` wrapper). Then insert the component **immediately before** the Cart `Link` (before line 192's `{me && (() => { const cartCount …`):

```tsx
          {me && (
            <TopbarMembership
              items={membershipBannerItems}
              seasonName={season.name}
              clubShort={myClubShort}
            />
          )}
```

Leave the `membershipBannerItems`, `season`, and `myClubShort` computations (lines 65-76) untouched — they now feed the component.

- [ ] **Step 3: Add the inline CSS**

In `src/index.css`, just after the `.member-banner a { color: inherit; }` rule (line 206), add:

```css
/* membership badges live in the topbar, left of the cart; one inline row */
.topbar-membership {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.member-banner { white-space: nowrap; }
```

- [ ] **Step 4: Build and lint**

Run: `npm run build`
Expected: build succeeds; `dist/index.html` exists with a script ref under `dist/assets`.

Run: `npx eslint src/components/TopbarMembership.tsx src/components/Layout.tsx`
Expected: no errors (warnings tolerated).

- [ ] **Step 5: Commit**

```bash
git add src/components/TopbarMembership.tsx src/components/Layout.tsx src/index.css
git commit -m "feat(topbar): badges left of cart in one inline row (extract TopbarMembership)"
```

---

## Task 2: Add measurement-driven degradation to `TopbarMembership`

Make the component react to real widths: inline when it fits, else stacked (coach left / athlete right), then shed the trailing link, then the season name — each step gated on actual overflow.

**Files:**
- Modify: `src/components/TopbarMembership.tsx`
- Modify: `src/components/Layout.tsx` (add a ref on `<header>`, pass it down)
- Modify: `src/index.css` (`.topbar-membership` stacked + shed rules; ensure `.topbar` wraps)

- [ ] **Step 1: Pass a topbar ref from `Layout` to the component**

In `src/components/Layout.tsx`, add `useRef` to the React import. At the top of the `Layout` function body (near line 56), add:

```tsx
  const topbarRef = useRef<HTMLElement>(null);
```

Attach it to the header (line 169): change `<header className="topbar">` to:

```tsx
        <header className="topbar" ref={topbarRef}>
```

Pass it to the component (extend the Step-2 usage from Task 1):

```tsx
          {me && (
            <TopbarMembership
              items={membershipBannerItems}
              seasonName={season.name}
              clubShort={myClubShort}
              topbarRef={topbarRef}
            />
          )}
```

- [ ] **Step 2: Implement the fitter logic**

Replace the body of `TopbarMembership` in `src/components/TopbarMembership.tsx` (keep the `Badge` component and `MembershipBannerItem` interface above it unchanged). Update the React import at the top of the file to:

```tsx
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { Link } from 'react-router-dom';
```

Then replace the exported component with:

```tsx
type Mode = 'inline' | 'stacked';
type Shed = 0 | 1 | 2; // 0 full · 1 drop link · 2 drop link + season

export function TopbarMembership({ items, seasonName, clubShort, topbarRef }: {
  items: MembershipBannerItem[];
  seasonName: string;
  clubShort: string;
  topbarRef: RefObject<HTMLElement | null>;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<Mode>('inline');
  const [shed, setShed] = useState<Shed>(0);

  // Measure real widths and pick the tightest state that still fits.
  // Uses forced synchronous layout (reading scrollWidth after each dataset
  // write reflows), which is fine here: it only runs on resize, on one element.
  const measure = useCallback(() => {
    const topbar = topbarRef.current;
    const root = rootRef.current;
    if (!topbar || !root) return;

    // Probe inline fit: force the topbar onto a single line and check overflow.
    root.dataset.mode = 'inline';
    root.dataset.shed = '0';
    const prevWrap = topbar.style.flexWrap;
    topbar.style.flexWrap = 'nowrap';
    const inlineFits = topbar.scrollWidth <= topbar.clientWidth;
    topbar.style.flexWrap = prevWrap;
    if (inlineFits) {
      commit('inline', 0);
      return;
    }

    // Stacked: badges on their own full-width row. Shed pieces until the row fits.
    root.dataset.mode = 'stacked';
    let nextShed: Shed = 0;
    root.dataset.shed = '0';
    if (root.scrollWidth > root.clientWidth) {
      nextShed = 1;
      root.dataset.shed = '1';
      if (root.scrollWidth > root.clientWidth) {
        nextShed = 2;
        root.dataset.shed = '2';
      }
    }
    commit('stacked', nextShed);

    function commit(m: Mode, s: Shed) {
      setMode((prev) => (prev === m ? prev : m));
      setShed((prev) => (prev === s ? prev : s));
    }
  }, [topbarRef]);

  useLayoutEffect(() => {
    measure();
    const topbar = topbarRef.current;
    if (!topbar || typeof ResizeObserver === 'undefined') return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    });
    ro.observe(topbar);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
    // Re-measure when the badge set / labels change (they affect content width).
  }, [measure, items, seasonName, clubShort, topbarRef]);

  if (items.length === 0) return null;
  return (
    <div ref={rootRef} className="topbar-membership" data-mode={mode} data-shed={shed}>
      {items.map((it) => (
        <Badge key={it.type} item={it} seasonName={seasonName} clubShort={clubShort} />
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Add the stacked + shed CSS**

In `src/index.css`, extend the `.topbar-membership` block added in Task 1 so it reads:

```css
/* membership badges live in the topbar, left of the cart; one inline row */
.topbar-membership {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.member-banner { white-space: nowrap; }

/* stacked: full-width second row, coach left + athlete right (pins right even alone) */
.topbar-membership[data-mode="stacked"] {
  order: 1;
  flex: 1 0 100%;
  justify-content: space-between;
  margin-top: 8px;
  gap: 8px;
}
.topbar-membership[data-mode="stacked"] .member-banner.is-athlete { margin-left: auto; }

/* shed levels: drop the trailing link, then the season name */
.topbar-membership[data-shed="1"] .mb-link,
.topbar-membership[data-shed="2"] .mb-link { display: none; }
.topbar-membership[data-shed="2"] .mb-season { display: none; }
```

Then ensure the topbar allows the stacked row to wrap below. Change the `.topbar` rule (line 179) to add `flex-wrap: wrap;`:

```css
.topbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 14px;
  padding: 12px 28px;
  background: rgba(252, 252, 252, 0.82);
  backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--line);
  position: sticky;
  top: 0;
  z-index: 40;
}
```

- [ ] **Step 4: Build and lint**

Run: `npm run build`
Expected: build succeeds; `dist/assets` script ref present in `dist/index.html`.

Run: `npx eslint src/components/TopbarMembership.tsx src/components/Layout.tsx`
Expected: no errors. (Watch for `react-hooks/exhaustive-deps` — the dep array listed is complete; if eslint still warns, it's a tolerated warning, not an error.)

- [ ] **Step 5: Commit**

```bash
git add src/components/TopbarMembership.tsx src/components/Layout.tsx src/index.css
git commit -m "feat(topbar): measure widths and degrade badges (inline → stacked → shed link → shed season)"
```

---

## Task 3: Mobile drawer nav

Replace the wrapping-block mobile sidebar with a fixed off-canvas drawer toggled by a hamburger, with overlay, Esc-close, route-change close, and body scroll lock.

**Files:**
- Modify: `src/components/Layout.tsx` (open state, effects, hamburger button, `id`/`open` class on `<aside>`, overlay)
- Modify: `src/index.css` (replace the `@media (max-width: 860px)` block; add `.nav-toggle` + `.nav-overlay`)

- [ ] **Step 1: Add open state + effects in `Layout`**

In `src/components/Layout.tsx`, ensure the React import includes `useEffect`, `useRef`, `useState`:

```tsx
import { useEffect, useRef, useState } from 'react';
```

Inside `Layout` (near `topbarRef`, ~line 56), add:

```tsx
  const [navOpen, setNavOpen] = useState(false);

  // Close the drawer on navigation.
  useEffect(() => { setNavOpen(false); }, [loc.pathname]);

  // Close on Escape; lock body scroll while the drawer is open.
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setNavOpen(false); };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [navOpen]);
```

- [ ] **Step 2: Add `id` + open class to the sidebar, and the overlay**

Change the `<aside className="sidebar">` (line 87) to:

```tsx
      <aside id="app-sidebar" className={`sidebar${navOpen ? ' open' : ''}`}>
```

Immediately after the closing `</aside>` (line 167), add the overlay:

```tsx
      {navOpen && <div className="nav-overlay" onClick={() => setNavOpen(false)} aria-hidden="true" />}
```

- [ ] **Step 3: Add the hamburger button as the first topbar child**

In the `<header className="topbar" ref={topbarRef}>` (line 169), insert as the **first** child, before the `goBack` block:

```tsx
          <button
            type="button"
            className="nav-toggle"
            aria-label={navOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={navOpen}
            aria-controls="app-sidebar"
            onClick={() => setNavOpen((o) => !o)}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
              <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
```

- [ ] **Step 4: Replace the mobile CSS**

In `src/index.css`, add the hidden-by-default rules near the topbar primitives (e.g. just after `.topbar-user-guest`, line 238):

```css
/* mobile drawer affordances — hidden on desktop, shown < 860px */
.nav-toggle { display: none; }
.nav-overlay { display: none; }
```

Then replace the entire `@media (max-width: 860px) { … }` block (lines 755-770) with:

```css
@media (max-width: 860px) {
  /* sidebar becomes an off-canvas drawer above the topbar */
  .sidebar {
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    width: min(280px, 82vw);
    height: 100vh;
    transform: translateX(-100%);
    transition: transform 0.22s ease;
    z-index: 60;
  }
  .sidebar.open {
    transform: translateX(0);
    box-shadow: 0 18px 50px rgba(8, 15, 30, 0.45);
  }
  .nav-overlay {
    display: block;
    position: fixed;
    inset: 0;
    background: rgba(8, 15, 30, 0.5);
    z-index: 50;
  }
  .nav-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 38px;
    height: 38px;
    padding: 0;
    color: var(--ink);
    background: var(--surface, #fff);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    cursor: pointer;
  }
  .nav-toggle:hover { border-color: var(--ink-soft); }
  .content { padding: 18px 14px 48px; }
  .topbar { padding: 10px 14px; }
}
```

Note: the old block set `.shell { flex-direction: column }` and turned the sidebar into a horizontal wrap — all removed. The sidebar is now `position: fixed` (out of flow), so `.main` already fills the row; no `.shell` change is needed.

- [ ] **Step 5: Build and lint**

Run: `npm run build`
Expected: build succeeds; `dist/assets` script ref present.

Run: `npx eslint src/components/Layout.tsx`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/Layout.tsx src/index.css
git commit -m "feat(nav): off-canvas drawer + hamburger for mobile (< 860px)"
```

---

## Task 4: Responsive verification sweep (preview)

Verify all states render correctly at the three canonical viewports and exercise the degradation ladder + drawer. This is the acceptance check for Tasks 1-3.

**Files:** none (verification only).

- [ ] **Step 1: Start the preview server**

Use the preview tooling (`preview_start`) against the dev server (`ucg-dev`, port 5173). If a Supabase session is needed to see the badges, sign in as the dual-role account (Nate) so both athlete + coach badges render — the worst case.

- [ ] **Step 2: Laptop — 1280px**

`preview_resize` to 1280×800, navigate to `/me`. Confirm: topbar is ONE line; badges sit left of the Cart; both badges show full text incl. `2025–26` and the link. `preview_screenshot`.

- [ ] **Step 3: Tablet — 768px**

`preview_resize` to 768×1024. Confirm: the hamburger appears; tapping it (`preview_click`) slides the drawer in over the overlay; clicking a nav link or the overlay closes it. Confirm the badges either stay inline or drop to a clean full-width second row (coach left, athlete right) with no overlap. `preview_screenshot` (drawer open and closed).

- [ ] **Step 4: Phone — 375px**

`preview_resize` to 375×812. Confirm: topbar line 1 is `☰ … 🛒 Cart · NS`; badges are on their own row, coach left / athlete right, and have shed the link and/or season name as needed so nothing overflows or overlaps. Verify text contrast is still legible (green-on-green-100 / coral-on-coral-100 unchanged). `preview_screenshot`.

- [ ] **Step 5: Single-badge sanity check**

Using the admin "View as" combo (or a known athlete-only person), confirm a one-badge user pins right when stacked and never shows an empty-looking layout. `preview_screenshot` at 375px.

- [ ] **Step 6: Record results**

If any state overflows or text is illegible, fix the relevant CSS (the measurement is content-driven, so fixes are almost always CSS spacing/`gap`, not new breakpoints) and re-run the sweep. No commit unless a fix was needed; commit fixes as `fix(topbar): …`.

---

## Task 5: Responsive-verification convention in `CLAUDE.md`

Bake the Part 3 convention into the standing dev process.

**Files:**
- Modify: `CLAUDE.md` (add a new subsection)

- [ ] **Step 1: Add the convention**

In `CLAUDE.md`, under the `## Build / tooling gotchas` section (after the launch-configs bullet), add:

```markdown
- **Responsive verification (mobile/tablet/laptop).** Any change that touches layout,
  CSS, the topbar, or the sidebar/nav MUST be verified at three canonical viewports
  before claiming done: **phone 375px**, **tablet 768px**, **laptop 1280px**. Use the
  preview tooling (`preview_resize` + `preview_screenshot`) and confirm at each width:
  no horizontal overflow, topbar stays one line (or degrades cleanly), text stays
  legible (contrast), and below 860px the nav drawer opens/closes (hamburger, overlay,
  Esc, link-tap). The topbar membership badges self-fit via measurement
  (`TopbarMembership`), so most layout fixes are CSS spacing, not new breakpoints.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add responsive verification convention (375/768/1280)"
```

---

## Task 6: Playwright follow-up plan + docs index

Write the Part 4 follow-up plan (not executed) and update the docs index.

**Files:**
- Create: `docs/plans/2026-06-24-playwright-responsive-tests.md`
- Modify: `docs/README.md`

- [ ] **Step 1: Write the Playwright plan**

Create `docs/plans/2026-06-24-playwright-responsive-tests.md`:

```markdown
# Playwright Responsive Screenshot Tests — Follow-up Plan (not yet built)

Status: Proposed. Scoped during the 2026-06-24 topbar/mobile-nav work as the
"automation later" half of the mobile dev pipeline. NOT implemented yet.

## Goal
Catch responsive/layout regressions automatically by screenshotting key pages at the
three canonical viewports (375 / 768 / 1280) in CI.

## Approach
1. Add `@playwright/test` as a devDependency; `npx playwright install --with-deps chromium`.
2. `playwright.config.ts`: one `chromium` project with three viewport variants
   (or a parametrized test that loops the viewports). Base URL = the Vite preview
   server (`npm run build && vite preview --port 4173`), started via Playwright's
   `webServer` option.
3. Tests in `e2e/responsive.spec.ts`: for each of Home (`/`), Profile (`/me`), a club
   page, and an admin page, at each viewport: assert no horizontal scroll
   (`document.documentElement.scrollWidth <= clientWidth`) and capture a
   `toHaveScreenshot()` baseline. Add one drawer test < 860px (open via hamburger,
   assert sidebar visible, close via overlay).
4. Auth: seed a logged-in dual-role session (storage state) so badges render; or run
   against the env-gated demo data path with no Supabase.

## CI wiring
- New GitHub Actions job in the deploy workflow, initially **non-blocking**
  (`continue-on-error: true`) until baselines are stable, then flip to blocking.
- Store screenshot baselines in-repo under `e2e/__screenshots__/`; budget for baseline
  churn on intentional UI changes (`--update-snapshots`).

## Cost / caveats
- First browser-based tests in a currently node-only Vitest suite: adds the Playwright
  browser download (~CI minutes) and snapshot maintenance overhead.
- Pixel snapshots are font/OS-sensitive; pin the CI runner OS and consider
  `maxDiffPixelRatio` tolerance to avoid flakiness.
```

- [ ] **Step 2: Index the new docs in `docs/README.md`**

In `docs/README.md`, add references to the new spec and plans under the appropriate
specs/plans listing (match the existing list format in that file):

```markdown
- `specs/2026-06-24-topbar-responsive-and-mobile-nav-design.md` — topbar one-line
  badges, measurement-driven degradation, mobile drawer nav, mobile dev pipeline.
- `plans/2026-06-24-topbar-responsive-and-mobile-nav.md` — implementation plan for the above.
- `plans/2026-06-24-playwright-responsive-tests.md` — proposed (not built) Playwright
  responsive screenshot tests.
```

- [ ] **Step 3: Commit**

```bash
git add docs/plans/2026-06-24-playwright-responsive-tests.md docs/README.md
git commit -m "docs: Playwright responsive-tests follow-up plan + index new docs"
```

---

## Self-Review

**Spec coverage:**
- Part 1 topbar reorder + single line → Task 1. ✓
- Part 1 measurement-driven 4-step degradation → Task 2. ✓
- Part 2 mobile drawer nav → Task 3. ✓
- Part 3 dev pipeline convention → Task 5 (+ verified in Task 4). ✓
- Part 4 Playwright follow-up plan → Task 6. ✓
- Files-touched list in spec (Layout, index.css, CLAUDE.md, plan doc, docs index) → all covered. ✓

**Placeholder scan:** No TBD/TODO; all code blocks are complete; CSS and TSX shown in full where changed.

**Type/name consistency:** `MembershipBannerItem` (interface), `TopbarMembership` (component), `Badge` (helper), props `items`/`seasonName`/`clubShort`/`topbarRef`, states `mode`/`shed`, data attrs `data-mode`/`data-shed`, CSS classes `.topbar-membership`/`.mb-season`/`.mb-link`/`.is-athlete`/`.nav-toggle`/`.nav-overlay`/`#app-sidebar`/`.sidebar.open` — all consistent across Tasks 1-5. The `topbarRef` type (`RefObject<HTMLElement | null>`) matches `useRef<HTMLElement>(null)` on the `<header>`.

**One known soft spot:** the inline-fit probe temporarily sets `topbar.style.flexWrap = 'nowrap'` and reads `scrollWidth`. If the topbar's own children (e.g. a very long crumb) can't shrink, the probe may report "doesn't fit" and choose stacked even on wide screens — acceptable (stacked is still correct/legible). Confirm during Task 4 at 1280px that the normal case stays inline.
```
