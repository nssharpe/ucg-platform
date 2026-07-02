# Plan: fire the first-membership welcome email on the Stripe card path

**Status:** ready to implement (Sonnet-tier task; ~half day).
**Context:** `sendMembershipWelcome` ("Welcome to UCG", no-club member's first
membership) currently fires only on the client `'comp'` path in `Membership.tsx`.
Since the direct card-pay retirement (2026-07-02), card purchases go through Stripe +
`stripe-webhook` fulfillment, which never sends it. Known gap flagged in CLAUDE.md.

## Requirements
1. When `stripe-webhook` fulfillment activates membership(s) for a person, send the
   welcome email iff ALL of:
   - it is the person's FIRST membership — no membership row for them existed BEFORE
     this fulfillment (any status counting as prior: active / pending-waiver /
     pending-club-payment / paid). **Compute this BEFORE activation writes, or exclude
     the just-activated row ids** — checking after activation would always find the new
     row and never send.
   - the person has NO club affiliation (same rule `send-membership-welcome` already
     re-checks server-side).
   - person is NOT `outside_us` (ditto — the existing function's skip conditions).
2. Club-cart-push and manager-paid member-targeted purchases must NOT trigger it
   (the no-club check already excludes them structurally, but confirm for the
   club-billed fulfillment branch — cheapest is to only evaluate the check for
   self-cart fulfillments).
3. One email per fulfillment even if the cart activates multiple membership types.
4. Best-effort: a send failure must NOT fail or retry fulfillment (log and continue),
   matching how the receipt email is handled.
5. The client `'comp'` path in `Membership.tsx` keeps working unchanged.

## Approach
- Extract the region-resolution + compose/send logic from
  `supabase/functions/send-membership-welcome/index.ts` into
  `supabase/functions/_shared/welcome.ts`; the standalone function becomes a thin
  auth wrapper around it (client 'comp' path unchanged), and `stripe-webhook` calls the
  shared helper directly (no self-HTTP, no JWT gymnastics).
- In `stripe-webhook`'s fulfill path: capture `hadPriorMembership` (query memberships
  for the person) BEFORE the activation writes; after successful fulfillment of a
  self-cart containing membership line(s), apply the guards and send.
- If any guard logic is extracted as a pure function, add a vitest for it.

## Verification
- `npm run build` + `npx eslint <touched files incl. supabase/functions/**>` +
  `npx vitest run`.
- Deploy BOTH functions; **`stripe-webhook` MUST be redeployed with `--no-verify-jwt`**
  and `supabase functions list` checked before AND after (see CLAUDE.md — this exact
  omission caused a real invisible-failure incident).
- Live check: `stripe trigger checkout.session.completed` won't exercise a real cart;
  verify via a seeded-user test purchase in test mode, or at minimum temporary logs
  confirming the guard path evaluates.
