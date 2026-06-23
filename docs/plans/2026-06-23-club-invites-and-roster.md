# Phase 3 — Club invites, Add-athlete & roster club selector

> Implements Phase 3 of [the 2026-06-22 feedback decomposition](../specs/2026-06-22-feedback-batch-decomposition.md).
> Decision (2026-06-22): **admin-create the auth user + email a branded set-password
> link via Resend**; setting the password lands the user on `#/membership`.

**Goal:** Club managers (and league admins) can create real accounts for athletes/coaches
from the club page; invitees get a set-password email and land on membership; the roster
page gains per-athlete invite + a club switcher.

**Architecture:**
- New Edge Function `invite-account` (service role): authorizes the caller manages the
  club (or is admin), creates/links the `people` row with the club as main club, creates
  the auth user via `auth.admin.generateLink({ type: 'invite' })`, and emails the returned
  `action_link` via Resend with set-password copy. `redirectTo` carries `?setpw=1` so the
  SPA shows a set-password screen after the session is established.
- New SPA route `#/set-password` (`SetPassword.tsx`): `supabase.auth.updateUser({ password })`,
  then redirect to `#/membership`. `App.tsx` detects `?setpw=1` on boot and routes there.
- `Club.tsx`: replace "Copy invite link" with **Add athlete** (modal: first/last/email);
  add a per-athlete **Invite** button on the roster; add a **club switcher** dropdown by
  the page title (managed clubs; all clubs for league admins).

**Tech stack:** Supabase Edge Functions (Deno) + `_shared/resend.ts`; React Router HashRouter;
existing `useCapabilities().managedClubIds` / `actingAsAdmin`.

---

## Task 3.4 — Roster/club page club switcher (no backend) ✅ do first
- **Files:** `src/pages/Club.tsx`.
- A `<select>` (type-ahead via existing `Combo`) next to `h1.page-title`. Options =
  `caps.actingAsAdmin ? db.clubs : db.clubs.filter(c => caps.managedClubIds.includes(c.id))`.
  Selecting navigates to `/club/<id>`. Hidden when the user manages ≤1 club and isn't admin.

## Task 3.1/3.2 — `invite-account` Edge Function + Add-athlete + set-password
- **Files:** `supabase/functions/invite-account/index.ts` (new); `src/lib/supabase.ts`
  (`inviteAccount` invoker); `src/pages/Club.tsx` (Add-athlete modal); `src/pages/SetPassword.tsx`
  (new); `src/App.tsx` (route + `?setpw=1` detection).
- **Function contract:** POST `{ clubId, email, firstName, lastName, kind: 'athlete'|'coach' }`.
  1. Authn caller (Bearer), authorize manages `clubId` or admin (pattern from `send-club-invite`).
  2. `generateLink({ type: 'invite', email, options: { redirectTo: `${APP_PUBLIC_URL}/?setpw=1` } })`.
     If the email already has an account, fall back to `type: 'recovery'` (so existing users
     get a reset link instead of erroring) and skip person creation if already linked.
  3. Upsert `people`: claim an unclaimed row with that email, else insert
     `{ id, auth_user_id: user.id, kind, first_name, last_name, email, main_club_id: clubId }`.
  4. Email `action_link` via `sendOne` with set-password copy.
- **SetPassword page:** form → `updateUser({ password })` → toast → `navigate('/membership')`.
- **App boot:** if `new URLSearchParams(location.search).get('setpw')` → `location.replace('#/set-password')`.

## Task 3.3 — Per-athlete roster "Invite" button
- **Files:** `src/pages/Club.tsx` (Roster).
- Each roster row (manager view) gets **Invite** → `sendClubInvite({ clubId, kind:'membership', email, name })`
  (existing function already emails a `#/membership` link). Disabled if the person has no email.

## Deploy & verify
- `supabase functions deploy invite-account --project-ref wkyerxlgricfphopocoz` (sandbox off).
- Live test (Nate): Add-athlete → receive email → set-password link → lands on membership.
  (The email round-trip can't be verified headlessly.)

## Open notes
- HashRouter + implicit-flow tokens: Supabase strips the `#access_token…` fragment on boot
  (detectSessionInUrl), leaving `?setpw=1`; App redirects to the hash route afterward.
- "Confirmation email on account creation": invited users are email-confirmed implicitly;
  a separate welcome email can be added later if desired.
