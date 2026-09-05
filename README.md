# agent-bridge

A Claude Code plugin that lets Claude delegate real work to other locally-installed CLI coding agents — and optionally itself — through a shared adapter interface, and hold multi-turn conversations with each of them, all from inside a Claude Code session.

Currently supported: [Codex CLI](https://github.com/openai/codex), [OpenCode](https://github.com/sst/opencode), [Qwen Code CLI](https://github.com/qwenlm/qwen-code), [Kilo Code CLI](https://github.com/Kilo-Org/kilocode), [Antigravity CLI](https://antigravity.google/) (`agy`). Adding another one is a matter of registering one more adapter in `server/index.js`, not building a new pipeline.

## What it does

Bundles a small MCP server (Node, stdio transport) exposing three generic tools:

- **`list_available_clis`** — probes every registered adapter and reports which are actually installed on this machine, plus each one's most recent session where supported. Always called first — nothing is assumed to be installed.
- **`agent_delegate`** — run one CLI (`cli: "codex" | "opencode" | "qwen" | "kilo" | "antigravity"`) non-interactively on a task and get its final answer back as text plus a `session_id`. `permission` (defaulting to each CLI's most restrictive tier) controls whether it can write files or run unattended commands.
- **`agent_list_sessions`** — list a CLI's existing sessions (auto-titled from their first message), most recent first, including sessions started outside this plugin. Not every CLI supports this (Antigravity doesn't — no non-interactive history exists for it, only a last-conversation cache).

Two skills teach Claude when and how to use these:

- **`delegate-to-cli-agent`** — general trigger-based skill: fires when the user asks to "check with codex," "get a second opinion," "run this through opencode," etc. For a comparison, it calls `agent_delegate` once per CLI (always read-only) rather than relying on a fixed pairing.
- **`/agent-bridge:delegate`** — a guided, menu-driven flow: detect what's installed → pick a worker pool (any subset of the installed CLIs, optionally plus Claude itself) → pick a session per CLI in the pool → pick how to delegate (a plain task to one or all pool members, a lanes-split job spread across the pool with Claude able to take a lane directly, or a compare across the whole pool).

## Requirements

- Whichever of the above CLIs you want to use, already installed **and authenticated** on your machine. **This plugin does not install or configure any of them for you** — it only shells out to whichever ones you already have working. An unauthenticated CLI still gets detected as "installed" by `list_available_clis` (it just checks the binary runs), but `agent_delegate` calls to it will come back with `ok: false` and the CLI's own auth error in `warnings` rather than crashing.
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

## Watching a delegated call live

Every `agent_delegate` result includes a `log_file` path. Each call's raw stdout/stderr is streamed to that file in real time as the delegated CLI runs (not just returned at the end), so you can open a second terminal and watch it happen:

```
# PowerShell
Get-Content -Wait <log_file>

# bash
tail -f <log_file>
```

Logs live under `%TEMP%\agent-bridge-logs\` (one file per call, so concurrent lanes each get their own).

## Security notes

- `agent_delegate` defaults to each CLI's most restrictive `permission` tier (`read-only` for all five currently). Delegated CLIs run non-interactively as child processes of Claude Code with whatever filesystem/shell access their permission level allows — treat write-enabled or full-access modes the same as you would any other command Claude runs on your machine.
- There is no dedicated write-enabled "compare" mode — comparisons are built by calling `agent_delegate` per CLI with `permission: "read-only"` explicitly, at the skill level, so nothing running a comparison can accidentally write files.
- Prompts and delegated CLI output pass through as plain text; this plugin does no additional sandboxing beyond what each CLI provides via its own permission/sandbox flags.
- Not every generic parameter is confirmed supported by every adapter (e.g. `model`/`agent`/`fork` on some of the newer ones) — where a flag isn't confirmed, the adapter returns a warning that it was ignored rather than guessing at CLI syntax that might do something unintended.

## Known platform notes

- Developed and tested on Windows. The bundled server uses [`nano-spawn`](https://github.com/sindresorhus/nano-spawn) specifically to resolve Windows `.cmd`/`.bat` CLI shims without needing `shell: true`.
- Both `codex exec resume`/`fork` reject `--sandbox`/`-C` — a resumed/forked session keeps whatever sandbox/cwd it was originally created with. The adapter drops those flags automatically on continuation calls and surfaces a warning if you passed them anyway.
- Kilo Code CLI has been observed not exiting its process after a provider auth error (unlike Qwen, which exits immediately) — the call still resolves correctly once `timeout_ms` elapses, with the auth error captured in `warnings`, just slower than a clean failure.
- Antigravity has no non-interactive session-history command — `agent_list_sessions` for it always returns unsupported rather than an empty/wrong result.
