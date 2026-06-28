# <Task title>

> Brief for the agy CLI. Self-contained: agy has only this file + `.agents/AGENTS.md`,
> no memory of any prior conversation. Spell everything out.

## Context
- What this task is about, in 2–4 sentences.
- Files in scope (point agy at the exact paths): `src/...`, `tests/...`
- Any relevant existing pattern to mirror (name the file/function).

## Requirements
1. <Concrete, testable change #1>
2. <Concrete, testable change #2>
3. ...

## Constraints
- Follow `.agents/AGENTS.md` exactly (verify gate, naming, no commit/push/deploy).
- Touch ONLY the files listed above; do not refactor unrelated code.
- <Anything to explicitly NOT do, e.g. "do not delete registrations", "host-club fees are $0">

## Definition of done
- `npm run build` clean, `npx eslint <touched files>` clean, `npx vitest run` green.
- <New vitest test added for any new pure logic? name it>
- Report: list every file changed + the verify-gate output. Do not commit.
