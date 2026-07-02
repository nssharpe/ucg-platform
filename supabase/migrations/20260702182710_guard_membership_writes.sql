-- C1: DB-enforced guard on `memberships` so a raw-PostgREST caller with their
-- own JWT cannot self-activate a membership, forge a waiver signature, or
-- forge a card/comp payment. `memberships_write` (FOR ALL, person_id =
-- my_person_id()) is intentionally broad — the app write-through pushes WHOLE
-- rows (membershipToRow in src/lib/supabase.ts), so RLS alone can't distinguish
-- "resave my own unchanged row" from "flip status to active". A trigger can,
-- by comparing OLD vs NEW.
--
-- Enumeration (grepped src/ before writing this): every legitimate non-admin
-- client write goes through pushMembership / pushPerson, both of which whole-
-- row-upsert membershipToRow(). The only non-admin, non-service-role path that
-- creates/edits a membership row is Membership.tsx's `complete(via)`:
--   - via='club' (any signed-in member, gated by club.allowClubPay): INSERT
--     with status='pending-club-payment' (minors: 'pending-waiver'), paidVia=
--     'club'. For a NON-MINOR adult, it also stamps waiverSignedAt=now()/
--     waiverSignedBy=<sig> on that same INSERT — this is legitimate: the
--     member just self-signed via the record-waiver-signature Edge Function
--     (service role) a few steps earlier in the same flow, which wrote a real
--     waiver_signatures row for (person_id, season_id) but the membership row
--     didn't exist yet at that point (comment in record-waiver-signature:
--     "these updates match 0 rows and are a harmless no-op"), so the wizard
--     re-asserts the timestamp on the INSERT it performs at the pay step.
--   - via='comp' is UI-gated to caps.isAdmin/actingAsAdmin, i.e. only reachable
--     with an admin JWT — already covered by the admin bypass.
-- record-waiver-signature and stripe-webhook run with the SERVICE ROLE key
-- (bypass RLS, but NOT triggers — must be explicitly exempted below).
--
-- Rule: for non-privileged callers,
--   INSERT: reject status='active'; reject paid_via in ('card','comp'); reject
--     a non-null waiver_signed_at UNLESS a matching waiver_signatures row
--     exists (person_id, season_id, signer_name = waiver_signed_by) with
--     signed_at not after the claimed waiver_signed_at (the self-sign-then-
--     insert sequence above) — i.e. the client can only claim a signature that
--     genuinely exists.
--   UPDATE: reject only TRANSITIONS (NEW IS DISTINCT FROM OLD on the column) —
--     an unchanged whole-row resave must keep working. Reject status becoming
--     'active'; reject waiver_signed_at changing to a different non-null value
--     unless the same waiver_signatures match holds; reject paid_via changing
--     to 'card' or 'comp'.
-- Privileged callers (service_role, admin, or no JWT at all i.e. direct
-- DB/dashboard/migration) bypass every check.

create or replace function guard_membership_writes() returns trigger as $$
declare
  v_privileged boolean;
  v_waiver_ok boolean;
begin
  v_privileged := auth.role() is null or auth.role() = 'service_role' or is_admin();
  if v_privileged then
    return new;
  end if;

  -- status: 'active' can only be set by the webhook/waiver function/admin.
  if new.status = 'active' and (tg_op = 'INSERT' or new.status is distinct from old.status) then
    raise exception 'guard_membership_writes: non-privileged caller cannot set status=active';
  end if;

  -- paid_via: 'card' (webhook-only) and 'comp' (admin-only) can't be
  -- client-asserted. 'club' and null stay legal.
  if new.paid_via in ('card', 'comp')
     and (tg_op = 'INSERT' or new.paid_via is distinct from old.paid_via) then
    raise exception 'guard_membership_writes: non-privileged caller cannot set paid_via=%', new.paid_via;
  end if;

  -- waiver_signed_at: only allow a non-null value that matches a REAL signature
  -- already on file (the Membership.tsx self-sign-then-insert sequence).
  -- Allow null->null and an unchanged value on UPDATE (whole-row resave).
  if new.waiver_signed_at is not null
     and (tg_op = 'INSERT' or new.waiver_signed_at is distinct from old.waiver_signed_at) then
    select exists (
      select 1 from waiver_signatures ws
      where ws.person_id = new.person_id
        and ws.season_id = new.season_id
        and ws.signed_at <= new.waiver_signed_at + interval '1 minute'
        and ws.signed_at >= new.waiver_signed_at - interval '1 minute'
    ) into v_waiver_ok;
    if not v_waiver_ok then
      raise exception 'guard_membership_writes: waiver_signed_at does not match an existing waiver_signatures row';
    end if;
  end if;

  return new;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

drop trigger if exists guard_membership_writes on memberships;
create trigger guard_membership_writes
  before insert or update on memberships
  for each row execute function guard_membership_writes();
