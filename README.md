# agent-bridge

A Claude Code plugin that lets Claude delegate real work to other locally-installed CLI coding agents — [Codex CLI](https://github.com/openai/codex) and [OpenCode](https://github.com/sst/opencode) — and hold multi-turn conversations with them, all from inside a Claude Code session.

## What it does

Bundles a small MCP server (Node, stdio transport) exposing five tools:

- **`codex_delegate`** — run a prompt through Codex CLI non-interactively (`codex exec`). Supports sandbox levels (`read-only` default, `workspace-write`, `danger-full-access`), a target `cwd`, and session continuation via Codex's own `resume`/`fork`.
- **`opencode_delegate`** — same idea for OpenCode CLI (`opencode run`), with `auto_approve` in place of a sandbox flag, and its own session continuation.
- **`codex_list_sessions`** / **`opencode_list_sessions`** — list each CLI's existing sessions (auto-titled from their first message) so Claude can resume a conversation from an earlier session, including ones started directly in the CLI's own interactive mode.
- **`compare_agents`** — send the same prompt to both Codex and OpenCode concurrently and get both answers back. Always read-only / no-auto-approve on both sides and has no session/write-enabled variant at all — safe to call even against files another tool (e.g. a `lanes` lane) currently owns for editing.

Two skills teach Claude when and how to use these:

- **`delegate-to-cli-agent`** — general trigger-based skill: fires when the user asks to "check with codex," "get a second opinion," "run this through opencode," etc.
- **`/agent-bridge:codex-delegate`** — a guided, menu-driven flow: pick a Codex session (or start new) → pick how to delegate (plain task / lanes-split parallel job / compare against OpenCode).

## Requirements

- [Codex CLI](https://github.com/openai/codex) and/or [OpenCode](https://github.com/sst/opencode) already installed and authenticated on your machine. **This plugin does not install or configure either CLI for you** — it only shells out to whichever one(s) you already have working.
- Node.js (the bundled MCP server runs on Node; dependencies are vendored in `server/node_modules` so no `npm install` step is required after installing the plugin).

## Install

```
/plugin marketplace add <this-repo>
/plugin install agent-bridge
```

Or for local development:

```
claude --plugin-dir /path/to/agent-bridge
```

## Security notes

- `codex_delegate` defaults to `sandbox: "read-only"` and `opencode_delegate` defaults to `auto_approve: false`. Both delegated CLIs run non-interactively as child processes of Claude Code with whatever filesystem/shell access their sandbox setting allows — treat write-enabled or full-access modes the same as you would any other command Claude runs on your machine.
- `compare_agents` cannot be put into a write-enabled mode; this is enforced by the tool's schema (no `sandbox`, `session_id`, or `auto_approve` parameters exist on it), not just by convention.
- Prompts and delegated CLI output pass through as plain text; this plugin does no additional sandboxing beyond what `codex`/`opencode` themselves provide via their own sandbox flags.

## Known platform notes

- Developed and tested on Windows. The bundled server uses [`nano-spawn`](https://github.com/sindresorhus/nano-spawn) specifically to resolve Windows `.cmd`/`.bat` CLI shims without needing `shell: true`.
- Both `codex exec resume`/`fork` reject `--sandbox`/`-C` — a resumed/forked session keeps whatever sandbox/cwd it was originally created with. The server drops those flags automatically on continuation calls and surfaces a warning if you passed them anyway.
