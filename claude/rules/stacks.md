# Stack gates
Invoke the listed skill FIRST when touching that stack. `skill-intake` appends entries here.
Build the self-check column from failures you have actually seen — keep it to the handful of footguns Claude repeats.

| Stack (trigger) | Skill first | Self-check |
|---|---|---|
| Claude API / Anthropic SDK code | `claude-api` | current model IDs, never from memory |
| _example:_ React / Next.js | `vercel-react-best-practices` | Server Components default; no `enum` (use `as const`) |
| _example:_ Cloudflare Workers / wrangler config | `workers-best-practices` | bindings typed; no global mutable state; secrets via `wrangler secret` |
