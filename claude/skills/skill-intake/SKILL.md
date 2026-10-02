---
name: skill-intake
description: Audit a new or changed skill so it fits the token-efficient stack (cbm, context-mode, RTK, Headroom, caveman). Use when the SessionStart hook reports "SKILL INTAKE pending", when a SKILL.md was just created/edited, or when the user says "intake/audit this skill". Args - path to SKILL.md, or "all" for every pending skill.
argument-hint: "<path-to-SKILL.md | all>"
model: sonnet
---

# Skill intake

Goal: every skill runs cheaply inside this stack. Keep behavior identical; change only how it spends tokens.

## 0. Find targets
`node "{{HOME}}/.claude/hooks/tokenstack/ts.js" skill-status` → JSON list of pending skills (`key`, `path`, `kind`).
Arg "all" → process each. If >3, delegate batches to subagents (≤3 parallel), each running steps 1–6 on its batch and reporting <150 words.

## 1. Classify
- `user:` / `project:` skill → editable. Apply steps 2–5.
- `plugin:` skill → **read-only** (plugin updates overwrite edits). Skip 2–3; do 4 if stack-specific; register.
- Skill whose path is under `skills/synced` or managed by an app → treat as read-only.

## 2. Token audit (editable only) — fix in place, minimal diff
- Frontmatter `description`: ≤ 300 chars, trigger-focused (when to use), no marketing. It loads every session.
- Body > ~250 lines → move reference material into `references/*.md` next to SKILL.md and link it ("read only when X").
- Replace raw shell reads in instructions: `cat/head/tail/grep/find/Get-Content/Select-String` → Read (offset/limit), Grep tool, Glob, cbm tools, or `ctx_execute_file`.
- Instructions that run tests/builds/large commands → route through `ctx_batch_execute` / `ctx_execute`.
- Instructions that explore code ("read all files in src") → cbm `get_architecture` / `search_graph` / `get_code_snippet`.
- Instructions that fetch docs/URLs → `ctx_fetch_and_index` + `ctx_search`.
- Add `model:` if absent: `haiku` for mechanical/format tasks, `sonnet` default, omit only if skill needs the main model's judgment.
- Keep `allowed-tools` if present; add `mcp__cbm__*` / context-mode tools only if you rewrote steps to use them.

## 3. Compress prose (editable only)
Tighten wording in caveman-lite style (drop filler, keep every rule, number, path, command, code block verbatim). Do NOT compress code, examples, or output templates.

## 4. Stack gate
If the skill targets a framework/platform/stack, add one row to `{{HOME}}/.claude/rules/stacks.md`: trigger, skill name, 1–3 self-check items (only footguns the skill itself warns about). Skip if a row already covers it.

## 5. Conflict check
- Skill instructs something the hooks block (e.g. `cat` a file)? → rewrite (editable) or note in report (read-only).
- Skill defines its own hooks in frontmatter? → ensure they don't duplicate tokenstack hooks (cbm-gate, shell-gate, compress, precompact).

## 6. Register (always, last)
`node "{{HOME}}/.claude/hooks/tokenstack/ts.js" skill-register "<SKILL.md path>" "<one-line note>"`
Registering stores the post-edit hash, so the skill won't be flagged again until it changes.

## Report
One line per skill: `key — edits made (or "read-only, registered") — gate row added?`.
