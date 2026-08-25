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

## Admin-pages MFA hard gate (UAT A-11-01, decided 2026-08-21)

`RequireAdmin` (`App.tsx`) now hard-blocks every `/admin/*` route for an admin with neither a
verified TOTP factor nor a satisfied passkey — full-page panel, not a dismissable nag. Decision
logic: `adminMfaGate` (`mfa-core.ts`, pure, unit-tested); reactive resolution:
`useAdminMfaSatisfied` (`src/lib/mfa.ts`). `/me` (ProfileMfa, the enrollment UI) is deliberately
NOT behind `RequireAdmin`, so a gated admin always has a way out. The old `AdminMfaNag`
(dismissable via `sessionStorage['ucg-mfa-nag-dismissed']`, which survived sign-out in the same
tab) was **deleted outright** rather than kept as a banner — once admin pages hard-block, a
reminder banner elsewhere adds no enforcement value. Both sign-out call sites (`Layout.tsx`,
`MfaChallenge.tsx`) call `clearLegacyMfaNagDismissal()` to scrub any leftover key from before this
change.

**Passkey satisfaction is credential-enrolled OR session-AMR (fixed UAT round 2, A-11-02) — not
AMR alone.** Originally `useAdminMfaSatisfied` computed `hasPasskey` off
`aal.methods.includes(PASSKEY_AMR_METHOD)` ONLY — the CURRENT session's sign-in method. That
meant enrolling a NEW passkey mid-session (via `ProfilePasskeys.tsx`, while still signed in with a
password) never satisfied the gate, because it doesn't change how the current session
authenticated — an enrolled admin stayed blocked until they signed out and back in with the
passkey (Julia's repro). **Fixed** with `hasPasskeySatisfaction(hasPasskeyCredential, authMethods)`
(`mfa-core.ts`, pure, unit-tested): true if `supabase.auth.passkey.list()` (the SAME list
`ProfilePasskeys.tsx` renders) returns any credential, OR the AMR exemption. `useAdminMfaSatisfied`
now fetches both `mfa.listFactors()` and `passkey.list()` in parallel. It also re-fetches
IMMEDIATELY on enrollment change via a new `notifyMfaEnrollmentChanged()` signal
(`useSyncExternalStore`-based, mirrors the idioms in `auth.ts`; no polling) — `ProfileMfa.tsx`
calls it after TOTP verify/unenroll, `ProfilePasskeys.tsx` after passkey add/remove — because
`RequireAdmin`/`useAdminMfaSatisfied` only remounts on navigating away from and back to an admin
route, which would otherwise miss an enrollment that happened without leaving the admin surface
(e.g. `/me` opened in a new tab while `/admin/*` stays open in the original one). **This hook
remains a CONSUMER of `mfa-core.ts`'s pure functions, not a fourth lockstep layer** — it never
reimplements the passkey/AMR check itself.

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
`redirectTo` = app base + `?setpw=invite` (`invite-account`) or `?setpw=reset` (Gate.tsx's
forgot-password) — a query survives hash-stripping; `App.tsx`'s `SetPasswordRedirect` detects it
and routes `#/set-password`; `SetPassword.tsx` waits ~2.5s for the async session. **Dashboard
requirement:** redirect URLs must include `https://nssharpe.github.io/ucg-platform/**` and
`http://localhost:5173/**` wildcards or the query is dropped. `Gate.tsx` also offers OTP
magic-link sign-in.

**A real ordering bug lived here, not just the dashboard gotcha above (audited 2026-08-21, UAT
A-07-02/A-06-01).** Traced through the installed `@supabase/auth-js` source (`GoTrueClient.js`):
`_initialize()` reads `window.location.href` into a local `params` object **synchronously**, at
the very start of the call (before any `await`) — this happens at module load in `auth.ts`
(`supabase.auth.getSession()`), well before React mounts. So the access/refresh tokens themselves
are safe from anything React Router does afterward; there is no token-LOSS race. The real bug was
downstream: `_getSessionFromURL`'s implicit-grant path does `await this._getUser(access_token)` —
a genuine network round trip — and only THEN runs `window.location.hash = ''` to scrub the tokens
from the URL. That direct hash mutation fires a real `hashchange`, which HashRouter follows
straight to `/`. Meanwhile `SetPasswordRedirect` (mounted inside the router) had already fired
once on `?setpw=...`, navigated to `/set-password`, and — as its OWN cleanup — deleted the `setpw`
query param. So by the time Supabase's later `hash=''` bounce lands, the query param the redirect
used to decide whether to re-navigate is already gone: the effect early-returned, stranding the
app on Home, often before the session had even been saved (`_saveSession` runs after
`_getSessionFromURL` returns) — i.e. it rendered signed-out. That is exactly Julia's "invite link
landed on the signed-out Home page with no guidance" repro.

**Fix:** capture the `setpw` marker and any link error ONCE at module load in `auth.ts`
(`initialSetPwKind()` / `hasInitialLinkError()`, mirroring the existing `initialUrlHasAuthCallback`
idiom just below them) instead of re-reading `window.location.search`/`.hash` later.
`SetPasswordRedirect` and `SetPassword.tsx` both read from these module-level captures, so they
keep working no matter how many times the URL gets rewritten out from under them afterward (own
cleanup, Supabase's `hash=''`, or both). `SetPassword.tsx` routes post-success on the captured
kind: `'reset'` → Home, `'invite'`/`'legacy'` (the old bare `?setpw=1`, for any already-sent email
still in flight) → `/membership`, matching the invite email's "you'll land on the membership page"
copy. A router-`state` marker was considered and rejected: the redirect's own
`window.history.replaceState(null, '', ...)` call would wipe it (passing `null` clears React
Router's history-state slot — now fixed to pass `window.history.state` instead regardless, but the
URL-marker approach avoids depending on it). Also fixed: `SetPassword.tsx`'s `!session`
(expired-link) state now shows an explicit "This link has expired or was already used" message
with a "Request a new link →" button (→ `/me`, which renders `Gate`'s sign-in screen with "Forgot
my password?" for a signed-out visitor) instead of only a terse heading.

**UAT round 2 (2026-08-25): the allow-list DID drop the marker in production.** The dashboard's
redirect allow-list used a bare `**` glob that does not match a URL carrying a query string, so
`?setpw=invite`/`?setpw=reset` was silently stripped on every real send — exactly the "still true
and NOT fixed" risk flagged in the paragraph below (now historical; the allow-list has been
corrected). Julia's repro: after submitting a new password, a "✓ Password set — taking you to
membership…" flash appeared, then the page went back to a BLANK set-password form.

Two separate fixes landed for this, one defensive and one a real bug this exposed:

1. **Marker-independent flavor resolution** (`resolveSetPasswordFlavor`,
   `src/lib/set-password-core.ts`): `SetPassword.tsx` no longer trusts the `?setpw=...` marker
   alone when it's ABSENT. `auth.ts` now also captures whether a `PASSWORD_RECOVERY`
   `onAuthStateChange` event fired this page load (`hasSeenPasswordRecoveryEvent()`) and uses it
   to fill in `'reset'` when no marker survived the redirect. **An explicit marker always wins
   over the event, in either direction** — `'invite'`/`'legacy'` → `'invite'`; `'reset'` →
   `'reset'`; only when there's NO marker at all does the event decide (seeing it or not both
   currently resolve to `'reset'`, the safe default). This precedence matters concretely: further
   down in this same file (`invite-account`), the invite-link generation falls back to a
   Supabase RECOVERY-type link — still marked `?setpw=invite` — whenever the invitee's auth user
   already exists, so consuming that link fires a genuine `PASSWORD_RECOVERY` event for a link
   that is legitimately an invite. An earlier draft let the event override the marker outright and
   would have silently sent that person Home after an email that told them they'd land on
   Membership — caught on review before merge. **The no-signal-at-all default changed from
   `'invite'`/membership to `'reset'`/Home** — landing Home is a smaller surprise than landing on
   Membership when the flow's origin can't be determined, and matches what confused Julia in the
   first place.

2. **The actual "flash then stranded" mechanism (a real bug, independent of the allow-list):**
   `SetPasswordRedirect` (`App.tsx`) force-navigates to `/set-password` whenever `initialSetPwKind()`
   is truthy and the current route isn't already `/set-password` — but `initialSetPwKind()` reads
   a page-load-scoped module constant that **never clears itself once "used."** So the very first
   time `SetPassword.tsx`'s post-`updateUser()` `navigate('/membership')` (or `/`) landed on the
   new route, this same effect saw "not on `/set-password`, marker still truthy" and immediately
   re-navigated BACK to `/set-password` with `replace: true` — remounting `SetPassword` fresh
   (blank fields, `done: false`) a few hundred ms after the success flash. This reproduces with or
   without the allow-list bug, any time the marker is present at all (i.e. on every real invite/
   reset link, allow-list bug or not) — it was simply invisible before because nobody had reason to
   watch the page for another ~1.2s after the "flash" screen appeared. **Fixed** with a `reachedRef`
   guard in `SetPasswordRedirect`: once the effect has legitimately landed on `/set-password`, it
   never force-navigates back to it again for the rest of that page load, so a post-success
   departure is never mistaken for "the marker hasn't been used yet."

**Still true and NOT fixed by the above (flag for dashboard/ops attention if it recurs):** if the
Supabase dashboard's redirect allow-list ever drops the custom `redirectTo` again (falls back to
the bare Site URL), the `?setpw=...` marker never reaches the app at all — (1) above now covers
this for the reset case (the `PASSWORD_RECOVERY` event still fires), but a genuine INVITE link
whose invite-generation path used the `type:'invite'` branch (not the `recovery` fallback) with a
dropped marker still can't be distinguished from a reset link — no `PASSWORD_RECOVERY` event
fires for it either — so it degrades to the new `'reset'` default rather than `'invite'`/
membership. Email link-scanners (Outlook/Gmail Safe Links) pre-fetching a one-time
invite link before the real click is a second, unrelated way to legitimately land on the
expired-link state.

## Signup name → person row, and post-confirmation landing (UAT round 2, A-01-02)

`Gate.tsx`'s sign-up form stashes `first`/`last`/`kind` in localStorage right before calling
`supabase.auth.signUp()`; `auth.ts`'s `onAuthenticated()` reads that stash and passes it to the
`link_or_create_person` RPC, which defaults an empty first/last to `'New'`/`'Member'` — that
default is exactly where "New Member" people came from. The localStorage stash only survives if
the confirmation email is clicked on the **same device/browser** the sign-up form ran in; clicking
it elsewhere (a different device, a mail app that opens a different browser, a cleared/private
localStorage) loses the stash entirely, silently falling through to the RPC's default. **Fixed**
by also passing the name/kind as `signUp()`'s `options.data` (`user_metadata`, stored on the auth
user server-side) — `stashedName()`/`stashedKind()` (`auth.ts`) now fall back to
`user.user_metadata` (already present on the session's `user` object, no extra round trip) when
the localStorage stash is missing, so a cross-device confirmation still gets the real name.

**Post-confirmation landing.** A brand-new signup confirmation lands with
`#access_token=...&type=signup` and previously fell through to Home with no special handling —
but Gate.tsx's sign-up form never collects dob/state/club/etc., so the profile is ALWAYS
incomplete at that point. `initialAuthCallbackType()` (`auth.ts`) captures the hash's `type=` param
at module load (same once-only rationale as `initialSetPwKind`); `SignupLandingRedirect` (`App.tsx`,
mirrors `SetPasswordRedirect`'s "reached-once" ref-guard shape) sends a `type === 'signup'` landing
to `/me` (Profile) once, instead of Home. Reset/invite links never carry `type=signup` — they use
the app's own `?setpw=...` marker via a custom `redirectTo`, so `SetPasswordRedirect` and
`SignupLandingRedirect` never compete for the same navigation.

## `invite-account`'s `clubId` is optional (UAT round 2, A-07-01)

`AdminMembers.tsx`'s per-person "Invite"/"Resend" row action and the "+ New person" checkbox now
route through the `invite-account` edge function too (previously a separate plain-text
`sendEmail` signup-link flow with no real set-password link) — `src/lib/supabase.ts`'s
`inviteAccount()` wrapper already existed for `Club.tsx`'s manager-side "add athlete" and needed
no changes. Because an admin can invite an **Independent Athlete** (no club at all), the edge
function's `clubId` requirement is now conditional: a club-manager caller MUST supply one (it's
the only thing their authorization can be checked against); an admin caller may omit it entirely.
When `clubId` is supplied for an EXISTING person, the function only updates `main_club_id` when a
`clubId` was actually passed — omitting it (independent invite) never clears an existing person's
club affiliation it doesn't know about. The `account_invites` table / `AccountInvite` type
(`pushAccountInvite`) is kept as bookkeeping only (pending-invite dedup on the Members page, GDPR
export in `person-data.ts`/`person-export.ts`) — it no longer carries its own separate email.

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
