const cp = require('child_process'), os = require('os'), path = require('path'), fs = require('fs');
const TS = path.join(os.homedir(), '.claude', 'hooks', 'tokenstack', 'ts.js');
const LOG = path.join(os.homedir(), '.claude', 'tokenstack', 'state', 'agents.jsonl');
// Router self-test. Temporarily swaps out your agents.jsonl and restores it at the end.
fs.mkdirSync(path.dirname(LOG), { recursive: true });
const backup = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : null;
fs.writeFileSync(LOG, '');
const SID = 'rt-' + Date.now();
const route = ti => { const r = cp.spawnSync('node', [TS, 'agent-route'], { input: JSON.stringify({ session_id: SID, tool_name: 'Agent', tool_input: ti }), encoding: 'utf8' }); try { const m = JSON.parse(r.stdout).hookSpecificOutput.updatedInput.model; return m && m !== ti.model ? m : '(unchanged)'; } catch { return '(unchanged)'; } };
const C = [
  [{ description: 'Security audit of auth module', prompt: 'Audit src/auth for vulnerabilities', subagent_type: 'general-purpose' }, 'opus'],
  [{ description: 'Refactor billing across files', prompt: 'refactor the billing service into modules' }, 'opus'],
  [{ description: 'Research Durable Objects alarms', prompt: 'research how DO alarms retry, summarize' }, 'sonnet'],
  [{ description: 'Implement CSV export', prompt: 'implement a CSV export endpoint and tests' }, 'sonnet'],
  [{ description: 'Rename variable', prompt: 'rename userId to accountId in src/util.ts' }, 'haiku'],
  // ceiling: explicit opus on routine work drops to the class tier; review/hard/critique keep opus
  [{ description: 'R3 table layout fixes', prompt: 'fix the table layout bugs listed below', model: 'opus' }, 'sonnet'],
  [{ description: 'Independent part review', prompt: 'review this diff for regressions', model: 'opus' }, '(unchanged)'],
  [{ description: 'Design critique round 1', prompt: 'critique the card designs', model: 'opus' }, '(unchanged)'],
  [{ description: 'Redesign play field', prompt: 'redesign the play field layout from scratch', model: 'opus' }, '(unchanged)'],
  [{ description: 'Find usages', prompt: 'find all usages of parseConfig and list the files' }, 'sonnet'], // lookups/counts: sonnet (haiku miscounted in live test)
  [{ description: 'Quick thing', prompt: 'hello there' }, 'sonnet'],
  [{ description: 'Design plan', prompt: 'plan the work', subagent_type: 'Plan' }, 'opus'],
  [{ description: 'Audit deps', prompt: 'security audit', model: 'haiku' }, 'opus'],
  [{ description: 'Summarize', prompt: 'summarize README', model: 'opus' }, 'sonnet'], // ceiling: routine research with explicit opus
  [{ description: 'Locate thing', prompt: 'where is the retry logic', subagent_type: 'caveman:cavecrew-investigator' }, '(unchanged)'],
  [{ description: 'Review diff', prompt: 'review this PR for race conditions', subagent_type: 'caveman:cavecrew-reviewer' }, 'opus'],
];
let fail = 0;
for (const [ti, want] of C) { const got = route(ti); const ok = got === want; if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${ti.description.padEnd(32)} ${(ti.subagent_type || '').padEnd(30)} ${ti.model ? 'explicit ' + ti.model : ''} -> ${got}`); }
// escalation learning: 8 research tasks on sonnet, 3 redone on opus -> research promoted
for (let i = 0; i < 8; i++) {
  route({ description: `Research topic ${i}`, prompt: `research caching behavior variant${i} alpha bravo charlie delta` });
  if (i < 3) route({ description: `Research topic ${i}`, prompt: `research caching behavior variant${i} alpha bravo charlie delta`, model: 'opus' });
}
const after = route({ description: 'Research new thing', prompt: 'research websocket hibernation' });
console.log(`${after === 'opus' ? 'PASS' : 'FAIL'} learned promotion: research after 3/8 escalations -> ${after}`); if (after !== 'opus') fail++;
console.log(cp.spawnSync('node', [TS, 'agent-report'], { encoding: 'utf8' }).stdout);
fs.writeFileSync(LOG, backup || '');
console.log(fail ? `${fail} FAILURES` : 'ALL PASS');
