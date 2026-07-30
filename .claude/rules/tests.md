---
paths:
  - "tests/**"
  - "e2e/**"
  - "vitest.config.ts"
  - "playwright.config.ts"
---

# Test layout and conventions

Run: `npm test` / `npx vitest run`. E2E: `npm run test:e2e`.

## Vitest — node environment by default

`vitest.config.ts`, no app plugins. Tests in `tests/**/*.test.{ts,tsx}` cover the **pure** logic:
scoring engines (`src/scoring/*`), `src/lib/pagination.ts`, `profile-core.ts`,
`reg-estimate.ts`, `registration-status.ts`, `navHistory.ts`, `capabilities-core.ts` (split from
React hooks so it imports zero runtime deps), `pricing.ts`.

Scoring tests encode ground-truth values from the original NAIGC calculators — they lock in port
correctness. Don't "fix" a scoring test to match new output without confirming against the
original calculator.

**Any new PURE logic needs a vitest test.** This is part of the `verify-before-commit` skill.

## Component tests

`tests/components/*.test.tsx`, jsdom via the **per-file `// @vitest-environment jsdom`
docblock** — `environmentMatchGlobs` is deprecated. RTL cleanup is registered explicitly in
`tests/components/setup.ts` because `globals: false` disables RTL auto-cleanup.

`vitest.config` force-blanks `VITE_SUPABASE_URL`/`ANON_KEY` via `define` so the Supabase client
stays inert (vitest loads `.env.local` even without app plugins).

Coverage focus is money-adjacent UI semantics: cart ✕ removal/revert (via the real
`removeCartItemWithSync` + shared `CART_REMOVAL_MESSAGE`), `RegistrationEditor` change-fee
derivation, hold badges.

## E2E (Playwright)

Specs in `e2e/` — kept OUT of `tests/` so vitest doesn't pick them up. Chromium against a vite
server in `--mode staging` on port 5178 (auto-started; reuses if running).

Covers real Gate sign-in (including the no-account message), the seeded athlete cart, live
`create-checkout-session` → Stripe Embedded render, and events pages. Tests suppress dev
auto-login via `sessionStorage['ucg-dev-signed-out']`.

Staging seeded state is documented in `supabase/README.md` — keep specs in sync with it.
⚠ The scaled staging fixture baseline was found absent 2026-07-28; reseed before trusting E2E.
