# Configuration reference

Everything that can be tuned, where it lives, and the default.

## 1. Environment (`~/.claude/settings.json` → `env`)

| Variable | Default here | Effect |
|---|---|---|
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | `50` | Auto-compact at 50% of the context window (leaves room for the PreCompact handoff). With a 1M-context model that is ~500K tokens. |
| `BASH_MAX_OUTPUT_LENGTH` | `20000` | Chars of shell output before Claude Code persists the rest to disk and shows a preview. The `compress` hook reads the full persisted file so tail errors aren't lost. |
| `MAX_MCP_OUTPUT_TOKENS` | `10000` | Cap on a single MCP tool result. |
| `CLAUDE_CODE_SUBAGENT_MODEL` | `claude-sonnet-5` | **Default** subagent model. Per-call `model` (set by you, Claude, or the router) overrides it. (`CLAUDE_CODE_SUBAGENT_MODEL_FORCE` would lock it — not used.) |
| `ENABLE_PROMPT_CACHING_1H` | `1` | 1-hour prompt-cache TTL instead of 5 min. |
| `CLAUDE_CODE_GIT_BASH_PATH` | detected | Lets plugin hooks written in POSIX sh (caveman) run on Windows. |
| `CLAUDE_CODE_USE_POWERSHELL_TOOL` | `1` | Keep the PowerShell tool enabled on Windows. |
| `CAVEMAN_DEFAULT_MODE` | `lite` | `off`, `lite`, `full`, `ultra`, `wenyan-*`. Per-repo override: `.caveman/config.json` `{"defaultMode":"…"}`; user file: `%APPDATA%\caveman\config.json`. In-session: `/caveman lite|full|ultra|off`. |
| `HEADROOM_BEACON` | `off` | Disable Headroom anonymous telemetry. |
| `HEADROOM_CCR_TTL_SECONDS` | `21600` | How long compressed originals stay retrievable (6 h) in `~/.headroom/ccr_store.db`. |
| `CAVEMAN_TELEMETRY` | `0` | Opt out of caveman plugin telemetry. Never use `DO_NOT_TRACK`, `DISABLE_TELEMETRY` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`: they disable Claude Code feature flags and break Remote Control. |
| `TS_IGNORE_UNLOCK` | unset | Tests only: ignore escape-hatch files. |
| `TS_DEBUG` | unset | Log tool_response shapes in the compress hook. (Or create `~/.claude/tokenstack/debug`.) |

Your existing values are never overwritten by the installer unless you pass `-ForceEnv`.

## 2. Hooks (`ts.js <subcommand>`)

| Event | Matcher | Subcommand | Behavior |
|---|---|---|---|
| PreToolUse | `Agent\|Task` | `agent-route` | Picks subagent model (section 5). |
| PreToolUse | `Read\|Grep` | `cbm-gate` | In a code project (has `.git`, `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, … or a `.sln`), denies a **full** Read of a source file or a **content** Grep over code unless a `cbm` tool ran in the last 120 s. Always allowed: non-source files, tests, `Read` with `limit ≤ 200`, `Grep` in `files_with_matches`/`count` mode, Grep scoped to docs/config globs. |
| PreToolUse | `Bash\|PowerShell` | `shell-gate` | Denies raw dump commands at the **head** of a pipeline: `cat head tail grep egrep fgrep rg find less more findstr Get-Content gc type Select-String sls`, and recursive `Get-ChildItem/ls/dir -Recurse`. Filters after a pipe are fine; `cat > file <<EOF` (writes) is fine. Then rewrites through RTK (absolute path) **except** diffs/patches/`git show`/`git log -p/--stat`/file dumps. |
| PostToolUse | `mcp__cbm__.*` | `cbm-mark` | Opens the 120 s Read/Grep window for this session. |
| PostToolUse | `Bash\|PowerShell` | `compress` | Guarded Headroom compression (section 4). |
| PostToolUse | `Agent\|Task` | `agent-log` | Records tokens, duration, resolved model. |
| PostToolUse | `Write\|Edit` | `skill-watch` | A `skills/<name>/SKILL.md` written/edited and not yet registered → reminds Claude to run `skill-intake`. |
| UserPromptSubmit | — | `prompt-mode` | Prompt contains `exact`, `full output`, `raw output`, `no compress(ion)`, `uncompressed` → compression off until a prompt without those words. |
| PreCompact | — | `precompact` | Writes `~/.claude/handoffs/<cwd-slug>.md`: deterministic extract first, then (if the CLI is logged in) a Sonnet-written JSON handoff, 75 s cap. Hook timeout 100 s. |
| SessionStart | — | `session-start` | Injects: cbm reminder (code projects), the handoff after compaction (<15 min old) or a pointer to a recent one (<48 h), and the list of skills pending intake. |

Plugins add their own hooks (caveman: SessionStart + UserPromptSubmit; context-mode: several). context-mode's PreToolUse covers `Bash` but not `PowerShell`; RTK and the gates cover both.

## 3. Thresholds and lists (top of `ts.js`)

| Constant | Default | Meaning |
|---|---|---|
| `CBM_WINDOW_MS` | 120 000 | Read/Grep unlock window after a cbm call |
| `UNLOCK_MS` | 600 000 | Escape-hatch file lifetime |
| `COMPRESS_MIN_CHARS` | 15 000 | Minimum string length the compress hook considers |
| `SOURCE_EXT` | js ts py go rs java cs dart … | What counts as "source" for the cbm gate |
| `PROJECT_MARKERS` | .git package.json pyproject.toml … | What makes a directory a "code project" |
| `BAN_ANY`, `LISTERS` | see §2 | Shell gate lists |
| `SKIP_CMD` | diffs, patches, show, file dumps | Never RTK-rewritten, never compressed |
| `SIGNAL` | error, fail, warn, exception, expected, received, ✗ … | Lines that must survive compression verbatim |
| signal cap | 40 | More signal lines than this → output is never compressed |

## 4. Compression policy (Headroom)

Compressed only if **all** hold: tool is Bash/PowerShell; command not in `SKIP_CMD`; user didn't say "exact" this turn; string ≥ 15K chars and doesn't look like a diff or source code; Headroom result carries a retrieval hash; every signal line of the original appears verbatim in the result; ≤ 40 signal lines. Otherwise the original passes through untouched. Every decision (including rejections) is logged to `~/.claude/tokenstack/state/headroom-hook.jsonl`.

To disable entirely: remove the `compress` hook entry, or run `install.ps1 -SkipHeadroom`.

## 5. Subagent model router (`~/.claude/tokenstack/model-routing.json`)

Created with defaults on first use; edit freely (applies on the next subagent call).

```json
{
  "classes": {
    "deep":       { "tier": "opus",   "pattern": "audit|security|review|refactor|architect|migrat|root cause|race condition|concurren|edge cases|…" },
    "build":      { "tier": "sonnet", "pattern": "implement|write|add|fix|build|create|update|test|debug|…" },
    "research":   { "tier": "sonnet", "pattern": "research|summari[sz]e|explore|investigate|compare|find|list|count|…" },
    "mechanical": { "tier": "haiku",  "pattern": "rename|reformat|format|typo|reword|convert (case|quotes|indent)" }
  },
  "fallbackTier": "sonnet",
  "builtinTypes": ["general-purpose", "claude", ""],
  "promote": { "rate": 0.25, "minSamples": 8 }
}
```

Rules, in order:
1. `Plan` subagent → `deep`. Otherwise first class whose regex matches description + prompt (first 3K chars).
2. Explicit `model` on the call wins — **except** a `deep` task is raised to at least `opus`.
3. Custom agents (types not in `builtinTypes`) keep their own frontmatter model unless the task is `deep`.
4. **Escalation learning:** re-delegating a similar task (word-overlap ≥ 0.5, same session, within 1 h) on a higher tier marks the earlier run *escalated*. If a class's base-tier runs escalate at ≥ `rate` over ≥ `minSamples`, the class is promoted one tier (max opus). `fable` is never chosen automatically.

Inspect: `node ~/.claude/hooks/tokenstack/ts.js agent-report` (calls, escalation %, avg tokens/time per class × model). Log: `~/.claude/tokenstack/state/agents.jsonl`.

Pricing basis (per 1M tokens, in/out): Fable 5.1 $10/$50 · Opus 5.5 $4/$20 · Sonnet 5 $2/$10 · Haiku 4.5 $1/$5.

## 6. Escape hatches

| Scope | How |
|---|---|
| One project, permanently | create `<project>/.claude/no-gates` |
| One session, 10 min | create `~/.claude/tokenstack/unlock-{cbm\|shell\|all}-<session_id>` (the deny message prints the exact path) |
| All sessions, 10 min (user only) | create `~/.claude/tokenstack/unlock-{cbm\|shell\|all}` |
| Compression, this turn | say "exact" / "full output" in the prompt |

## 7. Skill intake

- Registry: `~/.claude/tokenstack/skill-registry.json` (key → content hash, audited time, note).
- Tracked: `~/.claude/skills/*`, `<project>/.claude/skills/*` (by hash), plugin skills (by name; read-only — plugin updates overwrite edits).
- `ts.js skill-status` lists pending; `ts.js skill-register <SKILL.md> "<note>"` marks one audited; `--baseline-all` marks everything current.
- The `skill-intake` skill (model: sonnet) tightens descriptions, rewrites raw-shell instructions to stack tools, routes big runs through context-mode, sets a `model:`, adds a `rules/stacks.md` gate row, checks hook conflicts, then registers.

## 8. Files and state

| Path | What |
|---|---|
| `~/.claude/hooks/tokenstack/ts.js` | dispatcher (all hooks + CLI) |
| `~/.claude/hooks/tokenstack/hr_compress.py` | Headroom bridge (runs in `~/.headroom/venv`) |
| `~/.claude/tokenstack/rtk-path` | cached rtk.exe path |
| `~/.claude/tokenstack/state/` | per-session markers, `headroom-hook.jsonl`, `agents.jsonl`, `errors.log` |
| `~/.claude/handoffs/<cwd-slug>.md` | latest handoff per working directory |
| `~/.headroom/ccr_store.db` | retrievable originals of compressed output |
| `~/.claude.json` | MCP servers (`cbm`, `headroom`) |

## 9. Other knobs worth knowing
- `effortLevel` in settings (`low`…`max`) is the biggest per-model cost/quality lever for the main model.
- `/clear` between unrelated tasks; disable MCP servers/connectors you don't need in a session (each tool schema costs context).
- `/handoff` writes a manual checkpoint any time.

## Antigravity (optional)

The `antigravity` section of `~/.claude/tokenstack/model-routing.json` controls delegation to agy. The runner writes the defaults on first use. Delete the section to regenerate them.

| Key | Default | Meaning |
|---|---|---|
| `distro` | `Ubuntu` | WSL distro that runs agy. |
| `defaultTimeout` | `30m` | Per-job limit (`--print-timeout`; a hard `timeout` adds 60 s). Override per job with `--timeout`. |
| `hardPattern` | regex (hard, complex, from scratch, redesign, …) | Task text that routes to the `hard` class (Opus). |
| `route.<class>.<family>` | see docs/ANTIGRAVITY.md | Alias per router class (`hard`, `deep`, `build`, `research`, `mechanical`, `_default`) and family (`google`, `claude`, `any`). |
| `aliases` | `flash`, `flash-lo`, `pro`, `opus`, `sonnet`, … | Glob over model ids. The newest version wins. |

Environment: `AGR_MODELS_FILE` (tests only) replaces the live `agy models` list with a JSON fixture. Model list cache: `~/.claude/tokenstack/agy-models.json` (24 h; `agy-run.js models --refresh`). Jobs: `~/.claude/tokenstack/agy-jobs/`.

Runner commands are listed in [ANTIGRAVITY.md](ANTIGRAVITY.md#runner-commands).

## Models and advisor

Top-level keys in `settings.template.json`. The merger adds each one only when your `settings.json` does not already have it.

| Key | Default | Meaning |
|---|---|---|
| `model` | `sonnet` | Main session model. Sonnet builds; switch a single session to Opus or Fable from the model picker when needed. |
| `effortLevel` | `high` | Effort for the main session. |
| `advisorModel` | `opus` | [Advisor tool](https://code.claude.com/docs/en/advisor): Claude consults Opus at decision points. It is ignored when the main model outranks it (for example Fable). Advisor calls re-read the whole session at Opus rates and count toward your plan limits. CLAUDE.md limits calls to three checkpoints: before locking a multi-file plan, after the same error fails twice, and before declaring done or committing. Turn off with `/advisor off`. |

Subagent models are still chosen per task by the `agent-route` hook (Opus for reviews and architecture, Sonnet for build and lookup, Haiku for trivially checkable edits). A blanket "all subagents on Haiku" setting is not used because the router found Haiku unreliable for counts and lists.

### Router ceiling (`capExplicit`)

`model-routing.json` → `capExplicit: { enabled, keepPattern }`. When the main session passes `model: "opus"` (or fable) for a task the router classes as build, research or mechanical, the router lowers it to that class's tier (normally Sonnet). It keeps the explicit model when the task text matches `keepPattern` (hard, complex, redesign, critique, …) or when the same task already ran on a lower tier in the last hour (an escalation). Deep tasks are never lowered. Added after usage analysis showed 76% of explicit-Opus subagents were routine build/research work, and subagents were about 90% of total spend. Set `enabled: false` to restore "explicit always wins".

### Usage-driven defaults (added after the 2026-10 usage analysis)

| Mechanism | Where | What it does | Turn off |
|---|---|---|---|
| Subagent scope contract | `agent-route` hook | Appends a one-line `[tokenstack scope]` contract to every subagent prompt: one purpose, text verdict under 200 words, no images, text-first page reading, no re-reads. Subagents were ~90% of spend at ~233k context per call. | `"contract": false` in `model-routing.json` |
| Screenshot scale | `shot-scale` hook on `mcp__Claude_Browser__computer` and `browser_batch` | Sets `scale: 0.5` on screenshots that have no scale (about a quarter of the image tokens). Explicit scales and `zoom` are untouched. | `TS_SHOT_SCALE=1` in settings `env` |
| Antigravity offload | CLAUDE.md | Routine build/fix subtasks with acceptance tests on a clean tree go to the `antigravity` skill (Flash, Google quota) instead of a Claude subagent, then get verified. | Remove the line, or say "Claude only" |

Codeburn's auto-fixes were reviewed and not applied: archiving "unused" skills would break the stack gates in `rules/stacks.md`, and the total estimated saving was under $0.01. The MCP servers it flags are app-managed or connector tools that load deferred.
