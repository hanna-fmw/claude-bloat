# Task: Slim Hanna's always-on Claude Code config

You are a fresh Claude Code session dispatched to do ONE careful task: reduce how much
of Hanna's global Claude Code instruction set loads on every single session/message,
**without removing or weakening a single rule**. Slimming here means changing *when* a
rule loads (always-on vs read-on-demand), never *whether* it exists.

Read this whole file before doing anything.

## The problem (measured 2026-07-18)

Hanna's global config auto-loads roughly **12,200 words every session** (~16–18k tokens
on every message):

- `~/.claude/CLAUDE.md` — 302 lines / ~5,880 words
- Plus **9 rule files** that CLAUDE.md pulls in with `@~/.claude/rules/X.md` imports —
  ~6,302 words combined. The `@` syntax imports the file's FULL content into every session.

Baseline to beat: **~12,182 words always-on** (5,880 + 6,302).

The `@`-imported files are:
`agent-accessibility.md`, `browser-devtools.md`, `custom-agents.md`, `dangerous-commands.md`,
`github-accounts.md`, `gotchas.md`, `project-standards.md`, `repo-hygiene.md`, `shared-tooling.md`.

## Goal

Cut the always-on payload by roughly **one-third to one-half**, by converting the
*situational* rule files from always-loaded (`@`-import) to **read-on-demand** (referenced
by path from CLAUDE.md, read only when the task actually calls for them — the same pattern
`gotchas.md` already uses for its child files under `~/.claude/gotchas/`).

## Hard constraints (this is safety-adjacent config)

1. **Never delete, weaken, reword, or drop the substance of any rule.** Moving a rule to
   on-demand is fine; losing it is not.
2. **Back up first.** Copy `~/.claude/CLAUDE.md` and the entire `~/.claude/rules/` directory
   into `~/_system/utilities/claude-bloat/backup-<date>/` before editing anything. Verify the
   backup exists before the first edit.
3. **ZERO TOLERANCE safety rules must still fire every session.** Only *situational*
   guidance may become on-demand. See the split below.
4. **Get Hanna's explicit approval on the keep-vs-move split BEFORE editing any config
   file.** Present the plan, then WAIT for her answer. Do not edit first.
5. Touch only the **global** `~/.claude/` setup. Do not touch any project-scoped CLAUDE.md.
6. All changes must be reversible from the backup.

## Step 0 — Verify the loading mechanism FIRST (critical, do before moving anything)

Determine how Claude Code decides what auto-loads at session start:

- Does it load ONLY `CLAUDE.md` + its `@`-imports? Or does it ALSO auto-scan every file in
  `~/.claude/rules/` regardless of `@`?
- Reason for doubt: `~/.claude/rules/gotchas.md` contains a note that its child files were
  deliberately placed **outside** `~/.claude/rules/` "so Claude Code does not auto-load them
  at session start" — which implies files inside `rules/` may auto-load even without an `@`.
- Verify against **current Claude Code docs** (use the `claude-code-guide` agent, or official
  docs / context7). Do not guess.

Conclusion drives the method:
- **If only `@`-imports load** → removing the `@` and referencing by path is enough; files can
  stay in `~/.claude/rules/`.
- **If `rules/` is auto-scanned** → the on-demand files must **move OUT** of `rules/` (e.g. to
  a new `~/.claude/refs/` directory) and be referenced by absolute path from CLAUDE.md.
- **If docs are ambiguous, default to the safe option** (move out of `rules/`).

## Recommended split (Hanna confirms before you edit)

**Keep always-on** (safety + every-message relevance):
- The inline ZERO TOLERANCE blocks already in `CLAUDE.md` (secrets, MCP/database safety,
  project isolation/PII, git identity, one-command-at-a-time, guardrails-before-action,
  no-Artifacts-by-default, Vercel account safety, etc.) — stay inline.
- `@ dangerous-commands.md` — secret-leak prevention, must always fire.
- `@ project-standards.md` — restates isolation/PII/MCP safety; Hanna decides (overlaps with
  inline blocks, so possibly trimmable, but keep unless she says otherwise).

**Move to read-on-demand** (situational — read when the task hits that area):
- `github-accounts.md` → trigger: any GitHub repo/account/remote/git-identity setup.
- `browser-devtools.md` → trigger: UI work / before claiming a UI task done / Playwright.
- `custom-agents.md` → trigger: choosing or dispatching custom agents.
- `repo-hygiene.md` → trigger: before first commit/push on a personal/public repo.
- `agent-accessibility.md` → trigger: brainstorm/plan time for a new product/app.
- `shared-tooling.md` → trigger: before writing automation for someone else's machine.
- `gotchas.md` is already a lean index → leave as-is (small; keeping its `@` is fine).

For **every** moved file, CLAUDE.md must keep a ONE-LINE pointer with a crisp trigger, so
future sessions know exactly when to read it. Example line:
`- GitHub / repo / account / git-identity setup → FIRST read ~/.claude/refs/github-accounts.md`

A moved rule with no clear trigger = a rule that silently stops firing. The triggers are the
whole safety mechanism here — write them well.

## Optional second pass (propose to Hanna, don't assume)

Inside `CLAUDE.md` itself, some sections carry long **incident narratives, procedures, or
templates** (e.g. the Vercel incident history, the invoice/template blocks, long history
logs). The *rule* can stay inline as a one-line directive while the verbose backstory/example
moves to an on-demand file. Only prose/examples move — never the rule. Propose specific
candidates to Hanna; get approval per item.

## Procedure

1. Back up (constraint 2).
2. Verify the loading mechanism (Step 0).
3. Present Hanna the keep-vs-move split + any second-pass candidates. WAIT for approval.
4. For each approved move: relocate the file if Step 0 requires it, then replace the
   `@import` line in CLAUDE.md with a triggered one-line pointer.
5. Re-measure the always-on payload (`wc -w`) and report the before/after reduction.
6. Diff the new setup against the backup to confirm no rule content was lost.
7. Summarize what moved, the new always-on word count, and how to revert.

## Success criteria

- Always-on word count reduced ~1/3 to 1/2 from the 12,182 baseline.
- Every original rule still exists and is reachable, with a clear on-demand trigger.
- No ZERO TOLERANCE safety rule was moved to on-demand.
- Backup exists; every change is reversible.
- Hanna approved the split before any edit.

## Key paths

- `~/.claude/CLAUDE.md`
- `~/.claude/rules/*.md` (the 9 files listed above)
- Backup target: `~/_system/utilities/claude-bloat/backup-<date>/`
