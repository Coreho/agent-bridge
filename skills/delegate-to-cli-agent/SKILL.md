---
name: delegate-to-cli-agent
description: Use when the user asks to get a second opinion from another CLI coding agent (Codex, OpenCode, Qwen Code, Kilo Code, Antigravity), wants a task run by a specific model/provider Claude Code doesn't have direct access to, wants to compare how different coding agents approach the same problem, or wants work parallelized across multiple CLI coding agents. Triggers on "ask codex", "check with opencode", "get another model's take", "delegate this to X", "run this through codex/opencode/qwen/kilo/antigravity".
---

You have three MCP tools for delegating real work to other locally-installed CLI coding agents and holding a multi-turn conversation with them:

- `list_available_clis` — probe every CLI this plugin knows how to drive and report which are actually installed on this machine, plus each one's most recent session where supported. **Always call this first** — never assume a fixed set is installed, and never hardcode a CLI's name into a plan without checking it's actually there.
- `agent_delegate` — run one CLI (`cli: "codex" | "opencode" | "qwen" | "kilo" | "antigravity"`) non-interactively on a task and get its final answer back as text, along with a `session_id`.
- `agent_list_sessions` — list existing sessions for a given `cli`, most recent first, with auto-generated titles. Not every CLI supports this (Antigravity doesn't — check `sessions_supported` from `list_available_clis`, or the `ok` field here).

There is no dedicated "compare" tool — for a second opinion or side-by-side comparison, call `agent_delegate` once per CLI you want to include (always `permission: "read-only"` for a fair, non-destructive comparison) and present the answers yourself, labeled by which CLI produced which. This also means a comparison isn't locked to a fixed pair — include as many or as few of the available CLIs as makes sense for the request.

## Continuing a conversation

Each delegate call returns `session_id` in its JSON response. To continue talking to the *same* agent's thread later (it remembers everything from before), pass that `session_id` back in to another `agent_delegate` call for the SAME `cli`. Pass `fork: true` alongside it to branch a new line of conversation off that point instead of continuing in place — support for this varies by CLI (confirmed for codex, opencode, kilo; not confirmed for qwen/antigravity, which will warn and just continue in place instead). Omit `session_id` to start a brand new, stateless conversation.

If you don't already have the `session_id` in this conversation (e.g. it happened earlier, or context got compacted), call `agent_list_sessions` for that `cli` first — most of these CLIs auto-title sessions from their first message, so you can usually spot the right one by title alone. These list ALL sessions the CLI knows about, not just ones this plugin created, so they also surface work done through that CLI's own interactive/IDE use.

## Permissions — do not loosen defaults casually

`agent_delegate`'s `permission` parameter defaults to each CLI's most restrictive option and its accepted values vary per CLI (check `permissions` from `list_available_clis`, or the tool description) — roughly: `read-only` (can read/answer but not write files or run consequential shell commands), `workspace-write` (can edit files under `cwd`), and where available `danger-full-access` (no restrictions at all). Only loosen past `read-only` when the task genuinely requires the CLI to edit files, and only reach for the unrestricted tier if the user explicitly asks for unsandboxed execution.

`cwd` scopes where the delegated agent operates; `timeout_ms` (default 5 minutes) extends a call that needs longer.

## Usage pattern

1. Call `list_available_clis` to see what's actually installed and authenticated before planning anything.
2. Write a clear, self-contained prompt — the delegated agent has no access to this conversation's history unless you include it or reuse a `session_id`.
3. Call `agent_delegate`.
4. Read `text` for the answer. Check `ok`, `warnings`/`stderr_tail`, and `timed_out` before trusting the result — a false `ok` or non-empty `warnings` means something went wrong (including "this CLI isn't authenticated yet" errors, which surface here rather than as a crash) and the text may be partial or absent.
5. If you need to follow up, call again with the same `cli` and `session_id`.

Every result also includes `log_file` — that call's raw stdout/stderr streamed live to disk as the delegated CLI ran. If the user wants to watch a delegated call happen instead of just seeing the final answer, tell them this path and that they can `tail -f`/`Get-Content -Wait` it in another terminal while it runs — this is especially useful for a slow call or several concurrent lane calls, since each gets its own file.

Report back to the user which CLI/model actually produced the answer — don't present a delegated agent's output as your own.
