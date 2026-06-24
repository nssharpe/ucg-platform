-- Per-rep region for users holding the 'regional_rep' app role. One region per
-- user; multiple users may hold the same region. Admin manages all rows; a rep
-- may read their own row. (is_admin() is defined in 20260601000002_rls.sql.)

create table if not exists regional_rep_regions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  region  text not null
);

alter table regional_rep_regions enable row level security;

create policy rrr_admin_all on regional_rep_regions for all using (is_admin()) with check (is_admin());
create policy rrr_self_read on regional_rep_regions for select using (user_id = auth.uid());
