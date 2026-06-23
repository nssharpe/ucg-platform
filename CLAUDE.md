# UCG Registration & Scoring Platform

React + TypeScript + Vite. Live: https://nssharpe.github.io/ucg-platform/
Supabase backend (env-gated). Deploys via GitHub Actions on push to `main`.

## Working style (Nate = PM, not hands-on)
Do as much as possible directly. When a step is technically doable but blocked only
on a one-time setup or a permission grant, ask for *just that unblock*, then execute
the step yourself — don't hand the whole step back to Nate as instructions. Nate has
standing authorization to run `supabase db push` / apply migrations to the live DB
(granted 2026-06-18). Still confirm genuinely destructive prod actions and show what
will apply first.

## Supabase / migrations
- Project ref `wkyerxlgricfphopocoz` (org NAIGC). Migrations in `supabase/migrations/`.
  CLI is linked (`supabase link` done 2026-06-19). All migrations are applied and
  tracked by the CLI — through the waiver-e-sign set (`20260620000010/0020/0030`,
  the latest as of 2026-06-21). `supabase functions deploy <name>` deploys Edge
  Functions (see [Email infra] below).
- Migration filenames use Supabase's required timestamp format:
  `<YYYYMMDDHHmmss>_name.sql`. Create new ones with `supabase migration new <name>`.
- Apply via `supabase db push` (the shell sandbox blocks network — run with the
  sandbox disabled).
- **Enum gotcha:** `ALTER TYPE ... ADD VALUE` cannot be used in the same transaction
  that then references the new value. Put each such change in its OWN migration file
  so it commits before any file that uses it.

## Build / tooling gotchas
- **Location:** keep the working copy at `C:\dev\ucg-platform` (short, space-free,
  outside Dropbox). Plain `npm`/`npx` work normally there. Do **not** move it back
  under the old Dropbox path (`...\NAIGC Reg & Scoring Platform\`) — the spaces + `&`
  broke npm/npx cmd shims, and Dropbox sync locked `dist/` during builds. Both
  problems are gone purely by virtue of the new path; the workarounds below are
  retired and kept only as history.
- *(Retired — old Dropbox path only)* The repo path's spaces + `&` broke npm/npx cmd
  shims; you had to invoke binaries directly (`node node_modules/<pkg>/bin/...`).
- *(Retired — old Dropbox path only)* Dropbox locked `dist/` during `vite build`
  (EBUSY at prepare-out-dir); the fix was to remove `dist` with retries, build, then
  re-set the NTFS ADS `dist:com.dropbox.ignored=1`. Not needed outside Dropbox.
- Regardless of path: verify a build by grepping for "files generated" AND confirming
  `dist/index.html`'s script refs exist under `dist/assets` — never trust the piped
  exit code alone.
- Launch configs (`.claude/launch.json`): `ucg-dev` (the dev server on 5173) and
  `ucg-preview` (dev on 5176 with `--strictPort`, so previews don't collide with a
  running `ucg-dev`). If you ever run `vite preview` (serves `dist/` only): REBUILD
  first, and clear the service worker (unregister + `caches.delete` + reload) or it
  serves the previous bundle.
- Pre-existing lint debt (`src/lib/supabase.ts` `any`s, etc.) — `npm run lint` has
  never been clean. Lint only the files you touch.

## Tests
- Vitest, **node environment**, config in `vitest.config.ts` (no app plugins loaded).
  Tests live in `tests/**/*.test.ts` and cover the **pure** logic: the scoring
  engines (`src/scoring/*`) and capability derivation (`src/lib/capabilities-core.ts`,
  split out from the React hooks in `capabilities.ts` so it imports zero runtime deps).
- Run: `npm test` (or `npx vitest run`). Watch mode: drop `run` (`npx vitest`). The
  old `node node_modules/vitest/vitest.mjs run` workaround was only for the broken
  shim on the Dropbox path and is no longer needed.
- The scoring tests encode ground-truth values verified against the original NAIGC
  calculators, so they lock in the port's correctness. No DOM/React/component tests
  yet — those would need a jsdom environment + @testing-library added later.

## Docs
- `README.md` — overview/architecture. `docs/` — `specs/`, `plans/`, and reference
  notes (`docs/hosting-and-launch.md`, `docs/README.md` index). `supabase/README.md`
  — backend schema + RLS model.
- Write new design specs to `docs/specs/`, implementation plans to `docs/plans/`
  (overrides the brainstorming/writing-plans skill defaults — do NOT recreate
  `docs/superpowers/`).
- **Keep docs current after every commit.** A `PostToolUse` hook in
  `.claude/settings.json` fires after any `git commit` and injects a reminder to
  sweep the docs (`README.md`, `CLAUDE.md`, `docs/README.md`, `supabase/README.md`,
  + relevant `docs/specs`/`docs/plans`) and update anything the change made stale —
  in the same session. Skip only when the commit is docs-only or has no doc impact.
  Edit/disable the hook via `/hooks` or that settings file.

## Email infra (Resend, working)
- Transactional email sends via **Resend** (HTTP API) through a shared helper,
  `supabase/functions/_shared/resend.ts` (`resendFrom` / `sendOne` / `sendBatch`, plain
  `fetch`). Secrets: `RESEND_API_KEY` and `RESEND_FROM` (= `United Club Gymnastics
  <nate.sharpe@naigc.org>`; `naigc.org` is a verified Resend domain). `APP_PUBLIC_URL` is
  still used for links. The old `GMAIL_*` secrets remain set but UNUSED — the rollback
  path (revert the functions + redeploy). `RESEND_FROM` flips the sender with no code
  change/redeploy.
- Functions in `supabase/functions/`:
  - `send-email` — Communicate broadcast, **admin-only**, Resend batch (50-recipient cap).
  - `send-sms` — Communicate text sender, **admin-only**, Telnyx.
  - `request-guardian-waiver` — minor waiver signing link. `record-waiver-signature`.
  - `notify-club-cart` — emails a club's managers when a member pushes fees to the cart.
  - `send-club-invite` — club manager invites a coach (`kind:'coach'`) or a member to
    purchase membership (`kind:'membership'`); authorizes the caller manages the club.
  - `invite-account` — admin-create a real auth user + email a branded **set-password**
    link (`generateLink` type `invite`, or `recovery` if they already exist). Used by the
    roster "Add athlete". The link's `redirectTo` carries `?setpw=1` (see set-password note).
  - `request-manager-access` — any member asks a club's managers + admins for access.
  - `notify-sanction` — sanction lifecycle (`event:'submitted'` → team+admins;
    `'approved'`/`'rejected'` → the requester).
  - The notify-style functions allow any signed-in caller and resolve recipients
    server-side with the service role (pattern: `notify-club-cart`). `send-email`/`send-sms`
    are the only admin-gated senders.
- Front-end invokers in `src/lib/supabase.ts`: `sendEmail`, `sendSms`, `requestGuardianWaiver`,
  `notifyClubCart`, `sendClubInvite`, `inviteAccount`, `requestManagerAccess`, `notifySanction`.
  Deploy: `supabase functions deploy <name> --project-ref wkyerxlgricfphopocoz` (sandbox
  disabled; Docker NOT required) — the deploy bundles `_shared/resend.ts` automatically.
- **Edge Function error surfacing:** invokers must unwrap the JSON `error` body via
  `edgeErrorMessage(error)` (returns the function's real message), NOT `error.message`
  (which is the generic "Edge Function returned a non-2xx status code"). Every invoker
  follows this — match it for new ones.
- **Still over-claim** (deferred with Stripe — payment is itself a stub): the
  "Confirmation emailed" toasts in `Membership.tsx` (direct-pay completion) and
  `Club.tsx` (club-cart pay button) say email but send none. Wire when payments land.

## Patterns & gotchas (learned in build)
- **Auth/set-password round-trip with HashRouter.** Supabase uses implicit flow
  (`detectSessionInUrl`), which puts the token in the URL **hash** — clashing with
  HashRouter. The invite/set-password flow works around it: `redirectTo` is the app base
  + `?setpw=1` (a *query*, survives hash-stripping); on boot `App.tsx` detects `?setpw=1`,
  routes to `#/set-password`, and clears the marker. `SetPassword.tsx` waits ~2.5s for the
  session before showing an "expired link" message (the session arrives async via
  `onAuthStateChange`). **Dashboard requirement:** redirect URLs must include the
  wildcards `https://nssharpe.github.io/ucg-platform/**` and `http://localhost:5173/**`,
  or Supabase drops the query and the link lands on home.
- **Club-membership gate is ON.** A club needs an active `club_memberships` row for a
  season before its athletes can register or it can host. Enforced at the registration
  (`Meets.tsx`, `Club.tsx`) and sanction-request (`Sanction.tsx`) entry points via
  `clubHasActiveMembership`/`seasonForDate` (`capabilities-core.ts`). New registration
  paths MUST apply this gate. A migration backfills the current season for clubs with
  active members; future seasons require purchase/grant.
- **`rolesLoaded` gate.** Roles load async *after* the session resolves; `RequireAdmin`
  (and role screens) must wait on `useRolesLoaded()` or they flash "access denied" on
  refresh. Reset it on sign-out / new user (`auth.ts`).
- **Toasts.** `useToast()` takes `(msg, { variant?: 'info'|'error', persist? })`. Errors
  persist until closed; all toasts have an ✕ and hover-pause (`ui.tsx`). Prefer
  `{ variant: 'error' }` for failures so they don't auto-dismiss.
- **PDFs are client-side (jsPDF), generated on demand** — waiver proof (embeds the full
  signed waiver text + timestamp/IP) and receipts. No server PDF/storage; regenerate from
  data. Server-emailed PDF attachments are deferred to the payments work.
- **New DB collection plumbing** (e.g. `club_memberships`, `comm_log`): add to
  `types.ts` (`DB.<x>`), a `rowTo<X>` + `push<X>`/`delete<X>` in `supabase.ts`, the
  `loadAll` Promise.all + map + conditional spread into the return. `from('<new_table>')`
  typechecks even if absent from `database.types`.
- **ESLint traps that fail `npm run lint`:** don't define a component inside another
  component's render (extract to module scope); don't call `setState` synchronously in a
  `useEffect` body (initialize state instead). Lint only files you touch.

## Deferred / TODO (not yet built)
- **New-club-request email** — the new-club-request flow should email
  `newclubinquiries@naigc.org`. The email transport now exists (above); the request flow
  just doesn't fire it yet. Wire a best-effort send via the same path.
- **MFA / passkeys** — phased recommendation in
  `docs/research/2026-06-22-auth-2fa-passkeys.md` (TOTP opt-in → require for admins →
  passkeys). Not built.
- **Still over-claims email** (deferred with Stripe — payment is a stub): the
  "Confirmation emailed" toasts in `Membership.tsx` / `Club.tsx` pay buttons send no email.
- Stripe payments (memberships, meet entries, banquet) + server-emailed PDF receipts,
  per-season typed waivers, codeless judge access (URL / 6-digit / QR), multi-judge +
  score-entry-mode meet config, PDF certs, finals rosters. See `docs/specs/` + `docs/plans/`,
  and the roadmap in `docs/README.md`.
