-- Waiver e-signature tables
-- Depends on: seasons(id text), people(id text), is_admin(), my_person_id()

-- Versioned waiver text. A new row per edit; existing rows are immutable so
-- every signature stays bound to the exact text it agreed to.
create table waiver_documents (
  id            uuid primary key default gen_random_uuid(),
  season_id     text not null references seasons(id) on delete cascade,
  waiver_type   text not null,           -- 'Athlete' | 'Coach' | 'Judge' | 'Other Floor Access'
  version       int  not null,           -- per (season_id, waiver_type)
  body          text not null,
  content_hash  text not null,           -- sha-256 hex of body
  published     boolean not null default true,
  created_at    timestamptz not null default now(),
  created_by    uuid,                    -- auth.uid() of the editing admin
  unique (season_id, waiver_type, version)
);
create index on waiver_documents (season_id, waiver_type, published);

-- The legal artifact: one row per signing event.
create table waiver_signatures (
  id                  uuid primary key default gen_random_uuid(),
  person_id           text not null references people(id) on delete cascade,
  season_id           text not null references seasons(id) on delete cascade,
  waiver_type         text not null,
  waiver_document_id  uuid not null references waiver_documents(id),
  content_hash        text not null,     -- snapshot of the doc hash at signing
  signer_name         text not null,
  signer_email        text not null,
  signer_role         text not null,     -- 'self' | 'guardian'
  signer_relationship text,              -- e.g. 'parent' (guardian only)
  consent             boolean not null,
  signed_at           timestamptz not null default now(),
  ip                  text,
  user_agent          text,
  created_at          timestamptz not null default now()
);
create index on waiver_signatures (person_id, season_id, waiver_type);

-- Pending guardian signing tokens for minors.
create table waiver_sign_requests (
  id             uuid primary key default gen_random_uuid(),
  token          text not null unique,
  person_id      text not null references people(id) on delete cascade,
  season_id      text not null references seasons(id) on delete cascade,
  waiver_type    text not null,
  membership_type text not null,         -- 'athlete' | 'coach'
  guardian_email text not null,
  status         text not null default 'pending',  -- 'pending'|'completed'|'expired'
  created_at     timestamptz not null default now(),
  completed_at   timestamptz
);
create index on waiver_sign_requests (token);

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------
alter table waiver_documents     enable row level security;
alter table waiver_signatures    enable row level security;
alter table waiver_sign_requests enable row level security;

-- Waiver text: published rows are world-readable (guardians render via token,
-- no login). Admins manage.
create policy waiver_docs_read   on waiver_documents for select using (published or is_admin());
create policy waiver_docs_write  on waiver_documents for all    using (is_admin()) with check (is_admin());

-- Signatures: inserts/updates happen via the service-role Edge Function (RLS
-- bypassed). Through the API, admins read all; a person reads their own.
create policy waiver_sigs_read   on waiver_signatures for select
  using (is_admin() or person_id = my_person_id()::text);

-- Sign requests: token-based lookup is unauthenticated (a single pending row is
-- not sensitive); writes go through the service-role Edge Functions.
create policy waiver_reqs_read   on waiver_sign_requests for select using (true);
