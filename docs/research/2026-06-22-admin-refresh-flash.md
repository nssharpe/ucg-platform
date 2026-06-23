# Admin-page refresh flash — diagnosis and options

> Research note, 2026-06-22. Answers: "When you refresh on an admin-only page, it shows
> a dark version of a page and then a light version of a blank page showing a padlock
> icon and 'Admin access required' before then finishing loading and showing the actual
> page. This seems suboptimal — what are our options?"

## Root cause (confirmed in code)

On refresh there are **two** async loads racing the first render:

1. **Session** — `supabase.auth.getSession()` resolves the logged-in user
   (`src/lib/auth.ts`). `App.tsx` already handles this: if `hasLikelySession()` is true
   it shows `<PageFallback />` until the session resolves, so we don't flash the *gate*.
2. **Roles** — only *after* the session resolves does `onAuthenticated()` call
   `fetchMyRoles()` and populate `roles` (`auth.ts:73`). Until that returns, `useMyRoles()`
   is `[]`, so `caps.isAdmin` is **false**.

`RequireAdmin` (`src/App.tsx:99`) checks `caps.isAdmin` with no awareness of whether
roles have *loaded yet*. So during the window "session resolved, roles not yet loaded,"
an actual admin renders the **"🔒 Admin access required"** denial screen — then roles
arrive and it flips to the real page. That's the flash. (The "dark then light" is the
`PageFallback`/navy boot screen giving way to the white denial card.)

The same gap affects `Sanction.tsx`'s role-gated screens (club-manager / sanctioning-team
"access required").

## Options

### Option A — Add a `rolesLoaded` state and show the loader until roles are known *(recommended)*
Track whether `fetchMyRoles` has completed for the current user. While
`signedIn && !rolesLoaded`, `RequireAdmin` (and the other role gates) render
`<PageFallback />` instead of the denial card. Only show "Admin access required" once we
*know* the user truly lacks the role.

- **Pros:** correct, small, fixes the root cause for every role gate; no UX downside.
- **Cons:** must thread a `rolesLoaded` flag through `auth.ts` → `capabilities` → gates.
- **Sketch:** in `auth.ts`, add `let rolesLoaded = false;` set `true` at the end of
  `onAuthenticated` (and reset to `false` on sign-out / new user). Expose
  `useRolesLoaded()`. In `RequireAdmin`: `if (caps.signedIn && !rolesLoaded) return
  <PageFallback/>;` before the `isAdmin` check.

### Option B — Persist last-known roles in localStorage for an optimistic first paint
Cache the resolved roles and read them synchronously on boot (like `hasLikelySession`),
so an admin's first paint is already "admin." Revalidate in the background.

- **Pros:** zero flash, instant correct paint.
- **Cons:** trust issue — stale cache could briefly show admin UI to someone whose role
  was revoked (server RLS still blocks data, but the *UI* shows). Mitigate by treating
  the cache as presentational only and always revalidating. More moving parts than A.

### Option C — Block the whole app render until roles load
Extend the existing `App.tsx` `PageFallback` guard to also wait on roles, not just
session, before rendering any routes.

- **Pros:** simplest mental model; one place.
- **Cons:** delays *every* page (incl. public/home) on every refresh for the roles
  fetch, even when roles are irrelevant. Worse perceived performance for the common case.

## Recommendation

**Option A.** It targets exactly the racing condition, keeps public pages fast, fixes
all role gates uniformly, and has no security downside (we only ever *withhold* the
denial screen until we have a definitive answer; we never *grant* access optimistically).
Optionally layer Option B later if we want a truly flash-free admin first paint.

## Files involved
- `src/lib/auth.ts` — add `rolesLoaded` + `useRolesLoaded()`; reset on sign-out.
- `src/lib/capabilities.ts` / `capabilities-core.ts` — optionally expose via caps.
- `src/App.tsx` — `RequireAdmin` (and `RequireAccount` if desired) wait on `rolesLoaded`.
- `src/pages/Sanction.tsx` — apply the same guard to its role-gated screens.
