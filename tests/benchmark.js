#!/usr/bin/env node
// Real-world token benchmark for the stack. Usage: node tests/benchmark.js <path-to-a-git-repo> [--md]
// Measures, on YOUR repo: RTK shell compression (incl. what diffs lose), guarded Headroom compression on real noisy output.
// Tokens are estimated as chars/4 (Claude averages ~3.5-4.5 chars/token on code/English); ratios are what matter.
'use strict';
const cp = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
const repo = process.argv[2];
if (!repo || !fs.existsSync(path.join(repo, '.git'))) { console.error('usage: node tests/benchmark.js <git repo path>'); process.exit(1); }
const TS = path.join(os.homedir(), '.claude', 'hooks', 'tokenstack', 'ts.js');
const rtk = (() => { try { return fs.readFileSync(path.join(os.homedir(), '.claude', 'tokenstack', 'rtk-path'), 'utf8').trim(); } catch { return 'rtk'; } })();
const tok = s => Math.round((s || '').length / 4);
const run = (exe, args) => { const r = cp.spawnSync(exe, args, { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 28, windowsHide: true, shell: /^(npm|pnpm)/.test(exe) }); return (r.stdout || '') + (r.stderr || ''); };
const pct = (a, b) => a ? `${Math.round(100 * (1 - b / a))}%` : '-';

const rows = [];
// 1. RTK on everyday git commands
const GIT = [['status'], ['log', '-20'], ['log', '--stat', '-10'], ['branch', '-a'], ['diff', 'HEAD~3', '--stat'], ['diff', 'HEAD~3']];
for (const g of GIT) {
  const command = `git ${g.join(' ')}`;
  const raw = run('git', g), comp = run(rtk, ['git', ...g]);
  // Does the stack's shell-gate actually route this through RTK?
  const gate = cp.spawnSync('node', [TS, 'shell-gate'], { input: JSON.stringify({ session_id: 'bench', cwd: repo, tool_name: 'Bash', tool_input: { command } }), encoding: 'utf8' }).stdout;
  const rewritten = /updatedInput/.test(gate || '');
  const row = { layer: 'RTK', cmd: command, raw: tok(raw), out: tok(rewritten ? comp : raw) };
  if (g[0] === 'diff' && !g.includes('--stat')) {
    const changed = raw.split(/\r?\n/).filter(l => /^[+-](?![+-]{2} )/.test(l) && l.trim().length > 1);
    const lost = changed.filter(l => !comp.includes(l.slice(1).trim()));
    row.note = `raw RTK would hide ${lost.length}/${changed.length} changed lines → `;
  }
  row.note = (row.note || '') + (rewritten ? 'rewritten' : 'excluded by stack (exact output)');
  rows.push(row);
}
// 2. Headroom (guarded hook) on real noisy outputs
const NOISY = [['git', ['log', '--stat', '-300']], ['git', ['log', '--format=%h %an %ad %s', '-2000']]];
if (fs.existsSync(path.join(repo, 'pnpm-lock.yaml'))) NOISY.push(['pnpm', ['ls', '-r', '--depth', '2']]);
else if (fs.existsSync(path.join(repo, 'package.json'))) NOISY.push(['npm', ['ls', '--all']]);
for (const [exe, args] of NOISY) {
  const raw = run(exe, args);
  const r = cp.spawnSync('node', [TS, 'compress'], { input: JSON.stringify({ session_id: 'bench', tool_name: 'Bash', tool_input: { command: `${exe} ${args.join(' ')}` }, tool_response: { stdout: raw, stderr: '' } }), encoding: 'utf8', maxBuffer: 1 << 28 });
  let out = raw, note = 'not compressed (below threshold or failed safety guard)';
  try { const u = JSON.parse(r.stdout).hookSpecificOutput.updatedToolOutput; out = u.stdout; note = 'compressed; signal lines verified'; } catch {}
  rows.push({ layer: 'Headroom', cmd: `${exe} ${args.join(' ')}`, raw: tok(raw), out: tok(out), note });
}

const tRaw = rows.reduce((a, r) => a + r.raw, 0), tOut = rows.reduce((a, r) => a + r.out, 0);
const lines = ['| Layer | Command | Raw ≈tok | Sent ≈tok | Saved | Note |', '|---|---|---:|---:|---:|---|',
  ...rows.map(r => `| ${r.layer} | \`${r.cmd}\` | ${r.raw} | ${r.out} | ${pct(r.raw, r.out)} | ${r.note || ''} |`),
  `| **Total** | | **${tRaw}** | **${tOut}** | **${pct(tRaw, tOut)}** | |`];
console.log(lines.join('\n'));
