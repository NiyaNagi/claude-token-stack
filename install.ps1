<#
.SYNOPSIS
  Installs the Claude Code token-efficiency stack (Windows). Idempotent; safe to re-run.
.DESCRIPTION
  Backs up your config, installs Headroom (PyPI), RTK (winget), codebase-memory-mcp (scoop/winget),
  the caveman + context-mode plugins, the tokenstack hooks, CLAUDE.md / skill / command files, merges
  settings non-destructively, registers MCP servers, baselines existing skills, and runs the self-tests.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1
  .\install.ps1 -SkipCodeburn -SkipHeadroom
#>
param(
  [switch]$SkipHeadroom,   # no Headroom venv / MCP / compression (compress hook becomes a no-op)
  [switch]$SkipRtk,
  [switch]$SkipCbm,
  [switch]$SkipPlugins,    # caveman + context-mode
  [switch]$SkipCodeburn,
  [switch]$ForceEnv,       # overwrite env values you already set in settings.json
  [switch]$NoTests
)
$ErrorActionPreference = 'Stop'
$Repo   = $PSScriptRoot
$Claude = Join-Path $env:USERPROFILE '.claude'
$HomeFwd = $env:USERPROFILE -replace '\\','/'
function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "    ! $m" -ForegroundColor Yellow }
function Ok($m)   { Write-Host "    $m" -ForegroundColor Green }
function Write-Utf8($path, $text) { New-Item -ItemType Directory -Force (Split-Path $path) | Out-Null; [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding $false)) }

# ---------------------------------------------------------------- preflight
Step 'Preflight'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js not found. Install Node 22.13+ (winget install OpenJS.NodeJS.22).' }
$nv = [version]((node --version).TrimStart('v'))
if ($nv -lt [version]'22.5') { throw "Node $nv too old (context-mode needs >=22.5; codeburn >=22.13)." }
Ok "node $nv"
$py = Get-Command python -ErrorAction SilentlyContinue
if (-not $py -and -not $SkipHeadroom) { throw 'Python 3.10+ not found (needed for Headroom). Use -SkipHeadroom to skip.' }
# Claude CLI: PATH, or the desktop app's bundled copy (MSIX: real path is under LocalAppData\Packages)
$ClaudeExe = (Get-Command claude -ErrorAction SilentlyContinue).Source
if (-not $ClaudeExe) {
  $cands = @("$env:APPDATA\Claude\claude-code") + (Get-ChildItem "$env:LOCALAPPDATA\Packages" -Directory -Filter 'Claude_*' -ErrorAction SilentlyContinue | ForEach-Object { Join-Path $_.FullName 'LocalCache\Roaming\Claude\claude-code' })
  foreach ($c in $cands) {
    $v = Get-ChildItem $c -Directory -ErrorAction SilentlyContinue | Where-Object { Test-Path (Join-Path $_.FullName 'claude.exe') } | Sort-Object { [version]$_.Name } | Select-Object -Last 1
    if ($v) { $ClaudeExe = Join-Path $v.FullName 'claude.exe'; break }
  }
}
if (-not $ClaudeExe) { throw 'Claude Code CLI not found (PATH or Claude desktop app). Install from https://claude.ai/code' }
Ok "claude: $ClaudeExe"
$GitBash = @("$env:USERPROFILE\scoop\apps\git\current\bin\bash.exe", "$env:ProgramFiles\Git\bin\bash.exe", "${env:ProgramFiles(x86)}\Git\bin\bash.exe") | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if ($GitBash) { Ok "git bash: $GitBash" } else { Warn 'Git Bash not found: caveman plugin hooks (POSIX sh) will not run. Install Git for Windows.' }

# ---------------------------------------------------------------- backup
Step 'Backup'
$bk = Join-Path $Claude ("backups\token-stack-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force $bk | Out-Null
foreach ($f in "$Claude\settings.json", "$env:USERPROFILE\.claude.json", "$Claude\CLAUDE.md") { if (Test-Path $f) { Copy-Item $f $bk } }
Ok $bk

# ---------------------------------------------------------------- tools
if (-not $SkipHeadroom) {
  Step 'Headroom (PyPI: headroom-ai[mcp]) -> ~/.headroom/venv'
  # Official package only. Do NOT use extraheadroom.com or third-party "headroom desktop" installers.
  $hv = Join-Path $env:USERPROFILE '.headroom\venv'
  if (-not (Test-Path "$hv\Scripts\headroom.exe")) {
    python -m venv $hv
    & "$hv\Scripts\python.exe" -m pip install -q --disable-pip-version-check 'headroom-ai[mcp]'
  }
  Ok (& "$hv\Scripts\headroom.exe" --version)
}
if (-not $SkipRtk) {
  Step 'RTK (winget rtk-ai.rtk)  — NOT `cargo install rtk` (different crate)'
  winget install --id rtk-ai.rtk --exact --source winget --accept-package-agreements --accept-source-agreements --disable-interactivity | Out-Null
  $rtk = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\rtk-ai.rtk*" -Recurse -Filter rtk.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($rtk) { Write-Utf8 (Join-Path $Claude 'tokenstack\rtk-path') $rtk.FullName; Ok (& $rtk.FullName --version) } else { Warn 'rtk.exe not found after install' }
}
if (-not $SkipCbm) {
  Step 'codebase-memory-mcp'
  if (-not (Get-Command codebase-memory-mcp -ErrorAction SilentlyContinue)) {
    if (Get-Command scoop -ErrorAction SilentlyContinue) { scoop install codebase-memory-mcp | Out-Null }
    else { winget install --id DeusData.codebase-memory-mcp --exact --accept-package-agreements --accept-source-agreements --disable-interactivity | Out-Null }
  }
  $CbmExe = (Get-Command codebase-memory-mcp -ErrorAction SilentlyContinue).Source
  if ($CbmExe -like '*scoop\shims*') { $CbmExe = "$env:USERPROFILE\scoop\apps\codebase-memory-mcp\current\codebase-memory-mcp.exe" }
  Ok $CbmExe
}
if (-not $SkipPlugins) {
  Step 'Plugins: caveman, context-mode'
  $list = (& $ClaudeExe plugin list 2>&1) -join "`n"
  foreach ($p in @(@{m='JuliusBrussee/caveman'; id='caveman@caveman'}, @{m='mksglu/context-mode'; id='context-mode@context-mode'})) {
    if ($list -notmatch [regex]::Escape($p.id)) { & $ClaudeExe plugin marketplace add $p.m | Out-Null; & $ClaudeExe plugin install $p.id --scope user | Out-Null }
    Ok $p.id
  }
}
if (-not $SkipCodeburn) {
  Step 'Codeburn (npm codeburn, CLI only)'
  if ($nv -lt [version]'22.13') { Warn 'Node <22.13: skipping codeburn' } else { npm install -g codeburn 2>&1 | Out-Null; Ok 'codeburn installed (run: codeburn, or npx codeburn)' }
}

# ---------------------------------------------------------------- files
Step 'Hooks, CLAUDE.md, rules, skill, command'
Copy-Item "$Repo\hooks\tokenstack\*" (New-Item -ItemType Directory -Force "$Claude\hooks\tokenstack").FullName -Force
function Install-Template($src, $dst, [switch]$KeepExisting) {
  $text = [IO.File]::ReadAllText($src) -replace '\{\{HOME\}\}', $HomeFwd
  if ($KeepExisting -and (Test-Path $dst)) { Warn "$dst exists - left untouched"; return $false }
  Write-Utf8 $dst $text; Ok $dst; return $true
}
# CLAUDE.md: never overwrite yours. Install as CLAUDE.tokenstack.md and import it.
$cm = "$Claude\CLAUDE.md"
if ((Test-Path $cm) -and ([IO.File]::ReadAllText($cm) -match '^# Global rules \(token-efficient stack\)')) {
  Install-Template "$Repo\claude\CLAUDE.md" $cm | Out-Null   # it's ours from a previous install: update in place
} elseif (Test-Path $cm) {
  Install-Template "$Repo\claude\CLAUDE.md" "$Claude\CLAUDE.tokenstack.md" | Out-Null
  $cur = [IO.File]::ReadAllText($cm)
  if ($cur -notmatch '@CLAUDE\.tokenstack\.md') { Write-Utf8 $cm ($cur.TrimEnd() + "`n`n@CLAUDE.tokenstack.md`n"); Ok 'imported into existing CLAUDE.md' }
} else { Install-Template "$Repo\claude\CLAUDE.md" $cm | Out-Null }
Install-Template "$Repo\claude\rules\stacks.md" "$Claude\rules\stacks.md" -KeepExisting | Out-Null
Install-Template "$Repo\claude\skills\skill-intake\SKILL.md" "$Claude\skills\skill-intake\SKILL.md" | Out-Null
Install-Template "$Repo\claude\commands\handoff.md" "$Claude\commands\handoff.md" | Out-Null

# ---------------------------------------------------------------- settings
Step 'Merge settings.json (non-destructive)'
$mergeArgs = @("$Repo\scripts\merge-settings.js", "$Repo\settings.template.json", "$Claude\settings.json")
if ($GitBash) { $mergeArgs += @('--git-bash', $GitBash) }
if ($ForceEnv) { $mergeArgs += '--force-env' }
node @mergeArgs

# ---------------------------------------------------------------- MCP servers (user scope, short names = fewer tokens per call)
Step 'MCP servers'
$mcp = (& $ClaudeExe mcp list 2>&1) -join "`n"
if (-not $SkipCbm -and $CbmExe -and $mcp -notmatch '(?m)^cbm:') { & $ClaudeExe mcp add -s user cbm -- $CbmExe | Out-Null }
if (-not $SkipHeadroom -and $mcp -notmatch '(?m)^headroom:') {
  & $ClaudeExe mcp add -s user headroom -e HEADROOM_BEACON=off -e HEADROOM_CCR_TTL_SECONDS=21600 -- "$env:USERPROFILE\.headroom\venv\Scripts\headroom.exe" mcp serve | Out-Null
}
(& $ClaudeExe mcp list 2>&1) | Select-String 'cbm|headroom|context-mode' | ForEach-Object { Ok $_.Line.Trim() }

# ---------------------------------------------------------------- skills baseline
Step 'Baseline existing skills (only NEW/CHANGED skills will be flagged for intake)'
node "$Claude\hooks\tokenstack\ts.js" skill-register --baseline-all 'pre-existing at stack install' | Measure-Object -Line | ForEach-Object { Ok "$($_.Lines) skills baselined" }
node "$Claude\hooks\tokenstack\ts.js" skill-register "$Claude\skills\skill-intake\SKILL.md" 'stack skill' | Out-Null

# ---------------------------------------------------------------- tests
if (-not $NoTests) {
  Step 'Self-tests'
  node "$Repo\tests\hooks.test.js" | Select-String 'FAIL|ALL PASS|FAILURES'
  if (-not $SkipHeadroom) { node "$Repo\tests\compression.test.js" | Select-String 'FAIL|ALL PASS|FAILURES' }
  node "$Repo\tests\router.test.js" | Select-String 'FAIL|ALL PASS|FAILURES'
}

Step 'Done'
Write-Host @"
    Restart the Claude desktop app (or start a new CLI session) to load hooks, plugins and MCP servers.
    Optional: log the CLI in once for model-written handoffs:  & "$ClaudeExe"  then /login
    Benchmark on one of your repos:  node "$Repo\tests\benchmark.js" <repo>
    Backup of previous config: $bk
"@
