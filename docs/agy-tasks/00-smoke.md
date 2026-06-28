# Smoke test — confirm agy's write path + AGENTS.md pickup

## Context
This is a throwaway test to confirm agy can read the repo, edit files, and that it
sees `.agents/AGENTS.md`. It will be reverted immediately.

## Requirements
1. Create a file `AGY_SMOKE.txt` at the repo root containing exactly:
   `agy write path OK`
2. On a second line, write the name of the FIRST mandatory verification command listed
   in `.agents/AGENTS.md` (proves you read the rules file).

## Constraints
- Make NO other changes. Do not commit, push, or deploy.

## Definition of done
- `AGY_SMOKE.txt` exists with the two lines above.
- Report the file you created.
