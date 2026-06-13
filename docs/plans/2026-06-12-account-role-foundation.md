# Account & Role Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the prototype's single-role "Viewing as" switcher with real Supabase-auth-driven capabilities — account↔person claim-by-email, admin role grants, club-manager co-management, new-club requests, and self-attach-to-clubs.

**Architecture:** A pure `deriveCapabilities(session, db, actingPersonId)` function + `useCapabilities()` hook becomes the single permission source, replacing `useRole`. A security-definer RPC links/creates a person on first sign-in. A `0005` migration adds `club_requests`, widens `club_managers` RLS, and adds the RPC. UI pages switch from `role === X` checks to capability checks.

**Tech Stack:** React 19, TypeScript, Vite, react-router (HashRouter), Supabase (auth + Postgres + RLS), localStorage write-through store.

**Verification reality:** No test runner exists; verification is `tsc -b` (clean), ESLint on touched files (clean), and manual prod-preview against the **live** Supabase project. Two steps need human hands and are called out where they occur: (a) pasting `0005` into the Supabase SQL editor, (b) confirming Supabase Auth "Confirm email" is ON.

**Build commands (path has spaces + `&` — never use npm/npx shims):**
- Typecheck: `node node_modules/typescript/bin/tsc -b`
- Lint a file: `node node_modules/eslint/bin/eslint.js <path>`
- Build: remove `dist` with retries, then `node node_modules/vite/bin/vite.js build`, then re-set `dist:com.dropbox.ignored=1` ADS (see CLAUDE.md).
- Preview: `ucg-prod-preview` launch config (rebuild first; clear SW).

---

## File structure

| File | Responsibility | New? |
|---|---|---|
| `supabase/migrations/0005_account_foundation.sql` | `club_requests` table, widened `club_managers` RLS, `link_or_create_person` RPC | Create |
| `src/lib/types.ts` | add `ClubRequest` type; add `clubRequests` to `DB` | Modify |
| `src/lib/seed.ts` | seed `clubRequests: []` | Modify |
| `src/lib/supabase.ts` | read `club_requests` in `loadAll`; push helpers for `user_roles`, `club_managers`, `club_requests`; `linkOrCreatePerson()` RPC; `fetchMyRoles()` | Modify |
| `src/lib/capabilities.ts` | `deriveCapabilities()` (pure) + `useCapabilities()` hook | Create |
| `src/lib/auth.ts` | on first session, call `linkOrCreatePerson`; expose `useMyRoles()` | Modify |
| `src/lib/store.ts` | remove `ROLES`/`useRole`/`setRole`; keep persona machinery (admin impersonation only) | Modify |
| `src/pages/Gate.tsx` | sign-up first/last name fields; stash for post-confirm linking | Modify |
| `src/components/Layout.tsx` | nav + impersonation control from capabilities | Modify |
| `src/pages/Profile.tsx` | "My clubs" section (main + alt clubs) | Modify |
| `src/pages/Club.tsx` | "Managers" section (add/remove, admin or club's manager) | Modify |
| `src/pages/Admin.tsx` | AdminMembers: make-admin + assign-manager; AdminClubs: club-request queue + approve; "Request a new club" entry | Modify |
| `src/App.tsx` | route guards switch to capabilities | Modify |

Consumers of the removed `useRole` (must each migrate to `useCapabilities`): `Layout.tsx`, `App.tsx`, `ScoreDetail.tsx`, and any page reading `useRole`/`ROLES`. Task 8 enumerates them from a grep so none is missed.

---

## Task 1: Migration 0005 — club_requests, club_managers RLS, link RPC

**Files:**
- Create: `supabase/migrations/0005_account_foundation.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 0005 — Account & role foundation
-- New-club requests, club managers co-managing their own club, and a
-- security-definer RPC that links a new auth user to an existing (claimed by
-- verified email) or freshly created person row.

-- --- club_requests -------------------------------------------------------
create table if not exists club_requests (
  id                  uuid primary key default gen_random_uuid(),
  requester_person_id uuid references people (id) on delete set null,
  proposed_name       text not null,
  short_name          text not null default '',
  state               text,
  region              text,
  note                text not null default '',
  status              text not null default 'pending', -- pending | approved | dismissed
  created_at          timestamptz not null default now(),
  decided_at          timestamptz,
  decided_by          uuid references auth.users (id) on delete set null,
  created_club_id     text references clubs (id) on delete set null
);
create index if not exists club_requests_status_idx on club_requests (status);

alter table club_requests enable row level security;

create policy club_requests_read on club_requests for select
  using (is_admin() or requester_person_id = my_person_id());
create policy club_requests_insert on club_requests for insert
  with check (requester_person_id = my_person_id());
create policy club_requests_admin on club_requests for update
  using (is_admin()) with check (is_admin());

-- --- widen club_managers writes: admins OR a manager of THAT club ---------
drop policy if exists cm_admin on club_managers;
create policy cm_write on club_managers for all
  using (manages_club(club_id)) with check (manages_club(club_id));
-- (manages_club already returns true for admins; cm_read stays unchanged.)

-- --- link-or-create person on first sign-in ------------------------------
-- Claims an existing unclaimed row whose email matches the verified auth
-- email; otherwise inserts a new person. Idempotent.
create or replace function link_or_create_person(p_first text, p_last text)
returns uuid as $$
declare
  v_uid   uuid := auth.uid();
  v_email text := auth.email();
  v_id    uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  -- Already linked?
  select id into v_id from people where auth_user_id = v_uid limit 1;
  if v_id is not null then
    return v_id;
  end if;

  -- Claim an unclaimed row with a matching verified email.
  update people
    set auth_user_id = v_uid
    where auth_user_id is null
      and lower(email) = lower(v_email)
    returning id into v_id;
  if v_id is not null then
    return v_id;
  end if;

  -- Otherwise create a fresh person.
  insert into people (auth_user_id, kind, first_name, last_name, email)
    values (v_uid, 'athlete', coalesce(nullif(p_first,''),'New'),
            coalesce(nullif(p_last,''),'Member'), v_email)
    returning id into v_id;
  return v_id;
end;
$$ language plpgsql volatile security definer;

grant execute on function link_or_create_person(text, text) to authenticated;
```

- [ ] **Step 2: Validate SQL parses** (no live DB needed)

Run: `node -e "const s=require('fs').readFileSync('supabase/migrations/0005_account_foundation.sql','utf8'); console.log(s.includes('link_or_create_person') && s.includes('club_requests') ? 'OK' : 'MISSING')"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0005_account_foundation.sql
git commit -m "0005: club_requests, club-manager co-management RLS, link_or_create_person RPC"
```

- [ ] **Step 4: HUMAN STEP — apply to live DB.** Paste `0005` into the Supabase SQL editor and run it (watch the monaco setValue gotcha: type a character before Run, read the result from the table not the toast). Also confirm Auth → Providers → Email → "Confirm email" is ON. This is required before Task 5+ can be verified against live.

---

## Task 2: Types + seed for club_requests

**Files:**
- Modify: `src/lib/types.ts`
- Modify: `src/lib/seed.ts`

- [ ] **Step 1: Add the `ClubRequest` type and extend `DB`** in `types.ts`:

```ts
export interface ClubRequest {
  id: string;
  requesterPersonId: string | null;
  proposedName: string;
  shortName: string;
  state: string;
  region: Region | '';
  note: string;
  status: 'pending' | 'approved' | 'dismissed';
  createdAt: string;
  decidedAt?: string | null;
  createdClubId?: string | null;
}
```
Add `clubRequests: ClubRequest[];` to the `DB` interface.

- [ ] **Step 2: Seed empty list** — in `seed.ts`, add `clubRequests: [],` to the returned `DB` object.

- [ ] **Step 3: Typecheck**

Run: `node node_modules/typescript/bin/tsc -b`
Expected: errors only where `db.clubRequests` is not yet consumed are impossible (it's optional to read); must be clean. If `loadAll` shape complains, it is fixed in Task 3.

- [ ] **Step 4: Commit**

```bash
git add src/lib/types.ts src/lib/seed.ts
git commit -m "Add ClubRequest type + seed list"
```

---

## Task 3: Supabase data-layer helpers

**Files:**
- Modify: `src/lib/supabase.ts`

- [ ] **Step 1: Read `club_requests` in `loadAll`.** Add a `from('club_requests')` select alongside the other tables and map rows → `ClubRequest` (snake→camel). Include `clubRequests` in the returned `DB`. Empty/missing table → `[]`.

- [ ] **Step 2: Add write helpers** (fire-and-forget, `isSupabaseConfigured`-guarded, matching the file's existing `push*` style):

```ts
export async function pushUserRole(userId: string, role: string, grant: boolean) { /* upsert/delete user_roles */ }
export async function pushClubManager(clubId: string, personId: string, add: boolean) { /* insert/delete club_managers */ }
export function pushClubRequest(r: ClubRequest) { /* upsert club_requests (snake-case row) */ }
export async function fetchMyRoles(): Promise<string[]> { /* select role from user_roles where user_id = auth.uid() */ }
export async function linkOrCreatePerson(first: string, last: string): Promise<string | null> {
  if (!isSupabaseConfigured || !supabase) return null;
  const { data, error } = await supabase.rpc('link_or_create_person', { p_first: first, p_last: last });
  if (error) { console.error(error); return null; }
  return data as string;
}
```
Follow the exact snake_case column names from `0001`/`0005`. `pushUserRole(grant=false)` deletes the `(user_id, role)` row; `pushClubManager(add=false)` deletes the `(club_id, person_id)` row.

- [ ] **Step 3: Typecheck + lint touched file**

Run: `node node_modules/typescript/bin/tsc -b && node node_modules/eslint/bin/eslint.js src/lib/supabase.ts`
Expected: tsc clean. (supabase.ts has pre-existing `any` lint debt; ensure you add **no new** lint errors beyond the existing baseline — compare counts.)

- [ ] **Step 4: Commit**

```bash
git add src/lib/supabase.ts
git commit -m "Supabase helpers: roles, club managers, club requests, link RPC"
```

---

## Task 4: Capabilities module (the linchpin)

**Files:**
- Create: `src/lib/capabilities.ts`

- [ ] **Step 1: Write the pure derivation + hook.**

```ts
// The single source of truth for "what can the current user do", derived from
// the auth session, the user's roles, the DB, and (admin-only) impersonation.
import { useSyncExternalStore } from 'react';
import type { DB, Athlete, MembershipStatus } from './types';
import { getDB, useDB } from './store';
import { getSession, useSession, useMyRoles } from './auth';
import { useViewPersonId, getViewPersonId } from './store';

export interface Capabilities {
  signedIn: boolean;
  isAdmin: boolean;
  personId: string | null;       // the acting person (impersonated target if admin is impersonating)
  person: Athlete | null;
  managedClubIds: string[];
  isMeetHost: (meetId: string) => boolean;
  currentMembership: MembershipStatus;
  canRegister: boolean;
  impersonating: boolean;
}

export function deriveCapabilities(
  db: DB, signedIn: boolean, roles: string[], authPersonId: string | null,
  viewPersonId: string | null, currentSeasonId: string | null,
): Capabilities {
  const isAdmin = roles.includes('admin');
  const impersonating = isAdmin && !!viewPersonId && viewPersonId !== authPersonId;
  const personId = impersonating ? viewPersonId! : authPersonId;
  const person = personId ? db.people.find((p) => p.id === personId) ?? null : null;
  const managedClubIds = personId
    ? db.clubs.filter((c) => c.managerIds.includes(personId)).map((c) => c.id)
    : [];
  const membership = person && currentSeasonId
    ? person.memberships.find((m) => m.seasonId === currentSeasonId)
    : undefined;
  const currentMembership: MembershipStatus = membership?.status ?? 'none';
  return {
    signedIn, isAdmin, personId, person, managedClubIds, impersonating,
    isMeetHost: (meetId) => {
      const meet = db.meets.find((m) => m.id === meetId);
      return isAdmin || (!!meet && managedClubIds.includes(meet.hostClubId));
    },
    currentMembership,
    canRegister: signedIn && currentMembership === 'active',
  };
}

function currentSeasonId(db: DB): string | null {
  return db.seasons.find((s) => s.current)?.id ?? null;
}

export function useCapabilities(): Capabilities {
  const db = useDB();
  const session = useSession();
  const roles = useMyRoles();
  const viewPersonId = useViewPersonId();
  const authPersonId = db.people.find((p) => p.email && session?.user?.email
    && p.email.toLowerCase() === session.user.email.toLowerCase())?.id ?? null;
  return deriveCapabilities(db, !!session, roles, authPersonId, viewPersonId, currentSeasonId(db));
}

export function getCapabilities(): Capabilities {
  const db = getDB();
  const session = getSession();
  const authPersonId = db.people.find((p) => p.email && session?.user?.email
    && p.email.toLowerCase() === session.user.email.toLowerCase())?.id ?? null;
  // Non-reactive: roles fetched lazily elsewhere; default to [] when unknown.
  return deriveCapabilities(db, !!session, [], authPersonId, getViewPersonId(), currentSeasonId(db));
}
```

Note: `authPersonId` is matched by the session email against `people.email` for the reactive snapshot (the linked row shares that email after the RPC). `roles` come from `useMyRoles()` (Task 5). When Supabase is unconfigured (password-gate prototype), `session` is null → fall back handled in Task 8.

- [ ] **Step 2: Add `getViewPersonId()` non-reactive getter** to `store.ts` (next to `useViewPersonId`):

```ts
export function getViewPersonId(): string | null { return viewPersonId; }
```

- [ ] **Step 3: Typecheck**

Run: `node node_modules/typescript/bin/tsc -b`
Expected: fails only on `useMyRoles` (added Task 5). If you implement Task 5 first this is clean; otherwise temporarily expect that one missing-export error and resolve it in Task 5.

- [ ] **Step 4: Commit**

```bash
git add src/lib/capabilities.ts src/lib/store.ts
git commit -m "Add capabilities derivation (pure) + useCapabilities hook"
```

---

## Task 5: Auth — link person on sign-in, expose roles

**Files:**
- Modify: `src/lib/auth.ts`

- [ ] **Step 1:** After the session resolves (in the `getSession().then` and `onAuthStateChange` handlers), if there is a user, call `linkOrCreatePerson(first, last)` once — reading stashed names from `sessionStorage` key `ucg-signup-name` (set by Gate; default `'', ''`). Then call `fetchMyRoles()` and store the result in a module `roles` variable with its own listener set, exposed as:

```ts
let roles: string[] = [];
export function useMyRoles(): string[] { /* useSyncExternalStore over a roles listener set */ }
export function getMyRoles(): string[] { return roles; }
```

Guard so the link RPC runs at most once per session (a `linked` flag). After linking, trigger `syncFromSupabase()` so the claimed/created person row is in the local snapshot.

- [ ] **Step 2: Typecheck + lint**

Run: `node node_modules/typescript/bin/tsc -b && node node_modules/eslint/bin/eslint.js src/lib/auth.ts src/lib/capabilities.ts`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/lib/auth.ts
git commit -m "Link/create person on sign-in; expose useMyRoles"
```

---

## Task 6: Gate — capture name on sign-up

**Files:**
- Modify: `src/pages/Gate.tsx`

- [ ] **Step 1:** In `AuthGate`, when `mode === 'sign-up'`, render **First name** and **Last name** inputs above email. On submit (sign-up branch), before `supabase.auth.signUp`, stash `sessionStorage.setItem('ucg-signup-name', JSON.stringify([first, last]))` so `auth.ts` can read it after email confirmation + first sign-in. Keep the existing styles (navy gate). Names are not required for sign-in.

- [ ] **Step 2: Typecheck + lint**

Run: `node node_modules/typescript/bin/tsc -b && node node_modules/eslint/bin/eslint.js src/pages/Gate.tsx`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/pages/Gate.tsx
git commit -m "Capture first/last name on sign-up for person linking"
```

---

## Task 7: Remove the role switcher from the store

**Files:**
- Modify: `src/lib/store.ts`

- [ ] **Step 1:** Delete `ROLES`, `useRole`, `setRole`, `currentRole`, `roleListeners`, and `ROLE_KEY`. Keep `usePersona`/`getPersona`/`useViewPersonId`/`setViewPersonId`/`getViewPersonId` (now used only for admin impersonation). Keep the `Persona` interface and `DEFAULT_PERSONA`.

- [ ] **Step 2: Typecheck to surface every consumer**

Run: `node node_modules/typescript/bin/tsc -b 2>&1 | head -40`
Expected: a list of files importing `useRole`/`ROLES`/`setRole`. Record them — Task 8 migrates each. Do not commit until Task 8 makes tsc clean (these two tasks land together).

---

## Task 8: Migrate all consumers to capabilities; Layout nav + impersonation

**Files:**
- Modify: `src/components/Layout.tsx`, `src/App.tsx`, `src/pages/ScoreDetail.tsx`, and every file surfaced by Task 7 step 2.

- [ ] **Step 1: Enumerate consumers**

Run: `node node_modules/@eslint/js/... ` — instead use grep: `node node_modules/typescript/bin/tsc -b 2>&1` (from Task 7) lists them. Also: search for `useRole`, `ROLES`, `role ===`, `usePersona` references.

- [ ] **Step 2: Layout.tsx** — replace the role `<select>` with: nav links rendered from `useCapabilities()` (everyone: Home, Results, Meets; signed-in: My Profile, Membership, Clubs; `canRegister`: Register; `managedClubIds.length`: Club roster/registration; `isAdmin`: League Controls + AdminMembers + AdminClubs). Replace the persona `Combo` with an **admin-only** "View as (person)" `Combo` (render only when `isAdmin`); selecting sets `setViewPersonId`. Show a small "Viewing as X — exit" banner when `impersonating`. Add a **Sign out** action (already present) and, when not signed in, a "Sign in" link to the gate.

- [ ] **Step 3: App.tsx + other pages** — replace each `role === 'admin'`/etc. check with the matching capability (`isAdmin`, `canRegister`, `managedClubIds.includes(...)`, `isMeetHost(meetId)`, `person?.id === ...`). In `ScoreDetail.tsx`, `canView`/`canAdjust` use `isAdmin` + `person?.id === reg.athleteId` (replace the `role === 'judge'|'meet-host'` branches: judges no longer have accounts, so score-detail view is admin + owning athlete + meet host via `isMeetHost(score.meetId)`).

- [ ] **Step 4: Prototype (unconfigured) fallback** — when `!isSupabaseConfigured`, `useCapabilities` has no session. To keep the password-gate demo usable, in that mode treat the user as admin (so the local-seed prototype still exposes every screen). Implement: in `useCapabilities`, if `!isSupabaseConfigured`, return caps with `isAdmin: true, signedIn: true, personId: persona.athleteId` using the existing `getPersona()`. This preserves the current demo while real auth governs the configured app.

- [ ] **Step 5: Typecheck + lint + build**

Run: `node node_modules/typescript/bin/tsc -b && node node_modules/eslint/bin/eslint.js src/components/Layout.tsx src/App.tsx src/pages/ScoreDetail.tsx`
Expected: clean (no remaining `useRole` references anywhere).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Drive nav + permissions from capabilities; admin-only impersonation"
```

---

## Task 9: Profile — "My clubs"

**Files:**
- Modify: `src/pages/Profile.tsx`

- [ ] **Step 1:** Add a "My clubs" card visible when `person` exists. Controls: a `Combo` to set **main club** (`people.main_club_id` → `pushPerson`), and an add/remove list for **alt clubs** (`person_alt_clubs`; reflect into `person.altClubIds` and call a `pushAltClub(personId, clubId, add)` helper — add it to `supabase.ts` mirroring `pushClubManager`). Self-writes are already permitted by the `alt_self` RLS policy. Use `mutate` for the local snapshot + the push helper for remote, matching the existing write-through pattern.

- [ ] **Step 2: Typecheck + lint**

Run: `node node_modules/typescript/bin/tsc -b && node node_modules/eslint/bin/eslint.js src/pages/Profile.tsx src/lib/supabase.ts`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "Profile: self-attach to main + alternate clubs"
```

---

## Task 10: Club — Managers section

**Files:**
- Modify: `src/pages/Club.tsx`

- [ ] **Step 1:** For a club where `isAdmin || managedClubIds.includes(club.id)`, render a "Managers" card listing current managers (from `club.managerIds` → people). Add: a `Combo` over existing people to add a manager, plus an "invite by email" input that pre-creates an unclaimed person (insert into `people` with email only via a `pushPerson`-style helper, then add as manager). Remove buttons per manager. Each change updates `club.managerIds` locally (`mutate`) and calls `pushClubManager(clubId, personId, add)`. Guard the whole card behind the capability check so non-managers never see it.

- [ ] **Step 2: Typecheck + lint**

Run: `node node_modules/typescript/bin/tsc -b && node node_modules/eslint/bin/eslint.js src/pages/Club.tsx`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "Club page: co-manage club managers (admin or club's manager)"
```

---

## Task 11: Admin — role grants, club-request queue, request form

**Files:**
- Modify: `src/pages/Admin.tsx`

- [ ] **Step 1: AdminMembers role tools** — per person row (admins only): a "Make admin / Remove admin" toggle (needs the person's `auth_user_id`; if unlinked, disable with tooltip "no account yet") calling `pushUserRole(authUserId, 'admin', grant)`, and an "Add as manager of…" `Combo` over clubs calling `pushClubManager(clubId, personId, true)` + local `mutate`.

- [ ] **Step 2: AdminClubs request queue** — a "Club requests" card listing `db.clubRequests.filter(status==='pending')`. **Approve**: open the existing `ClubForm` modal prefilled from the request; on save, create the club (existing path), set the requester as its manager (`pushClubManager`), then mark the request `approved` with `createdClubId` (`pushClubRequest`). **Dismiss**: set status `dismissed` (`pushClubRequest`).

- [ ] **Step 3: "Request a new club" form** — available to any signed-in person (place on AdminClubs for admins and add a small entry on Profile or Clubs list for non-admins): a modal collecting proposed name / short name / state (region derived) / note → insert a `ClubRequest` (`requesterPersonId = personId`, `status:'pending'`) via `pushClubRequest` + local `mutate`. Note in helper text that email notification to newclubinquiries@naigc.org is coming later (deferred per CLAUDE.md).

- [ ] **Step 4: Typecheck + lint**

Run: `node node_modules/typescript/bin/tsc -b && node node_modules/eslint/bin/eslint.js src/pages/Admin.tsx`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Admin: grant admin/manager, approve club requests; new-club request form"
```

---

## Task 12: Build, verify against live Supabase, push

**Files:** none (verification + release)

- [ ] **Step 1: Full typecheck + build**

Run: `node node_modules/typescript/bin/tsc -b` then the Dropbox-safe build (remove dist w/ retries → `vite build` → re-set ADS) and verify `dist/index.html` asset refs exist.
Expected: tsc clean; "files generated"; all asset refs present.

- [ ] **Step 2: Manual verification (live Supabase)** — with `0005` applied and Confirm-email ON, in prod-preview (Supabase env present), exercise the spec's test matrix:
  1. Sign up a new email → fresh linked person.
  2. Sign up with an imported athlete's email → claims that row (history intact, `auth_user_id` set).
  3. Baseline account: edit profile, self-attach to two clubs, submit a club request; sees "buy a membership to register"; cannot register.
  4. Admin grants admin + assigns a manager.
  5. A manager adds/removes a co-manager on their own club; cannot touch another club's managers.
  6. Admin approves a club request → club created + requester is manager.
  7. Impersonation control appears only for admins and recomputes capabilities.

  Capture evidence (snapshots/screenshots). Clean up throwaway rows (delete test auth users + their people rows) afterward.

- [ ] **Step 3: Push + watch deploy**

```bash
git push origin main
```
Then watch the GitHub Actions deploy to success (`gh run watch`). NOTE: pushing to `main` is user-gated in this environment — request the push if the classifier blocks it.

- [ ] **Step 4: Code review** — invoke superpowers:requesting-code-review on the branch diff before considering A done.

---

## Self-review notes (author)
- **Spec coverage:** capability model (T4,T8) · claim-by-email RPC + confirm-email (T1,T5,T6) · admin role/club tools (T11) · club-manager co-management + widened RLS (T1,T10) · new-club request + queue (T1,T2,T11) · self-attach clubs (T9) · impersonation admin-gated (T8) · silent-write-failure dissolved via ownership-based self-policies (T1 note, existing RLS). All present.
- **Deferred (not in this plan, by design):** typed membership purchase/waiver/Stripe (B), club-based registration multi-club picker (C), judge access (D), meet scoring config (E), real club-request email.
- **Naming consistency:** `linkOrCreatePerson`/`link_or_create_person`, `pushClubManager`, `pushUserRole`, `pushClubRequest`, `useMyRoles`, `useCapabilities`, `getViewPersonId` used consistently across tasks.
