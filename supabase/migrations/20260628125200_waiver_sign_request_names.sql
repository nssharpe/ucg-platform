-- Surface first_name and last_name of the athlete to the public signing page,
-- so that it can verify the typed name matches the athlete's name on file.
drop function if exists get_waiver_sign_request(text);
create or replace function get_waiver_sign_request(p_token text)
returns table (
  person_id text, season_id text, waiver_type text,
  membership_type text, guardian_email text, status text, signer_role text,
  first_name text, last_name text
) as $$
  select w.person_id, w.season_id, w.waiver_type, w.membership_type,
         w.guardian_email, w.status, w.signer_role,
         p.first_name, p.last_name
  from waiver_sign_requests w
  left join people p on p.id = w.person_id
  where w.token = p_token and w.status = 'pending';
$$ language sql stable security definer set search_path = public;

grant execute on function get_waiver_sign_request(text) to anon, authenticated;
