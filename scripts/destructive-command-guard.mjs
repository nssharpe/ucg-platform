#!/usr/bin/env node
// PreToolUse hook: destructive-command guard for the Bash tool.
// Wired in .claude/settings.json. Reads the tool-call JSON on stdin and emits a
// permissionDecision when the command matches a destructive pattern:
//   deny — unambiguously catastrophic (recursive delete of a root/repo/.git,
//          remote `supabase db reset`, force-push to main)
//   ask  — destructive but sometimes legitimate (git reset --hard, git clean,
//          recursive rm of non-build paths, remote DROP/TRUNCATE, ...)
// No output = normal permission flow. Pattern-based (no shell parsing), so a
// quoted string containing e.g. "rm -rf" can false-positive as "ask" — that is
// an accepted tradeoff; "deny" patterns are kept narrow.
// Test battery: node scripts/destructive-command-guard.mjs --self-test

const REPO = 'c:/dev/ucg-platform'

// Targets safe to recursively delete without asking (build output, temp).
const SAFE_TARGET =
  /^(\.?\/)?(node_modules|dist|coverage|\.vite|playwright-report|test-results)([\\/].*)?$/i
const TEMP_TARGET = /appdata[\\/]local[\\/]temp|^\/tmp\/|scratchpad/i

// Catastrophic delete targets: filesystem/drive roots, home, parent, .git, repo root.
function isCatastrophic(t) {
  const n = t.replace(/^["']|["']$/g, '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  if (n === '' && t !== '') return true // was just "/"
  return (
    n === '/' || /^[a-z]:$/.test(n) || /^\/[a-z]$/.test(n) ||
    n === '~' || n === '$home' || n === '..' || n === '../..' ||
    n === '.git' || n.endsWith('/.git') ||
    n === REPO || n === '/c/dev/ucg-platform'
  )
}

function checkRm(cmd) {
  // Each `rm` invocation: flags then targets (up to a command separator).
  const re = /(?:^|[;&|]\s*|\s)rm\s+((?:-{1,2}[\w-]+\s+)*)([^;&|]*)/g
  let m
  let worst = null
  while ((m = re.exec(cmd))) {
    const flags = m[1]
    const recursive = /(^|\s)-{1,2}[\w-]*r/i.test(flags)
    if (!recursive) continue
    // Split targets, respecting simple quoting.
    const targets = (m[2].match(/"[^"]*"|'[^']*'|\S+/g) ?? []).filter((t) => !t.startsWith('-'))
    if (targets.some(isCatastrophic))
      return { decision: 'deny', reason: 'Recursive delete of a filesystem root, home, .git, or the repo itself.' }
    const allSafe =
      targets.length > 0 &&
      targets.every((t) => {
        const clean = t.replace(/^["']|["']$/g, '')
        return SAFE_TARGET.test(clean) || TEMP_TARGET.test(clean)
      })
    if (!allSafe)
      worst = { decision: 'ask', reason: `Recursive rm of non-build path(s): ${targets.join(' ')}` }
  }
  return worst
}

const RULES = [
  { re: /supabase\s+db\s+reset(?![\s\S]*--local)/, decision: 'deny',
    reason: 'supabase db reset without --local wipes a REMOTE database.' },
  { re: /git\s+push\b(?=[\s\S]*(\s--force(-with-lease)?\b|\s-f\b))[\s\S]*\b(main|master)\b/, decision: 'deny',
    reason: 'Force-push to main/master rewrites shared history and triggers a deploy.' },
  { re: /(remove-item|rd\b|rmdir)\b[\s\S]*(-recurse|\/s)\b/i, decision: 'ask',
    reason: 'Recursive Windows delete (Remove-Item/rd) — confirm the target.' },
  { re: /git\s+push\b[\s\S]*(\s--force(-with-lease)?\b|\s-f\b)/, decision: 'ask',
    reason: 'Force-push rewrites remote history.' },
  { re: /git\s+reset\s+--hard/, decision: 'ask',
    reason: 'git reset --hard discards uncommitted work.' },
  { re: /git\s+clean\b[\s\S]*\s-[\w]*f/, decision: 'ask',
    reason: 'git clean -f deletes untracked files (possibly new work).' },
  { re: /git\s+(checkout|restore)\s+(--\s+)?\.(\s|$)/, decision: 'ask',
    reason: 'Checkout/restore of "." discards ALL uncommitted changes.' },
  { re: /git\s+branch\s+(-D|--delete\s+--force)\b/, decision: 'ask',
    reason: 'Force branch delete can drop unmerged commits.' },
  { re: /git\s+stash\s+(drop|clear)\b/, decision: 'ask',
    reason: 'Dropping stashes is unrecoverable.' },
  { re: /(supabase\s+db\s+query|psql)\b[\s\S]*\b(drop\s+(table|schema|database)|truncate)\b/i, decision: 'ask',
    reason: 'Destructive SQL (DROP/TRUNCATE) against a live database.' },
  { re: /supabase\s+config\s+push/, decision: 'ask',
    reason: 'supabase config push AUTO-CONFIRMS under agent detection and pushes DEFAULTS for ' +
      'undeclared [auth] keys — it reset prod auth settings during a supposed dry run ' +
      '(2026-07-18). Use the config-push-dryrun skill: one `n` per expected prompt, read the diff.' },
  { re: /supabase\s+db\s+push/, decision: 'ask',
    reason: 'Applies migrations to a remote DB. Run `supabase migration list` and reconcile FIRST ' +
      '— a remote version with no local file means another session touched the DB. Staging ' +
      '(--project-ref xogpiksqtkayxwmczlbx) before prod. See the migration-push skill.' },
  { re: /find\b[\s\S]*(\s-delete\b|-exec\s+rm\b)/, decision: 'ask',
    reason: 'find with -delete/-exec rm mass-deletes files.' },
]

function evaluate(raw) {
  // Commit/PR messages are pure data — blank quoted -m/--message/--body args so
  // prose like `-m "fix: supabase db reset docs"` can't trip command patterns.
  const cmd = /git\s+commit|gh\s+(pr|issue|release)/.test(raw)
    ? raw
        .replace(/(-m|--message|--body|--title)([=\s]+)("(?:[^"\\]|\\.)*"|'[^']*')/g, '$1$2""')
        .replace(/<<\s*-?\s*'?"?(\w+)'?"?[\s\S]*?\n\s*\1/g, '<<STRIPPED\nSTRIPPED')
    : raw
  const rm = checkRm(cmd)
  if (rm?.decision === 'deny') return rm
  for (const r of RULES) if (r.re.test(cmd)) return { decision: r.decision, reason: r.reason }
  return rm // possibly an 'ask', or null
}

function emit(result) {
  if (!result) return
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: result.decision,
        permissionDecisionReason: `[destructive-command-guard] ${result.reason}`,
      },
    })
  )
}

if (process.argv.includes('--self-test')) {
  const cases = [
    ['rm -rf node_modules dist', null],
    ['rm -rf "C:/Users/x/AppData/Local/Temp/claude/abc/scratchpad/foo"', null],
    ['rm -rf src', 'ask'],
    ['rm -rf /', 'deny'],
    ['rm -rf ~', 'deny'],
    ['rm -rf C:/dev/ucg-platform', 'deny'],
    ['rm -rf .git', 'deny'],
    ['rm file.txt', null],
    ['cd /tmp && rm -rf build-cache', 'ask'],
    ['git reset --hard HEAD~1', 'ask'],
    ['git push --force origin main', 'deny'],
    ['git push --force-with-lease origin feat/x', 'ask'],
    ['git push origin main', null],
    ['supabase db reset', 'deny'],
    ['supabase db reset --local', null],
    ['supabase config push', 'ask'],
    ['echo n | supabase config push --agent no', 'ask'], // the dry run can still apply for real
    ['supabase db push', 'ask'],
    ['supabase db push --project-ref xogpiksqtkayxwmczlbx', 'ask'],
    ['supabase migration list', null],
    ['supabase functions deploy stripe-webhook --no-verify-jwt', null],
    ['git clean -fd', 'ask'],
    ['git checkout .', 'ask'],
    ['git checkout -- .', 'ask'],
    ['git checkout feat/x', null],
    ['git branch -D feat/x', 'ask'],
    ['git stash drop', 'ask'],
    ['supabase db query --db-url x -f drop.sql', null],
    ['psql "$URL" -c "truncate registrations"', 'ask'],
    ['find . -name "*.tmp" -delete', 'ask'],
    ['npm run build && git status', null],
    ['git commit -m "docs: rm -rf note"', null], // message text is stripped
    ['git commit -m "chore: supabase db reset docs" && git push', null],
    ['git commit -m "x" && supabase db reset', 'deny'], // real command after a commit still caught
  ]
  let fail = 0
  for (const [cmd, expected] of cases) {
    const got = evaluate(cmd)?.decision ?? null
    if (got !== expected) {
      fail++
      console.error(`FAIL: ${JSON.stringify(cmd)} -> ${got}, expected ${expected}`)
    }
  }
  console.log(fail ? `${fail} failures` : `all ${cases.length} cases pass`)
  process.exit(fail ? 1 : 0)
}

let stdin = ''
process.stdin.on('data', (c) => (stdin += c))
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(stdin)
    if (input.tool_name && input.tool_name !== 'Bash') return
    const cmd = input.tool_input?.command ?? ''
    emit(evaluate(cmd))
  } catch {
    // Never block tool use on a guard bug.
  }
})
