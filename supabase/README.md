# UCG backend (Supabase) — scaffold

This folder holds the database schema and security policies for the eventual
production backend. **Nothing here is wired into the running app yet** — the
prototype still runs entirely in the browser on the localStorage store
(`src/lib/store.ts`). This is the migration target, ready to stand up when you
greenlight hosting.

## Why Supabase

It gives us, on a managed free/low tier, everything the spec needs without
building it from scratch: Postgres (relational data + the scoring logic can run
in SQL), row-level security (the role model below), authentication, an
auto-generated REST + realtime API (live results push), file storage (waiver
PDFs, exports), and scheduled functions (membership-expiry emails, backups).
It also leaves a clean path to the spec's "we need an API" requirement — the
PostgREST API is automatic, and Edge Functions cover custom endpoints.

## Files

| File | Purpose |
|------|---------|
| `migrations/0001_schema.sql` | All tables + enums, mirroring `src/lib/types.ts`. |
| `migrations/0002_rls.sql` | Row-level security: the 6 roles + public read for results. |

## Stand it up

1. Create a project at https://supabase.com (free tier is fine to start).
2. Run the migrations — either:
   - **SQL editor:** paste `0001_schema.sql`, run; then `0002_rls.sql`, run; or
   - **CLI:** `supabase link --project-ref <ref>` then `supabase db push`.
3. In the app, copy `.env.example` → `.env.local` and fill in the project URL
   and anon key (Settings → API). `src/lib/supabase.ts` activates automatically.
4. Seed: export the prototype's demo data (League Controls → Demo tools can be
   extended to dump JSON) or write an `INSERT` seed. The shapes match the schema
   1:1, so a small script can map the seed in `src/lib/seed.ts` to rows.

## Role model (RLS)

Maps to the app's "Viewing as" personas:

- **admin** — full access to everything.
- **club-manager** — read/write the people, registrations, cart and invoices for
  clubs they manage (via `club_managers`).
- **athlete** — read/write their own `people` row, memberships, and registrations.
- **judge** / **meet-host** — write `scores`; hosts also manage their meet's
  sessions and squads.
- **spectator / anon** — public read of meets, sessions, registrations, and
  scores so the live-results and meet pages work with no login.

Roles live in `user_roles` (a user may hold several). Helper SQL functions
(`is_admin()`, `manages_club()`, `my_person_id()`) keep the policies readable.

## Migration path for the app data layer

`src/lib/store.ts` exposes a small surface (`useDB`, `mutate`, role helpers).
`src/lib/supabase.ts` sketches the `UcgRepository` contract that mirrors those
reads/writes. Migrate table-by-table:

1. Implement `loadAll()` to hydrate the in-memory snapshot from Supabase on boot.
2. Point each `mutate(...)` call site at the matching repository method, which
   writes to Supabase and lets realtime (`subscribeMeetScores`) refresh other
   clients — this is what makes live results push to spectators.
3. Replace the localStorage password gate with Supabase Auth (magic-link or
   email/password); drop the SHA-256 gate in `store.ts`.

Because the table shapes equal the TS types, most of this is mechanical.

## Not covered yet (future migrations)

Payments (Stripe via an Edge Function + `invoices`/`cart_items`), waiver PDF
storage + e-sign audit trail, the membership-expiry notification cron, scheduled
database backups, and the public API surface for other leagues.
