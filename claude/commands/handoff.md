---
description: Write a structured session handoff now (checkpoint before /clear or switching tasks)
model: sonnet
---
Write a handoff for this session from what is already in context. Do NOT re-read files or re-explore.

Get the target path: run `node "{{HOME}}/.claude/hooks/tokenstack/ts.js" handoff-path "<current working dir>"`.
Write that file with a `# HANDOFF (manual) — <ISO time>` heading, `cwd:` line, then one ```json block with keys:
task, completed_tasks[], current_state, constraints_to_preserve[] (user rules VERBATIM + ruled-out approaches with why),
files_touched[{path,status,summary}], issues_discovered[], open_questions[], next_steps[] (ordered; [0] = literal first action),
resume_prompt (one paragraph the user can paste into a fresh session).

Then reply with only the path and the resume_prompt.
