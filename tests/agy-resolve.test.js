// Offline test of Antigravity model resolution (no WSL, no agy): uses a fixture model list.
const cp = require('child_process'), os = require('os'), path = require('path'), fs = require('fs');
const AGR = path.join(os.homedir(), '.claude', 'hooks', 'tokenstack', 'agy-run.js');
const ids = [];
for (const v of ['3.8', '3.7', '3.6']) for (const e of ['high', 'medium', 'low']) ids.push([`gemini-${v}-flash-${e}`, `Gemini ${v} Flash (${e})`]);
for (const e of ['high', 'low']) ids.push([`gemini-3.1-pro-${e}`, `Gemini 3.1 Pro (${e})`]);
for (const f of ['opus', 'sonnet']) for (const e of ['low', 'medium', 'high']) ids.push([`claude-${f}-5-5-${e}`, `Claude ${f} 5.5 (${e})`]);
ids.push(['gpt-oss-120b-medium', 'GPT-OSS 120B (Medium)']);
const fixture = path.join(os.tmpdir(), 'agy-models-fixture.json');
fs.writeFileSync(fixture, JSON.stringify({ models: ids.map(([id, name]) => ({ id, name })) }));

const run = args => cp.spawnSync('node', [AGR, 'resolve', ...args], { encoding: 'utf8', env: { ...process.env, AGR_MODELS_FILE: fixture } });
const id = args => (run(args).stdout || '').split(/\s+/)[0];
const C = [
  [['--model', 'opus'], 'claude-opus-5-5-high'],
  [['--model', 'sonnet medium'], 'claude-sonnet-5-5-medium'],
  [['--model', 'flash 3.7'], 'gemini-3.7-flash-high'],
  [['--model', 'flash 3.6 low'], 'gemini-3.6-flash-low'],
  [['--model', 'gemini pro'], 'gemini-3.1-pro-high'],
  [['--model', 'claude-opus-5-5-low'], 'claude-opus-5-5-low'],
  [['--family', 'google', '--task', 'write unit tests for the parser'], 'gemini-3.8-flash-high'],
  [['--family', 'claude', '--task', 'write unit tests for the parser'], 'claude-sonnet-5-5-high'],
  [['--family', 'google', '--task', 'review this diff for race conditions'], 'gemini-3.1-pro-high'],
  [['--family', 'claude', '--task', 'review this diff for race conditions'], 'claude-opus-5-5-high'],
  [['--task', 'redesign the sync engine from scratch'], 'claude-opus-5-5-high'],
];
let f = 0;
for (const [a, want] of C) { const got = id(a); const ok = got === want; if (!ok) f++; console.log(`${ok ? 'PASS' : 'FAIL'} ${a.join(' ').padEnd(64)} -> ${got}${ok ? '' : ` (want ${want})`}`); }
const bad = run(['--model', 'llama 9']);
if (bad.status === 0) { f++; console.log('FAIL unknown model should exit non-zero'); } else console.log('PASS unknown model rejected');
fs.unlinkSync(fixture);
console.log(f ? `${f} FAILURES` : 'ALL PASS');
process.exit(f ? 1 : 0);
