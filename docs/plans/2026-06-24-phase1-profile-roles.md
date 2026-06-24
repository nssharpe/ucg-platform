# Phase 1 — Profile / New-account / Roles foundation & blocking bugs

> **For agentic workers:** executed via superpowers:subagent-driven-development (fresh subagent
> per task + spec & quality review between tasks). Steps use `- [ ]` checkboxes.

**Goal:** Fix new-account profile defaults & validation, add Outside-US/coach-only handling,
add two new user roles (Regional Representative w/ region, Finance Admin), fix the people-INSERT
RLS save bug, kill two auth-flash glitches, and add Forgot-Password + magic sign-in link.

**Architecture:** React + TS + Vite SPA over Supabase. Roles live in `user_roles.role` (an
`app_role` enum); each new enum value needs its OWN migration (enum gotcha). Profile fields are
edited in `Profile.tsx` (self/admin) and `PersonForm.tsx` (admin/club-manager create modal) —
both must change together. Region derives from `STATE_REGIONS` in `types.ts`. RLS helpers are
SECURITY DEFINER funcs in `20260601000002_rls.sql`.

**Tech stack:** React 18, react-router HashRouter, Supabase JS, vitest (node env), eslint.

---

## Task 1: New-account profile defaults & validation (1a–1c)

**Files:**
- Modify: `src/components/PersonForm.tsx` (create modal — `blank()`, validation)
- Modify: `src/pages/Profile.tsx` (self/admin edit — defaults, validation `validate()`)
- Modify: `src/lib/types.ts` (`Athlete.studentStatus` add `'' ` sentinel for "unset")

**Requirements:**
- **Student status** must default to **unfilled** (empty) for new athletes and be **required**
  (block save with a clear message; show the field as missing). Today it defaults `'Student'`.
  Add `'' as the unset value to the `studentStatus` union; the `<select>` gets a disabled
  placeholder option ("Select…"); validation rejects empty for athletes.
- **Undergrad grad year** must default to **N/A unchecked + year blank** so the user must act.
  `gradYear: 0` (unset) already does this in `PersonForm.blank()`; CONFIRM `Profile.tsx`'s
  new-person path also starts at `0` (not 1900/未填). Validation already rejects `gradYear===0`
  — keep it; ensure the N/A checkbox renders unchecked when `gradYear===0`.
- **Main club** must default to **"No club" unchecked** so the user must choose a club OR tick
  No-club. `PersonForm` already defaults `independent=false` for new; CONFIRM `Profile.tsx` new
  path defaults `independent=false` (not pre-checked) and that save is blocked until
  `clubChosen` (a club is selected OR No-club is ticked). Add the guard to `Profile.tsx`'s
  `validate()` if missing.

**Steps:**
- [ ] Add `''` to `studentStatus` type in `types.ts`; update `PersonForm.blank()` to
  `studentStatus: ''`. Add a placeholder `<option value="" disabled>Select…</option>` and mark
  the field required + missing-styled when empty, in BOTH `PersonForm.tsx` and `Profile.tsx`.
- [ ] In `Profile.tsx`, ensure the new-person initial state uses `gradYear: 0` and
  `independent` derived as `false` for a brand-new person (mainClubId not yet null-by-default);
  add a `clubChosen` guard to `validate()` mirroring `PersonForm` (block save until a club or
  No-club is chosen) with a clear error.
- [ ] Verify `npx vitest run` still green (no pure-logic tests touch this, but capability tests
  must not break from the type change). Run `npx eslint src/components/PersonForm.tsx
  src/pages/Profile.tsx src/lib/types.ts`.
- [ ] Verify in preview at 375/768/1280: new-athlete form shows Student status empty + required,
  grad-year N/A unchecked + blank, Main club unchosen; save is blocked until each is set.
- [ ] Commit: `feat(profile): require student status / grad year / club choice for new accounts`

## Task 2: Outside-US training-state option (1d)

**Files:**
- Modify: `src/lib/types.ts` (add `outsideUs?: boolean` to `Athlete`)
- Modify: `src/components/PersonForm.tsx`, `src/pages/Profile.tsx` (state/region UI + validation)
- Modify: `src/lib/supabase.ts` (`personToRow`/`rowToPerson` map the new field)
- Migration: add `outside_us boolean default false` to `people` (new file via
  `supabase migration new people_outside_us`)
- Region derivation: when `outsideUs`, Region resolves to **"Outside US"** and the state field
  is **not required**.

**Requirements:**
- Add an **"Outside US"** checkbox (label it clearly, e.g. "Training outside the US"),
  defaulting **unchecked**. When checked: the Training-state field becomes not-required and is
  hidden/disabled, and the derived **Region** shows **"Outside US"**.
- Persist via a new `people.outside_us` column. Map in `personToRow` (add `outside_us:
  p.outsideUs ?? false`) and `rowToPerson`.
- Validation: state required ONLY when `!outsideUs`.

**Steps:**
- [ ] Migration `supabase migration new people_outside_us` → `alter table people add column if
  not exists outside_us boolean not null default false;`
- [ ] `types.ts`: add `outsideUs?: boolean` to `Athlete`. `supabase.ts`: map both directions.
- [ ] `PersonForm.tsx` + `Profile.tsx`: add the checkbox; gate state-required on `!outsideUs`;
  Region field shows "Outside US" when checked (else the `STATE_REGIONS[state]` derivation).
- [ ] `npx eslint` the touched files; `npx vitest run`.
- [ ] Apply migration: `supabase db push` (sandbox disabled). Confirm column exists.
- [ ] Preview-verify at 3 widths: toggling Outside US hides/disables state, Region → "Outside US",
  save allowed without a state.
- [ ] Commit: `feat(profile): add Outside-US training option (region = Outside US, state optional)`

## Task 3: Coach-only field hiding & relabel (1e)

**Files:** `src/components/PersonForm.tsx`, `src/pages/Profile.tsx`

**Requirements:** For accounts that are **coach-only** (`roles.coach && !roles.athlete`, or
`kind==='coach'` in the create modal): hide AND un-require **Undergrad graduation year** and
**Student status**; relabel **"Training state" → "Coaching state"** (and in Task 2's Outside-US
copy too). Athlete or dual-role accounts keep the current fields/labels.

**Steps:**
- [ ] Compute `coachOnly` in both files. Wrap the grad-year and student-status `<Field>`s in
  `{!coachOnly && ...}`; exclude them from validation when `coachOnly`.
- [ ] Relabel the state field to "Coaching state" when `coachOnly` (param the label).
- [ ] `npx eslint` touched files; `npx vitest run`.
- [ ] Preview-verify: a coach-only profile hides those two fields and shows "Coaching state".
- [ ] Commit: `feat(profile): coach-only accounts hide student/grad fields, relabel coaching state`

## Task 4: New user roles — Regional Representative (+region) & Finance Admin (1f, 1g)

**Files:**
- Migrations (SEPARATE files, enum gotcha): one adds `'regional_rep'` to `app_role`, one adds
  `'finance_admin'`; a third creates `regional_rep_regions (user_id uuid, region text, primary
  key(user_id,region))` with RLS (admin write; self/admin read) for the per-rep region.
- Modify: `src/lib/supabase.ts` (grant/revoke already generic via `setUserRole`; add
  get/set for a rep's region — `setRegionalRepRegion`, include region in `fetchAllUserRoles`)
- Modify: `src/lib/capabilities-core.ts` + `capabilities.ts` (expose `isFinanceAdmin`,
  `isRegionalRep`, and the rep's region)
- Modify: `src/pages/Admin.tsx` (role-assignment UI: add the two roles; for Regional Rep show a
  region dropdown; allow multiple users per region)

**Requirements:**
- Add **Regional Representative** role with a **region dropdown** (the 7 NAIGC regions —
  derive the distinct list from `STATE_REGIONS` values in `types.ts`, plus "Outside US" if
  present). Multiple users may hold the same region.
- Add **Finance Admin** role (no extra attributes) — needed by Phase 5.
- Surface both in the Admin "User roles" UI with the same grant/revoke UX as `sanctioning`.

**Steps:**
- [ ] `supabase migration new app_role_regional_rep` → `alter type app_role add value if not
  exists 'regional_rep';` (own file).
- [ ] `supabase migration new app_role_finance_admin` → `alter type app_role add value if not
  exists 'finance_admin';` (own file).
- [ ] `supabase migration new regional_rep_regions` → create table + RLS (admin all; user reads
  own rows). Reference the region list as free text validated client-side.
- [ ] `supabase.ts`: extend the user-roles fetch to include each regional_rep's region (join
  `regional_rep_regions`); add `setRegionalRepRegion(userId, region)`.
- [ ] `capabilities-core.ts`: add `isFinanceAdmin = roles.includes('finance_admin')` and
  `isRegionalRep = roles.includes('regional_rep')` to `Capabilities` + `deriveCapabilities`.
  Update the capabilities test in `tests/` accordingly.
- [ ] `Admin.tsx`: add both roles to the role grid; for Regional Rep render a region `<select>`
  bound to `setRegionalRepRegion`.
- [ ] `npx vitest run` (capability tests pass); `npx eslint` touched files.
- [ ] `supabase db push` the three migrations (in order); confirm enum values + table exist.
- [ ] Preview-verify the Admin role UI renders both roles and the region dropdown (admin view).
- [ ] Commit: `feat(roles): add Regional Representative (with region) and Finance Admin roles`

## Task 5: Fix people-INSERT RLS save bug (1h)

**Files:**
- Modify: `src/lib/supabase.ts` (`pushPerson`/`personToRow` — include `auth_user_id` for the
  acting user's own row so a self INSERT satisfies the policy; and/or ensure self edits target
  the linked DB id)
- Migration: harden the `people` INSERT policy for self-claim by email if needed.

**Root cause (confirmed):** `personToRow` omits `auth_user_id`. When the acting user's local
person id doesn't match their linked DB row, `pushPerson` INSERTs a row with `auth_user_id=null`
→ fails `is_admin() OR manages_club(main_club_id) OR auth_user_id = auth.uid()` (a member does
not *manage* their own main club). Nate hit this saving his OWN profile signed in as the new
account.

**Requirements:** A signed-in user saving their own profile must succeed.
- **Client fix:** when pushing the acting user's own person, set `auth_user_id` to the current
  session user id (`getSession()?.user.id`) in the row so the `auth_user_id = auth.uid()` branch
  passes on INSERT. Do NOT set it for rows that aren't the acting self (admin/manager creating
  others stay as-is). Implement via an optional param to `pushPerson(p, { selfAuthUserId })` or by
  resolving the session inside `personToRow` guarded to the self id.
- **Belt-and-suspenders migration:** add a `people` INSERT policy branch allowing a row whose
  `lower(email)` matches the caller's verified `auth.jwt()->>'email'` and `auth_user_id` is the
  caller — so a self row inserts even if the client forgets the id linkage.
- Investigate (read-only) why the local person id can diverge from the linked DB id after
  `link_or_create_person` + `syncFromSupabase`; if there's a clear client-side linkage gap, fix
  it so self edits UPDATE rather than INSERT. (Use superpowers:systematic-debugging.)

**Steps:**
- [ ] Add the self `auth_user_id` to the pushed row for the acting user; keep others unchanged.
- [ ] `supabase migration new people_self_insert_by_email` → drop/recreate `people_admin_insert`
  adding `or (auth_user_id = auth.uid() and lower(email) = lower(coalesce(auth.jwt()->>'email','')))`.
- [ ] `npx eslint src/lib/supabase.ts`; `npx vitest run`.
- [ ] `supabase db push`; (cannot reproduce RLS locally — verify the policy SQL applies cleanly
  and reason through the three branches in the commit message).
- [ ] Commit: `fix(rls): allow a signed-in user to save their own people row (self INSERT)`

## Task 6: Kill auth-flash glitches (1i, 1j)

**Files:** `src/App.tsx`, `src/pages/Profile.tsx`, possibly `src/pages/SetPassword.tsx`

**Requirements:**
- **1i:** After "Confirm my account", a page flashes before settling on Home. Ensure the
  post-confirm boot routes to **Home first** (no intermediate flash). Inspect the `?setpw`/
  confirm boot path and the default redirect; route to `/` before any gated page renders.
- **1j:** After logout→login as a different account, a **"Person not found"** screen flashes
  before the new account's page loads. Guard the relevant page(s) so they show the loader (not a
  not-found) until `rolesLoaded` AND the person snapshot are ready; if the new account lacks
  access to the current route, navigate **Home** instead of flashing not-found.

**Steps:**
- [ ] Trace the confirm/login boot in `App.tsx`; ensure default landing = Home and no gated page
  renders mid-resolve. Add a "person loading" guard to `Profile.tsx` (show loader until the
  acting person resolves; route Home if no access).
- [ ] `npx eslint` touched files; `npx vitest run`.
- [ ] Preview-verify (best-effort without auth): no "Person not found" flash on a simulated
  person-load delay; default route is Home.
- [ ] Commit: `fix(auth): no page/not-found flash on confirm and account switch (land on Home)`

## Task 7: Forgot password + magic sign-in link (1k)

**Files:** `src/pages/Gate.tsx`, `src/App.tsx` (handle the recovery/magic redirect like
`?setpw=1`), `src/lib/auth.ts` if needed, Supabase redirect-URL config (note for Nate).

**Requirements:**
- Add **"Forgot my password"** on the sign-in gate → `supabase.auth.resetPasswordForEmail(email,
  { redirectTo: <app base>?setpw=1 })` → lands on `/set-password` (reuse the existing HashRouter
  workaround).
- Add a **magic sign-in link** option → `supabase.auth.signInWithOtp({ email, options: {
  emailRedirectTo: <app base> } })` that emails a link; clicking it auto-logs-in. Show a
  "check your email" confirmation. Keep the existing password sign-in.
- Both must use redirect URLs already whitelisted (`…/ucg-platform/**`, `localhost:5173/**`).

**Steps:**
- [ ] Add a "Forgot my password" link + a "Email me a sign-in link" action to `AuthGate` in
  `Gate.tsx`, with their own busy/info/error states and AA-contrast styling on the navy gate.
- [ ] Wire `resetPasswordForEmail` (with `?setpw=1` redirect) and `signInWithOtp`. Ensure
  `App.tsx`'s setpw redirect handles the recovery link landing.
- [ ] `npx eslint src/pages/Gate.tsx src/App.tsx`; `npx vitest run`.
- [ ] Preview-verify the gate UI renders both actions with legible contrast at 375/768/1280.
- [ ] Commit: `feat(auth): forgot-password reset and passwordless magic sign-in link`

## Final
- [ ] Full `npm test`, `npx eslint` on all touched files, `npm run build` (confirm
  `dist/index.html` script refs resolve under `dist/assets`).
- [ ] Responsive sweep (375/768/1280) on the gate + profile form.
- [ ] Update docs: `CLAUDE.md` (roles, Outside-US, RLS fix, forgot-pw), `supabase/README.md`
  (new migrations, regional_rep_regions, policy), `docs/README.md` if needed.
- [ ] Final code review subagent, then merge to `main` & push (per standing instruction).
