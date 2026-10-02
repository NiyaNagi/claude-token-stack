const cp = require('child_process'), fs = require('fs'), path = require('path'), os = require('os');
const TS = path.join(os.homedir(), '.claude', 'hooks', 'tokenstack', 'ts.js');
// Self-tests for gates, RTK rewrite, guarded compression, SessionStart. Runs against the INSTALLED hooks.
const proj = path.join(os.tmpdir(), 'tokenstack-fakeproj');
fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
fs.writeFileSync(path.join(proj, 'package.json'), '{}');
const SID = 'test-' + Date.now();
const run = (cmd, inp) => {
  const t = Date.now();
  const r = cp.spawnSync('node', [TS, cmd], { input: JSON.stringify({ session_id: SID, cwd: proj, ...inp }), encoding: 'utf8', env: { ...process.env, TS_IGNORE_UNLOCK: '1' } });
  let o = r.stdout; try { o = JSON.parse(o); } catch {}
  return { ms: Date.now() - t, out: o, err: r.stderr };
};
const dec = r => r.out && r.out.hookSpecificOutput ? (r.out.hookSpecificOutput.permissionDecision || (r.out.hookSpecificOutput.updatedInput ? 'REWRITE: ' + r.out.hookSpecificOutput.updatedInput.command : 'ctx')) : 'allow';
const cases = [
  ['cbm-gate', { tool_name: 'Read', tool_input: { file_path: path.join(proj, 'src', 'a.ts') } }, 'deny'],
  ['cbm-gate', { tool_name: 'Read', tool_input: { file_path: path.join(proj, 'src', 'a.ts'), limit: 80 } }, 'allow'],
  ['cbm-gate', { tool_name: 'Read', tool_input: { file_path: path.join(proj, 'README.md') } }, 'allow'],
  ['cbm-gate', { tool_name: 'Read', tool_input: { file_path: path.join(proj, 'src', 'a.test.ts') } }, 'allow'],
  ['cbm-gate', { tool_name: 'Grep', tool_input: { pattern: 'x', output_mode: 'content' } }, 'deny'],
  ['cbm-gate', { tool_name: 'Grep', tool_input: { pattern: 'x' } }, 'allow'],
  ['cbm-gate', { tool_name: 'Grep', tool_input: { pattern: 'x', output_mode: 'content', glob: '*.md' } }, 'allow'],
  ['shell-gate', { tool_name: 'Bash', tool_input: { command: 'cat src/a.ts' } }, 'deny'],
  ['shell-gate', { tool_name: 'Bash', tool_input: { command: 'cat > notes.txt <<EOF\nhi\nEOF' } }, 'allow'],
  ['shell-gate', { tool_name: 'Bash', tool_input: { command: 'npm ls | grep react' } }, 'any'], // filter after pipe: allowed (RTK may rewrite)
  ['shell-gate', { tool_name: 'Bash', tool_input: { command: 'git diff HEAD~1' } }, 'allow'], // diffs never rewritten by RTK
  ['shell-gate', { tool_name: 'Bash', tool_input: { command: 'cd x && find . -name "*.ts"' } }, 'deny'],
  ['shell-gate', { tool_name: 'PowerShell', tool_input: { command: 'Get-Content .\\src\\a.ts' } }, 'deny'],
  ['shell-gate', { tool_name: 'PowerShell', tool_input: { command: 'Get-ChildItem -Recurse src' } }, 'deny'],
  ['shell-gate', { tool_name: 'PowerShell', tool_input: { command: 'Get-ChildItem src' } }, 'allow'],
  ['shell-gate', { tool_name: 'PowerShell', tool_input: { command: 'git log | Select-String fix' } }, 'any'],
  ['shell-gate', { tool_name: 'PowerShell', tool_input: { command: 'git status', description: 'd' } }, 'REWRITE'],
  ['shell-gate', { tool_name: 'Bash', tool_input: { command: 'git status' } }, 'REWRITE'],
];
let fail = 0;
for (const [c, inp, want] of cases) {
  const r = run(c, inp), d = dec(r);
  const ok = want === 'any' || d.startsWith(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${r.ms}ms ${c} ${inp.tool_name} ${JSON.stringify(inp.tool_input).slice(0, 60)} -> ${d.slice(0, 110)}`);
}
// unlock via cbm marker
run('cbm-mark', { tool_name: 'mcp__cbm__search_graph' });
const after = dec(run('cbm-gate', { tool_name: 'Read', tool_input: { file_path: path.join(proj, 'src', 'a.ts') } }));
console.log(`${after === 'allow' ? 'PASS' : 'FAIL'} cbm unlock window -> ${after}`); if (after !== 'allow') fail++;
// compress
const log = Array.from({ length: 1500 }, (_, i) => `2026-10-01 12:00:${String(i % 60).padStart(2, '0')} INFO worker-${i % 7} batch ${i} ok`).join('\n') + '\nERROR worker-3 failed: disk full';
const cr = run('compress', { tool_name: 'Bash', tool_response: { stdout: log, stderr: '', interrupted: false } });
const u = cr.out && cr.out.hookSpecificOutput && cr.out.hookSpecificOutput.updatedToolOutput;
console.log(`${u && typeof u.stdout === 'string' && u.interrupted === false ? 'PASS' : 'FAIL'} ${cr.ms}ms compress shape kept; ${log.length} -> ${u && u.stdout.length} chars; keeps ERROR: ${u && /disk full/.test(u.stdout)}`);
console.log('   preview:', u && u.stdout.slice(0, 250).replace(/\n/g, ' | '));
const small = run('compress', { tool_name: 'Bash', tool_response: { stdout: 'small' } });
console.log(`${dec(small) === 'allow' ? 'PASS' : 'FAIL'} ${small.ms}ms compress skips small`);
// session start
const ss = run('session-start', { source: 'startup' });
console.log(`SESSIONSTART ${ss.ms}ms:`, JSON.stringify(ss.out).slice(0, 400));
console.log(fail ? `${fail} FAILURES` : 'ALL PASS');
