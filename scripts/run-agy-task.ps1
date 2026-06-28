<#
.SYNOPSIS
  Run a single agy (Antigravity CLI) implementation task headlessly on an
  isolated branch, capture the transcript, and run the verification gate.

.DESCRIPTION
  Drives Google's agy CLI in non-interactive print mode against a brief file.
  agy implements the task following the repo's .agents/AGENTS.md rules; this
  script then independently runs the verify gate (build + eslint + vitest) as a
  backstop. It NEVER commits, pushes, or deploys — you review the diff and commit.

.PARAMETER Brief
  Path to a task brief markdown file (see docs/agy-tasks/_TEMPLATE.md).

.PARAMETER Branch
  Optional branch to create/checkout for isolation (recommended: one per task).

.PARAMETER Model
  Optional agy model override (see `agy models`).

.PARAMETER SkipVerify
  Skip the build/lint/test backstop (faster; agy still self-verifies per AGENTS.md).

.EXAMPLE
  .\scripts\run-agy-task.ps1 -Brief docs\agy-tasks\01-fix-foo.md -Branch agy/01-fix-foo
#>
param(
  [Parameter(Mandatory = $true)][string]$Brief,
  [string]$Branch,
  [string]$Model,
  [switch]$SkipVerify
)

$ErrorActionPreference = 'Stop'
$repo = 'C:\dev\ucg-platform'
Set-Location $repo

if (-not (Test-Path $Brief)) { throw "Brief not found: $Brief" }
$briefText = Get-Content -Raw $Brief

# --- Isolate on a branch ------------------------------------------------------
if ($Branch) {
  if (git branch --list $Branch) { git checkout $Branch } else { git checkout -b $Branch }
}

# --- Run agy headlessly -------------------------------------------------------
$stamp     = Get-Date -Format 'yyyyMMdd-HHmmss'
$runDir    = Join-Path $repo 'docs\agy-tasks\runs'
New-Item -ItemType Directory -Force -Path $runDir | Out-Null
$transcript = Join-Path $runDir "$stamp.txt"
$logFile    = Join-Path $runDir "$stamp.log"

# Raise agy's internal tool/agent execution budget (default ~300s/5min) so multi-file
# investigations don't abort with "timed out waiting for response". --print-timeout alone
# does NOT govern this; AGY_TIMEOUT (+ tool-specific overrides) does.
$env:AGY_TIMEOUT = '1800'
$env:AGY_TIMEOUT_ANALYZE_FILES = '1800'
$env:AGY_TIMEOUT_DEEP_SEARCH = '1800'
$agyArgs = @('--print', $briefText, '--dangerously-skip-permissions', '--print-timeout', '1800s', '--log-file', $logFile)
if ($Model) { $agyArgs += @('--model', $Model) }

Write-Host "Running agy on: $Brief" -ForegroundColor Cyan
agy @agyArgs *>&1 | Tee-Object -FilePath $transcript

# --- Show what changed --------------------------------------------------------
Write-Host "`n--- git diff --stat ---" -ForegroundColor Cyan
git --no-pager diff --stat

# --- Verify gate (backstop) ---------------------------------------------------
if (-not $SkipVerify) {
  Write-Host "`n--- verify gate: npm run build ---" -ForegroundColor Cyan
  npm run build
  $changed = git --no-pager diff --name-only | Where-Object { Test-Path $_ }
  if ($changed) {
    Write-Host "`n--- verify gate: eslint touched files ---" -ForegroundColor Cyan
    npx eslint @changed
  }
  Write-Host "`n--- verify gate: vitest ---" -ForegroundColor Cyan
  npx vitest run
}

Write-Host "`nTranscript: $transcript" -ForegroundColor Green
Write-Host "agy log:    $logFile"   -ForegroundColor Green
Write-Host "Full JSONL: ~\.gemini\antigravity-cli\brain\<conversation-id>\.system_generated\logs\transcript_full.jsonl"
Write-Host "Review the diff, then commit when satisfied (this script does NOT commit)." -ForegroundColor Yellow
