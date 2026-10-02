const cp = require('child_process'), os = require('os'), path = require('path');
const TS = path.join(os.homedir(), '.claude', 'hooks', 'tokenstack', 'ts.js');
const SID = 'guard-' + Date.now();
const hook = (cmd, inp) => { const r = cp.spawnSync('node', [TS, cmd], { input: JSON.stringify({ session_id: SID, cwd: os.tmpdir(), ...inp }), encoding: 'utf8' }); try { return JSON.parse(r.stdout); } catch { return null; } };
const rep = (n, f) => Array.from({ length: n }, (_, i) => f(i)).join('\n');
const C = [
  ['git diff (cmd)', 'git diff HEAD~3', rep(300, f => `diff --git a/f${f}.ts b/f${f}.ts\n@@ -1 +1 @@\n-  x=1\n+  x=${f === 131 ? 'TWO' : 2}`), /x=TWO/, 'skip'],
  ['diff via other cmd', 'Write-Output $d', rep(300, f => `diff --git a/f${f}.ts b/f${f}.ts\n@@ -1 +1 @@\n-  x=1\n+  x=${f === 131 ? 'TWO' : 2}`), /x=TWO/, 'skip'],
  ['log, 1 WARN mid', 'npm run build', rep(1500, i => i === 700 ? 'WARN cache miss storm key=user:9921' : `INFO worker-${i % 7} batch ${i} ok`), /user:9921/, 'compress'],
  ['tests, 1 fail mid', 'npm test', rep(600, i => i === 373 ? '  ✗ billing › proration on downgrade (42 ms)\n    Expected: 1450\n    Received: 1540' : `  ✓ suite${i % 9} › case ${i} works (${i % 17} ms)`), /Received: 1540/, 'any'],
  ['JSON, 1 failed record', 'az resource list', JSON.stringify(Array.from({ length: 300 }, (_, i) => ({ id: i, status: i === 117 ? 'failed' : 'ok', region: 'us-east-1' })), null, 2), /failed/, 'any'],
  ['error-dense log', 'npm run lint', rep(800, i => i % 10 === 0 ? `src/f${i}.ts:${i}:3 error no-unused-vars 'x${i}'` : `src/f${i}.ts checked`), /x790/, 'skip'],
  ['source file dump', 'git show HEAD:src/app.ts', rep(900, i => `export function fn${i}(a) { return a + ${i}; }`), /fn450/, 'skip'],
];
let fail = 0;
for (const [name, command, text, needle, want] of C) {
  const o = hook('compress', { tool_name: 'PowerShell', tool_input: { command }, tool_response: { stdout: text, stderr: '', interrupted: false } });
  const u = o && o.hookSpecificOutput && o.hookSpecificOutput.updatedToolOutput;
  const got = u ? 'compress' : 'skip';
  const kept = u ? needle.test(u.stdout) : true;
  const ok = kept && (want === 'any' || want === got);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name.padEnd(22)} ${got.padEnd(8)} ${text.length}->${u ? u.stdout.length : text.length} detail ${kept ? 'kept' : 'LOST'}`);
}
hook('prompt-mode', { prompt: 'show me the exact output please' });
const big = rep(1500, i => `INFO worker batch ${i} ok`);
const ex = hook('compress', { tool_name: 'PowerShell', tool_input: { command: 'npm run build' }, tool_response: { stdout: big } });
console.log(`${ex ? 'FAIL' : 'PASS'} "exact" in prompt disables compression`); if (ex) fail++;
hook('prompt-mode', { prompt: 'ok continue' });
const ex2 = hook('compress', { tool_name: 'PowerShell', tool_input: { command: 'npm run build' }, tool_response: { stdout: big } });
console.log(`${ex2 ? 'PASS' : 'FAIL'} next normal prompt re-enables`); if (!ex2) fail++;
const wf = hook('compress', { tool_name: 'WebFetch', tool_input: {}, tool_response: big });
console.log(`${wf ? 'FAIL' : 'PASS'} WebFetch never compressed`); if (wf) fail++;
console.log(fail ? `${fail} FAILURES` : 'ALL PASS');
