# Troubleshooting

Every issue below was hit while building and testing this stack.

| Symptom | Cause | Fix |
|---|---|---|
| `headroom wrap claude` has no effect in the desktop app | The app launches its own Claude Code with its own auth and ignores `ANTHROPIC_BASE_URL` | Use the MCP server + `compress` hook (this repo). Proxy only works for the terminal CLI. |
| MCP server added to `claude_desktop_config.json` doesn't appear in the Code tab | That file belongs to the Chat tab | `claude mcp add -s user …` → `~/.claude.json` |
| `claude.exe` "not recognized" at `%APPDATA%\Claude\claude-code\…` from your terminal | Desktop app is MSIX-packaged; its AppData is virtualized | Use `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\claude-code\<ver>\claude.exe` |
| `claude -p` → "OAuth session expired" | CLI login is separate from the desktop app session | Run the CLI once and `/login` |
| `claude -p --bare` → auth failure | `--bare` only accepts `ANTHROPIC_API_KEY`/apiKeyHelper | Don't use `--bare`; use `--settings '{"disableAllHooks":true}' --tools "" --strict-mcp-config` |
| `uv tool install headroom-ai` → "os error 32 … being used by another process" / "invalid entry in scripts directory" | Windows file lock + corrupted partial install | `python -m venv ~/.headroom/venv` + `pip install "headroom-ai[mcp]"` |
| `rtk gain` errors / unknown command | Installed crates.io `rtk` ("Rust Type Kit") | `cargo uninstall rtk`; `winget install rtk-ai.rtk` |
| `rtk` not found right after winget install | PATH not refreshed in running processes | Hooks use the cached absolute path in `~/.claude/tokenstack/rtk-path` |
| RTK didn't rewrite `cd x; git status` | Rewrite was only accepted at command start | Fixed: rtk inserts at any command position; `ts.js` swaps each |
| caveman hooks fail on Windows | Its hook commands are POSIX sh (`$(…)`, `sed`) | Set `CLAUDE_CODE_GIT_BASH_PATH` to Git Bash; hooks then run under bash |
| Compression saw only 20K of an 85K output | Claude Code persists oversized output to disk and gives the hook a truncated `stdout` + `persistedOutputPath` | Hook reads the persisted file so tail errors survive |
| Compressed `git diff` lost the changed line | Headroom's lossy folding; `HEADROOM_LOSSLESS` only applies to its proxy | Diffs/code excluded; signal-line verification; see README "Accuracy safeguards" |
| `rtk git diff` hid ~36% of changed lines | RTK diff condensing | Diffs excluded from RTK rewrite |
| Skill registry suddenly empty / everything "pending" | File written by PowerShell 5.1 with a UTF-8 BOM | `ts.js` now strips BOMs; write JSON with Node or `-Encoding utf8` → prefer Node |
| Gates stopped blocking in all sessions | Another session created a global `unlock-*` file | Per-session unlocks now; global files expire after 10 min |
| `Remove-Item` on a file "blocked: system path '/'" | Claude Code's PowerShell safety guard misparsed a path | Use `[IO.File]::Delete(...)` |
| Handoff hook slow (~70 s) | Sonnet writing the structured handoff | Expected; 75 s cap, deterministic file is written first |
| Router routed a lookup to Haiku and it miscounted | Small-model counting error | Counting/listing now routes to Sonnet; Haiku only for checkable transforms |
| Code graph reports 0 callers but there are some | Dynamic/indirect calls, excluded dirs (e.g. `scripts/`) | Confirm with `Grep` (`files_with_matches` is never gated) |

## Diagnostics
- Hook errors: `~/.claude/tokenstack/state/errors.log` (hooks never block on internal errors — they fail open).
- Compression decisions: `~/.claude/tokenstack/state/headroom-hook.jsonl`
- Router decisions: `node ~/.claude/hooks/tokenstack/ts.js agent-report`
- MCP health: `claude mcp list`; context-mode: `/context-mode:ctx-doctor`
- Run a hook by hand: `'{"tool_name":"Bash","tool_input":{"command":"git status"},"cwd":"."}' | node ~/.claude/hooks/tokenstack/ts.js shell-gate`
