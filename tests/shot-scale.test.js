// Screenshot scale hook: half-scale by default, never overrides an explicit scale, leaves zoom alone.
const cp = require('child_process'), os = require('os'), path = require('path');
const TS = path.join(os.homedir(), '.claude', 'hooks', 'tokenstack', 'ts.js');
const run = (tool_name, tool_input) => { const r = cp.spawnSync('node', [TS, 'shot-scale'], { input: JSON.stringify({ tool_name, tool_input }), encoding: 'utf8' }); try { return JSON.parse(r.stdout).hookSpecificOutput.updatedInput; } catch { return null; } };
const C = [
  ['plain screenshot', () => run('mcp__Claude_Browser__computer', { action: 'screenshot' }).scale === 0.5],
  ['explicit scale kept', () => run('mcp__Claude_Browser__computer', { action: 'screenshot', scale: 1 }) === null],
  ['zoom untouched', () => run('mcp__Claude_Browser__computer', { action: 'zoom', region: [0, 0, 9, 9] }) === null],
  ['batch screenshot scaled, zoom not', () => { const u = run('mcp__Claude_Browser__browser_batch', { actions: [{ name: 'computer', input: { action: 'screenshot' } }, { name: 'computer', input: { action: 'zoom' } }] }); return u.actions[0].input.scale === 0.5 && u.actions[1].input.scale === undefined; }],
];
let f = 0;
for (const [n, t] of C) { let ok = false; try { ok = t(); } catch {} if (!ok) f++; console.log(`${ok ? 'PASS' : 'FAIL'} ${n}`); }
console.log(f ? `${f} FAILURES` : 'ALL PASS');
process.exit(f ? 1 : 0);
