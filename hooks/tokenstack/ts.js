#!/usr/bin/env node
// tokenstack: single dispatcher for all custom token-efficiency hooks.
// Usage: node ts.js <cbm-gate|cbm-mark|shell-gate|compress|skill-watch|session-start|precompact|skill-register|skill-status|handoff-path>
// Shell-agnostic (runs identically under Git Bash or PowerShell). Never throws: any internal error => allow (exit 0).
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const cp = require('child_process');

const HOME = os.homedir();
const CLAUDE = path.join(HOME, '.claude');
const TS = path.join(CLAUDE, 'tokenstack');
const STATE = path.join(TS, 'state');
const HANDOFFS = path.join(CLAUDE, 'handoffs');
const REGISTRY = path.join(TS, 'skill-registry.json');
const HR_PY = path.join(HOME, '.headroom', 'venv', 'Scripts', 'python.exe');
const HR_HELPER = path.join(__dirname, 'hr_compress.py');
const CBM_WINDOW_MS = 120e3;
const UNLOCK_MS = 10 * 60e3;
const COMPRESS_MIN_CHARS = 15000;

const SOURCE_EXT = new Set(('js jsx ts tsx mjs cjs py pyi rb go rs java kt kts swift c h cc cpp cxx hpp hh cs fs php dart ' +
  'scala lua vue svelte astro ex exs erl clj elm hs ml zig nim r jl m mm sol').split(' '));
const PROJECT_MARKERS = ['.git', 'package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod', 'pubspec.yaml',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'composer.json', 'Gemfile', 'deno.json', 'wrangler.toml', 'wrangler.jsonc', 'CMakeLists.txt'];

// ---------- helpers ----------
const readStdin = () => { try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return {}; } };
const mkdirp = d => { try { fs.mkdirSync(d, { recursive: true }); } catch {} };
const ageMs = f => { try { return Date.now() - fs.statSync(f).mtimeMs; } catch { return Infinity; } };
const touch = f => { mkdirp(path.dirname(f)); fs.writeFileSync(f, String(Date.now())); };
const out = obj => process.stdout.write(JSON.stringify(obj));
const sid = inp => String(inp.session_id || 'nosession').replace(/[^\w-]/g, '');
const deny = (event, reason) => out({ hookSpecificOutput: { hookEventName: event, permissionDecision: 'deny', permissionDecisionReason: reason } });
const sha = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const slug = p => String(p || 'unknown').replace(/^([a-zA-Z]):/, '$1').replace(/[\\/:\s]+/g, '-').replace(/[^\w.-]/g, '').slice(-80);

// Escape hatches (10 min, by file mtime): unlock-<gate>-<session_id> (this session only — preferred),
// unlock-<gate> / unlock-all (every session). TS_IGNORE_UNLOCK=1 (tests) ignores them.
function gatesOff(cwd, which, inp) {
  if (cwd && fs.existsSync(path.join(cwd, '.claude', 'no-gates'))) return true;
  if (process.env.TS_IGNORE_UNLOCK) return false;
  const s = inp ? sid(inp) : '';
  return [`unlock-${which}`, 'unlock-all', ...(s ? [`unlock-${which}-${s}`, `unlock-all-${s}`] : [])]
    .some(f => ageMs(path.join(TS, f)) < UNLOCK_MS);
}
function isCodeProject(cwd) {
  if (!cwd) return false;
  try { return PROJECT_MARKERS.some(m => fs.existsSync(path.join(cwd, m))) || fs.readdirSync(cwd).some(f => /\.sln$/i.test(f)); }
  catch { return false; }
}
const isSourceFile = fp => SOURCE_EXT.has(path.extname(fp || '').slice(1).toLowerCase()) && !/([\\/]tests?[\\/]|[._-](test|spec)\.)/i.test(fp);

// ---------- PreToolUse Read|Grep : codebase-memory gate ----------
function cbmGate(inp) {
  const cwd = inp.cwd || process.cwd();
  if (!isCodeProject(cwd) || gatesOff(cwd, 'cbm', inp)) return;
  if (ageMs(path.join(STATE, `cbm-${sid(inp)}`)) < CBM_WINDOW_MS) return;
  const ti = inp.tool_input || {};
  const how = 'Use cbm first: index_status (index_repository if unindexed) -> search_graph / get_code_snippet / trace_path / get_file_outline. ' +
    `After any cbm call, Read/Grep unlock for 120s. If cbm genuinely can't serve this (unindexed language, generated code), escape for THIS session only: create ~/.claude/tokenstack/unlock-cbm-${sid(inp)} (10 min) and tell the user why.`;
  if (inp.tool_name === 'Read') {
    if (!isSourceFile(ti.file_path)) return;
    if (ti.limit && Number(ti.limit) <= 200) return; // targeted range read is already cheap
    return deny('PreToolUse', `BLOCKED full Read of source file ${path.basename(ti.file_path)} without recent codebase-memory (cbm) query. ${how} Or Read with limit<=200 for a known range.`);
  }
  if (inp.tool_name === 'Grep') {
    if ((ti.output_mode || 'files_with_matches') !== 'content') return; // path/count listings are cheap
    const scope = `${ti.glob || ''} ${ti.type || ''} ${ti.path || ''}`;
    if (/\.(md|mdx|txt|json|ya?ml|toml|ini|cfg|env|lock|csv|log|html?|css|scss)\b|\b(md|json|yaml|toml|txt)\b/i.test(scope) && !/\.(js|ts|py|go|rs|java|cs|dart|rb|php)\b/i.test(scope)) return;
    return deny('PreToolUse', `BLOCKED content Grep over code without recent cbm query. ${how} (search_code is cbm's grep.)`);
  }
}

// ---------- PostToolUse mcp__cbm__* : unlock marker ----------
function cbmMark(inp) { touch(path.join(STATE, `cbm-${sid(inp)}`)); }

// ---------- PreToolUse Bash|PowerShell : raw-tool ban + RTK rewrite ----------
const BAN_ANY = new Set(['cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'find', 'less', 'more', 'findstr',
  'get-content', 'gc', 'type', 'select-string', 'sls']);
const LISTERS = new Set(['get-childitem', 'gci', 'ls', 'dir']);
function firstToken(seg) {
  let t = seg.trim().replace(/^(&|\.)\s+/, '').replace(/^(sudo|command|builtin)\s+/, '');
  t = (t.match(/^("[^"]+"|'[^']+'|\S+)/) || [''])[0].replace(/^["']|["']$/g, '');
  return path.basename(t).toLowerCase().replace(/\.exe$/, '');
}
function shellGate(inp) {
  const cwd = inp.cwd || process.cwd();
  const ti = inp.tool_input || {};
  const cmd = String(ti.command || '');
  if (!cmd) return;
  if (!gatesOff(cwd, 'shell', inp)) {
    // Only the head of each pipeline reads raw data into context; filters after a pipe (| grep, | Select-String) reduce output and are fine.
    for (const stmt of cmd.split(/;|&&|\|\||\r?\n/)) {
      const head = stmt.split('|')[0];
      const tok = firstToken(head);
      const recursiveList = LISTERS.has(tok) && /\s-(r|recurse)\b/i.test(head);
      const writes = /<<|(^|\s)>{1,2}\s*\S/.test(head); // cat > f <<EOF etc. writes, doesn't dump
      if ((BAN_ANY.has(tok) && !writes) || recursiveList) {
        return deny('PreToolUse', `BLOCKED raw \`${tok}\` in shell: dumps files/trees straight into context. Use: Read (offset/limit) | Grep tool | Glob | cbm search_graph/get_code_snippet for code | ctx_execute_file for big files/logs. Filtering AFTER a pipe is allowed. If truly needed, escape for THIS session only: create ~/.claude/tokenstack/unlock-shell-${sid(inp)} (10 min) and tell the user why.`);
      }
    }
  }
  // RTK rewrite (absolute path so it works before PATH refresh, in both shells).
  // Never for diffs/patches: benchmark showed `rtk git diff` hides ~36% of changed lines.
  if (SKIP_CMD.test(cmd)) return;
  const rtk = findRtk();
  if (!rtk) return;
  try {
    const r = cp.spawnSync(rtk, ['hook', 'claude'], { input: JSON.stringify(inp), encoding: 'utf8', timeout: 3000, windowsHide: true });
    const j = JSON.parse((r.stdout || '').trim().split('\n').pop() || '{}');
    const nc = j.hookSpecificOutput && j.hookSpecificOutput.updatedInput && j.hookSpecificOutput.updatedInput.command;
    // rtk inserts `rtk ` at command positions (start, or after ; && || | newline). Swap each for the absolute exe.
    const CMDPOS = /(^|[;&|\n]\s*)rtk\s+/g;
    if (!nc || nc === cmd || !CMDPOS.test(nc)) return;
    const exe = inp.tool_name === 'PowerShell' ? `& "${rtk}" ` : `"${rtk.replace(/\\/g, '/')}" `;
    out({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...ti, command: nc.replace(CMDPOS, (m, pre) => pre + exe) } } });
  } catch {}
}
function findRtk() {
  const cache = path.join(TS, 'rtk-path');
  try { const p = fs.readFileSync(cache, 'utf8').trim(); if (p && fs.existsSync(p)) return p; } catch {}
  const roots = [path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'Microsoft', 'WinGet', 'Packages'), path.join(HOME, '.cargo', 'bin')];
  for (const r of roots) {
    try {
      if (fs.existsSync(path.join(r, 'rtk.exe'))) { fs.writeFileSync(cache, path.join(r, 'rtk.exe')); return path.join(r, 'rtk.exe'); }
      for (const d of fs.readdirSync(r).filter(d => d.startsWith('rtk-ai.rtk'))) {
        const p = path.join(r, d, 'rtk.exe');
        if (fs.existsSync(p)) { mkdirp(TS); fs.writeFileSync(cache, p); return p; }
      }
    } catch {}
  }
  return null;
}

// ---------- PostToolUse Bash|PowerShell : Headroom compression (guarded) ----------
// Safety policy — compression must never silently drop signal:
//  1. shell tools only; 2. skip diffs/patches/source/file dumps; 3. user said "exact" this turn → skip;
//  4. after compressing, every signal line of the original must survive verbatim, else keep original.
const SKIP_CMD = /\bgit\s+(diff|show|format-patch|stash\s+show|log\b[^|;]*\s(-p|--patch|--stat))|\b(diff|patch|fc)(\.exe)?\s|\bgh\s+pr\s+diff\b|\b(type|cat|Get-Content|gc|more)\s/i;
const SIGNAL = /\b(error|errors|err!|fail(ed|ure|ing)?|fatal|panic|exception|traceback|warn(ing)?|denied|refused|not found|missing|cannot|can't|unable|timeout|timed out|assert(ion)?|expected|received|abort(ed)?|crash(ed)?|segfault|undefined|invalid|deprecated|conflict)\b|✗|✘|×|❌|FAIL|ERR/i;
const looksLikeDiffOrCode = s => /^(diff --git |@@ -\d|--- a\/|\+\+\+ b\/|Index: )/m.test(s) ||
  (s.match(/^\s*(import |export |function |def |class |const |let |public |private |#include|package |using )/gm) || []).length > 15;
function signalLines(s) {
  const set = new Set();
  for (const l of s.split(/\r?\n/)) { const t = l.trim(); if (t && t.length <= 400 && SIGNAL.test(t)) set.add(t); }
  return [...set];
}
function compressSafe(orig, comp) {
  if (typeof comp !== 'string' || !/hash=[0-9a-f]{8,}/.test(comp)) return false; // anything dropped must be retrievable
  const sig = signalLines(orig);
  if (sig.length > 40) return false; // signal-dense output: not safe to summarize
  return sig.every(t => comp.includes(t));
}
function compress(inp) {
  const tool = String(inp.tool_name || '');
  if (!/^(Bash|PowerShell)$/.test(tool)) return;
  if (!fs.existsSync(HR_PY)) return;
  if (ageMs(path.join(STATE, `exact-${sid(inp)}`)) < 6 * 3600e3) return;
  if (SKIP_CMD.test(String((inp.tool_input || {}).command || ''))) return;
  const resp = inp.tool_response;
  if (process.env.TS_DEBUG || fs.existsSync(path.join(TS, 'debug'))) {
    const shape = v => typeof v === 'string' ? `str(${v.length})` : Array.isArray(v) ? v.map(shape) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)])) : v;
    appendStat({ debug: true, tool, shape: shape(resp), head: JSON.stringify(resp).slice(0, 300) });
  }
  // Oversized shell output: stdout is only a truncated head; the full text is on disk. Compress the FULL text so tail errors survive.
  if (resp && typeof resp === 'object' && resp.persistedOutputPath && typeof resp.stdout === 'string') {
    try {
      const st = fs.statSync(resp.persistedOutputPath);
      if (st.size <= 8 * 1024 * 1024) resp.stdout = fs.readFileSync(resp.persistedOutputPath, 'utf8');
    } catch {}
  }
  const big = [];
  const walk = (v, set) => {
    if (typeof v === 'string') { if (v.length >= COMPRESS_MIN_CHARS && !looksLikeDiffOrCode(v)) { big.push({ v, set }); } return; }
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, nv => { v[i] = nv; }));
    else if (v && typeof v === 'object') Object.keys(v).forEach(k => walk(v[k], nv => { v[k] = nv; }));
  };
  let root = resp;
  walk(root, nv => { root = nv; });
  if (!big.length) return;
  try {
    const r = cp.spawnSync(HR_PY, [HR_HELPER], {
      input: JSON.stringify({ texts: big.map(b => b.v), tool }), encoding: 'utf8', timeout: 25000, windowsHide: true,
      env: { ...process.env, HEADROOM_BEACON: 'off', PYTHONIOENCODING: 'utf-8' }, maxBuffer: 64 * 1024 * 1024,
    });
    const res = JSON.parse(r.stdout || '{}').texts || [];
    let changed = false, before = 0, after = 0, rejected = 0;
    big.forEach((b, i) => {
      if (typeof res[i] !== 'string') return;
      if (!compressSafe(b.v, res[i])) { rejected++; return; }
      before += b.v.length; after += res[i].length;
      b.set(`[headroom: ${b.v.length}→${res[i].length} chars; all error/warn/fail lines kept verbatim. Repetitive lines folded — if you need an omitted line, call headroom_retrieve with the hash below. Never infer omitted content.]\n` + res[i]);
      changed = true;
    });
    appendStat({ t: Date.now(), tool, cmd: String((inp.tool_input || {}).command || '').slice(0, 120), before, after, rejected });
    if (!changed) return;
    out({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: root } });
  } catch {}
}
// UserPromptSubmit: "exact" / "full output" / "raw output" / "no compress" in the prompt disables compression until a prompt without it.
function promptMode(inp) {
  const f = path.join(STATE, `exact-${sid(inp)}`);
  if (/\b(exact|full output|raw output|no ?compress(ion)?|uncompressed)\b/i.test(String(inp.prompt || ''))) touch(f);
  else { try { fs.unlinkSync(f); } catch {} }
}
function appendStat(o) { try { mkdirp(STATE); fs.appendFileSync(path.join(STATE, 'headroom-hook.jsonl'), JSON.stringify(o) + '\n'); } catch {} }

// ---------- skills registry ----------
function scanSkills(cwd) {
  const found = {};
  const addDir = (dir, prefix, track) => {
    let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (!e.isDirectory() || e.name === 'synced' || e.name.startsWith('.')) continue;
      const f = path.join(dir, e.name, 'SKILL.md');
      if (fs.existsSync(f)) { try { found[prefix + e.name] = { path: f, hash: track ? sha(fs.readFileSync(f, 'utf8')) : null }; } catch {} }
    }
  };
  addDir(path.join(CLAUDE, 'skills'), 'user:', true);
  if (cwd) addDir(path.join(cwd, '.claude', 'skills'), `project:${slug(cwd)}:`, true);
  // plugin skills: track by key only (files are replaced on plugin update; never edited in place)
  const cache = path.join(CLAUDE, 'plugins', 'cache');
  try {
    for (const mkt of fs.readdirSync(cache)) {
      if (mkt.startsWith('.') || mkt === 'synced') continue;
      for (const plug of fs.readdirSync(path.join(cache, mkt))) {
        const vers = fs.readdirSync(path.join(cache, mkt, plug)).sort();
        const latest = vers[vers.length - 1];
        if (latest) addDir(path.join(cache, mkt, plug, latest, 'skills'), `plugin:${plug}:`, false);
      }
    }
  } catch {}
  return found;
}
const loadReg = () => { try { return JSON.parse(fs.readFileSync(REGISTRY, 'utf8').replace(/^﻿/, '')); } catch { return {}; } };
const saveReg = r => { mkdirp(TS); fs.writeFileSync(REGISTRY, JSON.stringify(r, null, 1)); };
function pendingSkills(cwd) {
  const reg = loadReg(), cur = scanSkills(cwd), pend = [];
  for (const [k, v] of Object.entries(cur)) {
    const r = reg[k];
    if (!r || (v.hash && r.hash !== v.hash)) pend.push({ key: k, path: v.path, kind: r ? 'changed' : 'new' });
  }
  return pend;
}
function skillRegister(args, cwd) {
  // node ts.js skill-register <SKILL.md path | --baseline-all> [note]
  const reg = loadReg(), cur = scanSkills(cwd), now = new Date().toISOString();
  const target = args[0];
  for (const [k, v] of Object.entries(cur)) {
    if (target === '--baseline-all' ? !reg[k] || (v.hash && reg[k].hash !== v.hash) : path.resolve(v.path) === path.resolve(target || '')) {
      reg[k] = { hash: v.hash, path: v.path, audited: target === '--baseline-all' ? 'baseline' : now, note: args.slice(1).join(' ') || undefined };
      process.stdout.write(`registered ${k}\n`);
    }
  }
  saveReg(reg);
}

// ---------- PostToolUse Write|Edit : detect skill files written mid-session ----------
function skillWatch(inp) {
  const fp = String((inp.tool_input || {}).file_path || '');
  if (!/[\\/]skills[\\/][^\\/]+[\\/]SKILL\.md$/i.test(fp)) return;
  const reg = loadReg();
  const known = Object.values(reg).find(r => path.resolve(r.path) === path.resolve(fp));
  let h = null; try { h = sha(fs.readFileSync(fp, 'utf8')); } catch {}
  if (known && known.hash === h) return; // registered state (e.g. intake just finished)
  out({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext:
    `SKILL INTAKE: ${fp} is new/changed. When done editing it, invoke skill-intake on it before using it.` } });
}

// ---------- handoff ----------
const handoffPath = cwd => path.join(HANDOFFS, `${slug(cwd)}.md`);

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(b => b && b.type === 'text').map(b => b.text).join('\n');
}
const clean = s => String(s || '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').replace(/\s+\n/g, '\n').trim();

function extractTranscript(tp) {
  let raw = '';
  try {
    const st = fs.statSync(tp), fd = fs.openSync(tp, 'r');
    const len = Math.min(st.size, 4 * 1024 * 1024), buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len); fs.closeSync(fd); raw = buf.toString('utf8');
  } catch { return null; }
  const userMsgs = [], files = new Map(), tail = [];
  let lastAssistant = '', todos = null;
  for (const line of raw.split('\n')) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    const m = e.message; if (!m) continue;
    if (e.type === 'user' && !e.isMeta) {
      const t = clean(textOf(m.content));
      if (t && !/^<(command|local-command|task-notification)/.test(t)) { userMsgs.push(t); tail.push('USER: ' + t.slice(0, 1500)); }
    } else if (e.type === 'assistant' && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === 'text' && clean(b.text)) { lastAssistant = clean(b.text); tail.push('ASSISTANT: ' + lastAssistant.slice(0, 1500)); }
        if (b.type === 'tool_use') {
          const fp = b.input && (b.input.file_path || b.input.notebook_path);
          if (fp && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(b.name)) files.set(fp, (files.get(fp) || 0) + 1);
          if (b.name === 'TodoWrite' && b.input && b.input.todos) todos = b.input.todos;
          tail.push(`TOOL ${b.name}: ${JSON.stringify(b.input || {}).slice(0, 200)}`);
        }
      }
    }
  }
  return { userMsgs, files, lastAssistant, todos, tail };
}

function deterministicHandoff(x, cwd, trigger) {
  const lines = [`# HANDOFF (auto, deterministic) — ${new Date().toISOString()} — trigger: ${trigger}`, `cwd: ${cwd}`, ''];
  lines.push('## Task (first request)', (x.userMsgs[0] || '?').slice(0, 1200), '');
  lines.push('## Recent user requests (latest last)', ...x.userMsgs.slice(-6).map(u => '- ' + u.slice(0, 500).replace(/\n/g, ' ')), '');
  if (x.todos) lines.push('## Todos', ...x.todos.map(t => `- [${t.status}] ${t.content}`), '');
  lines.push('## Files modified', ...([...x.files].map(([f, n]) => `- ${f} (${n} edits)`)), '');
  lines.push('## Last assistant state', x.lastAssistant.slice(0, 2000), '');
  return lines.join('\n');
}

function findClaudeCli() {
  const cands = [];
  for (const d of (process.env.PATH || '').split(path.delimiter)) cands.push(path.join(d, 'claude.exe'), path.join(d, 'claude.cmd'));
  cands.push(path.join(HOME, '.local', 'bin', 'claude.exe'));
  for (const c of cands) if (c && fs.existsSync(c)) return c;
  // Desktop app's bundled CLI. The app is MSIX-packaged: inside it, %APPDATA% is virtualized; from a plain terminal the
  // real files live under %LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming. Check both.
  const bases = [path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'Claude', 'claude-code')];
  const pk = path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'Packages');
  try { for (const d of fs.readdirSync(pk).filter(d => /^Claude_/.test(d))) bases.push(path.join(pk, d, 'LocalCache', 'Roaming', 'Claude', 'claude-code')); } catch {}
  const cmpVer = (a, b) => a.split('.').map(Number).reduce((s, n, i) => s || n - b.split('.').map(Number)[i], 0);
  for (const base of bases) {
    try {
      const v = fs.readdirSync(base).filter(d => /^\d+\.\d+\.\d+$/.test(d)).sort(cmpVer);
      for (const d of v.reverse()) { const p = path.join(base, d, 'claude.exe'); if (fs.existsSync(p)) return p; }
    } catch {}
  }
  return null;
}

const HANDOFF_PROMPT = `You write a session handoff so a fresh Claude Code session can resume with zero re-exploration.
Output ONLY valid JSON (no fences) with keys:
task (one sentence), completed_tasks [..], current_state (in-flight work, what works/broken),
constraints_to_preserve [user rules VERBATIM, ruled-out approaches + why], files_touched [{path,status,summary}],
issues_discovered [bugs/gotchas + workarounds], open_questions [..], next_steps [ordered; [0] = literal first action],
resume_prompt (one paragraph). Be specific: paths, commands, names. Skip anything not evidenced below.`;

function modelHandoff(det, x) {
  const exe = findClaudeCli();
  if (!exe) return null;
  const body = `${HANDOFF_PROMPT}\n\n=== EXTRACT ===\n${det}\n\n=== TRANSCRIPT TAIL ===\n${x.tail.join('\n').slice(-150000)}`;
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^CLAUDE_CODE_(SDK_HAS_HOST_AUTH_REFRESH|MESSAGING_|HOST_SESSION_ID|CHILD_SESSION|ENTRYPOINT|SESSION_ID|OAUTH_SCOPES)/.test(k) || k === 'CLAUDECODE') delete env[k];
  const r = cp.spawnSync(exe, ['-p', '--model', 'sonnet', '--strict-mcp-config', '--no-session-persistence',
    '--settings', '{"disableAllHooks":true}', '--setting-sources', 'user', '--tools', ''], {
    input: body, encoding: 'utf8', timeout: 75000, windowsHide: true, env, maxBuffer: 16 * 1024 * 1024 });
  const o = (r.stdout || '').trim();
  const s = o.indexOf('{'), e = o.lastIndexOf('}');
  if (r.status !== 0 || s < 0) return null;
  try { JSON.parse(o.slice(s, e + 1)); return o.slice(s, e + 1); } catch { return null; }
}

function precompact(inp) {
  const cwd = inp.cwd || process.cwd();
  const x = inp.transcript_path ? extractTranscript(inp.transcript_path) : null;
  if (!x) return;
  const det = deterministicHandoff(x, cwd, inp.trigger || '?');
  mkdirp(HANDOFFS);
  const hp = handoffPath(cwd);
  fs.writeFileSync(hp, det);
  const mj = modelHandoff(det, x);
  if (mj) fs.writeFileSync(hp, `# HANDOFF (model) — ${new Date().toISOString()}\ncwd: ${cwd}\n\n\`\`\`json\n${mj}\n\`\`\`\n`);
}

// ---------- SessionStart ----------
function sessionStart(inp) {
  const cwd = inp.cwd || process.cwd();
  const src = inp.source || 'startup';
  const parts = [];
  if (src !== 'resume' && isCodeProject(cwd) && !gatesOff(cwd, 'cbm', inp)) {
    parts.push('CODE NAV: cbm MCP first (index_status -> index_repository if needed; detect_changes if indexed). search_graph/trace_path/get_code_snippet/get_architecture beat Read/Grep. Full Read/content-Grep of source is gated until a cbm call.');
  }
  const hp = handoffPath(cwd);
  const age = ageMs(hp);
  if (src === 'compact' && age < 15 * 60e3) {
    try { parts.push('HANDOFF (written just before compaction; trust over re-exploring):\n' + fs.readFileSync(hp, 'utf8').slice(0, 6000)); } catch {}
  } else if (src === 'startup' && age < 48 * 3600e3) {
    parts.push(`Prior handoff for this dir (${Math.round(age / 3600e3)}h old): ${hp} — Read it only if user is continuing earlier work.`);
  }
  const pend = pendingSkills(cwd);
  if (pend.length) {
    parts.push(`SKILL INTAKE pending (${pend.length}): ${pend.slice(0, 8).map(p => `${p.key} [${p.kind}] ${p.path}`).join('; ')}` +
      `${pend.length > 8 ? ' …' : ''}. Tell user briefly, then invoke skill-intake on each before using them (after user's immediate request if urgent).`);
  }
  if (parts.length) out({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: parts.join('\n\n') } });
}

// ---------- subagent model router ----------
// PreToolUse Agent: fill `model` when the caller didn't choose one. Explicit model always wins (except: a "deep" task is never
// sent below opus). Learns: a task re-delegated on a higher tier soon after = escalation; classes that escalate often get promoted.
const ROUTING = path.join(TS, 'model-routing.json');
const AGENT_LOG = path.join(STATE, 'agents.jsonl');
const TIERS = ['haiku', 'sonnet', 'opus', 'fable'];
const DEFAULT_ROUTING = {
  _doc: 'Edit freely. classes: tier = default model; pattern = regex (case-insens.) on description+prompt. Order = priority. promote: auto-raise a class one tier when escalation rate >= rate over >= minSamples (max opus).',
  classes: {
    deep: { tier: 'opus', pattern: '\\b(audit|security|vulnerab|threat|exploit|code review|review (the|this|my)|refactor|architect|system design|migrat|root cause|race condition|concurren|deadlock|memory leak|edge cases?|correctness|invariant|regression|subtle|tricky|trade-?offs?|high.stakes|production incident)' },
    build: { tier: 'sonnet', pattern: '\\b(implement|write|add|fix|build|create|update|test|debug|port|wire)' },
    research: { tier: 'sonnet', pattern: '\\b(research|summari[sz]e|explore|investigate|look ?up|compare|document|analy[sz]e|read|search|docs?|list|inventory|count|collect|find|locate|where is|grep|extract)' },
    mechanical: { tier: 'haiku', pattern: '\\b(rename|reformat|format|typo|reword|convert (case|quotes|indent))' },
  },
  fallbackTier: 'sonnet',
  builtinTypes: ['general-purpose', 'claude', ''],
  promote: { rate: 0.25, minSamples: 8 },
};
function loadRouting() {
  try { return JSON.parse(fs.readFileSync(ROUTING, 'utf8').replace(/^﻿/, '')); }
  catch { mkdirp(TS); fs.writeFileSync(ROUTING, JSON.stringify(DEFAULT_ROUTING, null, 2)); return DEFAULT_ROUTING; }
}
const readJsonl = f => { try { return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const words = s => new Set(String(s).toLowerCase().match(/[a-z0-9_]{4,}/g) || []);
const jaccard = (a, b) => { let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i || 1); };
const tierIdx = m => { const i = TIERS.findIndex(t => String(m || '').toLowerCase().includes(t)); return i < 0 ? 1 : i; };

function classify(text, R) {
  for (const [name, c] of Object.entries(R.classes)) if (new RegExp(c.pattern, 'i').test(text)) return name;
  return null;
}
function classStats(log, cls) {
  // only runs at the class's base tier can "escalate"; re-runs on higher tiers aren't samples
  const base = tierIdx((loadRouting().classes[cls] || {}).tier);
  const recs = log.filter(r => r.cls === cls && r.phase === 'pre' && tierIdx(r.model) === base);
  return { n: recs.length, esc: recs.filter(r => r.escalated).length };
}
function agentRoute(inp) {
  const ti = inp.tool_input || {};
  const R = loadRouting();
  const text = `${ti.description || ''}\n${String(ti.prompt || '').slice(0, 3000)}`;
  const type = String(ti.subagent_type || '');
  let cls = type === 'Plan' ? 'deep' : classify(text, R);
  const log = readJsonl(AGENT_LOG);
  let tier = cls ? R.classes[cls].tier : R.fallbackTier;
  // learned promotion
  if (cls) {
    const s = classStats(log, cls);
    if (s.n >= R.promote.minSamples && s.esc / s.n >= R.promote.rate && tierIdx(tier) < 2) tier = TIERS[tierIdx(tier) + 1];
  }
  // escalation detection: same session, similar task, within 60 min, previously on a lower tier
  const w = words(text), now = Date.now();
  const sameTask = log.filter(r => r.phase === 'pre' && r.sid === sid(inp) && now - r.t < 3600e3 && jaccard(new Set(r.w), w) >= 0.5);
  const explicit = ti.model ? String(ti.model) : null;
  const custom = !R.builtinTypes.includes(type) && type !== 'Plan';
  let chosen = explicit;
  let why;
  if (explicit) {
    if (cls === 'deep' && tierIdx(explicit) < 2) { chosen = 'opus'; why = `floor: deep task raised ${explicit}->opus`; }
    else why = 'explicit';
  } else if (custom && cls !== 'deep') {
    chosen = null; why = `custom agent ${type}: own frontmatter model`;
  } else { chosen = tier; why = `${cls || 'unclassified'} -> ${tier}`; }
  const effTier = tierIdx(chosen || (custom ? 'sonnet' : tier));
  const prev = sameTask[sameTask.length - 1];
  if (prev && effTier > tierIdx(prev.model)) {
    // mark earlier record escalated (rewrite log line)
    try {
      const all = readJsonl(AGENT_LOG);
      const idx = all.findIndex(r => r.id === prev.id);
      if (idx >= 0) { all[idx].escalated = true; fs.writeFileSync(AGENT_LOG, all.map(r => JSON.stringify(r)).join('\n') + '\n'); }
    } catch {}
  }
  const id = inp.tool_use_id || `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  try { mkdirp(STATE); fs.appendFileSync(AGENT_LOG, JSON.stringify({ phase: 'pre', id, t: now, sid: sid(inp), cls, type, model: chosen || 'agent-default', why, desc: String(ti.description || '').slice(0, 100), w: [...w].slice(0, 60) }) + '\n'); } catch {}
  try { fs.writeFileSync(path.join(STATE, `agent-pending-${sid(inp)}`), id); } catch {}
  if (chosen && chosen !== explicit) {
    out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecisionReason: `model router: ${why}`, updatedInput: { ...ti, model: chosen } } });
  }
}
function agentLog(inp) {
  const r = inp.tool_response || {};
  const pick = {};
  for (const k of ['status', 'totalTokens', 'totalDurationMs', 'totalToolUseCount']) if (r[k] !== undefined) pick[k] = r[k];
  if (r.usage) pick.out_tokens = r.usage.output_tokens;
  if (r.resolvedModel) pick.resolvedModel = r.resolvedModel;
  let pid = inp.tool_use_id || null;
  if (!pid) { try { pid = fs.readFileSync(path.join(STATE, `agent-pending-${sid(inp)}`), 'utf8'); } catch {} }
  try { fs.appendFileSync(AGENT_LOG, JSON.stringify({ phase: 'post', id: pid, t: Date.now(), ...pick }) + '\n'); } catch {}
}
function agentReport() {
  const log = readJsonl(AGENT_LOG), R = loadRouting();
  const post = Object.fromEntries(log.filter(r => r.phase === 'post' && r.id).map(r => [r.id, r]));
  const rows = {};
  for (const r of log.filter(r => r.phase === 'pre')) {
    const k = `${r.cls || 'unclassified'} | ${r.model}`;
    const g = rows[k] = rows[k] || { n: 0, esc: 0, tok: 0, ms: 0, m: 0 };
    g.n++; if (r.escalated) g.esc++;
    const p = post[r.id]; if (p && p.totalTokens) { g.tok += p.totalTokens; g.ms += p.totalDurationMs || 0; g.m++; }
  }
  const lines = ['class | model            calls  escalated  avg tokens  avg sec'];
  for (const [k, g] of Object.entries(rows).sort()) lines.push(`${k.padEnd(28)} ${String(g.n).padStart(4)}  ${String(Math.round(100 * g.esc / g.n) + '%').padStart(8)}  ${String(g.m ? Math.round(g.tok / g.m) : '-').padStart(10)}  ${String(g.m ? Math.round(g.ms / g.m / 1000) : '-').padStart(7)}`);
  lines.push('', 'current tiers (after learned promotion):');
  for (const [c, def] of Object.entries(R.classes)) { const s = classStats(log, c); const promoted = s.n >= R.promote.minSamples && s.esc / s.n >= R.promote.rate && tierIdx(def.tier) < 2; lines.push(`  ${c.padEnd(11)} ${def.tier}${promoted ? ` -> ${TIERS[tierIdx(def.tier) + 1]} (escalation ${s.esc}/${s.n})` : ''}`); }
  process.stdout.write(lines.join('\n') + '\n');
}

// ---------- main ----------
const [cmd, ...args] = process.argv.slice(2);
try {
  if (cmd === 'skill-register') skillRegister(args, process.cwd());
  else if (cmd === 'skill-status') process.stdout.write(JSON.stringify(pendingSkills(process.cwd()), null, 1) + '\n');
  else if (cmd === 'agent-report') agentReport();
  else if (cmd === 'handoff-path') process.stdout.write(handoffPath(args[0] || process.cwd()) + '\n');
  else {
    const inp = readStdin();
    ({ 'cbm-gate': cbmGate, 'cbm-mark': cbmMark, 'shell-gate': shellGate, compress, 'skill-watch': skillWatch,
       'session-start': sessionStart, precompact, 'prompt-mode': promptMode, 'agent-route': agentRoute, 'agent-log': agentLog }[cmd] || (() => {}))(inp);
  }
} catch (e) {
  try { mkdirp(STATE); fs.appendFileSync(path.join(STATE, 'errors.log'), `${new Date().toISOString()} ${cmd} ${e && e.stack}\n`); } catch {}
}
process.exitCode = 0;
