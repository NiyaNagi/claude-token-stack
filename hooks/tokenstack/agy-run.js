#!/usr/bin/env node
// agy-run: delegate a task to Antigravity (agy) running in WSL, with model routing, live progress, and review data.
//
//   node agy-run.js start   --task-file <f> | --task "<text>"  [--model <spec|auto>] [--family google|claude]
//                           [--dir <path>] [--add-dir <path>]... [--timeout 30m] [--no-yolo] [--no-digest] [--label <s>]
//   node agy-run.js models  [--refresh]          list models agy can use + current routing table
//   node agy-run.js resolve [--model <spec>] [--family f] [--task "<text>"]   show which model would run, and why
//   node agy-run.js list | status <id> | result <id> | cancel <id> | doctor
//
// `start` streams a readable progress view to stdout (run it as a background Bash task so it shows in the task list),
// then prints the result, a git change summary (vs. a pre-run snapshot), token usage, and the job directory.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');

const HOME = os.homedir();
const TS = path.join(HOME, '.claude', 'tokenstack');
const JOBS = path.join(TS, 'agy-jobs');
const ROUTING = path.join(TS, 'model-routing.json');
const MODELS_CACHE = path.join(TS, 'agy-models.json');
const AGENT_LOG = path.join(TS, 'state', 'agents.jsonl');
const RUNNER = path.join(__dirname, 'agy', 'runner.sh');

const DEFAULT_AGY = {
  _doc: 'Antigravity routing. family: google|claude|any. classes reuse classes.*.pattern above, plus hardPattern. aliases map short names to agy model ids.',
  distro: 'Ubuntu',
  defaultTimeout: '30m',
  hardPattern: '\\b(hard|difficult|complex|tricky|from scratch|novel|intricate|subtle|stumped|prove|formal(ly)? verif|optimi[sz]e (the )?algorithm|re-?architect|redesign)',
  route: {
    hard:       { google: 'pro',      claude: 'opus',   any: 'opus' },
    deep:       { google: 'pro',      claude: 'opus',   any: 'pro' },
    build:      { google: 'flash',    claude: 'sonnet', any: 'flash' },
    research:   { google: 'flash',    claude: 'sonnet', any: 'flash' },
    mechanical: { google: 'flash-lo', claude: 'sonnet', any: 'flash-lo' },
    _default:   { google: 'flash',    claude: 'sonnet', any: 'flash' },
  },
  aliases: {
    'flash': 'gemini-*-flash-high', 'flash-lo': 'gemini-*-flash-low', 'flash-med': 'gemini-*-flash-medium',
    'pro': 'gemini-*-pro-high', 'pro-lo': 'gemini-*-pro-low', 'gemini': 'gemini-*-pro-high', 'google': 'gemini-*-pro-high',
    'opus': 'claude-opus-*-high', 'sonnet': 'claude-sonnet-*-high', 'claude': 'claude-opus-*-high',
    'gpt': 'gpt-oss-*', 'oss': 'gpt-oss-*',
  },
};
const TIER_OF = id => /opus|-pro-/.test(id) ? 'opus' : /flash-low/.test(id) ? 'haiku' : 'sonnet'; // cost-tier equivalent for router stats

// ---------------- utils ----------------
const mkdirp = d => fs.mkdirSync(d, { recursive: true });
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch { return d; } };
const now = () => Date.now();
const fmtT = ms => { const s = Math.floor(ms / 1000); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const k = n => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n || 0);
const parseDur = s => { const m = String(s || '').match(/^(\d+)\s*([smh]?)$/i); if (!m) return 1800; return +m[1] * ({ s: 1, m: 60, h: 3600, '': 60 }[m[2].toLowerCase()]); };
function args(argv) {
  const o = { _: [], addDir: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--add-dir') o.addDir.push(argv[++i]);
    else if (a.startsWith('--no-')) o[a.slice(5)] = false;
    else if (a.startsWith('--')) { const key = a.slice(2); const nx = argv[i + 1]; if (nx === undefined || nx.startsWith('--')) o[key] = true; else { o[key] = nx; i++; } }
    else o._.push(a);
  }
  return o;
}
function toWsl(p) {
  const abs = path.resolve(p);
  const m = abs.match(/^([A-Za-z]):[\\/]?(.*)$/);
  if (!m) return abs.replace(/\\/g, '/');
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
}
const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
function loadCfg() {
  const r = readJson(ROUTING, {});
  if (!r.antigravity) { r.antigravity = DEFAULT_AGY; mkdirp(TS); fs.writeFileSync(ROUTING, JSON.stringify(r, null, 2)); }
  const a = r.antigravity;
  for (const key of Object.keys(DEFAULT_AGY)) if (a[key] === undefined) a[key] = DEFAULT_AGY[key];
  return { all: r, agy: a };
}
function wsl(cfg, cmdArgs, opts = {}) {
  return cp.spawnSync('wsl.exe', ['-d', cfg.agy.distro, '--cd', '~', '--', ...cmdArgs], { encoding: 'utf8', windowsHide: true, timeout: 120000, ...opts });
}

// ---------------- models + resolution ----------------
function getModels(cfg, refresh) {
  if (process.env.AGR_MODELS_FILE) return readJson(process.env.AGR_MODELS_FILE, { models: [] }).models; // tests
  const c = readJson(MODELS_CACHE, null);
  if (!refresh && c && now() - c.t < 24 * 3600e3 && c.models.length) return c.models;
  const r = wsl(cfg, ['bash', '-lc', 'agy models']);
  const models = (r.stdout || '').split(/\r?\n/).map(l => l.split('\t')).filter(x => x.length >= 2 && /^[a-z0-9.-]+$/.test(x[0])).map(([id, name]) => ({ id, name: name.trim() }));
  if (!models.length) {
    if (c && c.models.length) return c.models;
    throw new Error(`could not list agy models (signed in? run: wsl -d ${cfg.agy.distro} -- bash -lc agy)\n${(r.stdout || '') + (r.stderr || '')}`.trim());
  }
  mkdirp(TS); fs.writeFileSync(MODELS_CACHE, JSON.stringify({ t: now(), models }, null, 1));
  return models;
}
const verKey = id => (id.match(/\d+(?:[.-]\d+)*/) || ['0'])[0].split(/[.-]/).map(Number);
const cmpVer = (a, b) => { const x = verKey(a), y = verKey(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; };
function globPick(models, pattern) {
  const re = new RegExp('^' + pattern.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return models.filter(m => re.test(m.id)).sort((a, b) => cmpVer(b.id, a.id))[0] || null;
}
const EFFORTS = ['low', 'medium', 'high'];
// Free-text model spec -> exact id. "opus" "opus low" "flash 3.7" "gemini pro" "sonnet medium" "claude-opus-5-5-high" "3.6 flash lo"
function matchSpec(models, spec, aliases) {
  const s = String(spec).toLowerCase().trim();
  const exact = models.find(m => m.id === s || m.name.toLowerCase() === s);
  if (exact) return exact;
  if (aliases[s]) return globPick(models, aliases[s]);
  const words = s.replace(/(\d)\.(\d)/g, '$1-$2').split(/[^a-z0-9-]+/).flatMap(w => w.split('-')).filter(Boolean)
    .map(w => ({ lo: 'low', med: 'medium', mid: 'medium', hi: 'high', max: 'high', gemini: '', google: '', claude: '', anthropic: '', model: '', the: '', use: '' }[w] ?? w)).filter(Boolean);
  const effort = words.find(w => EFFORTS.includes(w));
  const nums = words.filter(w => /^\d+$/.test(w));
  const names = words.filter(w => !EFFORTS.includes(w) && !/^\d+$/.test(w));
  const fam = /\b(claude|anthropic)\b/.test(s) ? 'claude' : /\b(gemini|google)\b/.test(s) ? 'gemini' : null;
  let cand = models.filter(m => {
    const t = m.id.replace(/(\d)\.(\d)/g, '$1-$2').split('-');
    if (fam && t[0] !== fam) return false;
    return names.every(n => t.includes(n)) && nums.every(n => t.includes(n));
  });
  if (!cand.length) return null;
  const want = effort || 'high';
  const byEffort = cand.filter(m => m.id.endsWith('-' + want));
  if (byEffort.length) cand = byEffort;
  return cand.sort((a, b) => cmpVer(b.id, a.id))[0];
}
function classify(task, cfg) {
  if (new RegExp(cfg.agy.hardPattern, 'i').test(task)) return 'hard';
  for (const [name, c] of Object.entries(cfg.all.classes || {})) if (new RegExp(c.pattern, 'i').test(task)) return name;
  return '_default';
}
function familyFrom(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(claude|anthropic|opus|sonnet)\b/.test(t)) return 'claude';
  if (/\b(google|gemini|flash|pro)\b/.test(t)) return 'google';
  return 'any';
}
function resolve(cfg, models, { model, family, task }) {
  const spec = model && model !== true && model !== 'auto' ? String(model) : null;
  if (spec) {
    const m = matchSpec(models, spec, cfg.agy.aliases);
    if (!m) throw new Error(`no agy model matches "${spec}". Options:\n${models.map(x => `  ${x.id}  (${x.name})`).join('\n')}`);
    return { model: m, why: `you asked for "${spec}"`, cls: classify(task || '', cfg) };
  }
  const fam = family && family !== true ? (/claude|anthropic/i.test(family) ? 'claude' : /google|gemini/i.test(family) ? 'google' : 'any') : 'any';
  const cls = classify(task || '', cfg);
  const row = cfg.agy.route[cls] || cfg.agy.route._default;
  const alias = row[fam] || row.any;
  const m = matchSpec(models, alias, cfg.agy.aliases);
  if (!m) throw new Error(`routing alias "${alias}" matches no available model — edit antigravity.route in ${ROUTING}`);
  return { model: m, why: `${cls === '_default' ? 'general' : cls} task${fam !== 'any' ? `, ${fam} requested` : ''} → ${alias}`, cls };
}

// ---------------- git snapshot (Windows git owns the checkout) ----------------
const git = (dir, a) => cp.spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 26 });
function gitSnap(dir) {
  if (!dir || git(dir, ['rev-parse', '--is-inside-work-tree']).stdout.trim() !== 'true') return null;
  const head = git(dir, ['rev-parse', 'HEAD']).stdout.trim();
  const stash = git(dir, ['stash', 'create']).stdout.trim();      // snapshot of tracked edits; worktree untouched
  const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  const untracked = git(dir, ['ls-files', '--others', '--exclude-standard']).stdout.split(/\r?\n/).filter(Boolean);
  const dirty = git(dir, ['status', '--porcelain']).stdout.split(/\r?\n/).filter(Boolean).length;
  return { head, base: stash || head, branch, untracked, dirty };
}
function gitChanges(dir, pre) {
  if (!pre) return null;
  const stat = git(dir, ['diff', '--stat=100', pre.base]).stdout.trim();
  const names = git(dir, ['diff', '--name-status', pre.base]).stdout.trim().split(/\r?\n/).filter(Boolean);
  const nowUntracked = git(dir, ['ls-files', '--others', '--exclude-standard']).stdout.split(/\r?\n/).filter(Boolean);
  const added = nowUntracked.filter(f => !pre.untracked.includes(f));
  const head = git(dir, ['rev-parse', 'HEAD']).stdout.trim();
  return { base: pre.base, names, added, stat, committed: head !== pre.head ? head : null };
}

// ---------------- progress rendering ----------------
const PARAM_KEYS = ['CommandLine', 'TargetFile', 'AbsolutePath', 'FilePath', 'Path', 'DirectoryPath', 'SearchPath', 'Query', 'Url', 'URL', 'Pattern', 'SearchDirectory', 'Name'];
function paramSummary(info, workdirWsl) {
  const p = (info && info.parameters) || {};
  let v = '';
  for (const key of PARAM_KEYS) if (p[key]) { v = String(p[key]); break; }
  if (!v) { const f = Object.values(p).find(x => typeof x === 'string'); v = f || ''; }
  if (workdirWsl) v = v.split(workdirWsl + '/').join('');
  return v.replace(/\s+/g, ' ').slice(0, 90);
}
const ICON = t => /write|edit|replace|create|delete|move/.test(t) ? '✎' : /command|terminal|run/.test(t) ? '▶' : /search|grep|find|list|view|read|browse|url|web/.test(t) ? '⌕' : /subagent|agent/.test(t) ? '⇢' : '•';

function header(job) {
  const line = '─'.repeat(64);
  const out = [`╭─ Antigravity · ${job.id} ${line.slice(job.id.length + 16)}`,
    `│ model  ${job.modelName}  (${job.modelId})`,
    `│ why    ${job.why}`,
    `│ dir    ${job.dir || '(none)'}${job.git ? `  ·  git ${job.git.branch}${job.git.dirty ? `, ${job.git.dirty} pre-existing changes` : ', clean'}` : ''}`,
    `│ mode   ${job.yolo ? 'auto-approve (all tools)' : 'ask (headless: tools needing permission are denied)'}  ·  timeout ${job.timeout}`,
    `│ task   ${job.taskPreview}`,
    `╰${line}`];
  return out.join('\n');
}

// ---------------- commands ----------------
async function cmdStart(o) {
  const cfg = loadCfg();
  const task = o['task-file'] ? fs.readFileSync(o['task-file'], 'utf8') : o.task || o._.join(' ');
  if (!task || !task.trim()) throw new Error('no task (use --task-file <f> or --task "<text>")');
  const models = getModels(cfg);
  const fam = o.family || familyFrom(o.model && o.model !== 'auto' ? '' : o.request || '');
  const r = resolve(cfg, models, { model: o.model, family: fam, task });
  const dir = o.dir === false ? null : path.resolve(o.dir && o.dir !== true ? o.dir : process.cwd());
  const id = `ag-${new Date().toISOString().replace(/[-:T]/g, '').slice(4, 12)}-${Math.random().toString(36).slice(2, 5)}`;
  const jd = path.join(JOBS, id); mkdirp(jd);
  const yolo = o.yolo !== false;
  const timeoutS = parseDur(o.timeout || cfg.agy.defaultTimeout);
  const contract = o.digest === false ? '' : `

---
Reply contract (the reply is read by another AI that will verify your work):
- End with a concise digest, max ~300 words: what you did; files created/modified (relative paths); commands you ran and their results (tests/build pass/fail with counts); anything uncertain, skipped, or not done.
- Do not paste whole file contents or long logs into the reply.
- Never git commit, push, or change remotes; leave changes in the working tree for review.
- Never weaken, skip, or stub tests or checks to make them pass; report failures honestly.`;
  const envNote = dir && /^[A-Za-z]:/.test(dir) ? `

---
Environment: you run in Linux (WSL), but this project lives on Windows at ${dir} (mounted at ${toWsl(dir)}) and its dependencies were installed with the Windows toolchain.
Run project commands (npm, pnpm, yarn, node, python, pytest, cargo, dotnet, build/test/lint scripts) through Windows from the project directory, ALWAYS with stdin redirected or they hang waiting for input: cmd.exe /c "npm test" < /dev/null (or powershell.exe -NoProfile -NonInteractive -Command "..." < /dev/null). Do not install Linux toolchains or reinstall dependencies.` : '';
  fs.writeFileSync(path.join(jd, 'prompt.txt'), task.trim() + envNote + contract);
  const pre = gitSnap(dir);
  const job = { id, t0: now(), task: task.trim(), taskPreview: task.trim().split(/\r?\n/)[0].slice(0, 100), modelId: r.model.id, modelName: r.model.name, why: r.why, cls: r.cls,
    dir, yolo, timeout: o.timeout || cfg.agy.defaultTimeout, git: pre, label: o.label || null, sid: process.env.CLAUDE_CODE_SESSION_ID || null, status: 'running' };
  fs.writeFileSync(path.join(jd, 'job.json'), JSON.stringify(job, null, 1));
  fs.writeFileSync(path.join(jd, 'job.env'), [
    `MODEL=${shq(r.model.id)}`, `TIMEOUT_S=${timeoutS}`, `YOLO=${yolo ? 1 : 0}`, `WORKDIR=${dir ? shq(toWsl(dir)) : "''"}`,
    `ADD_DIRS=${shq(o.addDir.map(toWsl).join('\n'))}`].join('\n') + '\n');
  logAgent({ phase: 'pre', id, t: job.t0, sid: job.sid, cls: r.cls === '_default' ? null : r.cls, type: 'antigravity', model: `agy/${TIER_OF(r.model.id)}/${r.model.id}`, why: r.why, desc: job.taskPreview, w: [...new Set(task.toLowerCase().match(/[a-z0-9_]{4,}/g) || [])].slice(0, 60) });

  console.log(header(job));
  const child = cp.spawn('wsl.exe', ['-d', cfg.agy.distro, '--cd', '~', '--', 'bash', toWsl(RUNNER), toWsl(jd)], { windowsHide: true, stdio: 'ignore' });
  const evFile = path.join(jd, 'events.jsonl');
  let off = 0, buf = '', resp = '', result = null, lastResp = 0, toolsSeen = 0;
  const wdW = dir ? toWsl(dir) : null;
  const pump = () => {
    let st; try { st = fs.statSync(evFile); } catch { return; }
    if (st.size <= off) return;
    const fd = fs.openSync(evFile, 'r'); const b = Buffer.alloc(st.size - off); fs.readSync(fd, b, 0, b.length, off); fs.closeSync(fd); off = st.size;
    buf += b.toString('utf8');
    const lines = buf.split('\n'); buf = lines.pop();
    for (const l of lines) {
      let e; try { e = JSON.parse(l); } catch { continue; }
      const T = fmtT(now() - job.t0);
      if (e.event === 'result') { result = e.result; continue; }
      const s = e.step_update; if (!s) continue;
      if (s.step_type === 'tool') {
        const name = s.tool_name || (s.tool_info && s.tool_info.name) || 'tool';
        if (s.state === 'ACTIVE') { toolsSeen++; console.log(`${T}  ${ICON(name)} ${name.padEnd(20)} ${paramSummary(s.tool_info, wdW)}`); }
        else if (s.state === 'DONE' && s.duration_seconds > 5) console.log(`${T}    ✓ ${name} (${s.duration_seconds.toFixed(1)}s)`);
        else if (s.state && !/DONE|ACTIVE/.test(s.state)) console.log(`${T}    ✗ ${name} ${s.state}`);
      } else if (s.step_type === 'agent_response') {
        if (s.text_delta) resp += s.text_delta;
        if (s.state === 'DONE' && s.usage && now() - lastResp > 1500) { lastResp = now(); console.log(`${T}  ● thinking/responding   in ${k(s.usage.input_tokens)} · out ${k(s.usage.output_tokens)}`); }
      } else if (s.step_type && s.step_type !== 'user_input' && s.state === 'ACTIVE') {
        console.log(`${T}  • ${s.step_type}`);
      }
    }
  };
  const tick = setInterval(pump, 700);
  const heartbeat = setInterval(() => console.log(`${fmtT(now() - job.t0)}  … working (${toolsSeen} tool calls so far)`), 60000);
  const code = await new Promise(res => child.on('exit', c => res(c)));
  clearInterval(tick); clearInterval(heartbeat); pump();
  let rc = code; try { rc = +fs.readFileSync(path.join(jd, 'exit'), 'utf8').trim(); } catch {}
  const stderr = (() => { try { return fs.readFileSync(path.join(jd, 'stderr.log'), 'utf8'); } catch { return ''; } })();
  const response = (result && result.response) || resp;
  const status = result ? result.status : rc === 124 || rc === 137 ? 'TIMEOUT' : rc ? 'FAILED' : response ? 'SUCCESS' : 'EMPTY';
  const changes = gitChanges(dir, pre);
  const usage = (result && result.usage) || {};
  Object.assign(job, { status, rc, t1: now(), usage, turns: result && result.num_turns, conversation: result && result.conversation_id, changes });
  fs.writeFileSync(path.join(jd, 'job.json'), JSON.stringify(job, null, 1));
  fs.writeFileSync(path.join(jd, 'result.md'), response || '');
  logAgent({ phase: 'post', id, t: now(), status: status.toLowerCase(), totalTokens: usage.total_tokens || 0, totalDurationMs: job.t1 - job.t0, resolvedModel: job.modelId });

  const bar = '─'.repeat(20);
  console.log(`\n── result ${bar} ${status} · ${fmtT(job.t1 - job.t0)} · ${job.turns || '?'} turns · ${k(usage.total_tokens)} tokens (in ${k(usage.input_tokens)} / out ${k(usage.output_tokens)})`);
  const MAX = 8000;
  console.log(response ? (response.length > MAX ? response.slice(0, MAX) + `\n…[${response.length - MAX} more chars in result.md]` : response.trim()) : '(no reply)');
  if (status !== 'SUCCESS') console.log(`\n── stderr (last lines)\n${stderr.trim().split(/\r?\n/).slice(-12).join('\n') || '(empty)'}`);
  if (changes) {
    console.log(`\n── changes by Antigravity (vs. pre-run snapshot ${changes.base.slice(0, 10)}) ${bar}`);
    if (!changes.names.length && !changes.added.length) console.log('(no file changes)');
    else { if (changes.stat) console.log(changes.stat); for (const a of changes.added) console.log(` + ${a} (new, untracked)`); }
    if (changes.committed) console.log(`⚠ HEAD moved to ${changes.committed.slice(0, 10)} — agy committed despite instructions`);
    console.log(`review: git -C "${dir}" diff ${changes.base.slice(0, 12)}`);
  }
  console.log(`\njob: ${jd}`);
  process.exitCode = status === 'SUCCESS' ? 0 : rc || 1;
}
function logAgent(o) { try { mkdirp(path.dirname(AGENT_LOG)); fs.appendFileSync(AGENT_LOG, JSON.stringify(o) + '\n'); } catch {} }

function jobsList() { try { return fs.readdirSync(JOBS).filter(d => d.startsWith('ag-')).map(d => readJson(path.join(JOBS, d, 'job.json'), null)).filter(Boolean).sort((a, b) => b.t0 - a.t0); } catch { return []; } }
function cmdList() {
  const js = jobsList().slice(0, 20);
  if (!js.length) return console.log('no Antigravity jobs yet');
  for (const j of js) console.log(`${j.id}  ${String(j.status).padEnd(8)} ${j.t1 ? fmtT(j.t1 - j.t0) : 'running'}  ${j.modelId.padEnd(26)} ${j.taskPreview.slice(0, 60)}`);
}
function cmdStatus(id) {
  const jd = path.join(JOBS, id), j = readJson(path.join(jd, 'job.json'), null);
  if (!j) throw new Error(`no job ${id}`);
  let n = 0, tools = 0, last = '';
  try { for (const l of fs.readFileSync(path.join(jd, 'events.jsonl'), 'utf8').split('\n')) { if (!l) continue; n++; try { const s = JSON.parse(l).step_update; if (s && s.step_type === 'tool' && s.state === 'ACTIVE') { tools++; last = `${s.tool_name} ${paramSummary(s.tool_info)}`; } } catch {} } } catch {}
  console.log(`${j.id} ${j.status} · ${j.t1 ? fmtT(j.t1 - j.t0) : 'running ' + fmtT(now() - j.t0)} · ${j.modelName} · ${tools} tool calls${last ? ` · last: ${last}` : ''}`);
}
function cmdResult(id) {
  const jd = path.join(JOBS, id), j = readJson(path.join(jd, 'job.json'), null);
  if (!j) throw new Error(`no job ${id}`);
  console.log(`${j.id} ${j.status} · ${j.modelName}`);
  try { console.log(fs.readFileSync(path.join(jd, 'result.md'), 'utf8')); } catch { console.log('(no result yet)'); }
}
function cmdCancel(id) {
  const cfg = loadCfg(), jd = path.join(JOBS, id);
  const r = wsl(cfg, ['bash', '-lc', `kt(){ for c in $(pgrep -P "$1"); do kt "$c"; done; kill -TERM "$1" 2>/dev/null; }; p=$(cat ${shq(toWsl(jd) + '/pid')} 2>/dev/null) && kt "$p" && echo cancelled || echo "not running"`]);
  console.log((r.stdout || r.stderr).trim());
}
function cmdModels(o) {
  const cfg = loadCfg(), models = getModels(cfg, !!o.refresh);
  console.log('Models available to Antigravity (agy):');
  for (const m of models) console.log(`  ${m.id.padEnd(26)} ${m.name}`);
  console.log('\nAuto-routing (say "use antigravity" / "use google" / "use antigravity with claude", or name any model above):');
  console.log(`  ${'task kind'.padEnd(20)} ${'google'.padEnd(24)} ${'claude'.padEnd(24)} ${'neutral ("use antigravity")'}`);
  for (const [cls, row] of Object.entries(cfg.agy.route)) {
    const show = a => { const m = matchSpec(models, a, cfg.agy.aliases); return (m ? m.id : `?${a}`).padEnd(24); };
    console.log(`  ${(cls === '_default' ? 'other' : cls).padEnd(20)} ${show(row.google)} ${show(row.claude)} ${show(row.any)}`);
  }
}
function cmdResolve(o) {
  const cfg = loadCfg(), models = getModels(cfg);
  const fam = o.family || familyFrom(o.request || '');
  const r = resolve(cfg, models, { model: o.model, family: fam, task: o.task || '' });
  console.log(`${r.model.id}  (${r.model.name})  — ${r.why}`);
}
function cmdDoctor() {
  const cfg = loadCfg();
  const v = wsl(cfg, ['bash', '-lc', 'agy --version']);
  console.log(`wsl distro ${cfg.agy.distro}: agy ${(v.stdout || '').trim() || 'MISSING'} ${v.status ? '(rc ' + v.status + ')' : ''}`);
  try { const m = getModels(cfg, true); console.log(`signed in: yes (${m.length} models)`); } catch (e) { console.log(`signed in: NO — ${e.message.split('\n')[0]}`); }
  console.log(`runner: ${fs.existsSync(RUNNER) ? 'ok' : 'MISSING'} ${RUNNER}`);
  console.log(`jobs dir: ${JOBS}`);
}

(async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  const o = args(rest);
  try {
    if (cmd === 'start') await cmdStart(o);
    else if (cmd === 'models') cmdModels(o);
    else if (cmd === 'resolve') cmdResolve(o);
    else if (cmd === 'list') cmdList();
    else if (cmd === 'status') cmdStatus(o._[0]);
    else if (cmd === 'result') cmdResult(o._[0]);
    else if (cmd === 'cancel') cmdCancel(o._[0]);
    else if (cmd === 'doctor') cmdDoctor();
    else { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 11).join('\n').replace(/^\/\/ ?/gm, '')); process.exitCode = 1; }
  } catch (e) { console.error(`agy-run: ${e.message}`); process.exitCode = 1; }
})();
