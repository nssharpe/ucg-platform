# Fix: registrations_squad_id_fkey violation on registration edit

## Context
Editing a meet registration from **My Registrations** fails with:
`insert or update on table "registrations" violates foreign key constraint
"registrations_squad_id_fkey"` (UI shows "We couldn't reach the server (registrations).
Your changes are queued — retry to save them.").

The member-side save lives in `src/pages/MyRegistrations.tsx` (its save handler mirrors
`Club.tsx` `saveRegs`/`addToCart` but targets the member's OWN cart via
`pushCart(personId, cart, false)`). The registration write goes through
`src/lib/supabase.ts`. The error means the row being written carries a `squad_id` that
does not exist in the `squads` table.

## Task (diagnose, then fix the root cause — do not just add a retry)
1. Trace the My-Registrations edit → save → `registrations` insert/update path and find
   where `squad_id` is set. Determine WHY it references a non-existent squad — likely
   candidates: a squad_id is carried over/edited but the squad row was never persisted;
   a stale or blanked squad_id; or squad creation is skipped on the member path that the
   Club path performs.
2. Fix so a registration edit from My Registrations saves cleanly: either ensure the
   referenced squad row exists before the registration write, or set `squad_id` correctly
   (incl. null if the column is nullable and that's valid). Match how the working Club.tsx
   path handles squads.
3. Do NOT alter the FK or schema via a migration unless that is clearly the correct fix —
   if you believe a schema change is needed, STOP and report it instead of applying it.

## Constraints
- Follow `.agents/AGENTS.md` (verify gate; never commit/push/db push/deploy).

## Definition of done
- Editing a registration from My Registrations saves with no FK error. Build / eslint
  (touched) / vitest clean. Report the ROOT CAUSE you found + every file changed.
