# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [0.2.0]

### Changed

- Replaced the five hardcoded tools (`codex_delegate`, `opencode_delegate`, `codex_list_sessions`, `opencode_list_sessions`, `compare_agents`) with three generic ones backed by an adapter registry:
  - **`list_available_clis`** — probes every registered adapter and reports which are actually installed on this machine, plus each one's most recently updated session where the CLI supports session listing.
  - **`agent_delegate`** — runs a given CLI (`cli` parameter) non-interactively on a task and returns its final answer as text; supports continuing or forking a prior conversation via `session_id`.
  - **`agent_list_sessions`** — lists a CLI's existing sessions (id, title, timestamps), most recently updated first, including sessions created outside this plugin.
- Added adapters for **Qwen Code CLI** and **Kilo Code CLI** (fully supportable) and **Antigravity CLI** (supportable except session listing — no real non-interactive history mechanism exists for it).
- Renamed the guided skill from `codex-delegate` to **`delegate`** (`/agent-bridge:delegate`): it now detects available CLIs, lets the user pick a worker pool (any subset of installed CLIs, optionally plus Claude itself), picks a session per pooled CLI, then offers Plain task (single worker or all of them), Lanes (split across the pool — Claude can take a lane directly, delegated lanes are reviewed before reporting done), or Compare (every pool member, always read-only).
- Every `agent_delegate` result now includes `log_file` — a path each call's raw stdout/stderr is streamed to live as the CLI runs, so a call in progress can be watched (`Get-Content -Wait`/`tail -f`) instead of only seeing the result once it finishes.

### Fixed

- Windows `.cmd` batch shims (what npm generates for every globally-installed CLI) silently truncate any argument containing a literal newline at the first line, dropping everything after it — including subsequent CLI flags — with no indication anything was cut. This affected any multi-line prompt sent to Codex, OpenCode, Qwen, or Kilo. Fixed by resolving each npm shim's real underlying `node <script>.js` target and invoking that directly, bypassing cmd.exe's batch interpreter entirely.
- A CLI can silently ignore its own `--format`/`--output-format json` flag and print plain, unparseable text instead (observed with OpenCode on a free-tier model) — this surfaced as a false empty/failed result. `agent_delegate` now falls back to the raw stdout as the answer when zero JSON events could be parsed, with a warning explaining what happened.
- `opencode`'s (and `kilo`'s) `session list --format json` prints nothing at all — not `"[]"` — when zero sessions exist yet, which crashed the JSON parser. Now treated as an empty list.

## [0.1.0] - Initial release

### MCP tools

- **`codex_delegate`** / **`opencode_delegate`** — run Codex CLI / OpenCode CLI non-interactively on a task and return the final answer as text, with session continuation via `session_id`/`fork`.
- **`codex_list_sessions`** / **`opencode_list_sessions`** — list each CLI's existing sessions, most recently updated first.
- **`compare_agents`** — send the same prompt to both Codex and OpenCode concurrently, always read-only, no session continuation.

### Skills

- **`delegate-to-cli-agent`** — triggers when the user asks for a second opinion from another CLI coding agent, wants a task run by a specific model/provider, or wants work compared or parallelized across multiple CLI coding agents.
- **`codex-delegate`** (`/agent-bridge:codex-delegate`) — a guided, menu-driven flow: pick a Codex session (or start new), then choose a plain task, a lanes-split job (fanned out to Codex), or a compare against OpenCode.
