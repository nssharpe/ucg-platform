# Profile / account-creation form fixes

## Context
Bugs in the new-profile / account-creation form (the "Confirm Profile" flow). These are
regressions, several from merge `46bd11d`. All live in the profile / account-creation
components and their save path — locate them (search for the Student Status field, the
graduation-year field, and the profile save/`pushPerson` flow).

## Requirements
1. **Student Status default:** must start UNSELECTED/blank (a placeholder like "Select a
   student status…"), NOT pre-filled to "Student". Today it defaults to "Student",
   forcing users to toggle to save.
2. **Undergrad Graduation Year:** must NOT render with the "N/A" checkbox pre-checked.
   The field starts blank and is a REQUIRED field UNTIL the user manually checks "N/A"
   (checking N/A clears the requirement).
3. **Name porting:** the first name and last name entered during account creation must
   persist onto the profile. Today they are lost and the profile shows "New Member" —
   fix the field mapping so the entered names carry through to the saved person.
4. **Coach exemption:** the (hidden) Student Status field must NOT be a hard requirement
   for COACHES — a coach must be able to advance to the waiver step without student-status
   data. Keep it required for athletes/students.

## Constraints
- Touch only the profile / account-creation form + its save path. No unrelated refactors.
- Follow `.agents/AGENTS.md` (verify gate; no commit/push/deploy).

## Definition of done
- All four behaviors corrected. `npm run build` / `npx eslint <touched>` / `npx vitest run`
  all clean. Report every file changed.
