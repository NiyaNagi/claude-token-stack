#!/usr/bin/env node
// Non-destructive merge of settings.template.json into ~/.claude/settings.json.
// - env: adds missing keys; never overwrites a value you already set (use --force-env to overwrite)
// - enabledPlugins / extraKnownMarketplaces: adds missing entries
// - hooks: adds a template hook group unless a hook with the same tokenstack subcommand already exists for that event
// Usage: node merge-settings.js <template> <settings.json> [--git-bash <path>] [--force-env] [--dry-run]
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const [tplPath, outPath, ...rest] = process.argv.slice(2);
const flag = f => rest.includes(f);
const opt = f => { const i = rest.indexOf(f); return i >= 0 ? rest[i + 1] : null; };
const home = os.homedir().replace(/\\/g, '/');
const gitBash = (opt('--git-bash') || '').replace(/\\/g, '\\\\');
const readJson = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); } catch { return {}; } };

const tplRaw = fs.readFileSync(tplPath, 'utf8').replace(/\{\{HOME\}\}/g, home).replace(/\{\{GIT_BASH\}\}/g, gitBash);
const tpl = JSON.parse(tplRaw);
if (!gitBash) delete tpl.env.CLAUDE_CODE_GIT_BASH_PATH;
const cur = readJson(outPath);
const log = [];

cur.env = cur.env || {};
for (const [k, v] of Object.entries(tpl.env || {})) {
  if (!(k in cur.env)) { cur.env[k] = v; log.push(`env +${k}=${v}`); }
  else if (cur.env[k] !== v) { if (flag('--force-env')) { log.push(`env ~${k}: ${cur.env[k]} -> ${v}`); cur.env[k] = v; } else log.push(`env =${k} kept your value (${cur.env[k]}); template suggests ${v}`); }
}
// Top-level model keys: only set when absent (your model choice always wins).
for (const k of ['model', 'effortLevel', 'advisorModel']) if (k in tpl && !(k in cur)) { cur[k] = tpl[k]; log.push(`+${k}=${tpl[k]}`); }
for (const key of ['enabledPlugins', 'extraKnownMarketplaces']) {
  cur[key] = cur[key] || {};
  for (const [k, v] of Object.entries(tpl[key] || {})) if (!(k in cur[key])) { cur[key][k] = v; log.push(`${key} +${k}`); }
}
cur.hooks = cur.hooks || {};
const sub = c => (String(c).match(/tokenstack\/ts\.js"?\s+([\w-]+)/) || [])[1];
for (const [event, groups] of Object.entries(tpl.hooks || {})) {
  cur.hooks[event] = cur.hooks[event] || [];
  const have = new Set(cur.hooks[event].flatMap(g => (g.hooks || []).map(h => sub(h.command))).filter(Boolean));
  for (const g of groups) {
    const s = sub(g.hooks[0].command);
    if (have.has(s)) { log.push(`hooks.${event} =${s} already present`); continue; }
    cur.hooks[event].push(g); log.push(`hooks.${event} +${s}${g.matcher ? ` [${g.matcher}]` : ''}`);
  }
}
console.log(log.join('\n'));
if (!flag('--dry-run')) { fs.mkdirSync(path.dirname(outPath), { recursive: true }); fs.writeFileSync(outPath, JSON.stringify(cur, null, 2) + '\n'); console.log(`wrote ${outPath}`); }
