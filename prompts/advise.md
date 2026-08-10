You are advising on how to keep my global Claude Code configuration lean. Read this whole prompt before doing anything.

## The measurement

A local utility (`claude-bloat`) just measured what loads on every message. The full report is at {{REPORT_PATH}} and inlined below.

---
{{REPORT}}
---

## What I want from you

Concrete, specific suggestions grounded in (a) what is actually in my config right now and (b) current documented best practice. Not generic advice.

## Step 1 - research current best practice FIRST, do not answer from memory

Claude Code's configuration surfaces change often. Before suggesting anything, look up the current official documentation (docs.claude.com / code.claude.com, plus the Claude Code changelog) and confirm how each of these works TODAY, and what each one costs in context on every message versus on demand:

- `CLAUDE.md` memory files: user-global vs project vs directory-scoped, and the `@`-import mechanism (is an import loaded in full, always?).
- Two things already confirmed against https://code.claude.com/docs/en/memory on 2026-08-10 - re-verify only if the docs have moved on: files in `~/.claude/rules/` load every session WITHOUT an `@`-import unless they carry `paths:` frontmatter, and the documented size guidance for CLAUDE.md is "target under 200 lines per file" with no hard cap (the 200-line/25KB limit that appears elsewhere in the docs applies to auto-memory `MEMORY.md`, not CLAUDE.md).
- Path-scoped rules via `paths:` frontmatter, and when a rule file loads conditionally rather than always.
- Skills: when a skill's full body loads versus just its name and description. How many skills is too many, and what does each one cost while idle?
- MCP servers: tool definitions loading on every message, and any current mechanism for deferred or on-demand tool schemas.
- Hooks and settings.json: what belongs in a hook rather than in prose instructions in CLAUDE.md. Behaviour I want enforced deterministically ("always do X before Y") is often better as a hook than as a rule I am asking a model to remember.
- Plugins and marketplaces: what they add to context.
- Output styles, subagents, and any other surface that consumes context.

Cite your sources with URLs. If the docs are ambiguous on a point, say so plainly rather than guessing - I would rather have "the docs do not state this" than a confident wrong answer.

## Step 2 - analyse my actual setup

Read the files the report names, at minimum `~/.claude/CLAUDE.md` and everything it `@`-imports. Then tell me, specifically:

1. Which content in the always-on payload does NOT need to be always-on, and where each piece should live instead (on-demand ref file with a trigger line, a skill, a hook, a project-scoped CLAUDE.md, or deleted as redundant).
2. Which rules are duplicated - stated inline AND in an imported file - so one copy can go.
3. Which rules are really deterministic behaviour that a hook in settings.json would enforce better than prose.
4. Anything the report counts that is dead weight: skills I never trigger, MCP servers configured for projects I no longer touch, refs with weak or missing triggers.
5. An estimate of the words and tokens each suggestion would save.

Rank suggestions by tokens saved per unit of risk. Put the safe, high-value ones first.

## Hard constraints

- **Never delete, weaken, reword, or drop the substance of any rule.** Moving a rule so it loads on demand instead of always is fine. Losing it is not. If you think a rule is genuinely redundant, propose removing it and explain why - do not act on it.
- **Safety-critical rules stay always-on.** Anything covering secrets and credentials, dangerous commands, data or client isolation, database and deployment safety, or destructive actions is never a candidate for on-demand loading, no matter how large the file gets.
- **Every rule that moves to on-demand needs a one-line pointer in CLAUDE.md with a crisp trigger.** A moved rule with no clear trigger is a rule that silently stops firing. The triggers are the whole safety mechanism.
- **Do not edit anything yet.** Present the analysis and the ranked suggestions, then WAIT for my approval on the split. If I approve, back up `~/.claude/CLAUDE.md`, `~/.claude/rules/` and `~/.claude/refs/` into a dated backup folder before the first edit, and make every change reversible from that backup.
- **Never print the value of any secret, token, or env var.** Names and file paths only. Do not run `claude mcp list`, `cat ~/.claude.json`, `env`, or anything else on my dangerous-commands list.
- Touch only the global `~/.claude/` setup. Do not touch any project-scoped CLAUDE.md.

## After any approved change

Re-run `claude-bloat check` and show me the before/after always-on word count.
