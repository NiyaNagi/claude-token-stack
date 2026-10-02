# Setup

Windows 10/11. Works for Claude Code in the **Claude desktop app (Code tab)** and the **CLI**.
macOS/Linux: the hooks (`ts.js`) are cross-platform Node, but `install.ps1` is Windows-only — follow the manual steps and swap paths/package managers.

## Prerequisites

| Need | Version | Install |
|---|---|---|
| Claude Code | 2.1.2xx+ | Claude desktop app, or https://claude.ai/code |
| Node.js | ≥ 22.5 (≥ 22.13 for Codeburn) | `winget install OpenJS.NodeJS.22` |
| Python | ≥ 3.10 (Headroom) | python.org or `winget install Python.Python.3.13` |
| Git for Windows | any | Provides Git Bash, required by the caveman plugin's POSIX hooks |
| winget | built in | RTK; optionally codebase-memory-mcp |
| scoop | optional | preferred for codebase-memory-mcp |

## Automated install

```powershell
git clone https://github.com/NiyaNagi/claude-token-stack.git
cd claude-token-stack
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Flags: `-SkipHeadroom` `-SkipRtk` `-SkipCbm` `-SkipPlugins` `-SkipCodeburn` `-ForceEnv` (overwrite env values you already set) `-NoTests`.
Re-running is safe: every step checks before acting, and settings are merged, never replaced.

Then **restart the Claude desktop app** (or open a new CLI session).

## What the installer does (manual equivalents)

1. **Backup** `~/.claude/settings.json`, `~/.claude.json`, `~/.claude/CLAUDE.md` → `~/.claude/backups/token-stack-<timestamp>/`.
2. **Headroom** — official PyPI package only, in its own venv:
   ```powershell
   python -m venv $HOME\.headroom\venv
   & $HOME\.headroom\venv\Scripts\python.exe -m pip install "headroom-ai[mcp]"
   ```
   Package page must link to `github.com/headroomlabs-ai/headroom`. Do **not** use extraheadroom.com or "headroom desktop" installers.
   (`uv tool install` also works but hit a Windows file-lock bug during testing — the venv route is reliable.)
3. **RTK** — `winget install rtk-ai.rtk`. Never `cargo install rtk` (wrong crate). Its absolute path is cached in `~/.claude/tokenstack/rtk-path` so hooks work before PATH refreshes. We do **not** run `rtk init -g`; `ts.js` calls `rtk hook claude` itself so it can exclude diffs.
4. **codebase-memory-mcp** — `scoop install codebase-memory-mcp` (or `winget install DeusData.codebase-memory-mcp`). We do **not** run its own `install` command, which adds hooks that would duplicate ours.
5. **Plugins**
   ```powershell
   claude plugin marketplace add JuliusBrussee/caveman;  claude plugin install caveman@caveman --scope user
   claude plugin marketplace add mksglu/context-mode;   claude plugin install context-mode@context-mode --scope user
   ```
   (In-app equivalent: `/plugin marketplace add …`, `/plugin install …`.)
6. **Codeburn** (optional) — `npm install -g codeburn`; run `codeburn` (or `npx codeburn`).
7. **Files** → `~/.claude/`:
   - `hooks/tokenstack/ts.js`, `hr_compress.py`
   - `CLAUDE.md` — if you already have one, installed as `CLAUDE.tokenstack.md` and imported with an `@CLAUDE.tokenstack.md` line
   - `rules/stacks.md` (only if absent), `skills/skill-intake/SKILL.md`, `commands/handoff.md` (`{{HOME}}` replaced with your home path)
8. **Settings** — `node scripts/merge-settings.js settings.template.json ~/.claude/settings.json --git-bash <path-to-bash.exe>` (add `--dry-run` to preview).
9. **MCP servers** (user scope; short names = fewer tokens on every tool call):
   ```powershell
   claude mcp add -s user cbm -- <path>\codebase-memory-mcp.exe
   claude mcp add -s user headroom -e HEADROOM_BEACON=off -e HEADROOM_CCR_TTL_SECONDS=21600 -- $HOME\.headroom\venv\Scripts\headroom.exe mcp serve
   ```
   These land in `~/.claude.json`, which is what the desktop **Code tab** reads (not `claude_desktop_config.json`, which is the Chat tab's).
10. **Baseline skills** — `node ~/.claude/hooks/tokenstack/ts.js skill-register --baseline-all` so only skills added or changed later get flagged for intake.
11. **Self-tests** — `node tests/hooks.test.js`, `tests/compression.test.js`, `tests/router.test.js`.

### Finding the `claude` CLI when only the desktop app is installed
The app bundles it, but the app is MSIX-packaged, so its `%APPDATA%` is virtualized:
- Inside the app (hooks, the Code tab's shell): `%APPDATA%\Claude\claude-code\<ver>\claude.exe`
- From a normal terminal: `%LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming\Claude\claude-code\<ver>\claude.exe`

`install.ps1` and `ts.js` check both. Likewise, `npm -g` installs made from inside the app may not be visible from a normal terminal — use `npx codeburn` there.

### Optional: log the CLI in (better handoffs)
The PreCompact handoff calls `claude -p --model sonnet` to write a structured JSON handoff. Hooks don't inherit the desktop app's session auth, so log the CLI in once:
```powershell
& (Resolve-Path "$env:LOCALAPPDATA\Packages\Claude_*\LocalCache\Roaming\Claude\claude-code\*\claude.exe" | Select-Object -Last 1).Path   # then type /login
```
Without it, handoffs fall back to a deterministic transcript extract (always written, no model call).

## Verify

| Check | How | Expected |
|---|---|---|
| MCP servers | `claude mcp list` | `cbm`, `headroom`, `plugin:context-mode:context-mode` all ✓ Connected |
| Plugins | `claude plugin list` | caveman, context-mode enabled |
| Shell gate | ask Claude to run `Get-Content somefile` | blocked with a pointer to Read |
| RTK | ask Claude to run `git status` | compact `* main...origin/main` style output |
| Diff exactness | ask Claude to run `git diff` | full raw diff |
| cbm gate | in a code repo, ask Claude to read a whole `.ts` file before any cbm call | blocked; works after `search_graph` |
| Compression | `1..1500 \| % { "INFO line $_" }; "ERROR boom"` | folded output with `ERROR boom` kept and a retrieval hash |
| "exact" | same, with "exact output" in your prompt | uncompressed |
| Router | ask for a security audit subagent | `ts.js agent-report` shows `deep | opus` |
| Skill intake | create `~/.claude/skills/x/SKILL.md` | hook says "SKILL INTAKE …" |
| Handoff | `/compact` in a session | `~/.claude/handoffs/<cwd-slug>.md` written and injected |

## Benchmark your own repo
```powershell
node tests/benchmark.js C:\path\to\a\git\repo
node tests/caveman-ab.js sonnet        # uses your CLI login; a few cents of usage
node $HOME\.claude\hooks\tokenstack\ts.js agent-report
```

## Uninstall / rollback
1. Restore `~/.claude/settings.json` (and `~/.claude.json`) from `~/.claude/backups/token-stack-<timestamp>/`, or delete the tokenstack hook entries and env keys by hand.
2. `claude mcp remove -s user cbm`; `claude mcp remove -s user headroom`
3. `claude plugin uninstall caveman@caveman`; `claude plugin uninstall context-mode@context-mode`
4. Remove `~/.claude/hooks/tokenstack`, `~/.claude/tokenstack`, `~/.claude/handoffs`, `~/.claude/skills/skill-intake`, `~/.claude/commands/handoff.md`, `~/.claude/CLAUDE.tokenstack.md` (and the `@` import line).
5. `winget uninstall rtk-ai.rtk`; `scoop uninstall codebase-memory-mcp`; delete `~/.headroom`; `npm rm -g codeburn`.
