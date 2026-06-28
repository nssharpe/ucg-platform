<#
.SYNOPSIS
  Self-driving batch runner for agy implementation tasks. Runs every brief in a folder,
  in order, on one batch branch: agy implements -> verify gate -> commit on green,
  discard + log on red. Designed for "kick it off and walk away" (use -Auto); Claude
  reviews the branch diff once at the end.

.PARAMETER Folder
  Folder of brief .md files (e.g. docs\agy-tasks\batch-mechanical). Runs them sorted by
  name; ignores _TEMPLATE.md / TRACKER.md.

.PARAMETER Auto
  No per-task pause. Commit on green, discard+log on red, continue. Walk-away mode.
  Without -Auto, pauses after each task for [c]ommit / [s]kip / [a]bort.

.PARAMETER Branch
  Batch branch name (default agy/batch-<timestamp>), created off main.

.PARAMETER Model
  Optional agy model override.

.EXAMPLE
  .\scripts\run-agy-batch.ps1 -Folder docs\agy-tasks\batch-mechanical -Auto
#>
param(
  [Parameter(Mandatory = $true)][string]$Folder,
  [switch]$Auto,
  [string]$Branch,
  [string]$Model
)

$ErrorActionPreference = 'Stop'
$repo = 'C:\dev\ucg-platform'
Set-Location $repo

# Raise agy's internal tool/agent execution budget (default ~300s/5min) so multi-file
# investigations don't abort with 'timed out waiting for response'. --print-timeout alone
# does NOT govern this; AGY_TIMEOUT (+ tool-specific overrides) does.
$env:AGY_TIMEOUT = '1800'
$env:AGY_TIMEOUT_ANALYZE_FILES = '1800'
$env:AGY_TIMEOUT_DEEP_SEARCH = '1800'

$briefs = Get-ChildItem -Path $Folder -Filter '*.md' |
          Where-Object { $_.Name -notmatch '^(_TEMPLATE|TRACKER)\.md$' } |
          Sort-Object Name
if (-not $briefs) { throw "No brief .md files in $Folder" }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
if (-not $Branch) { $Branch = "agy/batch-$stamp" }
git checkout main | Out-Null
if (git branch --list $Branch) { git checkout $Branch | Out-Null } else { git checkout -b $Branch | Out-Null }

$runDir = Join-Path $repo 'docs\agy-tasks\runs'
New-Item -ItemType Directory -Force -Path $runDir | Out-Null

function Test-VerifyGate {
  npm run build; if ($LASTEXITCODE -ne 0) { return $false }
  $changed = git --no-pager diff --name-only | Where-Object { Test-Path $_ }
  if ($changed) { npx eslint @changed; if ($LASTEXITCODE -ne 0) { return $false } }
  npx vitest run; if ($LASTEXITCODE -ne 0) { return $false }
  return $true
}

$passed = @(); $failed = @(); $abort = $false

foreach ($b in $briefs) {
  if ($abort) { break }
  Write-Host ("`n==================== " + $b.Name + " ====================") -ForegroundColor Cyan
  $briefText = Get-Content -Raw $b.FullName
  $base = "$stamp-" + $b.BaseName
  $transcript = Join-Path $runDir ($base + ".txt")
  $logFile    = Join-Path $runDir ($base + ".log")

  $agyArgs = @('--print', $briefText, '--dangerously-skip-permissions', '--print-timeout', '1800s', '--log-file', $logFile)
  if ($Model) { $agyArgs += @('--model', $Model) }
  agy @agyArgs *>&1 | Tee-Object -FilePath $transcript

  if (-not (git status --porcelain)) {
    Write-Host "agy made NO changes - logging as failed." -ForegroundColor Red
    $failed += ($b.Name + "  (no changes; transcript: " + $transcript + ")")
    continue
  }

  Write-Host "`n--- git diff --stat ---" -ForegroundColor Cyan
  git --no-pager diff --stat

  if (Test-VerifyGate) {
    if ($Auto) {
      git add -A; git commit -m ("agy: " + $b.BaseName) | Out-Null
      Write-Host "PASS -> committed." -ForegroundColor Green
      $passed += $b.Name
    } else {
      $ans = Read-Host "PASS. [c]ommit / [s]kip / [a]bort"
      if ($ans -eq 'c') {
        git add -A; git commit -m ("agy: " + $b.BaseName) | Out-Null
        $passed += $b.Name
      } elseif ($ans -eq 'a') {
        git reset --hard HEAD | Out-Null; git clean -fd | Out-Null; $abort = $true
      } else {
        git reset --hard HEAD | Out-Null; git clean -fd | Out-Null
        $failed += ($b.Name + " (skipped)")
      }
    }
  } else {
    Write-Host "VERIFY FAILED -> discarding changes, logging for review." -ForegroundColor Red
    git reset --hard HEAD | Out-Null
    git clean -fd | Out-Null
    $failed += ($b.Name + "  (verify failed; transcript: " + $transcript + ")")
    if (-not $Auto) { Read-Host "Press Enter to continue" | Out-Null }
  }
}

Write-Host "`n==================== BATCH SUMMARY ====================" -ForegroundColor Cyan
Write-Host ("Branch: " + $Branch)
Write-Host ("Committed (" + $passed.Count + "):") -ForegroundColor Green
$passed | ForEach-Object { Write-Host ("  " + $_) }
Write-Host ("Needs review (" + $failed.Count + "):") -ForegroundColor Yellow
$failed | ForEach-Object { Write-Host ("  " + $_) }
Write-Host ("`nReview:  git --no-pager diff main.." + $Branch)
Write-Host ("Merge:   git checkout main; git merge " + $Branch + "   (after Claude reviews)")
