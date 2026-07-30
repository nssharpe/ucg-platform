#!/usr/bin/env node
// PostToolUse hook: deterministic post-Bash checks. Wired in .claude/settings.json.
//
// Replaces prose instructions that only worked when the model remembered them.
// Each check corresponds to a real incident:
//   1. doc sweep after `git commit`             — docs drift (reminder only)
//   2. verify_jwt after `functions deploy`      — a bare redeploy silently resets
//      verify_jwt=true on the three functions that MUST stay false; the gateway
//      then rejects callers before the function runs, with no logs. A real
//      customer charge sat unfulfilled 2026-07-02.
//   3. dev-auth firewall after a build          — dev auto-login must never be
//      reachable from a production bundle.
//
// Design rules for this file:
//   * Fail OPEN. A bug here must never break a Bash call. Everything is wrapped.
//   * Do nothing unless the command matches. This runs after EVERY Bash call.
//   * Emit findings as additionalContext so they land in the transcript.
//
// Self-test: node scripts/hooks/post-bash-checks.mjs --self-test

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const REPO = 'C:/dev/ucg-platform'
const PROD_REF = 'wkyerxlgricfphopocoz'

// Functions whose gateway auth MUST stay off. Keep in lockstep with
// .claude/rules/edge-functions.md and supabase/README.md.
const NO_VERIFY_JWT = ['stripe-webhook', 'sms-webhook', 'notify-manager-access-denied']

// Tokens that must never appear in a built bundle (src/lib/dev-auth.ts firewall).
const DEV_AUTH_TOKENS = ['VITE_DEV_AUTH', 'initDevAuth']

// ---------------------------------------------------------------- matchers

const isCommit = (c) => /\bgit\s+commit\b/.test(c)
const isFunctionsDeploy = (c) => /\bsupabase\s+functions\s+deploy\b/.test(c)
const isBuild = (c) => /\bnpm\s+run\s+build\b|\bvite\s+build\b/.test(c)

/** Which of the sensitive functions could this deploy have reset? */
export function affectedFunctions(cmd) {
  if (!isFunctionsDeploy(cmd)) return []
  const named = NO_VERIFY_JWT.filter((f) => cmd.includes(f))
  if (named.length) return named
  // `functions deploy` with no function name deploys ALL of them.
  const bare = /\bsupabase\s+functions\s+deploy\s*(?:--[\w-]+(?:[=\s]+\S+)?\s*)*$/.test(cmd.trim())
  return bare ? [...NO_VERIFY_JWT] : []
}

export function projectRefOf(cmd) {
  const m = cmd.match(/--project-ref[=\s]+([a-z0-9]+)/i)
  return m ? m[1] : PROD_REF
}

// ---------------------------------------------------------------- checks

const DOC_SWEEP =
  'DOC SWEEP REMINDER: a git commit just ran. Before continuing, check whether this ' +
  'change made any docs stale (README.md, CLAUDE.md, .claude/rules/*, .claude/skills/*, ' +
  'docs/README.md, supabase/README.md, and relevant files under docs/specs and docs/plans) ' +
  'and update them this same session. Skip only if the commit was docs-only or clearly has ' +
  'no documentation impact.'

function checkVerifyJwt(cmd) {
  const affected = affectedFunctions(cmd)
  if (!affected.length) return null
  const ref = projectRefOf(cmd)
  let out
  try {
    out = execFileSync('supabase', ['functions', 'list', '--project-ref', ref], {
      encoding: 'utf8',
      timeout: 45_000,
      windowsHide: true,
    })
  } catch (err) {
    return (
      `⚠ VERIFY_JWT CHECK COULD NOT RUN (${err?.code ?? 'error'}) after deploying ` +
      `${affected.join(', ')}. --no-verify-jwt is NOT sticky: a bare redeploy resets it to ` +
      `true and silently breaks these functions. Run manually and confirm verify_jwt: false ` +
      `for ${NO_VERIFY_JWT.join(', ')}:\n  supabase functions list --project-ref ${ref}`
    )
  }
  // Rows look like: `... | stripe-webhook | ... | false | ...` — find each function's
  // line and look for a truthy verify_jwt token on it.
  const broken = []
  for (const fn of affected) {
    const line = out.split('\n').find((l) => new RegExp(`\\b${fn}\\b`).test(l))
    if (!line) continue
    if (/\btrue\b/i.test(line)) broken.push(fn)
  }
  if (broken.length) {
    return (
      `🚨 verify_jwt IS TRUE on: ${broken.join(', ')} (project ${ref}).\n` +
      `These MUST be false or Supabase's gateway rejects callers BEFORE the function runs ` +
      `— no logs, invisible failure (an unfulfilled customer charge, 2026-07-02). Redeploy ` +
      `each with the flag, then re-check:\n` +
      broken
        .map((f) => `  supabase functions deploy ${f} --project-ref ${ref} --no-verify-jwt`)
        .join('\n')
    )
  }
  return `✓ verify_jwt confirmed false for ${affected.join(', ')} (project ${ref}).`
}

function checkDevAuthFirewall() {
  const assets = join(REPO, 'dist', 'assets')
  if (!existsSync(assets)) return null
  let hits = []
  try {
    for (const f of readdirSync(assets)) {
      if (!/\.(js|mjs|css)$/.test(f)) continue
      const body = readFileSync(join(assets, f), 'utf8')
      const found = DEV_AUTH_TOKENS.filter((t) => body.includes(t))
      if (found.length) hits.push(`${f}: ${found.join(', ')}`)
    }
  } catch {
    return null
  }
  if (hits.length) {
    return (
      `🚨 DEV-AUTH LEAKED INTO THE BUNDLE — dist/assets contains dev auto-login tokens:\n` +
      hits.map((h) => `  ${h}`).join('\n') +
      `\nsrc/lib/dev-auth.ts must only ever be reached via a dynamic import guarded by ` +
      `import.meta.env.DEV. Do NOT deploy this build.`
    )
  }
  return '✓ dev-auth firewall: no VITE_DEV_AUTH/initDevAuth in dist/assets.'
}

export function runChecks(cmd, { deps = {} } = {}) {
  const verifyJwt = deps.checkVerifyJwt ?? checkVerifyJwt
  const devAuth = deps.checkDevAuthFirewall ?? checkDevAuthFirewall
  const notes = []
  if (isCommit(cmd)) notes.push(DOC_SWEEP)
  if (isFunctionsDeploy(cmd)) {
    const r = safe(() => verifyJwt(cmd))
    if (r) notes.push(r)
  }
  if (isBuild(cmd)) {
    const r = safe(() => devAuth())
    if (r) notes.push(r)
  }
  return notes
}

function safe(fn) {
  try {
    return fn()
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- self-test

if (process.argv.includes('--self-test')) {
  const stub = {
    checkVerifyJwt: (c) => `VJWT(${affectedFunctions(c).join('+') || 'none'}@${projectRefOf(c)})`,
    checkDevAuthFirewall: () => 'DEVAUTH',
  }
  const cases = [
    ['git status', []],
    ['git commit -m "x"', [DOC_SWEEP]],
    ['npm run build', ['DEVAUTH']],
    ['npm run build && git commit -m "x"', [DOC_SWEEP, 'DEVAUTH']],
    [
      'supabase functions deploy stripe-webhook --project-ref wkyerxlgricfphopocoz --no-verify-jwt',
      ['VJWT(stripe-webhook@wkyerxlgricfphopocoz)'],
    ],
    // A deploy of an unrelated function cannot reset the trio.
    ['supabase functions deploy send-email --project-ref abc123', ['VJWT(none@abc123)']],
    // Bulk deploy touches everything.
    [
      'supabase functions deploy --project-ref abc123',
      [`VJWT(${NO_VERIFY_JWT.join('+')}@abc123)`],
    ],
    ['supabase functions deploy sms-webhook', [`VJWT(sms-webhook@${PROD_REF})`]],
  ]
  let fail = 0
  for (const [cmd, expected] of cases) {
    const got = runChecks(cmd, { deps: stub })
    if (JSON.stringify(got) !== JSON.stringify(expected)) {
      fail++
      console.error(`FAIL: ${JSON.stringify(cmd)}\n  got:      ${JSON.stringify(got)}\n  expected: ${JSON.stringify(expected)}`)
    }
  }
  console.log(fail ? `${fail} failures` : `all ${cases.length} cases pass`)
  process.exit(fail ? 1 : 0)
}

// ---------------------------------------------------------------- hook entry

if (!process.argv.includes('--self-test')) {
  let stdin = ''
  process.stdin.on('data', (c) => (stdin += c))
  process.stdin.on('end', () => {
    try {
      const input = JSON.parse(stdin)
      if (input.tool_name && input.tool_name !== 'Bash') return
      const cmd = input.tool_input?.command ?? ''
      const notes = runChecks(cmd)
      if (!notes.length) return
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            additionalContext: notes.join('\n\n'),
          },
        })
      )
    } catch {
      // Fail open — never break a Bash call on a hook bug.
    }
  })
}
