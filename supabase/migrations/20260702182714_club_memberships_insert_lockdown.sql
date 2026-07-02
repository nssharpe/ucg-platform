-- H3: club_memberships can only be created by fulfillment (stripe-webhook,
-- service role) or an admin — never a club manager directly.
--
-- Enumeration (grepped `pushClubMembership`/`from('club_memberships')` in
-- src/ before writing this): `pushClubMembership` is called from exactly one
-- UI path, Club.tsx's `grant(seasonId, byAdmin)`, and that function is wired
-- to ONE button: `{isAdmin && (... : <button onClick={() => grant(s.id,
-- true)}>Grant (admin)</button>)}` — i.e. `byAdmin` is always `true` and the
-- button itself only renders for `isAdmin`. The manager-facing "Purchase"
-- button (`canManage`) instead opens `ClubMembershipReview`, which pushes a
-- `kind:'membership', refType:'club'` line to the CLUB CART (pushCartItem) —
-- never a direct club_memberships insert. So there is no legitimate client
-- manager INSERT path today; `manages_club(club_id)` in `club_mem_insert` is
-- unused dead permission surface. Confirmed stripe-webhook (service role,
-- bypasses RLS entirely) creates club_memberships server-side on a paid
-- 'membership'/refType:'club' cart line (supabase/functions/stripe-webhook/
-- index.ts ~L223-233).

drop policy if exists club_mem_insert on club_memberships;
create policy club_mem_insert on club_memberships for insert
  with check (is_admin());
