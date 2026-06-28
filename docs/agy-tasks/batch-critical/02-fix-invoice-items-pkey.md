# Fix: invoice_items_pkey duplicate-key on add-to-cart

## Context
Flow: **Meets → select an event → Register myself → Add to cart** fails with:
`duplicate key value violates unique constraint "invoice_items_pkey"` (UI shows
"We couldn't reach the server (invoice_items). Your changes are queued — retry to save
them.").

`invoice_items_pkey` is the item `id`. The insert is generating an id that collides with
an existing row — the cart/invoice-item id is not being made unique per add. The
add-to-cart path runs through `pushCart` / the cart→`invoice_items` write in
`src/lib/supabase.ts`; check how invoice_item ids are generated there and in the cart
construction in the Meets registration flow.

## Task (diagnose, then fix the root cause)
1. Find exactly how the `id` (pkey) for `invoice_items` rows is generated on the
   add-to-cart path. Identify why it collides — e.g. a reused composite/static id, an id
   not regenerated for each new line, or the same line being inserted twice.
2. Fix so every invoice_item insert gets a unique pkey and adding to cart from Meets
   succeeds. Prefer the id-generation scheme already used elsewhere for cart/invoice
   items; keep it consistent.
3. If the collision is actually a double-insert (same line written twice), fix the
   duplication rather than just randomizing the id.

## Constraints
- Follow `.agents/AGENTS.md` (verify gate; never commit/push/db push/deploy).

## Definition of done
- Register-myself → Add to cart from Meets works with no unique-constraint error, and a
  second add doesn't collide. Build / eslint (touched) / vitest clean. Report the ROOT
  CAUSE + every file changed.
