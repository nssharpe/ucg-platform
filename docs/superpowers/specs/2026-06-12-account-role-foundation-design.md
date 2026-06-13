# Account & role foundation — design (2026-06-12)

Sub-project **A** of the role-management / auth-hardening effort. Replaces the
prototype's single-role "Viewing as" switcher with real Supabase-auth-driven
capabilities, links accounts to person records, and gives admins and club
managers the tools to grant roles and manage clubs. Unblocks B (typed
memberships + waiver + Stripe), C (clubs/registration), D (judge access),
E (meet scoring config), which are separate specs.

## Context

Current state (see `src/lib/store.ts`, `src/lib/auth.ts`, `supabase/migrations/`):
- `useRole()` reads one role from `sessionStorage` ('admin' default) and drives the
  whole sidebar/permission surface. `usePersona()` / `setViewPersonId()` impersonate
  a person for everyone.
- Supabase auth is wired (`Gate.tsx` shows email/password when configured). New
  sign-ups get **no** `user_roles`, so role-gated writes fail silently under RLS.
- RLS (`0002_rls.sql`) already does public-read + admin-all + self/club-manager
  scoping. `people.auth_user_id` links a person to an auth user. `club_managers`
  is the person↔club manager join; `person_alt_clubs` the multi-club join.
- ~1,500 imported `people` (Nationals data) and club-manager-created athletes exist
  with emails but no `auth_user_id`.

### Role model simplification (the core insight)

The six prototype roles collapse under real auth:

| Prototype role | Real model |
|---|---|
| admin | explicit `user_roles` grant |
| club-manager | `club_managers` row (person↔club) |
| athlete / coach | **not roles** — membership types + a person record |
| meet-host | **derived** = club-manager of the meet's `host_club_id` |
| judge | **account-free** (sub-project D) |
| spectator | **not logged in** (public read) |

So the only true account role is **admin**; **club-manager** lives in
`club_managers`; everyone else is a "baseline logged-in person" whose capabilities
flow from memberships and club links. The `app_role` enum keeps all its values
(no destructive migration); we simply stop issuing judge/meet-host/spectator.

## Architecture

### 1. Capability model — `src/lib/capabilities.ts`

A `useCapabilities()` hook (and non-reactive `getCapabilities()`), derived from the
auth session + the in-memory DB, replacing `useRole()` as the permission source:

```ts
interface Capabilities {
  signedIn: boolean;
  isAdmin: boolean;
  personId: string | null;          // linked people row
  person: Athlete | null;
  managedClubIds: string[];          // from club_managers
  isMeetHost: (meetId: string) => boolean;   // manages the meet's host club
  currentMembership: MembershipStatus;       // the acting person's current-season membership row status
  canRegister: boolean;                      // signedIn && currentMembership === 'active'
  // impersonation (admin only)
  impersonating: boolean;
  actingPersonId: string | null;     // personId, or the impersonated person
}
```

- When an admin impersonates (existing `setViewPersonId`), `actingPersonId` and the
  derived club/membership fields recompute for the target; `isAdmin` stays true so
  RLS still permits writes. The "View as" control is **admin-gated** and relabeled.
- The current `memberships` table has one row per (person, season) with no type
  column (the athlete/coach/club split is added in B). So A reads that single row:
  `currentMembership` is its status for the current season, and `canRegister`
  derives from it. The typed-membership API (`membership('athlete'|'coach'|'club',
  season)`) lands with B; A deliberately does not model types yet.

Nav and per-page guards switch from `role === X` checks to capability checks. The
`ROLES`/`useRole`/`setRole` machinery is removed; `Layout.tsx` renders nav from
capabilities (union, not a toggle). `usePersona`/`setViewPersonId` stay (now
admin-only impersonation).

### 2. Sign-up → person claim — `link_or_create_person` RPC

A security-definer Postgres function (migration `0005`):

```sql
create function link_or_create_person(p_first text, p_last text)
returns uuid  -- the linked/created people.id
```

Logic: if a `people` row has `lower(email) = lower(auth.email())` and
`auth_user_id is null`, set its `auth_user_id = auth.uid()` and return it
(claim). Otherwise insert a new row (`auth_user_id = auth.uid()`, email from
`auth.email()`, kind 'athlete', given names) and return it. Idempotent: if the
caller already has a linked person, return it unchanged.

- Called from `auth.ts` once per session after `getSession()` resolves with a user
  that has no linked person yet; result cached.
- **Email confirmation ON** (Supabase Auth setting) — this is what makes claim-by-
  email safe: a user can only claim a row whose inbox they verified. Document this
  as a required project setting.
- `Gate.tsx` sign-up form gains **first name** + **last name** fields, passed to the
  RPC on first load (held in `sessionStorage` between sign-up and confirmation).

### 3. Role & club-management UI

- **AdminMembers** (`src/pages/Admin.tsx`): per-person row actions — "Make admin" /
  "Remove admin" (writes `user_roles`), "Add as manager of…" (writes
  `club_managers`). Visible only when `isAdmin`.
- **Club page** (`src/pages/Club.tsx`): a **Managers** section for admins and the
  club's own managers — add (search existing people or enter an email to pre-create
  an unclaimed person) / remove managers for **that** club.
- **New-club request**: a "Request a new club" form for any signed-in person → insert
  into `club_requests`. An admin queue (in AdminClubs) lists pending requests with
  **Approve** (creates the club via existing ClubForm prefilled, then inserts a
  `club_managers` row for the requester) and **Dismiss**. Email to
  `newclubinquiries@naigc.org` is deferred (see CLAUDE.md) — in-app queue is the
  source of truth for now.
- **Self-attach to clubs** (`src/pages/Profile.tsx`): a "My clubs" section — set
  `main_club_id`, add/remove alt clubs (`person_alt_clubs`). Uses the searchable
  `Combo`. Already permitted by the `alt_self` RLS policy.

### 4. Data model + RLS — migration `0005_account_foundation.sql`

- **`club_requests`** table:
  `id uuid pk, requester_person_id uuid, proposed_name text, short_name text,
   state text, region text, note text, status text default 'pending'
   ('pending'|'approved'|'dismissed'), created_at, decided_at, decided_by uuid`.
  RLS: requester reads own + admin reads all; requester inserts own; admin updates.
- **Widen `club_managers` writes**: replace the admin-only `cm_admin` policy with a
  policy allowing `is_admin()` OR an existing manager of the **same** `club_id`
  (`manages_club(club_id)`). Insert/delete both covered.
- **`link_or_create_person()`** security-definer function (above).
- Self-action policies already exist (people self update, memberships_write,
  alt_self, regs_write) — verify they cover a baseline authenticated user with no
  roles. This is what removes the "silent write failure": self-actions are gated on
  ownership, not on holding a role.
- These changes are applied to the live DB via the Supabase SQL editor (per the
  project's migration workflow) and committed as `0005`.

### 5. Deferred (other specs)
Typed membership purchase + per-season waiver + Stripe (B); club membership $109 +
club-based registration multi-club picker (C); codeless judge access (D); meet
scoring config (E). A shows a "buy an athlete membership to register" prompt where
B's purchase will land, but does not build the purchase.

## Components & boundaries

| Unit | Responsibility | Depends on |
|---|---|---|
| `capabilities.ts` | derive what the current (possibly impersonated) user can do | auth session, DB, `club_managers`, `memberships` |
| `link_or_create_person` RPC | safely link/create a person on first sign-in | auth.uid()/email, `people` |
| `Gate.tsx` | email/password auth + name capture on sign-up | auth, capabilities |
| Admin role/club tools | grant admin, assign managers, approve club requests | capabilities (isAdmin), `user_roles`, `club_managers`, `club_requests` |
| Club Managers section | club managers co-manage their club | capabilities, `club_managers` |
| Profile My-clubs | self-attach to clubs | capabilities, `person_alt_clubs`, `people.main_club_id` |
| `0005` migration | `club_requests`, widened `club_managers` RLS, RPC | existing schema |

## Error handling
- RPC failures (claim/create) surface a toast and a retry; the app still renders
  public content while unlinked.
- A write rejected by RLS (e.g. a non-manager trying to add a manager) surfaces an
  explicit error toast instead of silently no-oping — the write helpers in
  `supabase.ts` already return errors; wire them to toasts at the call sites touched
  here.
- Impersonation is a no-op for non-admins (control not rendered; `setViewPersonId`
  guarded).

## Testing
Manual, in prod-preview against a throwaway Supabase auth account (do not pollute
prod data; clean up created rows after):
1. Sign up a brand-new email → a fresh `people` row is created and linked.
2. Sign up using an imported athlete's email → that existing row is claimed
   (registrations/history intact, `auth_user_id` set).
3. Baseline account: can edit own profile, self-attach to two clubs, submit a club
   request; sees the "buy a membership to register" prompt; cannot register.
4. Admin grants admin to another user and assigns them as a club manager.
5. A club manager adds and removes a co-manager on their own club; cannot manage a
   different club's managers.
6. Admin approves a club request → club created + requester is its manager.
7. Impersonation control appears only for admins and recomputes capabilities.
8. `tsc -b` clean; lint clean for touched files; build verified (dist asset refs).
