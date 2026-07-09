-- Event-management v2 Phase 1, Task 4: insurance-certificate file storage
-- (spec §C status card + §B4 checklist "insurance certificate upload").
-- First real Supabase Storage use in this project (the "brand" bucket,
-- 20260708201845, is a public asset bucket with no RLS on storage.objects).
--
-- PRIVATE bucket. Path convention: insurance/<event_id>/<filename> — the
-- event id is (storage.foldername(name))[2] (index 1 is 'insurance').

insert into storage.buckets (id, name, public)
values ('event-files', 'event-files', false)
on conflict (id) do update set public = false;

-- Write (insert/update/delete): sanctioning-team + admins only. The event
-- owner is drawn from the sanctioning team (spec §B3) and uploads the
-- certificate as part of the owner checklist; host-club managers and event
-- admins can VIEW but not upload. Fail-closed via coalesce (CLAUDE.md).
create policy event_files_insert on storage.objects for insert
  with check (
    bucket_id = 'event-files'
    and (is_admin() or coalesce(auth_has_role('sanctioning'), false))
  );

create policy event_files_update on storage.objects for update
  using (
    bucket_id = 'event-files'
    and (is_admin() or coalesce(auth_has_role('sanctioning'), false))
  )
  with check (
    bucket_id = 'event-files'
    and (is_admin() or coalesce(auth_has_role('sanctioning'), false))
  );

create policy event_files_delete on storage.objects for delete
  using (
    bucket_id = 'event-files'
    and (is_admin() or coalesce(auth_has_role('sanctioning'), false))
  );

-- Read: admins, sanctioning, the host club's managers, or that event's
-- per-event admins (event_admins, 20260709133846). Every branch wrapped
-- fail-closed with coalesce so a NULL from an unauthenticated/errored
-- auth_has_role()/manages_club() lookup denies rather than short-circuiting
-- the OR-chain to true (CLAUDE.md "fail-closed SQL" trap).
create policy event_files_select on storage.objects for select
  using (
    bucket_id = 'event-files'
    and (
      is_admin()
      or coalesce(auth_has_role('sanctioning'), false)
      or coalesce(manages_club((select e.host_club_id from events e where e.id = (storage.foldername(name))[2])), false)
      or exists (
        select 1 from event_admins ea
        where ea.event_id = (storage.foldername(name))[2]
          and ea.user_id = auth.uid()
      )
    )
  );
