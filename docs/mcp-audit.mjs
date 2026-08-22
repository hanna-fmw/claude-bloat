#!/usr/bin/env node
// Local MCP supply-chain audit. Reads ~/.claude.json on your machine and prints
// ONLY a safe report: scope, server name, launcher, package, and pinned status.
// It never prints env vars, and redacts any token-shaped argument.

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const raw = await readFile(join(homedir(), '.claude.json'), 'utf8');
const cfg = JSON.parse(raw);

const TOKENISH = /(sbp_|sk-|ghp_|gho_|github_pat_|xox[baprs]-|AKIA|Bearer\s|eyJ[\w-]{10,}|[A-Fa-f0-9]{32,}|[A-Za-z0-9_-]{40,})/;
const RUNNERS = new Set(['npx', 'pnpm', 'pnpx', 'bunx', 'yarn', 'uvx', 'pipx', 'uv']);

function pickPackage(command, args = []) {
  const cmd = (command || '').split('/').pop();
  // Docker image
  if (cmd === 'docker') {
    const img = args.find((a) => !a.startsWith('-') && a !== 'run' && !TOKENISH.test(a));
    return { launcher: 'docker', pkg: img || '(unknown image)' };
  }
  // npx/uvx/etc: first non-flag arg after the runner (skip -y, dlx, exec, run)
  if (RUNNERS.has(cmd)) {
    const skip = new Set(['-y', '--yes', 'dlx', 'exec', 'run', '-p', '--package']);
    for (const a of args) {
      if (skip.has(a) || a.startsWith('-')) continue;
      if (TOKENISH.test(a)) return { launcher: cmd, pkg: '[redacted-token-shaped]' };
      return { launcher: cmd, pkg: a };
    }
    return { launcher: cmd, pkg: '(none)' };
  }
  // node/python/local script or absolute binary → local, not a registry package
  if (cmd === 'node' || cmd === 'python' || cmd === 'python3' || (command || '').startsWith('/') || (command || '').startsWith('.')) {
    return { launcher: cmd || command, pkg: '(local script/binary)' };
  }
  return { launcher: cmd || command || '(unknown)', pkg: '(unclassified)' };
}

function isPinned(launcher, pkg) {
  if (!pkg || pkg.startsWith('(') || pkg.startsWith('[')) return null; // n/a
  if (launcher === 'docker') return /:(?!latest\b)[\w.-]+$/.test(pkg);
  if (['uvx', 'pipx', 'uv'].includes(launcher)) return /(==|@)/.test(pkg);
  // npm: scoped "@scope/name@1.2.3" has a version after the final @; unscoped "name@1.2.3"
  const at = pkg.lastIndexOf('@');
  return at > 0 && /^[\dv]/.test(pkg.slice(at + 1));
}

function collect(scope, servers) {
  const rows = [];
  for (const [name, def] of Object.entries(servers || {})) {
    if (!def || typeof def !== 'object') continue;
    const { launcher, pkg } = pickPackage(def.command, def.args);
    rows.push({ scope, name, launcher, pkg, pinned: isPinned(launcher, pkg) });
  }
  return rows;
}

let rows = [];
rows = rows.concat(collect('global', cfg.mcpServers));
for (const [path, pdef] of Object.entries(cfg.projects || {})) {
  if (pdef && pdef.mcpServers && Object.keys(pdef.mcpServers).length) {
    const short = path.replace(homedir(), '~');
    rows = rows.concat(collect(short, pdef.mcpServers));
  }
}

if (!rows.length) {
  console.log('No MCP servers found.');
  process.exit(0);
}

const mark = (p) => (p === null ? '  n/a  ' : p ? ' PINNED' : ' UNPINNED');
console.log('\nMCP supply-chain audit (no secrets shown)\n');
for (const r of rows) {
  console.log(`${mark(r.pinned)}  ${r.launcher.padEnd(8)}  ${r.pkg}`);
  console.log(`           scope: ${r.scope}  server: ${r.name}\n`);
}
const risky = rows.filter((r) => r.pinned === false);
console.log(`--- ${risky.length} unpinned registry package(s) to consider pinning ---`);
for (const r of risky) console.log(`  ${r.name}  (${r.pkg})  in ${r.scope}`);
