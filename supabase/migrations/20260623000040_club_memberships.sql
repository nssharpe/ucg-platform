-- Club membership lifecycle: a club must hold an active membership for a season
-- before its athletes can register or it can host in that season. One row per
-- (club, season). League admins grant/revoke; club managers purchase.
create table if not exists club_memberships (
  id          uuid primary key default gen_random_uuid(),
  club_id     text not null references clubs(id) on delete cascade,
  season_id   text not null references seasons(id) on delete cascade,
  status      text not null default 'active',   -- 'active' (room to grow)
  purchased_by uuid,                            -- auth.uid() of purchaser/granter
  granted_by_admin boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (club_id, season_id)
);
create index if not exists club_memberships_idx on club_memberships (club_id, season_id);

alter table club_memberships enable row level security;

-- World-readable (the registration/hosting gate must check it for any caller);
-- a club's managers may insert (purchase) their own club's membership; admins
-- manage all.
create policy club_mem_read   on club_memberships for select using (true);
create policy club_mem_insert on club_memberships for insert
  with check (is_admin() or manages_club(club_id));
create policy club_mem_admin  on club_memberships for all
  using (is_admin()) with check (is_admin());

-- Backfill: grant the CURRENT season's club membership to every club that
-- already has at least one active member, so enabling the gate does not block
-- clubs that are already operating. (New/empty clubs and future seasons must
-- purchase or be granted.)
insert into club_memberships (club_id, season_id, granted_by_admin)
select distinct p.main_club_id, s.id, true
from people p
join memberships m on m.person_id = p.id
join seasons s on s.id = m.season_id and s.current = true
where p.main_club_id is not null and m.status = 'active'
on conflict (club_id, season_id) do nothing;
