-- Test meet (2026-06-13): one athlete per level/discipline for scoring QA.
-- Covers all 13 levels: 4 MAG, 6 WAG (incl. wag-masters), 3 TNT.
begin;

insert into meets (id, slug, name, host_club_id, city, state, timezone, start_date, end_date, status, reg_opens, reg_closes, entry_fee, second_discipline_fee, disciplines)
values ('test-meet', 'test-meet', 'Scoring Test Meet', null, 'Test City', 'IL', 'America/Chicago', '2026-06-13', '2026-06-14', 'in-progress', null, null, 0, 0, '{MAG,WAG,TNT}');

insert into meet_sessions (id, meet_id, name, discipline, date, "time", level_ids, sort_order) values
  ('test-meet-mag', 'test-meet', 'MAG Session', 'MAG', '2026-06-13', '09:00', '{mag-dev,mag-int,mag-adv,mag-masters}', 0),
  ('test-meet-wag', 'test-meet', 'WAG Session', 'WAG', '2026-06-13', '13:00', '{wag-silver,wag-plat,wag-diamond,wag-l9,wag-open,wag-masters}', 1),
  ('test-meet-tnt', 'test-meet', 'TNT Session', 'TNT', '2026-06-14', '09:00', '{tnt-new,tnt-int,tnt-high}', 2);

insert into registrations (id, meet_id, athlete_id, club_id, discipline, level_id, events, session_id) values
  ('test-reg-mag-dev',     'test-meet', '208087', '27822', 'MAG', 'mag-dev',     '{FX,PH,SR,VT,PB,HB}', 'test-meet-mag'),
  ('test-reg-mag-int',     'test-meet', '208163', '23237', 'MAG', 'mag-int',     '{FX,PH,SR,VT,PB,HB}', 'test-meet-mag'),
  ('test-reg-mag-adv',     'test-meet', '208112', '24340', 'MAG', 'mag-adv',     '{FX,PH,SR,VT,PB,HB}', 'test-meet-mag'),
  ('test-reg-mag-masters', 'test-meet', '208662', '27785', 'MAG', 'mag-masters', '{FX,PH,SR,VT,PB,HB}', 'test-meet-mag'),
  ('test-reg-wag-silver',  'test-meet', '208023', '26864', 'WAG', 'wag-silver',  '{VT,UB,BB,FX}', 'test-meet-wag'),
  ('test-reg-wag-plat',    'test-meet', '207958', '25297', 'WAG', 'wag-plat',    '{VT,UB,BB,FX}', 'test-meet-wag'),
  ('test-reg-wag-diamond', 'test-meet', '207982', '25246', 'WAG', 'wag-diamond', '{VT,UB,BB,FX}', 'test-meet-wag'),
  ('test-reg-wag-l9',      'test-meet', '207960', '30876', 'WAG', 'wag-l9',      '{VT,UB,BB,FX}', 'test-meet-wag'),
  ('test-reg-wag-open',    'test-meet', '208322', '30832', 'WAG', 'wag-open',    '{VT,UB,BB,FX}', 'test-meet-wag'),
  ('test-reg-wag-masters', 'test-meet', '207966', '27814', 'WAG', 'wag-masters', '{VT,UB,BB,FX}', 'test-meet-wag'),
  ('test-reg-tnt-new',     'test-meet', '207984', '24710', 'TNT', 'tnt-new',     '{TR,DM,TU}', 'test-meet-tnt'),
  ('test-reg-tnt-int',     'test-meet', '208009', '27807', 'TNT', 'tnt-int',     '{TR,DM,TU}', 'test-meet-tnt'),
  ('test-reg-tnt-high',    'test-meet', '208491', '27807', 'TNT', 'tnt-high',    '{TR,DM,TU}', 'test-meet-tnt');

commit;
