# LANES — repo hygiene (2026-09-05)

## Lane table

| Lane | Owner scope | Footprint (write only) | Waits on |
|---|---|---|---|
| A | Line-ending normalization | `.gitattributes` (new) | nothing |
| B | Contributor docs | `CONTRIBUTING.md` (new) | nothing |
| C | Release changelog | `CHANGELOG.md` (new) | nothing |

No shared-mutable resource across these three — each lane creates exactly one
new file at repo root and touches nothing else. No sync points. No §Z. Runs
fully parallel.

## Sync points

None.

## Section board

### §W — Genuinely open
(none)

### §D — Done & verified
- Lane A: `.gitattributes` created by Codex CLI. Verified: file exists at repo root with `* text=auto eol=lf` plus explicit `.js`/`.json`/`.md` LF rules; `git check-attr` confirmed by the lane; only this file touched. (Codex also attempted a scoped `git commit --only -- .gitattributes`, which failed with an unrelated environment error — "Access is denied" spawning `pwsh.exe` — the file itself is fine, it's just uncommitted like the other lanes' output.)
- Lane B: `CONTRIBUTING.md` created. Antigravity CLI hit a broken `PreToolUse` hook in its own environment (an unrelated `googlecloudtools.datacloud_telemetry` plugin misconfiguration that blocks all its tool calls) and could only return the drafted content as text instead of writing the file — so Claude wrote the file directly instead, based on that draft, corrected against `README.md` (the "no `npm install` needed to run, deps are vendored" detail Antigravity's draft got wrong) and `server/index.js`. Verified: file exists at repo root, covers local run/test via `--plugin-dir`, code style, adding a tool, adding a skill.
- Lane C: `CHANGELOG.md` created directly by Claude. Verified: file exists at repo root, lists exactly v0.1.0 with the three real tools (`list_available_clis`, `agent_delegate`, `agent_list_sessions`) and both real skills (`delegate-to-cli-agent`, `delegate`), matching `server/index.js` and `skills/*/SKILL.md`.

Final check: `git status --short` shows only `.gitattributes`, `CHANGELOG.md`, `CONTRIBUTING.md`, `LANES.md` as untracked — `README.md` and `server/index.js` untouched, no overlap between lanes.

### §V / §X / §Y / §Z
(none)

## Escalations
None blocking. Note for awareness: `.claude-plugin/plugin.json` already reports
version `0.2.0` while `server/package.json` reports `0.1.0` — the two are out
of sync. The user explicitly asked to document `v0.1.0` as the changelog entry,
so Lane C proceeds with that version number as specified rather than guessing
which file is "right"; this mismatch is not Lane C's to fix (would touch files
outside its footprint) and is just flagged here for the user's own follow-up.

## Lane prompts

### Lane A — .gitattributes for LF normalization

Owns (write only these): `.gitattributes` (new file at repo root)
Do NOT touch: `CONTRIBUTING.md`, `CHANGELOG.md`, `README.md`, `server/index.js`, anything under `server/node_modules`
Waits on: nothing
Branch: one commit, this file only
Tasks:
  1. Create `.gitattributes` at the repo root of `C:\Users\koreo\claude-plugins\agent-bridge`.
  2. Normalize line endings to LF for text files, specifically `.js`, `.json`, `.md` (and it's fine to also set a sane default for all text via `* text=auto eol=lf` plus explicit per-extension rules) — the goal is to stop the CRLF warnings git shows on add/commit on this Windows checkout.
  3. Keep it minimal and idiomatic (standard `.gitattributes` syntax), no unrelated rules.
Done means: `.gitattributes` exists at repo root; `git add -A` (or `git status`) on a modified `.js`/`.json`/`.md` file no longer prints a CRLF-normalization warning. Do not run `git add -A` on the whole repo yourself — just verify the rules are syntactically correct and target the right extensions.
Escalate, don't guess: none needed — this is a well-defined, standard file.

### Lane B — CONTRIBUTING.md

Owns (write only these): `CONTRIBUTING.md` (new file at repo root)
Do NOT touch: `.gitattributes`, `CHANGELOG.md`, `README.md`, `server/index.js`, anything under `server/node_modules`
Waits on: nothing
Branch: one commit, this file only
Tasks:
  1. Create `CONTRIBUTING.md` at the repo root of `C:\Users\koreo\claude-plugins\agent-bridge`.
  2. Cover, at minimum:
     - **Running/testing locally**: how to load this plugin via `claude --plugin-dir <path-to-this-repo>` (or the equivalent `claude-plugins`-relative path) to exercise it end-to-end without publishing; mention the server is a Node MCP server started via `.mcp.json` (`node ${CLAUDE_PLUGIN_ROOT}/server/index.js`), so `cd server && npm install` is needed once before first run.
     - **Code style expectations**: plain Node.js (ESM, `"type": "module"`), no build step, keep tool descriptions in `server/index.js` accurate since Claude Code reads them directly; match existing formatting rather than introducing a new style/linter.
     - **How to add a new MCP tool**: where tools are registered in `server/index.js` (look at the existing `codex_delegate`/`opencode_delegate`/etc. registrations as the pattern), what a tool needs (name, description, zod input schema, handler), and to update the README's tool list.
     - **How to add a new skill**: create `skills/<skill-name>/SKILL.md` following the pattern of the existing `skills/codex-delegate` and `skills/delegate-to-cli-agent` skills, and register/describe it appropriately.
  3. Read `README.md` and `server/index.js` first (read-only) so the instructions match what's actually there — but do not edit either file.
Done means: `CONTRIBUTING.md` exists at repo root, is accurate to the actual repo layout/tool registration pattern observed in `server/index.js`, and gives a newcomer everything needed to run the plugin locally and add a tool or skill without asking further questions.
Escalate, don't guess: none needed for scope; if `server/index.js`'s actual registration pattern is ambiguous, describe it as observed rather than guessing.

### Lane C — CHANGELOG.md

Owns (write only these): `CHANGELOG.md` (new file at repo root)
Do NOT touch: `.gitattributes`, `CONTRIBUTING.md`, `README.md`, `server/index.js`, `.claude-plugin/plugin.json`, `server/package.json`, anything under `server/node_modules`
Waits on: nothing
Branch: one commit, this file only
Tasks:
  1. Create `CHANGELOG.md` at the repo root of `C:\Users\koreo\claude-plugins\agent-bridge`, following the "Keep a Changelog" style (or similarly standard format).
  2. Document a single entry: **v0.1.0 — Initial release** (the user asked specifically for v0.1.0; note `.claude-plugin/plugin.json` currently says `0.2.0` and `server/package.json` says `0.1.0` — these are out of sync in the repo already, do not touch either file, just use v0.1.0 as the changelog heading as instructed).
  3. Under that entry, list the three MCP tools this plugin actually provides (confirmed by reading `server/index.js`): `list_available_clis`, `agent_delegate`, `agent_list_sessions` — with a one-line description of each, matching the tool descriptions already registered there (do not use older/different tool names like `codex_delegate` or `compare_agents` — those are not what's in the current code).
  4. Also list the two skills that actually exist under `skills/` (confirmed): `delegate` and `delegate-to-cli-agent` — with a one-line description of each, taken from their `SKILL.md` frontmatter `description` field (do not use an older name like `codex-delegate` — no such skill directory exists).
Done means: `CHANGELOG.md` exists at repo root, lists exactly v0.1.0 with all three tools and both skills named correctly and matching what's actually registered/described in the repo right now.
Escalate, don't guess: none needed — scope and version are fixed by the request; tool/skill names are verifiable directly in `server/index.js` and `skills/*/SKILL.md`.
