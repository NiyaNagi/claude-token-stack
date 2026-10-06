---
name: antigravity
description: Delegate work to Antigravity (agy in WSL; Gemini/Claude/GPT models) as a monitored background task, then verify it. Use on "use antigravity/google/gemini/agy", "have gemini do X", an Antigravity model name (flash, pro, "opus via antigravity"), or "what models can antigravity use".
argument-hint: "[model spec] <task>"
---

# Antigravity delegation

Runner: `node "{{HOME}}/.claude/hooks/tokenstack/agy-run.js"` (below: `AGR`). It runs agy inside WSL, streams a readable progress view, snapshots git before/after, and logs to the subagent router (`ts.js agent-report`).

## 0. Model options request ("what models can antigravity use?")
Run `AGR models` and show the output (model list + auto-routing table). Stop there unless a task was also given.

## 1. Pick the model — never guess ids
- User named a model ("use antigravity with opus", "gemini pro", "flash 3.7", "sonnet medium") → pass it verbatim as `--model "<their words>"`; the runner fuzzy-matches against `agy models`.
- Else pass the family the user implied: "google"/"gemini" → `--family google`; "claude"/"anthropic" → `--family claude`; plain "antigravity" → omit (neutral).
- Auto-routing (from `~/.claude/tokenstack/model-routing.json` → `antigravity.route`): bulk work (build/research/tests/scaffolding) → Flash (Sonnet if claude); reasoning & reviews → Pro (Opus if claude); hard tasks → Opus; trivial transforms → Flash Low.
- Preview without running: `AGR resolve --task "<task>" [--family f] [--model spec]`. If the runner errors with "no agy model matches", show its option list and ask.

## 2. Write the task file (Write tool) — self-contained
Path: `{{HOME}}/.claude/tokenstack/agy-jobs/inbox/<short-slug>.md`. Include: goal; relevant paths (relative to the project dir); constraints and the user's rules verbatim; acceptance criteria (exact test/lint commands that must pass). Antigravity sees files, not this conversation — give it what it needs, not a transcript. The runner appends the reply/no-commit/Windows-toolchain contract automatically.

## 3. Start it as a background Bash task (so it shows in the task list)
```
node "{{HOME}}/.claude/hooks/tokenstack/agy-run.js" start --task-file "<file>" --dir "<project root>" [--model "<spec>" | --family google|claude] [--timeout 30m]
```
- Bash tool: `run_in_background: true`, `timeout: 7200000`, `description: "Antigravity · <model short> · <task summary>"`.
- `--dir` = the repo root of the current task (omit only for pure research with no files). Extra dirs: `--add-dir <path>`.
- Default is auto-approve (user's choice). `--no-yolo` only if the user asks for a cautious run.
- Tell the user in one line: model chosen + why, and that it's running in the task list.

## 4. Monitor
- Don't poll in a loop. Keep working on other things; you're re-invoked when the task exits.
- If the user asks for progress: `AGR status <job-id>` (one line) or read the task output file's tail.
- Cancel on request: `AGR cancel <job-id>`.

## 5. Verify (mandatory — never relay unchecked)
The final output shows status, reply, token usage, a git change summary vs. the pre-run snapshot, and `review: git -C <dir> diff <base>`.
1. Status ≠ SUCCESS → report the stderr reason; for TIMEOUT/EMPTY offer a re-run (same or higher tier).
2. Code changes → read the diff (`git diff <base> --stat`, then the hunks that matter), then run the project's real gates yourself (tests, typecheck, lint — via `ctx_batch_execute`). Never trust agy's self-reported "tests pass". Check: no weakened/skipped tests, no stubbed deps, no edits outside scope, no committed changes (runner warns if HEAD moved).
3. Research/answers → spot-check 2–3 concrete claims against files or sources.
4. Problems found → fix small ones yourself; for larger ones re-delegate with specific feedback (escalate one tier: flash→pro→opus). Re-runs on a higher tier are logged as escalations.
5. Report: model + why, duration, tokens, files changed, what you verified and the result, anything you fixed or that remains open.

## Notes
- Projects on mapped network drives (e.g. Z:) need a one-time WSL mount: `sudo mkdir -p /mnt/z && sudo mount -t drvfs Z: /mnt/z`. The runner reports exit 16 if the dir isn't reachable.
- Auto-approve means agy can act anywhere WSL can reach, including /mnt/c. Prefer clean working trees; mention uncommitted user changes before write tasks.
- Health check: `AGR doctor`. Job history: `AGR list`. Jobs live in `~/.claude/tokenstack/agy-jobs/<id>/` (prompt, events, result, job.json).
