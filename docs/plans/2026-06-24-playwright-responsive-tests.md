# Playwright Responsive Screenshot Tests — Follow-up Plan (not yet built)

Status: 📓 Proposed. Scoped during the 2026-06-24 topbar/mobile-nav work as the
"automation later" half of the mobile dev pipeline. NOT implemented yet.

## Goal
Catch responsive/layout regressions automatically by screenshotting key pages at the
three canonical viewports (375 / 768 / 1280) in CI, instead of relying on a manual
`preview_resize` sweep each change.

## Why this is worth doing later (motivating evidence)
The 2026-06-24 topbar work shipped a measurement-driven badge fitter whose first
implementation had two layout bugs that ONLY surfaced under live multi-width testing
(the inline-fit probe was fooled by flexbox; dual badges overflowed a phone row). A
manual sweep caught them; an automated sweep would have caught them in CI and would
guard against silent regressions when the topbar/nav is next touched.

## Approach
1. Add `@playwright/test` as a devDependency; `npx playwright install --with-deps chromium`.
2. `playwright.config.ts`: one `chromium` project; parametrize a test across three
   viewports (375×812, 768×1024, 1280×800). Base URL = the Vite **preview** server
   (`npm run build && vite preview --port 4173 --strictPort`), started via Playwright's
   `webServer` option so CI builds the real bundle.
3. Tests in `e2e/responsive.spec.ts`: for each of Home (`/`), Profile (`/me`), a club
   page, and an admin page, at each viewport: assert no horizontal scroll
   (`document.documentElement.scrollWidth <= document.documentElement.clientWidth`) and
   capture a `toHaveScreenshot()` baseline. Add a drawer test < 860px: click the
   `.nav-toggle`, assert the sidebar gains `.open` and is on-screen, click `.nav-overlay`,
   assert it closes.
4. **Topbar badge coverage (the regression we just fixed):** seed a logged-in dual-role
   session via Playwright storage-state (a person with BOTH athlete + coach memberships
   and a long name = worst case) so the badge fitter actually renders, and assert no
   horizontal overflow at 375/768/1280 plus that the stacked badge row never overlaps.
   Alternatively, drive the same injected-DOM harness used in the manual sweep (see
   CLAUDE.md → Responsive verification → No-session gotcha) if auth seeding is too heavy.

## CI wiring
- New GitHub Actions job in the deploy workflow, initially **non-blocking**
  (`continue-on-error: true`) until baselines are stable, then flip to blocking.
- Store screenshot baselines in-repo under `e2e/__screenshots__/`; budget for baseline
  churn on intentional UI changes (`--update-snapshots`).

## Cost / caveats
- First browser-based tests in a currently node-only Vitest suite: adds the Playwright
  browser download (CI minutes) and snapshot-maintenance overhead.
- Pixel snapshots are font/OS-sensitive; pin the CI runner OS and consider a
  `maxDiffPixelRatio` tolerance to avoid flakiness.
- Auth seeding against the env-gated Supabase backend is the main setup cost; the
  injected-DOM harness is a lower-fidelity but auth-free fallback.
