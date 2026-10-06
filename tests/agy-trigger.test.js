const cp = require('child_process'), os = require('os'), path = require('path');
const TS = path.join(os.homedir(), '.claude', 'hooks', 'tokenstack', 'ts.js');
const hint = p => { const r = cp.spawnSync('node', [TS, 'prompt-mode'], { input: JSON.stringify({ session_id: 'trig', prompt: p }), encoding: 'utf8' }); try { return JSON.parse(r.stdout).hookSpecificOutput.additionalContext; } catch { return ''; } };
const C = [
  ['use antigravity to write tests for the parser', /auto-route/],
  ['use google to research Durable Objects alarms', /--family google/],
  ['use gemini pro to review this diff', /--model "pro"/],
  ['use antigravity with opus to fix the sync bug', /--model "opus"/],
  ['have antigravity do it with sonnet medium', /--model "sonnet medium"/],
  ['use antigravity with flash 3.7 low', /--model "flash 3\.7 low"/],
  ['delegate this to antigravity using claude', /--family claude/],
  ['what models can antigravity use?', /which Antigravity models/],
  ['use the google docs api in the code', /--family google/], // known false positive: the skill confirms intent
  ['fix the bug in google-auth.ts', /^$/],
  ['refactor the module', /^$/],
];
let f = 0;
for (const [p, re] of C) { const h = hint(p); const ok = re.test(h); if (!ok) f++; console.log(`${ok ? 'PASS' : 'FAIL'} ${p.padEnd(48)} -> ${h.replace(/^User /, '').slice(0, 90)}`); }
console.log(f ? `${f} FAILURES` : 'ALL PASS');
