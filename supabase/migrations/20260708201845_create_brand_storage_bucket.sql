-- Public "brand" storage bucket for static brand assets (webfonts, logos).
-- Objects are served via /storage/v1/object/public/brand/... — public read only;
-- no INSERT/UPDATE/DELETE policies on storage.objects for this bucket, so writes
-- require the service role (uploads happen via CLI/controller, never the app).
insert into storage.buckets (id, name, public)
values ('brand', 'brand', true)
on conflict (id) do update set public = true;
