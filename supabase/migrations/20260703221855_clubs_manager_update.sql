-- Fix: clubs had only `public_read` (select) and `admin_all` (using/with
-- check is_admin()) — no policy ever let a non-admin CLUB MANAGER update
-- their OWN club row. Discovered live while consolidating the club edit UI
-- (feedback tracker B8): Club.tsx shows "Edit club details" to any manager
-- (`canManage = caps.actingAsAdmin || caps.managedClubIds.includes(club.id)`),
-- but every non-admin manager's save has always been silently rejected by
-- RLS underneath (queued for "retry" that can never succeed) — the feature
-- has never actually worked end-to-end for its main non-admin audience.
--
-- Additive permissive policy (Postgres OR's it with admin_all) scoped to a
-- club the caller currently manages, matching the existing manages_club()
-- pattern used elsewhere (people_self_update, event/session policies, etc.).
-- UPDATE only — creating a brand-new club stays admin-only (ClubForm's
-- create/`club=undefined` path is only reachable from Admin.tsx).
create policy manager_update on clubs for update
  using (manages_club(id)) with check (manages_club(id));
