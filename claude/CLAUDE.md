# Global rules (token-efficient stack)

## Flow — code tasks
1. Index: cbm `index_status` → unindexed? `index_repository` : `detect_changes`.
2. Skill gate: invoke every matching skill FIRST. Stack rules: @rules/stacks.md
3. Ambiguous → AskUserQuestion. No guessing.
4. Explore via cbm: `get_architecture` → `search_graph` → `get_code_snippet` / `get_file_outline`.
5. Changed symbol → cbm `trace_path` + update ALL call sites.
6. TDD where tests exist. Verify: lint + typecheck + tests pass before "done".

## Tool routing
| Want | Use |
|---|---|
| find def / callers / flow | cbm `search_graph` / `trace_path` |
| code text search | cbm `search_code` |
| read known range | Read w/ offset+limit (≤200 lines) |
| big output: tests, builds, logs, many cmds | `ctx_batch_execute` / `ctx_execute` / `ctx_execute_file` |
| fetch URL / docs | `ctx_fetch_and_index` → `ctx_search` |
| restore compressed output | `headroom_retrieve(hash)` |

Hooks enforce: full Read / content Grep on source blocked until a cbm call (120s window). Shell `cat/head/tail/grep/rg/find/Get-Content/Select-String` as pipeline head blocked; filters after a pipe OK. Git etc. auto-rewritten through RTK. Huge repetitive shell output (>15K chars) may be folded by Headroom; error/warn/fail lines always kept verbatim, diffs/code never touched. Never infer folded lines — `headroom_retrieve(hash)` if needed. User saying "exact"/"full output" disables folding for that turn.
Escapes: project `.claude/no-gates` file, or `~/.claude/tokenstack/unlock-{cbm|shell|all}-<session_id>` (this session, 10 min). Global `unlock-<gate>` (no session id) affects ALL sessions — only the user creates those. Never use escapes to dodge the stack without telling the user why.

## Subagents
Delegate: web research, refactor >2 files, multi-file summaries, audits, unknown-repo exploration, big log triage. Inline: single-file read/edit, one search.
Prompts self-contained, <500 tok; ask for report <200 words. ≤3 parallel.
Model routing (hook fills `model` if you omit it; pass it yourself when you know better):
| Task | Model |
|---|---|
| audit, security, review, refactor, architecture, migration, root-cause, concurrency, edge cases, Plan agent | opus (floor — never lower) |
| implement, fix, test, research, summarize, find/list/count | sonnet |
| rename, reformat, typo — output trivially checkable | haiku |
| hardest open-ended reasoning where opus already failed | fable (explicit only) |
Escalate, don't patch: if a subagent result is uncertain, incomplete, or contradicts evidence on anything that matters, re-run the same task one tier up (router logs this and auto-promotes classes that escalate often). Verify haiku/sonnet counts and lists before relying on them.
Workflow `agent()` calls bypass the router: always pass `model` per this table (default sonnet). Router caps explicit opus on routine build/research to sonnet unless the task is hard or an escalation re-run.
"use antigravity / google / gemini" → `antigravity` skill (agy in WSL, background task, verify after).
Routine build/fix subtask with explicit acceptance tests, clean git tree → prefer `antigravity` skill (auto-routes to Flash, uses Google quota) over a Claude subagent; verify after. Not for review, design, security, or when the user says Claude only.
Visual QA: text first (`get_page_text`/`read_page`); screenshots auto-scale 0.5 (hook), `zoom` only the region in question. Subagents return text verdicts, never images.

## Advisor (Opus on call; main = Sonnet)
Call `advisor` only at: (1) before locking a multi-file plan (auth invariants, schema/API contracts); (2) same test/compile error fails twice — root cause or rabbit hole?; (3) before declaring done or committing — full-diff regression check. Never for routine bash, reads, or single-file edits: each call re-reads the whole session at Opus rates.

## Skills
New/changed skills → run `skill-intake` before use (SessionStart hook lists pending).

## Never set
Never add `DO_NOT_TRACK`, `DISABLE_TELEMETRY` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` to any settings `env`, shell profile or system environment. They turn off Claude Code feature flags and break Remote Control. To opt out of plugin telemetry, use that tool's own switch, e.g. `CAVEMAN_TELEMETRY=0` or `HEADROOM_BEACON=off`.

## Handoff
PreCompact hook writes `~/.claude/handoffs/<cwd-slug>.md`; injected after compaction. Manual: `/handoff`.

## Style
Diagrams: Mermaid over prose. Code, commits, security notes, and user-facing docs: normal full prose.
