#!/usr/bin/env node
// claude-bloat - measure and control the always-on cost of the global Claude Code config.
//
// Measures the always-on payload (~/.claude/CLAUDE.md + everything it @-imports,
// recursively), plus context-cost signals (MCP servers, skills, on-demand refs).
// Writes a dated markdown report, compares against the last run, and fires a
// macOS notification only when something grew past a threshold.
//
// Reports counts and file names only. Never reads or prints env values or secrets.

import { readFile, writeFile, mkdir, readdir, symlink, unlink, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const HOME = homedir();
// fileURLToPath, not URL.pathname: the latter is percent-encoded, so a path with a
// space or a non-ASCII character silently breaks every path derived from it.
const HERE = dirname(fileURLToPath(import.meta.url));
const SELF = join(HERE, 'claude-bloat.mjs');
const REPORTS = join(HERE, 'reports');
const PROMPT = join(HERE, 'prompts', 'advise.md');
const STATE = join(HERE, '.bloat-state.json');
const LABEL = 'com.claude-bloat.check';
const PLIST = join(HOME, 'Library/LaunchAgents', `${LABEL}.plist`);
const BIN = join(HOME, '.local/bin/claude-bloat');

// Alert thresholds.
// MAX_LINES is the only number here that comes from Anthropic rather than from us:
// "Size: target under 200 lines per CLAUDE.md file. Longer files consume more context
// and reduce adherence." - https://code.claude.com/docs/en/memory
// The growth thresholds are this tool's own, chosen to catch drift early. Tune freely.
const GROWTH_WORDS = 300; // absolute growth in always-on words since last run
const GROWTH_PCT = 5; // percent growth since last run
const MAX_LINES = 200; // documented per-file target for CLAUDE.md and rule files
const SOFT_MAX_LINES = 500; // community figure (Boris Cherny), reported second, never alerted on

// There is NO documented budget for the always-on total - the only official size guidance
// is per file. Context window size is not a useful yardstick either: Fable 5, Sonnet 5,
// Opus 4.6+ support 1M, and Opus is auto-upgraded to 1M on Max/Team/Enterprise but NOT on
// Pro. https://code.claude.com/docs/en/model-config#extended-context
// So the argument for staying lean is adherence (documented: longer files get followed less
// reliably) and per-prompt cost, not running out of room. /context gives the live truth.
const MAX_IMPORT_DEPTH = 4; // documented: imports recurse a maximum of four hops

// CALIBRATED FROM A REAL `/context` RUN - not from docs examples or blog posts.
// Run `/context` in a Claude Code session and replace these with your own figures.
// The values below came from one setup on claude-opus-5:
//   System prompt 3.7k | System tools 11.4k | Custom agents 7.6k
//   Memory files 21.1k (CLAUDE.md 14.4k, dangerous-commands 4k, gotchas 2.7k)
//   Skills 9.9k
// Re-run `/context` and update these when Claude Code updates or your setup changes.
const CALIBRATED_ON = '2026-08-10';
const FIXED_SYSTEM_PROMPT = 3_700; // not tunable
const FIXED_SYSTEM_TOOLS = 11_400; // not tunable
// 7,600 tokens across the 107 agents present at calibration, so scale per agent rather
// than freezing the total - otherwise adding 50 agents would show as zero growth.
const AGENT_TOKENS_EACH = 7_600 / 107;
// The version calibrated against. When Claude Code updates, the fixed numbers may drift and
// the tool says so instead of quietly reporting stale figures.
const CALIBRATED_VERSION = '2.1.226';
// Word and byte counts under-read badly on dense markdown full of paths and backticks.
// Derived from the measurement above: 21,100 tokens / 57,045 bytes, 9,900 tokens / 5,224 words.
const TOKENS_PER_BYTE = 21_100 / 57_045;
const SKILL_TOKENS_PER_WORD = 1.9;

// Imports can be absolute, ~/-rooted, or relative to the file containing them, and the
// path does not have to end in .md (@README and @package.json are documented examples).
// Match loosely, then keep only what actually exists on disk.
const IMPORT_RE = /(?:^|\s)@([^\s`'"()[\],]+)/g;
const WORDS_PER_TOKEN = 0.75; // ~1.33 tokens per word

const HELP = `claude-bloat - keep the global Claude Code config lean

USAGE
  claude-bloat [command] [options]

COMMANDS
  check              Measure the config, write a report, notify on growth (default)
  show               Print the most recent report
  advise             Run a check, then open Claude with a prompt to research current
                     best practice and suggest concrete fixes for what the report found
  install            Install the weekly LaunchAgent (Mondays 09:00) and the CLI symlink
  uninstall          Remove the LaunchAgent (leaves reports and the symlink alone)
  status             Show whether the schedule is installed and when it last ran
  help               Show this help

OPTIONS
  --json             Print machine-readable measurements instead of markdown (check)
  --no-notify        Do not fire a macOS notification even if a threshold is crossed
  --quiet            Write the report but print nothing to stdout
  --print            advise: print the generated prompt instead of launching Claude
  -h, --help         Show this help

WHAT IT MEASURES
  Always-on payload   ~/.claude/CLAUDE.md, every file it @-imports, and every file in
                      ~/.claude/rules/ without \`paths:\` frontmatter. All of it loads
                      on every single prompt.
  Other context cost  MCP servers configured (names only), personal skills,
                      and on-demand refs in ~/.claude/refs.

WHEN IT ALERTS (edit the thresholds at the top of claude-bloat.mjs)
  The config gained ${GROWTH_WORDS}+ words or ${GROWTH_PCT}%+ since the last check, an
  always-on file passed ${MAX_LINES} lines (Anthropic's documented per-file target), an
  MCP server was added, or an @-imported file went missing.

FILES
  reports/<date>.md    dated report      reports/latest.md   most recent
  .bloat-state.json    previous run      prompts/advise.md   the advise prompt
`;

const expand = (p) => (p.startsWith('~/') ? join(HOME, p.slice(2)) : p);
const countWords = (s) => (s.trim() ? s.trim().split(/\s+/).length : 0);

// Claude Code skips imports inside code spans and fenced blocks, so we blank those out
// before looking for imports - otherwise a path shown as an example gets counted as loaded.
// Fences may be indented (inside a list item) and may never be closed, in which case
// everything after the opener is code. Walk line by line rather than regex the whole file.
function stripCode(text) {
  const out = [];
  let fence = null;
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(```+|~~~+)/);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
      continue; // inside a fence, closing line included
    }
    if (m) {
      fence = m[1];
      continue;
    }
    out.push(line.replace(/`[^`\n]*`/g, ''));
  }
  return out.join('\n');
}

async function walkImports(path, seen, out, depth = 0) {
  const real = expand(path);
  if (seen.has(real)) return;
  seen.add(real);
  let text;
  try {
    text = await readFile(real, 'utf8');
  } catch {
    out.push({ path: path.replace(HOME, '~'), words: 0, missing: true });
    return;
  }
  out.push({
    path: real.replace(HOME, '~'),
    words: countWords(text),
    bytes: Buffer.byteLength(text, 'utf8'),
    lines: text.split('\n').length,
  });
  if (depth >= MAX_IMPORT_DEPTH) return; // documented limit: deeper imports never load
  for (const m of stripCode(text).matchAll(IMPORT_RE)) {
    const raw = m[1];
    const target = raw.startsWith('~/') || isAbsolute(raw) ? expand(raw) : resolve(dirname(real), raw);
    // Loose matching means prose like @anthropic-ai or @refs can match. Only a real FILE
    // counts - a bare word resolving to a directory is not an import and must not be
    // reported as a broken one. A missing .md path IS worth reporting: the import is live
    // but the file is gone.
    let isFile = false;
    try {
      isFile = (await stat(target)).isFile();
    } catch {
      isFile = false;
    }
    if (isFile) await walkImports(target, seen, out, depth + 1);
    else if (!existsSync(target) && raw.endsWith('.md') && (raw.startsWith('~/') || isAbsolute(raw)))
      await walkImports(target, seen, out, depth + 1);
  }
}

// Everything in ~/.claude/rules/ loads every session on its own - no @-import needed -
// unless it has `paths:` frontmatter, which makes it load only for matching files.
// Measuring only the @-imports would miss a rule file dropped in there.
// https://code.claude.com/docs/en/memory
async function walkRules(dir, seen, out, conditional) {
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    // stat() follows symlinks; dirent.isDirectory() does not, and the docs document
    // symlinked rule directories as a supported way to share rules across projects.
    let st;
    try {
      st = await stat(p);
    } catch {
      continue; // broken symlink - skip it rather than killing the whole run
    }
    if (st.isDirectory()) {
      await walkRules(p, seen, out, conditional);
      continue;
    }
    if (!e.name.endsWith('.md') || seen.has(p)) continue;
    let text;
    try {
      text = await readFile(p, 'utf8');
    } catch {
      continue;
    }
    const fm = text.startsWith('---') ? text.slice(3).split('\n---')[0] : '';
    const entry = {
      path: p.replace(HOME, '~'),
      words: countWords(text),
      bytes: Buffer.byteLength(text, 'utf8'),
      lines: text.split('\n').length,
    };
    if (/^\s*paths\s*:/m.test(fm)) {
      conditional.push(entry);
    } else {
      seen.add(p);
      out.push(entry);
    }
  }
}

async function measureAlwaysOn() {
  const files = [];
  const conditional = [];
  const seen = new Set();
  // Managed policy CLAUDE.md loads before yours and cannot be excluded by any setting.
  // Usually absent on a personal machine, but it is the one input you cannot see or control.
  const MANAGED = '/Library/Application Support/ClaudeCode/CLAUDE.md';
  if (existsSync(MANAGED)) await walkImports(MANAGED, seen, files);
  await walkImports(join(HOME, '.claude/CLAUDE.md'), seen, files);
  await walkRules(join(HOME, '.claude/rules'), seen, files, conditional);
  const words = files.reduce((n, f) => n + f.words, 0);
  const bytes = files.reduce((n, f) => n + (f.bytes || 0), 0);
  return { files, conditional, words, bytes, tokens: Math.round(words / WORDS_PER_TOKEN) };
}

async function measureMcp() {
  // Names and counts only. Values are never read out of the config.
  try {
    const cfg = JSON.parse(await readFile(join(HOME, '.claude.json'), 'utf8'));
    const global = Object.keys(cfg.mcpServers || {});
    const perProject = {};
    for (const [p, def] of Object.entries(cfg.projects || {})) {
      const names = Object.keys(def?.mcpServers || {});
      if (names.length) perProject[p.replace(HOME, '~')] = names;
    }
    return { global, perProject };
  } catch {
    return { global: [], perProject: {}, unreadable: true };
  }
}

// Auto memory: "The first 200 lines of MEMORY.md, or the first 25KB, whichever comes
// first, are loaded at the start of every conversation. Content beyond that threshold is
// not loaded." - https://code.claude.com/docs/en/memory
// Only the current project's MEMORY.md loads in a given session, so this is not part of
// the always-on payload - but anything past the limit is silently dropped, which is worse
// than bloat: the memory is there and never reaches Claude.
const MEMORY_MAX_LINES = 200;
const MEMORY_MAX_BYTES = 25 * 1024;

async function measureMemory() {
  const root = join(HOME, '.claude/projects');
  const out = [];
  let dirs = [];
  try {
    dirs = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const p = join(root, d.name, 'memory/MEMORY.md');
    try {
      const raw = await readFile(p, 'utf8');
      // Claude Code strips YAML frontmatter and block-level HTML comments before applying
      // the limit, so measuring the raw file would raise false "content is dropped" alarms.
      const loaded = raw
        .replace(/^---\n[\s\S]*?\n---\n/, '')
        .replace(/^<!--[\s\S]*?-->\s*$/gm, '');
      out.push({
        project: d.name,
        lines: loaded.split('\n').length,
        bytes: Buffer.byteLength(loaded, 'utf8'),
      });
    } catch {
      /* project has no auto memory yet */
    }
  }
  return out.sort((a, b) => b.lines - a.lines);
}

// Skills are cheap while idle, but not free: the name and description of every skill are
// listed for the model so it knows what it can invoke. The bodies load only on use.
// Plugin skills share that same listing, so they are counted here too.
// Note this is an upper bound: Claude Code truncates each entry and drops the least-used
// descriptions once the listing exceeds ~1% of the context window.
// https://code.claude.com/docs/en/skills
async function collectSkills(root, out) {
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(root, e.name);
    let st;
    try {
      st = await stat(p); // follows symlinks; symlinked skill dirs are common
    } catch {
      continue;
    }
    const file = st.isDirectory() ? join(p, 'SKILL.md') : p;
    if (!file.endsWith('.md')) continue;
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    const fm = text.startsWith('---') ? text.slice(3).split('\n---')[0] : '';
    // A skill with disable-model-invocation is never listed for the model.
    if (/^\s*disable-model-invocation\s*:\s*true/m.test(fm)) continue;
    const meta = fm.match(/^(name|description)\s*:[\s\S]*?(?=\n\w+\s*:|$)/gm) || [];
    if (!meta.length) continue;
    out.count++;
    out.words += countWords(meta.join(' '));
  }
}

// The plugin cache keeps every version ever installed, and plugins can live under more
// than one root (~/.claude and ~/.claude-private). Walking the cache tree counts stale
// versions three times over and misses the other root entirely, so resolve the ONE active
// install path per plugin from the manifest instead.
async function activePluginPaths() {
  try {
    const manifest = JSON.parse(
      await readFile(join(HOME, '.claude/plugins/installed_plugins.json'), 'utf8')
    );
    const paths = new Set();
    for (const installs of Object.values(manifest.plugins || {}))
      for (const i of installs || []) if (i?.installPath) paths.add(i.installPath);
    return [...paths];
  } catch {
    return [];
  }
}

async function measureSkillIndex() {
  const personal = { words: 0, count: 0 };
  await collectSkills(join(HOME, '.claude/skills'), personal);

  const plugin = { words: 0, count: 0 };
  for (const p of await activePluginPaths()) await collectSkills(join(p, 'skills'), plugin);

  return {
    personal,
    plugin,
    count: personal.count + plugin.count,
    words: personal.words + plugin.words,
  };
}

// Subagents are NOT part of the always-on payload: the docs' context-cost table says they
// load "When spawned" and run isolated from the main session, unlike skill descriptions
// which load at start of every request. Counted for awareness only, never alerted on.
// https://code.claude.com/docs/en/features-overview#understand-context-costs
// The fixed startup numbers are calibrated per Claude Code version. If the version moved,
// say so rather than reporting stale figures as fact.
async function claudeVersion() {
  try {
    const { stdout } = await run('claude', ['--version']);
    return (stdout.match(/[\d.]+/) || ['unknown'])[0];
  } catch {
    return 'unknown';
  }
}

async function countAgents() {
  let personal = 0;
  let plugin = 0;
  const walk = async (dir, isPlugin) => {
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p, isPlugin);
      else if (e.name.endsWith('.md')) isPlugin ? plugin++ : personal++;
    }
  };
  await walk(join(HOME, '.claude/agents'), false);
  for (const p of await activePluginPaths()) await walk(join(p, 'agents'), true);
  return { personal, plugin, total: personal + plugin };
}

async function countDir(path) {
  try {
    return (await readdir(path)).filter((f) => !f.startsWith('.')).length;
  } catch {
    return 0;
  }
}

const kb = (bytes) => `${(bytes / 1024).toFixed(1)}KB`;

function fmtDelta(now, before) {
  if (before === undefined || before === null) return 'new';
  const d = now - before;
  if (d === 0) return 'no change';
  return `${d > 0 ? '+' : ''}${d}`;
}

// On a Mac with Hanna's ops shared library (`paths get ops`), alerts go through its one notifier
// (Slack #system, new and fixed only) and the schedule comes from its jobs register; anywhere
// else this tool keeps its own dialog and LaunchAgent.
async function opsDir() {
  try {
    const { stdout } = await run('paths', ['get', 'ops']);
    const d = stdout.trim();
    return d && existsSync(join(d, 'lib', 'notify.py')) ? d : null;
  } catch {
    return null;
  }
}

async function opsNotify(ops, lines) {
  await new Promise((done) => {
    const p = spawn('python3', ['-m', 'lib.notify', 'Claude config bloat'], { cwd: ops, stdio: ['pipe', 'ignore', 'ignore'] });
    p.on('close', done).on('error', done);
    p.stdin.end(lines.join('\n'));
  });
}

// terminal-notifier has its own bundle identity, so it shows up in System Settings >
// Notifications and can be granted permission. osascript banners are delivered as
// "Script Editor" and stay silent if that app has no permission - keep it only as a fallback.
const NOTIFIER = ['/opt/homebrew/bin/terminal-notifier', '/usr/local/bin/terminal-notifier'].find(
  (p) => existsSync(p)
);

// A dialog window, not a notification banner: Focus modes suppress banners, and a
// weekly check you never see is worthless. The dialog gives up on its own after
// 10 minutes so a background run can never hang forever.
async function notify(title, body, openPath) {
  const esc = (s) => s.replace(/[\\"]/g, (m) => `\\${m}`);
  const buttons = openPath ? '{"Dismiss", "Open report"}' : '{"OK"}';
  const dflt = openPath ? '"Open report"' : '"OK"';
  const script =
    `tell application "System Events" to display dialog "${esc(body)}" ` +
    `with title "${esc(title)}" buttons ${buttons} default button ${dflt} ` +
    `with icon caution giving up after 600`;
  try {
    const { stdout } = await run('osascript', ['-e', script]);
    if (openPath && stdout.includes('Open report')) await run('open', [openPath]);
    return;
  } catch {
    /* fall through to a banner */
  }
  if (NOTIFIER) {
    const args = ['-title', title, '-message', body, '-group', 'claude-bloat'];
    if (openPath) args.push('-open', `file://${openPath}`);
    try {
      await run(NOTIFIER, args);
    } catch {
      /* notification is best-effort */
    }
  }
}

// Bump when the MEANING of a stored field changes, so a stale state file cannot produce a
// fabricated delta. v2: mcpCount went from "every server in every project" to "global only".
const STATE_SCHEMA = 2;

async function readState() {
  if (!existsSync(STATE)) return null;
  try {
    const s = JSON.parse(await readFile(STATE, 'utf8'));
    // Treat an older schema as "no previous run" rather than comparing incomparable numbers.
    return s?.schema === STATE_SCHEMA ? s : null;
  } catch {
    return null;
  }
}

async function measure() {
  const alwaysOn = await measureAlwaysOn();
  const mcp = await measureMcp();
  const skills = await countDir(join(HOME, '.claude/skills'));
  const refs = await countDir(join(HOME, '.claude/refs'));
  // Only the global servers plus the current project's load in any one session, so the
  // number that matters is the global count - not the sum across every project ever opened.
  const mcpCount = mcp.global.length;
  const mcpProjectCount = Object.values(mcp.perProject).flat().length;
  const memory = await measureMemory();
  const skillIndex = await measureSkillIndex();
  const agents = await countAgents();
  const version = await claudeVersion();
  const prev = await readState();

  const growth = prev ? alwaysOn.words - prev.words : 0;
  const growthPct = prev && prev.words ? (growth / prev.words) * 100 : 0;

  // Name the number, where it came from, and what it costs - "+910 words" on its own
  // tells you nothing when you read it a week later.
  const grew = (prev?.files || [])
    .map((o) => {
      const now = alwaysOn.files.find((f) => f.path === o.path);
      return now ? { path: o.path, delta: now.words - o.words } : null;
    })
    .filter((f) => f && f.delta > 0)
    .sort((a, b) => b.delta - a.delta);
  const newFiles = alwaysOn.files.filter(
    (f) => prev && !(prev.files || []).some((o) => o.path === f.path)
  );

  // Alerts are written as plain-English paragraphs. Numbers only mean something with
  // the sentence around them, and a list of fragments is harder to read than prose.
  const alerts = [];
  if (prev && (growth >= GROWTH_WORDS || growthPct >= GROWTH_PCT)) {
    const where = newFiles.length
      ? `${newFiles.map((f) => f.path).join(' and ')} is new and now loads on every prompt.`
      : grew.length
        ? `Most of the growth came from ${grew[0].path} (+${grew[0].delta} words).`
        : 'The growth is spread across the imported files, with no single culprit.';
    alerts.push(
      `Grew by ${growth} words (${growthPct.toFixed(1)}%) since the last check, now ` +
        `${alwaysOn.words} words / ~${alwaysOn.tokens} tokens on every prompt. ${where}`
    );
  }
  for (const f of alwaysOn.files.filter((f) => (f.lines || 0) > MAX_LINES))
    alerts.push(
      `${f.path} is ${f.lines} lines. Anthropic's target is under ${MAX_LINES} per file ` +
        `(Cherny: ${SOFT_MAX_LINES}) - past that, rules get followed less reliably. Move ` +
        `situational parts to on-demand refs; delete nothing.`
    );
  if (prev && mcpCount > prev.mcpCount)
    alerts.push(
      `Global MCP servers went ${prev.mcpCount} to ${mcpCount}. Tool names load on every ` +
        `prompt (full schemas stay deferred by default) - drop the ones you never use.`
    );
  for (const f of alwaysOn.files.filter((f) => f.missing))
    alerts.push(
      `${f.path} is imported by CLAUDE.md but missing, so its rules reach Claude not at all. ` +
        `Restore it, or remove the import line.`
    );

  for (const m of memory.filter((m) => m.lines > MEMORY_MAX_LINES || m.bytes > MEMORY_MAX_BYTES))
    alerts.push(
      `Auto memory for ${m.project} is ${m.lines} lines / ${kb(m.bytes)}. Only the first ` +
        `${MEMORY_MAX_LINES} lines or ${MEMORY_MAX_BYTES / 1024}KB load - the rest is silently ` +
        `dropped. Move detail into topic files.`
    );

  if (version !== 'unknown' && version !== CALIBRATED_VERSION)
    alerts.push(
      `Claude Code is now ${version}, but the fixed startup numbers here were calibrated on ` +
        `${CALIBRATED_VERSION} (${CALIBRATED_ON}). Run /context in a session and update the ` +
        `constants at the top of claude-bloat.mjs so the totals stay honest.`
    );

  return {
    alwaysOn,
    version,
    mcp,
    mcpCount,
    mcpProjectCount,
    skills,
    refs,
    memory,
    skillIndex,
    agents,
    prev,
    alerts,
  };
}

// Shared by the report and the popup so the two can never disagree.
const n = (x) => x.toLocaleString('en-US');

// "no change" reads wrong with a unit appended ("no change words"), so only label a real delta.
const withUnit = (now, before, unit) => {
  if (before === undefined || before === null) return 'first check';
  const d = fmtDelta(now, before);
  return d === 'no change' ? 'no change' : `${d} ${unit}`;
};

function startupBreakdown(m) {
  const { alwaysOn, skillIndex, agents, prev } = m;
  const configTokens = Math.round(alwaysOn.bytes * TOKENS_PER_BYTE);
  const skillTokens = Math.round(skillIndex.words * SKILL_TOKENS_PER_WORD);
  const fixed = FIXED_SYSTEM_PROMPT + FIXED_SYSTEM_TOOLS;
  const agentTokens = Math.round(agents.total * AGENT_TOKENS_EACH);
  const yours = configTokens + skillTokens + agentTokens;
  return {
    yours,
    configTokens,
    skillTokens,
    agentTokens,
    fixed,
    startup: fixed + yours,
    rows: [
      {
        yours: true,
        label: 'Your CLAUDE.md + rules',
        tokens: configTokens,
        detail: `${n(alwaysOn.words)} words across ${alwaysOn.files.length} files`,
        change: withUnit(alwaysOn.words, prev?.words, 'words'),
      },
      {
        yours: true,
        label: 'Skill descriptions',
        tokens: skillTokens,
        detail: `${skillIndex.count} skills listed (${skillIndex.personal.count} yours, ${skillIndex.plugin.count} from plugins)`,
        change: withUnit(skillIndex.count, prev?.skills, 'skills'),
      },
      {
        yours: true,
        label: 'Subagent descriptions',
        tokens: Math.round(agents.total * AGENT_TOKENS_EACH),
        detail: `${agents.total} agents (${agents.personal} yours, ${agents.plugin} from plugins)`,
        change: withUnit(agents.total, prev?.agents, 'agents'),
      },
      {
        yours: false,
        label: 'Claude Code system tools',
        tokens: FIXED_SYSTEM_TOOLS,
        detail: 'built-in tool definitions',
        change: 'fixed',
      },
      {
        yours: false,
        label: 'Claude Code system prompt',
        tokens: FIXED_SYSTEM_PROMPT,
        detail: 'core instructions',
        change: 'fixed',
      },
    ],
  };
}

function buildReport(m, date) {
  const { alwaysOn, mcp, mcpCount, mcpProjectCount, refs, memory, skillIndex, agents, prev, alerts } =
    m;
  const prevByPath = Object.fromEntries((prev?.files || []).map((f) => [f.path, f.words]));
  const L = [];

  const memOver = memory.filter((mm) => mm.lines > MEMORY_MAX_LINES || mm.bytes > MEMORY_MAX_BYTES);

  const { yours, startup, fixed, rows } = startupBreakdown(m);

  L.push(`# Claude config check - ${date}`);
  L.push('');
  L.push(`**Startup context: ~${n(startup)} tokens before you type anything.**`);
  L.push(`**~${n(yours)} of that is yours to change; ~${n(fixed)} is Claude Code itself.**`);
  L.push('');
  L.push('| Part of startup | Tokens | What it is | Change |');
  L.push('| --- | ---: | :--- | :--- |');
  for (const r of rows)
    L.push(`| ${r.yours ? '**' + r.label + '**' : r.label} | ${n(r.tokens)} | ${r.detail} | ${r.change} |`);
  L.push('');
  L.push(
    `Calibrated against your own \`/context\` output from ${CALIBRATED_ON}. Re-run \`/context\` ` +
      `after a Claude Code update and adjust the constants at the top of claude-bloat.mjs if they drift.`
  );
  L.push('');

  if (alerts.length) {
    for (const a of alerts) L.push(`- ${a}`);
  } else {
    L.push('- Nothing over a threshold. Nothing to do.');
  }
  L.push('');

  L.push('## Loads on every prompt');
  L.push('');
  L.push('| File | Lines | Words | Change |');
  L.push('| --- | ---: | ---: | ---: |');
  for (const f of [...alwaysOn.files].sort((a, b) => b.words - a.words)) {
    const flag = f.missing ? ' (MISSING)' : (f.lines || 0) > MAX_LINES ? ' (long)' : '';
    L.push(
      `| ${f.path}${flag} | ${f.lines || 0} | ${f.words} | ${fmtDelta(f.words, prevByPath[f.path])} |`
    );
  }
  L.push('');
  L.push(
    `CLAUDE.md, its \`@\`-imports, and \`~/.claude/rules/\` (which loads with no import). ` +
      `Target is under ${MAX_LINES} lines per file.`
  );
  L.push('');

  L.push('## Also in context');
  L.push('');
  L.push(
    `- **${mcpCount} global MCP servers** (${fmtDelta(mcpCount, prev?.mcpCount)}) - tool *names* load every prompt, schemas stay deferred by default`
  );
  if (mcp.global.length) L.push(`  - ${mcp.global.join(', ')}`);
  if (mcpProjectCount)
    L.push(`  - plus ${mcpProjectCount} project-scoped, only in their own project`);
  L.push(
    `- **${skillIndex.count} skills listed** (${skillIndex.personal.count} personal, ${skillIndex.plugin.count} from plugins) - names and descriptions only, ~${Math.round(skillIndex.words / WORDS_PER_TOKEN)} tokens at most`
  );
  L.push(
    `- **${agents.total} subagents** (${agents.personal} personal, ${agents.plugin} from plugins) - not startup cost, they load only when spawned`
  );
  L.push(
    `- **${refs} on-demand refs** (${fmtDelta(refs, prev?.refs)}) - load only when a task needs them, the good kind`
  );
  L.push(
    `- **Auto memory**: ${memory.length} projects, biggest ${memory[0]?.lines || 0} lines. ` +
      (memOver.length
        ? `${memOver.length} over the ${MEMORY_MAX_LINES}-line limit - content is being dropped.`
        : `All within the ${MEMORY_MAX_LINES}-line limit.`)
  );
  L.push('');
  L.push(
    `Run \`claude-bloat advise\` for specific suggestions, or \`/context\` in a session for live figures.`
  );
  L.push('');
  return L.join('\n');
}

async function cmdCheck(opts) {
  const m = await measure();
  const date = new Date().toISOString().slice(0, 10);
  const report = buildReport(m, date);

  await mkdir(REPORTS, { recursive: true });
  await writeFile(join(REPORTS, `${date}.md`), report);
  await writeFile(join(REPORTS, 'latest.md'), report);
  await writeFile(
    STATE,
    JSON.stringify(
      {
        schema: STATE_SCHEMA,
        date,
        words: m.alwaysOn.words,
        files: m.alwaysOn.files,
        mcpCount: m.mcpCount,
        skills: m.skillIndex.count,
        agents: m.agents.total,
        version: m.version,
        refs: m.refs,
      },
      null,
      2
    )
  );

  const ops = opts.noNotify ? null : await opsDir();
  if (ops) await opsNotify(ops, m.alerts);  // an empty list tells it any earlier alert is fixed
  else if (m.alerts.length && !opts.noNotify) {
    // Always lead with the headline numbers and where they come from, then the alerts.
    const b = startupBreakdown(m);
    const head = [
      `Startup context: ~${n(b.startup)} tokens before you type anything.`,
      `~${n(b.yours)} yours to change, ~${n(b.fixed)} Claude Code itself.`,
      '',
      ...b.rows.map((r) => `${n(r.tokens).padStart(6)}  ${r.label} (${r.change})`),
      '',
      `Calibrated against your own /context from ${CALIBRATED_ON}.`,
    ].join('\n');
    const body = [head, ...m.alerts].join('\n\n');
    await notify(
      'Claude config bloat',
      `${body}\n\nOpen the report for the full breakdown and what to do about it.`,
      join(REPORTS, 'latest.md')
    );
  }

  if (opts.quiet) return m;
  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          date,
          words: m.alwaysOn.words,
          tokens: m.alwaysOn.tokens,
          files: m.alwaysOn.files,
          mcp: m.mcp,
          mcpCount: m.mcpCount,
          skills: m.skills,
          refs: m.refs,
          alerts: m.alerts,
        },
        null,
        2
      )
    );
  } else {
    console.log(report);
    if (m.alerts.length) console.log(`report: ${join(REPORTS, 'latest.md')}`);
  }
  return m;
}

async function cmdShow() {
  const p = join(REPORTS, 'latest.md');
  if (!existsSync(p)) {
    console.log('No report yet. Run: claude-bloat check');
    return;
  }
  console.log(await readFile(p, 'utf8'));
}

async function cmdAdvise(opts) {
  await cmdCheck({ ...opts, quiet: true });
  const template = await readFile(PROMPT, 'utf8');
  const report = await readFile(join(REPORTS, 'latest.md'), 'utf8');
  const prompt = template
    .replaceAll('{{REPORT_PATH}}', () => join(REPORTS, 'latest.md'))
    .replaceAll('{{REPORT}}', () => report);

  if (opts.print) {
    console.log(prompt);
    return;
  }
  console.log('Opening Claude with the advise prompt...\n');
  const child = spawn('claude', [prompt], { stdio: 'inherit' });
  child.on('error', (e) => {
    console.error(`Could not launch claude: ${e.message}`);
    console.error('Run `claude-bloat advise --print` and paste the prompt manually.');
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}

async function cmdInstall() {
  if (await opsDir()) {
    // Her scheduled jobs are made from one register (ops jobs/launchd.py, entry claude-config-bloat).
    console.log('Schedule: Mondays 09:00, from ops jobs/launchd.py (entry claude-config-bloat); no LaunchAgent written here.');
    if (!existsSync(BIN)) {
      await mkdir(dirname(BIN), { recursive: true });
      await symlink(SELF, BIN);
      console.log(`Linked CLI: ${BIN} -> ${SELF}`);
    }
    return;
  }
  // process.execPath resolves to a versioned Cellar path that breaks on the next
  // node upgrade. Prefer a stable symlink if one exists.
  const stableNode = ['/opt/homebrew/bin/node', '/usr/local/bin/node'].find((p) => existsSync(p));
  const nodeBin = stableNode || process.execPath;
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodeBin}</string>
        <string>${SELF}</string>
        <string>check</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Weekday</key><integer>1</integer>
        <key>Hour</key><integer>9</integer>
        <key>Minute</key><integer>0</integer>
    </dict>
    <key>RunAtLoad</key>
    <false/>
    <key>StandardOutPath</key>
    <string>${join(REPORTS, 'launchd.out.log')}</string>
    <key>StandardErrorPath</key>
    <string>${join(REPORTS, 'launchd.err.log')}</string>
</dict>
</plist>
`;
  await mkdir(REPORTS, { recursive: true });
  await writeFile(PLIST, plist);
  const uid = process.getuid();
  await run('launchctl', ['bootout', `gui/${uid}/${LABEL}`]).catch(() => {});
  await run('launchctl', ['bootstrap', `gui/${uid}`, PLIST]);
  console.log(`Installed weekly schedule (Mondays 09:00): ${PLIST}`);

  if (!existsSync(BIN)) {
    await mkdir(dirname(BIN), { recursive: true });
    await symlink(SELF, BIN);
    console.log(`Linked CLI: ${BIN} -> ${SELF}`);
  }
}

async function cmdUninstall() {
  const uid = process.getuid();
  await run('launchctl', ['bootout', `gui/${uid}/${LABEL}`]).catch(() => {});
  if (existsSync(PLIST)) await unlink(PLIST);
  console.log('Schedule removed. Reports, state, and the CLI symlink were left in place.');
}

async function cmdStatus() {
  const uid = process.getuid();
  let loaded = false;
  try {
    await run('launchctl', ['print', `gui/${uid}/${LABEL}`]);
    loaded = true;
  } catch {
    loaded = false;
  }
  const prev = await readState();
  console.log(`Schedule: ${loaded ? 'installed (Mondays 09:00)' : 'not installed'}`);
  console.log(`CLI symlink: ${existsSync(BIN) ? BIN : 'not linked'}`);
  console.log(
    prev
      ? `Last run: ${prev.date} - ${prev.words} always-on words, ${prev.mcpCount} MCP servers`
      : 'Last run: never'
  );
}

const argv = process.argv.slice(2);
const opts = {
  json: argv.includes('--json'),
  noNotify: argv.includes('--no-notify'),
  quiet: argv.includes('--quiet'),
  print: argv.includes('--print'),
};
const cmd = argv.find((a) => !a.startsWith('-')) || 'check';

if (argv.includes('-h') || argv.includes('--help') || cmd === 'help') {
  console.log(HELP);
} else if (cmd === 'check') await cmdCheck(opts);
else if (cmd === 'show') await cmdShow();
else if (cmd === 'advise') await cmdAdvise(opts);
else if (cmd === 'install') await cmdInstall();
else if (cmd === 'uninstall') await cmdUninstall();
else if (cmd === 'status') await cmdStatus();
else {
  console.error(`Unknown command: ${cmd}\n`);
  console.log(HELP);
  process.exit(1);
}
