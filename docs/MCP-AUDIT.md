# Task: MCP server supply-chain audit + hardening

You are a fresh Claude Code session. This task reduces Hanna's exposure to untrusted /
unpinned Model Context Protocol (MCP) servers. It is the sibling of the CLAUDE.md slimming
task (`SPEC.md` in this same folder) — both are "clean up my global Claude config safely."

Read this whole file first. Follow Hanna's global rules (especially: never surface secret
values into the transcript; do not `cat`/`jq` `~/.claude.json` yourself — the secret-leak
hook blocks it, and it holds tokens).

## Why this matters

MCP servers launch as local processes at session start. Many are installed via
`npx -y <package>`, which fetches and runs whatever version resolves at launch. A
third-party package under a solo maintainer's npm account is a supply-chain risk: if that
account is compromised, a malicious new release runs on Hanna's machine automatically. The
`yt-dlp` case (below) was the trigger for this audit.

## What has already been done (2026-07-18)

Context from the originating session, so you don't repeat it:

1. **Identified the risk:** `@kevinwatt/yt-dlp-mcp` — a solo-maintainer npm package (trust
   tier 3, see framework below) — was providing the `mcp__yt-dlp__ytdlp_search_videos` and
   `mcp__yt-dlp__ytdlp_get_video_metadata` tools used by Hanna's YouTube skills.
2. **Removed the dependency entirely** by rewriting the skills to call the trusted `yt-dlp`
   binary (Homebrew) directly via Bash instead of through the MCP wrapper. Converted:
   - `~/.claude/skills/fmw-content-search-youtube/SKILL.md` (edited)
   - `~/.claude/skills/fmw-content-research-youtube/SKILL.md` (edited)
   - `~/.claude/skills/fmw-content-curate-youtube-docs/SKILL.md` (new skill, already direct)
   - `~/.claude/skills/fmw-content-transcribe-youtube/SKILL.md` (already called yt-dlp
     directly, no change). No `mcp__yt-dlp__` references remain in any skill.
3. **Removed the server config** from the two places it lived:
   - A project-scoped `.mcp.json` in `~/_projects/apps/curated-yt-list/` (created
     then removed; committed removal).
   - The per-project block for the `claude-code-skills` Google Drive project inside
     `~/.claude.json`, via the helper `~/remove-unused-ytdlp-mcp.sh`. Backup written to
     `~/.claude.json.bak-ytdlp-removal`.
4. **Built this audit script** (`mcp-audit.mjs`, in this folder) — reads `~/.claude.json`
   locally and prints a safe report (launcher, package, pinned-status) with secrets redacted.

### Commands already run
- Hanna: `jq -r '.projects | to_entries[] | select(.value.mcpServers | has("yt-dlp")) | .key' ~/.claude.json`
  → returned the `claude-code-skills` path (that's how we found the stray registration).
- Hanna: `cp ~/.claude.json ~/.claude.json.bak-$(date +%Y%m%d)` (a dated safety backup).
- Hanna: `bash ~/remove-unused-ytdlp-mcp.sh` (removed the yt-dlp server; made its own backup).

### Leftover files you may clean up when done
- `~/remove-unused-ytdlp-mcp.sh` (one-off helper; safe to `rm`)
- `~/.claude.json.bak-ytdlp-removal` and `~/.claude.json.bak-<date>` (keep until Hanna is
  confident nothing broke, then she can delete)

## The step NOT yet done — run the audit

The broad audit has not been run yet. Do this:

```
node ~/_system/utilities/claude-bloat/mcp-audit.mjs
```

It prints, per MCP server across the global block and every project block: PINNED/UNPINNED,
launcher (npx/uvx/docker/local), and package. It never prints env vars and redacts
token-shaped args. (If Hanna prefers, she runs it and pastes the output — but this script is
already secret-safe by construction, so you running it is fine too.)

## Trust-tier framework (use this to classify each server)

The one thing version-pinning protects against: npm won't let anyone republish an existing
version, so `@1.2.3` is immutable. Pinning does NOT protect the version you're on — it stops
`npx -y` from auto-pulling a *future* release that got hijacked. Cost of pinning: you stop
getting security fixes until you manually bump. So how hard to lean on pinning scales with
source trust:

- **Tier 1 — first-party / official** (package published by the actual vendor, official
  scope: `@modelcontextprotocol/*`, `@anthropic-ai/*`, `@supabase/*`, `@cloudflare/*`,
  `@notionhq/*`). Low hijack risk, valuable fixes. Floating `latest` is defensible; optional
  light pin-and-bump.
- **Tier 2 — reputable third-party** (widely used, active maintainer, real repo, npm
  provenance badge). Pin, and bump deliberately when you have a reason.
- **Tier 3 — solo / hobby / low-adoption** (one maintainer, few downloads, e.g. the old
  `@kevinwatt/yt-dlp-mcp`). Pin hard and read the diff before ever bumping. Better: remove
  the dependency — if the server is a thin wrapper around a trusted CLI (like yt-dlp) or a
  service with an official SDK, call that directly / rebuild the wrapper with the official
  MCP SDK (`@modelcontextprotocol/sdk`, tier 1) instead.

How to place a package (check on npmjs.com): scope/maintainer, weekly downloads, linked
source repo, green "provenance" badge, last-publish date. Solo + low downloads + no
provenance → tier 3.

Stronger than a version pin, if ever wanted: install locally into a project with a lockfile
(`pnpm add …`) — pins by integrity hash. Usually overkill for personal tooling.

## Procedure

1. Run `mcp-audit.mjs`.
2. For each server, classify tier 1/2/3 and note pinned vs unpinned.
3. Produce a table: server, scope, package, tier, pinned?, recommended action.
4. Recommend per server:
   - Tier 1 unpinned → fine to leave (or optional pin).
   - Tier 2 unpinned → pin to current version.
   - Tier 3 → prefer removing the dependency (direct CLI / official-SDK rebuild); if it must
     stay, pin hard.
5. Present the table + recommendations to Hanna and get her decision per risky server before
   changing any config.
6. Apply approved changes. You CANNOT read/edit `~/.claude.json` yourself (secret-leak hook).
   For each edit, hand Hanna a short **script file** to run (`bash ~/name.sh`) — never a long
   pasteable one-liner (her terminal wraps long pastes and corrupts them; this is now a rule
   in her global CLAUDE.md). Each script backs up `~/.claude.json` first, then uses `jq` to
   pin or remove exactly one key, writing back atomically.
7. Re-run `mcp-audit.mjs` to confirm the result.

## Hard constraints

- Never print any secret value. Do not `cat`/`jq`/`env`-dump `~/.claude.json` — use the audit
  script (secret-safe) or have Hanna run targeted checks.
- Back up `~/.claude.json` before any edit; every change reversible.
- Get Hanna's approval before removing or changing any server.
- Removing a server that a skill/tool still depends on will break that tool — check for
  references first (grep `~/.claude/skills` and project `.mcp.json` files for the tool name).
