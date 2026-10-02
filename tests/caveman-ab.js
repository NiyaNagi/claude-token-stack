#!/usr/bin/env node
// A/B: same questions with and without caveman-lite style. Uses your logged-in Claude CLI (costs a few cents of usage).
// Usage: node tests/caveman-ab.js [model=sonnet]
'use strict';
const cp = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
function findClaude() {
  const bases = [path.join(process.env.APPDATA || '', 'Claude', 'claude-code')];
  const pk = path.join(process.env.LOCALAPPDATA || '', 'Packages');
  try { for (const d of fs.readdirSync(pk).filter(d => /^Claude_/.test(d))) bases.push(path.join(pk, d, 'LocalCache', 'Roaming', 'Claude', 'claude-code')); } catch {}
  for (const b of bases) { try { const v = fs.readdirSync(b).filter(d => /^\d+\.\d+\.\d+$/.test(d)).sort((x, y) => x.localeCompare(y, undefined, { numeric: true })).pop(); if (v && fs.existsSync(path.join(b, v, 'claude.exe'))) return path.join(b, v, 'claude.exe'); } catch {} }
  return 'claude';
}
const CLAUDE = findClaude(), MODEL = process.argv[2] || 'sonnet';
const LITE = 'Respond terse. No filler, hedging, or pleasantries. Keep articles and full sentences OK, but stay tight. Technical terms, code, commands, paths, and errors stay exact.';
const Q = [
  'Why might a Node.js process exit with code 0 while an awaited promise never resolves? Give causes and how to diagnose.',
  'Explain the difference between git rebase and git merge for a feature branch, and when to prefer each.',
  'My Cloudflare Worker returns 1101 errors intermittently. What should I check?',
];
const env = { ...process.env };
for (const k of Object.keys(env)) if (/^CLAUDE_CODE_(SDK_HAS_HOST_AUTH_REFRESH|MESSAGING_|HOST_SESSION_ID|CHILD_SESSION|ENTRYPOINT|SESSION_ID|OAUTH_SCOPES)/.test(k) || k === 'CLAUDECODE') delete env[k];
const ask = (q, sys) => {
  const args = ['-p', '--model', MODEL, '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--settings', '{"disableAllHooks":true}', '--setting-sources', 'user'];
  if (sys) args.push('--append-system-prompt', sys);
  const r = cp.spawnSync(CLAUDE, args, { input: q, encoding: 'utf8', env, timeout: 180000, windowsHide: true });
  return (r.stdout || '').trim();
};
let A = 0, B = 0;
console.log('| Question | Normal ≈tok | Caveman-lite ≈tok | Saved |\n|---|---:|---:|---:|');
for (const q of Q) {
  const a = ask(q).length / 4, b = ask(q, LITE).length / 4; A += a; B += b;
  console.log(`| ${q.slice(0, 48)}… | ${Math.round(a)} | ${Math.round(b)} | ${Math.round(100 * (1 - b / a))}% |`);
}
console.log(`| **Total** | **${Math.round(A)}** | **${Math.round(B)}** | **${Math.round(100 * (1 - B / A))}%** |`);
