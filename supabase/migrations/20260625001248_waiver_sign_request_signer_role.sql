-- Carry the intended signer role (self vs guardian) on a no-login signing token.
-- A prior change emails 18+ athletes a SELF link and minors a GUARDIAN link, but
-- the signing path was hardcoded to 'guardian'. Store the role on the mint so
-- record-waiver-signature can stamp the correct signer_role on the signature.
-- Default 'guardian' preserves every existing (minor) link.
alter table waiver_sign_requests
  add column if not exists signer_role text not null default 'guardian';

-- Surface signer_role to the public (no-login) signing page, which looks the
-- request up by its secret token via this SECURITY DEFINER function.
create or replace function get_waiver_sign_request(p_token text)
returns table (
  person_id text, season_id text, waiver_type text,
  membership_type text, guardian_email text, status text, signer_role text
) as $$
  select person_id, season_id, waiver_type, membership_type,
         guardian_email, status, signer_role
  from waiver_sign_requests
  where token = p_token and status = 'pending';
$$ language sql stable security definer set search_path = public;

grant execute on function get_waiver_sign_request(text) to anon, authenticated;
