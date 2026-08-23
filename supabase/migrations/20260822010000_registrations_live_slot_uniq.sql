-- UAT Z-02-01 (S1): no athlete can be charged twice for the same
-- (event, discipline). A league admin and a club manager both registered the
-- SAME athlete for the SAME event/discipline at the same moment and both
-- checked out — two invoice, two Stripe charges, two `registrations` rows.
-- Ids are minted CLIENT-side as `reg-<ms>-<athlete>-<disc>`
-- (RegistrationEditor.tsx), so two concurrent sessions mint two DIFFERENT
-- ids and nothing ever collided. There was no DB constraint preventing two
-- live rows from occupying the same slot.
--
-- A "live slot" is one (event_id, athlete_id, discipline) triple. At most
-- ONE non-refunded registration should ever occupy a slot — deliberately
-- NOT scoped to club_id (a duplicate across two different clubs for the
-- same athlete+event+discipline is exactly the same bug, and the existing
-- client-side `paidRegistrationClub` cross-club lock already treats
-- "already paid-registered under another club for the same event" as a
-- conflict) and deliberately NOT excluding waitlisted rows — a waitlisted
-- registration is still a real claim on the slot and must not be allowed to
-- coexist with a live paid row for it (or with another waitlisted row);
-- `where refunded = false` alone is the correct predicate.
--
-- `create unique index concurrently` cannot run inside a migration
-- transaction, so this is a plain `create unique index if not exists`
-- (idempotent on re-run). Because a unique index would fail to CREATE over
-- existing duplicate rows, the block below dedupes first: for every
-- (event_id, athlete_id, discipline) slot currently held by more than one
-- non-refunded row, it keeps exactly one (the PAID row if any, else the
-- earliest-created row) and marks every other row in that slot
-- `refunded = true, keep_listed = false, refund_requested = false`,
-- RAISE NOTICE-ing what it did for each slot so the controller can verify
-- the output on staging/prod before/after applying. The only known
-- duplicates as of this migration are the two ZZTEST rows from the UAT
-- round-1 run (Stripe test-mode money — no real refund needed); this logic
-- is written generically so it safely no-ops if none exist and safely
-- handles any other duplicate it finds.
--
-- Idempotent on re-run: the dedupe's `having count(*) > 1` finds nothing
-- once every slot has at most one non-refunded row (either it never had a
-- duplicate, or a prior run of this same migration already fixed it), and
-- `create unique index if not exists` is a no-op once the index exists.

do $$
declare
  slot record;
  keeper_id text;
  dup record;
begin
  for slot in
    select event_id, athlete_id, discipline
    from registrations
    where refunded = false
    group by event_id, athlete_id, discipline
    having count(*) > 1
  loop
    -- Keeper: the paid row (earliest created if more than one is paid),
    -- else simply the earliest-created row in the slot.
    select id into keeper_id
    from registrations
    where event_id = slot.event_id
      and athlete_id = slot.athlete_id
      and discipline = slot.discipline
      and refunded = false
    order by paid desc, created_at asc, id asc
    limit 1;

    raise notice 'registrations_live_slot_uniq dedupe: slot (event_id=%, athlete_id=%, discipline=%) has duplicates — keeping registration %',
      slot.event_id, slot.athlete_id, slot.discipline, keeper_id;

    for dup in
      select id, paid, created_at
      from registrations
      where event_id = slot.event_id
        and athlete_id = slot.athlete_id
        and discipline = slot.discipline
        and refunded = false
        and id <> keeper_id
    loop
      raise notice '  -> marking duplicate registration % (paid=%, created_at=%) refunded=true, keep_listed=false',
        dup.id, dup.paid, dup.created_at;
    end loop;

    update registrations
    set refunded = true, keep_listed = false, refund_requested = false
    where event_id = slot.event_id
      and athlete_id = slot.athlete_id
      and discipline = slot.discipline
      and refunded = false
      and id <> keeper_id;
  end loop;
end $$;

create unique index if not exists registrations_live_slot_uniq
  on registrations (event_id, athlete_id, discipline)
  where refunded = false;
