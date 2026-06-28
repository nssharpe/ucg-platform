# T&T: enforce at least one discipline on edit

## Context
In the registration editor, a user editing a T&T registration can remove disciplines.
They must be allowed to remove disciplines as long as ≥1 remains, but blocked from
removing the final one. (Area: the shared `RegistrationEditor` discipline add/remove UI.)

## Requirements
1. Allow removing disciplines during an edit as long as at least 1 discipline stays
   selected.
2. Attempting to remove the LAST remaining discipline must be blocked (the action does
   not proceed) and must surface this exact notification text:
   *"You must stay registered for at least 1 discipline. If you remove all selected
   events, the meet host will know that you do not plan to compete."*
3. Use the app's existing toast/notification mechanism (`useToast`) for the message.

## Constraints
- Editor logic only; do not change save/cart/paid semantics. Follow `.agents/AGENTS.md`.

## Definition of done
- Removing a non-last discipline works; removing the last is blocked with the message.
  Build / eslint(touched) / vitest clean. If you can express the "≥1 discipline" rule as
  a pure helper, add a vitest test for it. Report files changed.
