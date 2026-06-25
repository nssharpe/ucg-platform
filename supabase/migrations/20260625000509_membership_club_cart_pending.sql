alter table memberships add column if not exists club_cart_pending boolean not null default false;
alter table cart_items add column if not exists ref_season_id text;
alter table cart_items add column if not exists ref_type text;
