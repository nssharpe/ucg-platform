-- UCG — Row-Level Security
-- Roles map to the app's "Viewing as" personas. Public (anon) can read the
-- competition-facing tables so the live-results & meet pages work with no login.

-- ---------------------------------------------------------------------------
-- Helper functions (security definer so they can read user_roles under RLS)
-- ---------------------------------------------------------------------------
create or replace function auth_has_role(r app_role) returns boolean as $$
  select exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.role = r);
$$ language sql stable security definer;

create or replace function is_admin() returns boolean as $$
  select auth_has_role('admin');
$$ language sql stable security definer;

-- The person row that belongs to the current auth user
create or replace function my_person_id() returns uuid as $$
  select id from people where auth_user_id = auth.uid();
$$ language sql stable security definer;

-- Does the current user manage this club?
create or replace function manages_club(cid text) returns boolean as $$
  select is_admin() or exists (
    select 1 from club_managers cm
    join people p on p.id = cm.person_id
    where cm.club_id = cid and p.auth_user_id = auth.uid()
  );
$$ language sql stable security definer;

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere
-- ---------------------------------------------------------------------------
alter table seasons        enable row level security;
alter table levels         enable row level security;
alter table regions        enable row level security;
alter table clubs          enable row level security;
alter table people         enable row level security;
alter table person_alt_clubs enable row level security;
alter table club_managers  enable row level security;
alter table memberships    enable row level security;
alter table meets          enable row level security;
alter table meet_sessions  enable row level security;
alter table squads         enable row level security;
alter table registrations  enable row level security;
alter table scores         enable row level security;
alter table coupons        enable row level security;
alter table cart_items     enable row level security;
alter table invoices       enable row level security;
alter table invoice_items  enable row level security;
alter table user_roles     enable row level security;

-- ---------------------------------------------------------------------------
-- Public read: league config + competition pages (spectators, no login)
-- ---------------------------------------------------------------------------
create policy public_read on seasons       for select using (true);
create policy public_read on levels        for select using (true);
create policy public_read on regions       for select using (true);
create policy public_read on clubs         for select using (true);
create policy public_read on meets         for select using (true);
create policy public_read on meet_sessions for select using (true);
create policy public_read on squads        for select using (true);
create policy public_read on registrations for select using (true);
create policy public_read on scores        for select using (true);

-- Admin can do anything on the config/competition tables
create policy admin_all on seasons       for all using (is_admin()) with check (is_admin());
create policy admin_all on levels        for all using (is_admin()) with check (is_admin());
create policy admin_all on regions       for all using (is_admin()) with check (is_admin());
create policy admin_all on clubs         for all using (is_admin()) with check (is_admin());
create policy admin_all on meets         for all using (is_admin()) with check (is_admin());
create policy admin_all on meet_sessions for all using (is_admin()) with check (is_admin());
create policy admin_all on squads        for all using (is_admin()) with check (is_admin());
create policy admin_all on coupons       for all using (is_admin()) with check (is_admin());
create policy public_read_coupons on coupons for select using (true);

-- ---------------------------------------------------------------------------
-- People: a user sees/edits their own row; club managers see their roster;
-- admins see all.
-- ---------------------------------------------------------------------------
create policy people_self_read on people for select
  using (auth_user_id = auth.uid() or is_admin() or manages_club(main_club_id));
create policy people_self_update on people for update
  using (auth_user_id = auth.uid() or is_admin() or manages_club(main_club_id))
  with check (auth_user_id = auth.uid() or is_admin() or manages_club(main_club_id));
create policy people_admin_insert on people for insert
  with check (is_admin() or manages_club(main_club_id) or auth_user_id = auth.uid());

-- Memberships: owner + their club manager + admin
create policy memberships_read on memberships for select
  using (is_admin()
    or person_id = my_person_id()
    or exists (select 1 from people p where p.id = memberships.person_id and manages_club(p.main_club_id)));
create policy memberships_write on memberships for all
  using (is_admin()
    or person_id = my_person_id()
    or exists (select 1 from people p where p.id = memberships.person_id and manages_club(p.main_club_id)))
  with check (is_admin()
    or person_id = my_person_id()
    or exists (select 1 from people p where p.id = memberships.person_id and manages_club(p.main_club_id)));

-- Club managers / alt clubs: admin manages; everyone can read (drives rosters)
create policy cm_read on club_managers for select using (true);
create policy cm_admin on club_managers for all using (is_admin()) with check (is_admin());
create policy alt_read on person_alt_clubs for select using (true);
create policy alt_self on person_alt_clubs for all
  using (is_admin() or person_id = my_person_id())
  with check (is_admin() or person_id = my_person_id());

-- ---------------------------------------------------------------------------
-- Registrations: athlete (self) or their club manager or admin can write
-- ---------------------------------------------------------------------------
create policy regs_write on registrations for all
  using (is_admin() or athlete_id = my_person_id() or manages_club(club_id))
  with check (is_admin() or athlete_id = my_person_id() or manages_club(club_id));

-- ---------------------------------------------------------------------------
-- Scores: judges & admins write; everyone reads (public_read above)
-- ---------------------------------------------------------------------------
create policy scores_write on scores for all
  using (is_admin() or auth_has_role('judge') or auth_has_role('meet-host'))
  with check (is_admin() or auth_has_role('judge') or auth_has_role('meet-host'));

-- Meet hosts can manage their own meet's sessions/squads
create policy host_sessions on meet_sessions for all
  using (is_admin() or exists (select 1 from meets m where m.id = meet_sessions.meet_id and manages_club(m.host_club_id)))
  with check (is_admin() or exists (select 1 from meets m where m.id = meet_sessions.meet_id and manages_club(m.host_club_id)));
create policy host_squads on squads for all
  using (is_admin() or exists (
    select 1 from meet_sessions s join meets m on m.id = s.meet_id
    where s.id = squads.session_id and manages_club(m.host_club_id)))
  with check (is_admin() or exists (
    select 1 from meet_sessions s join meets m on m.id = s.meet_id
    where s.id = squads.session_id and manages_club(m.host_club_id)));

-- ---------------------------------------------------------------------------
-- Money: carts & invoices visible to their owner (club manager / athlete) + admin
-- ---------------------------------------------------------------------------
create policy cart_owner on cart_items for all
  using (is_admin() or person_id = my_person_id() or manages_club(club_id))
  with check (is_admin() or person_id = my_person_id() or manages_club(club_id));

create policy invoice_owner on invoices for select
  using (is_admin() or athlete_id = my_person_id() or manages_club(club_id));
create policy invoice_admin on invoices for all
  using (is_admin() or manages_club(club_id)) with check (is_admin() or manages_club(club_id));

create policy invoice_items_read on invoice_items for select
  using (is_admin() or exists (
    select 1 from invoices i where i.id = invoice_items.invoice_id
    and (i.athlete_id = my_person_id() or manages_club(i.club_id))));
create policy invoice_items_admin on invoice_items for all
  using (is_admin()) with check (is_admin());

-- user_roles: a user can read their own roles; only admins write
create policy roles_self_read on user_roles for select using (user_id = auth.uid() or is_admin());
create policy roles_admin on user_roles for all using (is_admin()) with check (is_admin());

-- ---------------------------------------------------------------------------
-- Public competitor names for live results.
-- `people` is intentionally NOT public (PII), but the results pages need each
-- competitor's display name + club. This view exposes ONLY those columns and
-- runs with the owner's rights, so spectators see names without any PII leak.
-- ---------------------------------------------------------------------------
create view public_competitors
  with (security_invoker = false) as
  select p.id, p.first_name, p.last_name, p.main_club_id
  from people p;

grant select on public_competitors to anon, authenticated;
