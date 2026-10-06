# Bootstrap prompt

Paste everything in the box below into a new Claude Code session (desktop app Code tab or CLI) on the machine you want to set up. Claude will clone this repo, ask you a few questions, install, verify, and benchmark — stopping for your approval before anything is installed.

---

```text
Set up the token-efficiency stack from https://github.com/NiyaNagi/claude-token-stack on this machine.

1. Clone it to ~/Documents/Code/claude-token-stack (git pull if it already exists). Read README.md, docs/SETUP.md,
   docs/CONFIGURATION.md and docs/TROUBLESHOOTING.md completely before doing anything else.
2. Inspect my current setup without changing it: ~/.claude/settings.json, ~/.claude/CLAUDE.md, ~/.claude/skills,
   installed plugins (claude plugin list), MCP servers (claude mcp list), and whether node (>=22.5), python (>=3.10),
   Git Bash, winget and scoop exist. Locate the claude CLI (PATH, or the desktop app's bundled copy — see SETUP.md
   about MSIX paths). Summarize what exists and exactly what the installer would add or change.
3. Ask me (one AskUserQuestion round): keep Headroom compression (guarded) or skip it; enforcement hard-block with
   escape hatches or skip gates; caveman level (lite/full/off); install Codeburn; add Antigravity delegation
   (agy in WSL, see docs/ANTIGRAVITY.md; needs a WSL distro); anything in my existing config the merge should
   treat specially. Recommend defaults from the README.
4. Before installing, confirm every source is the official one listed in docs/SETUP.md (PyPI headroom-ai linking to
   headroomlabs-ai/headroom; winget rtk-ai.rtk — never `cargo install rtk`; DeusData/codebase-memory-mcp;
   JuliusBrussee/caveman; mksglu/context-mode; https://antigravity.google/cli/install.sh, which you must download and
   read before running). Never use extraheadroom.com or third-party "headroom desktop" installers.
5. Run install.ps1 with the flags matching my answers. If a step fails, diagnose with docs/TROUBLESHOOTING.md, fix,
   and re-run (it is idempotent). Do not overwrite my existing env values or CLAUDE.md — the installer merges/imports.
6. Verify using the table in docs/SETUP.md "Verify": run the three self-tests, `claude mcp list`, and exercise the
   shell gate, RTK rewrite, diff exactness, and compression live in this session where hooks allow.
7. Ask me for one of my git repos and run `node tests/benchmark.js <repo>`; report the table.
8. Final report: what was installed (versions), test results, benchmark table, anything skipped or failed and why,
   where the backup is, and the two manual follow-ups: restart the Claude desktop app, and optionally log the
   bundled CLI in (/login) for model-written handoffs. If Antigravity was installed, also: sign in once with
   `wsl -d Ubuntu --cd ~ -- bash -lc agy`, then run `agy-run.js doctor`.
```

---

## Variants

- **Already installed, just update:** "Pull ~/Documents/Code/claude-token-stack, show me what changed (git log), then re-run install.ps1 and the self-tests."
- **macOS/Linux:** use the same prompt but replace step 5 with: "install.ps1 is Windows-only; perform the manual steps in docs/SETUP.md with this OS's package managers (pip venv, brew/cargo-from-git for rtk, the official codebase-memory-mcp release), copy the files, run scripts/merge-settings.js, then continue."
- **Add Antigravity later:** "Read docs/ANTIGRAVITY.md, run install.ps1 -Antigravity, have me sign in to agy, run agy-run.js doctor, then delegate a tiny test task with flash and verify it."
- **Audit an existing install:** "Compare my ~/.claude against ~/Documents/Code/claude-token-stack (hooks, settings entries, MCP servers, plugins) and report drift; don't change anything."
