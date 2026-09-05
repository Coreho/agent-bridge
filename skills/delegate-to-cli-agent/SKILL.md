---
name: delegate-to-cli-agent
description: Use when the user asks to get a second opinion from Codex or OpenCode, wants a task run by a specific model/provider Claude Code doesn't have direct access to, wants to compare how different coding agents approach the same problem, or wants work parallelized across multiple CLI coding agents. Triggers on "ask codex", "check with opencode", "get another model's take", "delegate this to X", "run this through codex/opencode".
---

You have five MCP tools for delegating real work to other locally-installed CLI coding agents and holding a multi-turn conversation with them:

- `codex_delegate` — OpenAI's Codex CLI
- `opencode_delegate` — OpenCode CLI (itself multi-provider)
- `codex_list_sessions` / `opencode_list_sessions` — list existing sessions for each agent, most recent first, with auto-generated titles
- `compare_agents` — send the same prompt to both Codex and OpenCode at once and get both answers back; use this instead of calling both delegate tools yourself when the user wants a second opinion or wants to see how the two backends differ

The two delegate tools run the target CLI non-interactively, wait for it to finish, and return its final answer as text, along with a `session_id`. `compare_agents` always runs both sides read-only/no-auto-approve with no session continuation (a fresh, fair comparison every time) — it has no write-enabled mode by design, so it's always safe to call even against files another tool (like a `lanes` lane) currently owns for editing.

## Continuing a conversation

Each delegate call returns `session_id` in its JSON response. To continue talking to the *same* agent thread later (it remembers everything from before), pass that `session_id` back in on the next call. Pass `fork: true` alongside it if you want to branch a new line of conversation off that point instead of continuing in place. Omit `session_id` to start a brand new, stateless conversation.

If you don't already have the `session_id` in this conversation (e.g. it happened in an earlier session, or context got compacted), call `codex_list_sessions` / `opencode_list_sessions` first — both CLIs auto-title sessions from their first message, so you can usually spot the right one by title alone. These list ALL sessions each CLI knows about, not just ones this plugin created, so they also surface work done through the CLI's own interactive mode.

## Sandboxing — do not loosen defaults casually

- `codex_delegate` defaults to `sandbox: "read-only"` — Codex can read files and run read-only shell commands but cannot write anything. Only pass `sandbox: "workspace-write"` when the task genuinely requires Codex to edit files, and only `danger-full-access` if the user explicitly asks for unsandboxed execution.
- `opencode_delegate` defaults to `auto_approve: false`. Only set `auto_approve: true` if a task needs a tool permission that would otherwise stall waiting on an approval that can never come (this is a non-interactive call — there is no one to click "approve").

Both calls accept `cwd` to scope where the delegated agent operates, and `timeout_ms` (default 5 minutes) if a task needs longer.

## Usage pattern

1. Write a clear, self-contained prompt/message — the delegated agent has no access to this conversation's history unless you include it or reuse a `session_id`.
2. Call the appropriate tool.
3. Read `text` for the answer. Check `ok`, `warnings`/`stderr_tail`, and `timed_out` before trusting the result — a false `ok` or non-empty `warnings` means something went wrong and the text may be partial or absent.
4. If you need to follow up, call again with the same `session_id`.

Every result also includes `log_file` — that call's raw stdout/stderr streamed live to disk as the delegated CLI ran (for `compare_agents`, this is nested under `codex.log_file` / `opencode.log_file`). If the user wants to watch a delegated call happen instead of just seeing the final answer, tell them this path and that they can `tail -f`/`Get-Content -Wait` it in another terminal while it runs — this is especially useful for a slow call or several concurrent lane calls, since each gets its own file.

Report back to the user which agent/model actually produced the answer — don't present a delegated agent's output as your own.
