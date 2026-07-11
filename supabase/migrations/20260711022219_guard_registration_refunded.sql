-- Close a DB-level gap found in review of emv2 P3 T7 (commit 21333eb): the
-- rule "a refunded registration can't be re-enabled except by an admin" was
-- enforced ONLY in the React UI (Club.tsx/MyRegistrations.tsx hide the
-- controls). `registrations` is member/club-manager writable under RLS, so a
-- post-deadline-refunded athlete (who already received a partial refund and
-- must not compete) could call PostgREST directly and flip
-- `refunded:false` / `keep_listed:true` on their own row to get themselves
-- silently re-added.
--
-- Sibling function/trigger (not folded into guard_registration_paid): that
-- function's history is already a hard-won record of the upsert-trigger
-- trap (20260702182711 -> 20260703034325) and is scoped to the `paid`/
-- `updated_pending` state machine. `refunded`/`keep_listed` are a
-- conceptually separate invariant (post-refund lockout, not payment
-- staging) with their own, much simpler rule. Keeping them as two focused
-- functions on the same BEFORE INSERT OR UPDATE event (Postgres runs both
-- for a single upsert) is clearer to audit than interleaving two unrelated
-- state machines in one function, and avoids touching/re-reviewing the
-- already-battle-tested paid guard.
--
-- Same upsert-trigger trap applies here: the app always issues whole-row
-- upserts (`INSERT ... ON CONFLICT (id) DO UPDATE`) via
-- `registrationToRow`/`pushRegistration` (src/lib/supabase.ts ~line 250),
-- so tg_op is 'INSERT' and OLD is NULL even when updating an existing row.
-- This function therefore never trusts tg_op/OLD and instead re-SELECTs the
-- true pre-write row by `new.id`, exactly like guard_registration_paid.
--
-- Safe against false rejections: `registrationToRow` ALWAYS includes both
-- `refunded` and `keep_listed` explicitly in every upsert payload (never
-- omitted/defaulted), so a legitimate no-op write from the app re-sends the
-- same values it read and never trips this guard.

create or replace function guard_registration_refunded() returns trigger as $$
declare
  v_privileged boolean;
  v_old registrations%rowtype;
  v_old_refunded boolean;
  v_old_keep_listed boolean;
begin
  v_privileged := auth.role() is null or auth.role() = 'service_role' or is_admin();
  if v_privileged then
    return new;
  end if;

  -- Resolve the ACTUAL pre-write row by id rather than trusting tg_op/OLD
  -- (see header: unreliable for the app's INSERT ... ON CONFLICT DO UPDATE
  -- upsert pattern).
  select * into v_old from registrations where id = new.id;
  v_old_refunded := coalesce(v_old.refunded, false);
  v_old_keep_listed := coalesce(v_old.keep_listed, false);

  if new.refunded is distinct from v_old_refunded
     or new.keep_listed is distinct from v_old_keep_listed then
    raise exception 'guard_registration_refunded: non-privileged caller cannot change refunded/keep_listed on a registration';
  end if;

  return new;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

create trigger guard_registration_refunded_trigger
  before insert or update on registrations
  for each row execute function guard_registration_refunded();
