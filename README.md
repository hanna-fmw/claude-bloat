# claude-bloat

Measures what Claude Code loads into context before you type anything, tracks it week over
week, and tells you when it grows.

Your global `CLAUDE.md`, the files it `@`-imports, everything in `~/.claude/rules/`, and every
skill and subagent description are re-sent on every prompt, in every project, whether or not
they are relevant. There is no warning when that grows, and no documented budget for the
total. This tool measures it and puts a number on it.

```
Startup context: ~53,726 tokens before you type anything.
~38,626 yours to change, ~15,100 Claude Code itself.

21,100  Your CLAUDE.md + rules (no change)
 9,926  Skill descriptions (+3 skills)
 7,600  Subagent descriptions (no change)
11,400  Claude Code system tools (fixed)
 3,700  Claude Code system prompt (fixed)
```

## Install

Requires Node 18+ and macOS for the scheduled check (the CLI itself works anywhere).

```sh
git clone https://github.com/hanna-fmw/claude-bloat.git
cd claude-bloat
node claude-bloat.mjs install
```

`install` adds a weekly LaunchAgent (Mondays 09:00) and symlinks the CLI into `~/.local/bin`.
Nothing runs in the background otherwise, and nothing is ever edited in your config.

## Calibrate it (worth the two minutes)

Token counts estimated from word counts read about 40% low on dense markdown. So the tool is
calibrated against a real measurement instead:

1. Run `/context` in any Claude Code session.
2. Copy the figures for **System prompt**, **System tools**, **Custom agents**, **Memory
   files** and **Skills** into the constants at the top of `claude-bloat.mjs`.

The shipped values came from one setup on `claude-opus-5`. When Claude Code updates, the tool
notices the version changed and reminds you to re-run `/context` rather than quietly reporting
stale numbers.

## Commands

```
claude-bloat            measure, write a report, pop a dialog if something crossed a threshold
claude-bloat show       print the latest report
claude-bloat advise     measure, then open Claude with a prompt to research current best
                        practice, read your files, and propose what to move
claude-bloat install    weekly schedule + CLI symlink
claude-bloat uninstall  remove the schedule
claude-bloat status     is it installed, when did it last run
claude-bloat help       full help
```

Options: `--json`, `--no-notify`, `--quiet`, `--print`.

## When it alerts

- The config gained 300+ words or 5%+ since the last check
- An always-on file passed 200 lines — [Anthropic's documented per-file target](https://code.claude.com/docs/en/memory)
- An `@`-imported file went missing, so its rules silently stopped loading
- A `MEMORY.md` passed the 200-line / 25KB load limit, so part of it is being dropped
- A global MCP server was added
- Claude Code updated, so the calibration may be stale

It uses a dialog rather than a notification banner because Focus modes suppress banners, and a
weekly check you never see is worthless. The dialog gives up after 10 minutes so a background
run cannot hang.

## What it does not do

It never edits your configuration. `advise` hands the findings to Claude with instructions to
propose changes and wait for approval, and to move rules to on-demand files rather than delete
them — moving a rule is safe, deleting one is not.

It reads `~/.claude.json` for MCP server **names** only. No env var, token or credential value
is ever read, stored or printed.

## Notes on the numbers

- The only officially documented size guidance is **under 200 lines per CLAUDE.md file**.
  There is no documented budget for the total. Boris Cherny has been quoted with a looser 500
  lines; that is shown as a second opinion, never used as a threshold.
- Files in `~/.claude/rules/` load every session without an `@`-import unless they carry
  `paths:` frontmatter. Those are listed separately as conditional.
- `@`-imports load in full, recursing a maximum of four hops, and are skipped inside code
  fences. All three are honoured here.
- Subagent descriptions do load at startup, measured at ~71 tokens each.

## Licence

MIT
