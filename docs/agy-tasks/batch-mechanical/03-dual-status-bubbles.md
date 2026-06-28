# Render both membership holds as two distinct bubbles

## Context
A membership can have TWO independent holds at once: an unsigned under-18 guardian
waiver AND a payment pushed to a club cart. The code already derives both via
`membershipHolds(m)` in `src/lib/capabilities-core.ts` (`waiverHold` + `paymentHold`).
Today the UI renders only ONE bubble when both holds exist. (Area: wherever membership
status bubbles render — `Membership.tsx` and/or `Club.tsx`, driven off `membershipHolds`.)

## Requirements
1. When a membership payment is pushed to a club cart, show:
   `Pending Payment by [Club Name] (Athlete)`.
2. When an under-18 waiver hold ALSO exists at the same time, render TWO distinct bubbles:
   `Pending guardian waiver (Athlete)` AND `Pending Payment by [Club Name] (Athlete)`.
3. Drive this off `membershipHolds(m)` (waiverHold / paymentHold), not the single status
   enum — both holds can be true simultaneously.

## Constraints
- Use the existing `membershipHolds` derivation; do not reintroduce single-enum logic.
- Ensure bubble text has readable contrast against its background (WCAG AA).
- Follow `.agents/AGENTS.md`.

## Definition of done
- Both bubbles render when both holds are active; correct single bubble otherwise.
  Build / eslint(touched) / vitest clean. Report files changed.
