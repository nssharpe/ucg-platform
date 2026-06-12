-- UCG — convert human-readable id columns from uuid to text + score calc extras
--
-- The app (src/lib/types.ts, src/lib/seed.ts) uses human-readable text ids
-- everywhere (people `p-1`, registrations `reg-…`, memberships, cart items
-- `ci-…`, invoices `inv-…`, invoice items `ii-…`), but 0001_schema.sql
-- declared these columns `uuid`. This migration converts them to `text` so
-- the write-through layer (src/lib/supabase.ts) can upsert app-generated ids.
--
-- Also adds the `scores` columns needed to round-trip embedded-calculator
-- state without data loss: calc, calc_state, adjust_note, adjusted_at.
--
-- Does not touch people.auth_user_id or user_roles.user_id (auth.users refs
-- stay uuid).

begin;

-- ---------------------------------------------------------------------------
-- 1. Drop the public_competitors view (depends on people.id) — recreated below.
-- ---------------------------------------------------------------------------
drop view if exists public_competitors;

-- ---------------------------------------------------------------------------
-- 2. Drop RLS policies that depend on my_person_id(), and the function itself
--    (return type uuid -> text requires drop + recreate).
-- ---------------------------------------------------------------------------
drop policy if exists memberships_read on memberships;
drop policy if exists memberships_write on memberships;
drop policy if exists alt_self on person_alt_clubs;
drop policy if exists regs_write on registrations;
drop policy if exists cart_owner on cart_items;
drop policy if exists invoice_owner on invoices;
drop policy if exists invoice_items_read on invoice_items;

drop function if exists my_person_id();

-- ---------------------------------------------------------------------------
-- 3. Drop FK constraints on columns we're converting (both sides of each FK
--    must change type together).
-- ---------------------------------------------------------------------------
alter table club_managers   drop constraint if exists club_managers_person_id_fkey;
alter table person_alt_clubs drop constraint if exists person_alt_clubs_person_id_fkey;
alter table memberships     drop constraint if exists memberships_person_id_fkey;
alter table registrations   drop constraint if exists registrations_athlete_id_fkey;
alter table cart_items       drop constraint if exists cart_items_person_id_fkey;
alter table cart_items       drop constraint if exists cart_items_ref_user_id_fkey;
alter table invoices         drop constraint if exists invoices_athlete_id_fkey;
alter table invoice_items    drop constraint if exists invoice_items_ref_user_id_fkey;
alter table scores           drop constraint if exists scores_reg_id_fkey;
alter table invoice_items    drop constraint if exists invoice_items_invoice_id_fkey;

-- ---------------------------------------------------------------------------
-- 4. Convert people.id (PK) and all referencing columns from uuid to text.
-- ---------------------------------------------------------------------------
alter table people            alter column id          type text using id::text;
alter table people            alter column id          drop default;

alter table club_managers     alter column person_id   type text using person_id::text;
alter table person_alt_clubs  alter column person_id   type text using person_id::text;
alter table memberships       alter column person_id   type text using person_id::text;
alter table registrations     alter column athlete_id  type text using athlete_id::text;
alter table cart_items        alter column person_id   type text using person_id::text;
alter table cart_items        alter column ref_user_id type text using ref_user_id::text;
alter table invoices          alter column athlete_id  type text using athlete_id::text;
alter table invoice_items     alter column ref_user_id type text using ref_user_id::text;

-- ---------------------------------------------------------------------------
-- 5. Convert memberships.id, registrations.id (+ scores.reg_id),
--    cart_items.id, invoices.id (+ invoice_items.invoice_id), invoice_items.id.
-- ---------------------------------------------------------------------------
alter table memberships   alter column id type text using id::text;
alter table memberships   alter column id drop default;

alter table registrations alter column id type text using id::text;
alter table registrations alter column id drop default;
alter table scores         alter column reg_id type text using reg_id::text;

alter table cart_items     alter column id type text using id::text;
alter table cart_items     alter column id drop default;

alter table invoices       alter column id type text using id::text;
alter table invoices       alter column id drop default;
alter table invoice_items  alter column invoice_id type text using invoice_id::text;

alter table invoice_items  alter column id type text using id::text;
alter table invoice_items  alter column id drop default;

-- ---------------------------------------------------------------------------
-- 6. Re-add FK constraints with the same ON DELETE behavior as 0001_schema.sql.
-- ---------------------------------------------------------------------------
alter table club_managers
  add constraint club_managers_person_id_fkey
  foreign key (person_id) references people (id) on delete cascade;

alter table person_alt_clubs
  add constraint person_alt_clubs_person_id_fkey
  foreign key (person_id) references people (id) on delete cascade;

alter table memberships
  add constraint memberships_person_id_fkey
  foreign key (person_id) references people (id) on delete cascade;

alter table registrations
  add constraint registrations_athlete_id_fkey
  foreign key (athlete_id) references people (id) on delete cascade;

alter table cart_items
  add constraint cart_items_person_id_fkey
  foreign key (person_id) references people (id) on delete cascade;

alter table cart_items
  add constraint cart_items_ref_user_id_fkey
  foreign key (ref_user_id) references people (id) on delete set null;

alter table invoices
  add constraint invoices_athlete_id_fkey
  foreign key (athlete_id) references people (id) on delete set null;

alter table invoice_items
  add constraint invoice_items_ref_user_id_fkey
  foreign key (ref_user_id) references people (id) on delete set null;

alter table scores
  add constraint scores_reg_id_fkey
  foreign key (reg_id) references registrations (id) on delete cascade;

alter table invoice_items
  add constraint invoice_items_invoice_id_fkey
  foreign key (invoice_id) references invoices (id) on delete cascade;

-- ---------------------------------------------------------------------------
-- 7. Recreate my_person_id() returning text, and the dependent policies
--    verbatim from 0002_rls.sql.
-- ---------------------------------------------------------------------------
create function my_person_id() returns text as $$
  select id from people where auth_user_id = auth.uid();
$$ language sql stable security definer;

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

create policy alt_self on person_alt_clubs for all
  using (is_admin() or person_id = my_person_id())
  with check (is_admin() or person_id = my_person_id());

create policy regs_write on registrations for all
  using (is_admin() or athlete_id = my_person_id() or manages_club(club_id))
  with check (is_admin() or athlete_id = my_person_id() or manages_club(club_id));

create policy cart_owner on cart_items for all
  using (is_admin() or person_id = my_person_id() or manages_club(club_id))
  with check (is_admin() or person_id = my_person_id() or manages_club(club_id));

create policy invoice_owner on invoices for select
  using (is_admin() or athlete_id = my_person_id() or manages_club(club_id));

create policy invoice_items_read on invoice_items for select
  using (is_admin() or exists (
    select 1 from invoices i where i.id = invoice_items.invoice_id
    and (i.athlete_id = my_person_id() or manages_club(i.club_id))));

-- ---------------------------------------------------------------------------
-- 8. Recreate public_competitors view identically.
-- ---------------------------------------------------------------------------
create view public_competitors
  with (security_invoker = false) as
  select p.id, p.first_name, p.last_name, p.main_club_id
  from people p;

grant select on public_competitors to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 9. Add scores columns for embedded-calculator provenance/adjustment
--    (mirrors src/lib/types.ts Score: calc?, calcState?, adjustNote?, adjustedAt?)
-- ---------------------------------------------------------------------------
alter table scores add column if not exists calc        text;
alter table scores add column if not exists calc_state  jsonb;
alter table scores add column if not exists adjust_note text;
alter table scores add column if not exists adjusted_at timestamptz;

commit;
