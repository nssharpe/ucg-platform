# Remove redundant "add athlete membership again" block

## Context
On the membership status area, after a user has just added a membership, there is a
text block + horizontal separator below it reading roughly:
*"You can also add an Athlete membership for 2025-26. Add athlete membership →"*
Prompting users to add the membership they just added is confusing. (Area: the
membership page / status component — search for that copy or the "Add athlete
membership" link.)

## Requirements
1. Remove that text block AND its horizontal separator from below the membership status
   area, so a user who has just added a membership is not re-prompted to add it.
2. Leave the membership status display itself intact.

## Constraints
- UI-only removal; do not alter membership logic. Follow `.agents/AGENTS.md`.

## Definition of done
- The block + separator no longer render. Build / eslint(touched) / vitest clean.
  Report the file(s) changed.
