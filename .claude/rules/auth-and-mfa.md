---
paths:
  - "src/lib/auth.ts"
  - "src/lib/dev-auth.ts"
  - "src/lib/mfa-core.ts"
  - "src/lib/capabilities-core.ts"
  - "src/lib/supabase.ts"
  - "src/App.tsx"
  - "src/pages/Gate.tsx"
  - "src/pages/SetPassword.tsx"
  - "src/pages/Profile*.tsx"
  - "src/pages/Admin*.tsx"
  - "supabase/functions/_shared/jwt-aal.ts"
  - "supabase/functions/_shared/aal-guard.ts"
  - "supabase/functions/admin-*/**"
---

# Auth, roles, MFA, passkeys

## MFA / aal2

TOTP opt-in (`ProfileMfa.tsx`). `App.tsx` renders the `MfaChallenge` step-up interstitial when
`needsMfaStepUp` (`mfa-core.ts`); no-factor accounts (including seeded dev/E2E users) never see
it. `is_admin()` returns true only on an aal2 JWT once the caller has a verified factor
(`20260717140238`).

**Passkey exemption — THREE LAYERS IN LOCKSTEP.** A passkey sign-in session (amr method
`'passkey'`, still aal1 in GoTrue) skips the TOTP step-up, enforced identically in:
1. `needsMfaStepUp` (`src/lib/mfa-core.ts`)
2. the `is_admin()` migration `20260718093940`
3. `supabase/functions/_shared/jwt-aal.ts`

**Never change one without the others** or passkey-signed-in enrolled admins lock out.

**Privileged edge functions MUST call `_shared/aal-guard.ts` `requireAalForEnrolledCaller`
immediately after their role gate** — service-role clients bypass the RLS-level hardening.
9 functions are guarded; runbook in `supabase/README.md` → "Auth: MFA". Break-glass:
`admin-reset-mfa` (itself guarded) or the dashboard.

WebAuthn-as-MFA (`mfa.enroll` factorType `'webauthn'`) is a PAID Supabase add-on — declined.
`[auth.mfa.web_authn]` in config.toml stays `false`; flipping it true triggers the CLI's
cost-confirmation prompt on push (and see the `config-push-dryrun` skill for why that extra
prompt is dangerous).

## Passkey SIGN-IN (free, separate from the paid MFA add-on)

`auth.signInWithPasskey()` / `auth.registerPasskey()` / `auth.passkey.*`, fully typed in the
installed SDK, opted into via `experimental.passkey: true` on the client (`src/lib/supabase.ts`).
"Sign in with a passkey" on `Gate.tsx` (sign-in mode, feature-detected on
`window.PublicKeyCredential`); management in the Profile "Passkeys" card
(`src/pages/ProfilePasskeys.tsx`, separate from the Two-factor authentication card).

Yields an **aal1** session — a TOTP-enrolled user still hits `MfaChallenge` for step-up, which
is intended. `[auth.passkey]`/`[auth.webauthn]` are declared in config.toml mirroring the prod
dashboard (RP display "UCG Events", RP ID `nssharpe.github.io`, origin
`https://nssharpe.github.io`) so an undeclared-key `config push` can't silently disable it.
E2E: `e2e/passkey.spec.ts` uses Playwright's CDP virtual authenticator; skips cleanly today
because staging's RP ID isn't `localhost`.

## App roles

`user_roles.role`, enum `app_role`: `admin`, `sanctioning`, `regional_rep` (region via
`regional_rep_regions`), `finance_admin`, `refund_manager`. Capabilities:
`isSanctioning`/`isRegionalRep`/`isFinanceAdmin`/`isRefundManager` — **admins are NOT implicitly
any of them.**

**`rolesLoaded` gate:** roles load async after the session, so `RequireAdmin`/role screens must
wait on `useRolesLoaded()` or they flash "access denied" on refresh. Reset on sign-out/new user
(`auth.ts`).

## HashRouter vs Supabase implicit flow

Auth tokens arrive in the URL hash, which clashes with HashRouter. Invite/set-password links use
`redirectTo` = app base + `?setpw=1` (a query survives hash-stripping); `App.tsx` detects it and
routes `#/set-password`; `SetPassword.tsx` waits ~2.5s for the async session. **Dashboard
requirement:** redirect URLs must include `https://nssharpe.github.io/ucg-platform/**` and
`http://localhost:5173/**` wildcards or the query is dropped. `Gate.tsx` also offers
forgot-password (same `?setpw=1` landing) and OTP magic-link sign-in.

## Initial-paint auth flash (App.tsx)

`!session && authLoading && (hasLikelySession() || hasAuthCallbackInUrl())` gates the very first
render behind `<PageFallback/>` so the app never paints in guest mode right before a session
resolves. `hasLikelySession()` covers a RETURNING session (refresh); `hasAuthCallbackInUrl()`
covers a BRAND NEW one being established from a signup-confirmation/magic-link/recovery URL
token — `hasLikelySession()` alone misses that case (no prior localStorage entry yet), which is
exactly what caused the "confirm my account → flashes a page" report.

## Self profile save stamps `auth_user_id`

`pushPerson(p, { selfAuthUserId })` **only** when saving one's OWN row (passes the `people`
self-INSERT RLS branch). Admin/manager creation of others omits it.

## Dev test-auth (seeded auto-login)

`src/lib/dev-auth.ts` does a real `signInWithPassword` of a seeded test user on dev boot (real
JWT → RLS/Edge Functions/member/club/admin/checkout UI all work locally). Bottom-left switcher
flips athlete/manager/admin (persists in `sessionStorage['ucg-dev-role']`); sign-out sets
`ucg-dev-signed-out` so it isn't undone by re-login.

**Firewall:** loaded only via dynamic `import('./dev-auth')` behind
`if (import.meta.env.DEV)` in `auth.ts`. A PostToolUse hook greps `dist/assets` for
`VITE_DEV_AUTH`/`initDevAuth` after every build and must find NONE.

Credentials in gitignored `.env.local`
(`VITE_DEV_AUTH_{ATHLETE,MANAGER,ADMIN}_{EMAIL,PASSWORD}`); seeded emails in
`docs/specs/2026-06-25-dev-test-auth.md`. If the vars are blank (fresh clone/CI) the dev server
is unauthenticated — rely on build/eslint/vitest + a console smoke test and flag auth flows for
manual check.
