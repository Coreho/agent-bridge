# Contributing to agent-bridge

Thanks for looking at improving this plugin. It's a small Claude Code plugin that lets Claude delegate work to other locally-installed CLI coding agents (Codex, OpenCode, Qwen Code, Kilo Code, Antigravity) through a shared adapter interface in a Node MCP server.

## Running and testing locally

You don't need to publish or install the plugin to try changes — point Claude Code straight at your working copy:

```
claude --plugin-dir /path/to/agent-bridge
```

On Windows:

```
claude --plugin-dir C:\Users\you\claude-plugins\agent-bridge
```

This starts the bundled MCP server (defined in `.mcp.json`, launched as `node ${CLAUDE_PLUGIN_ROOT}/server/index.js`) and registers the skills under `skills/`. A few things to know:

- Dependencies are vendored in `server/node_modules`, so no `npm install` step is required just to run the plugin. If you add or change a dependency in `server/package.json`, run `npm install` inside `server/` and commit the resulting `node_modules`/`package-lock.json` changes.
- Changes to `server/index.js` take effect the next time Claude Code starts (or reconnects) the MCP server — restart your `--plugin-dir` session to pick them up.
- Changes to a `skills/*/SKILL.md` file take effect in a new session.
- To sanity-check the server starts cleanly on its own: `node server/index.js` (it talks MCP over stdio, so it will just sit there waiting for a client — `Ctrl+C` to stop).
- To exercise a real delegated call, start a `--plugin-dir` session and ask Claude to use `/agent-bridge:delegate` or trigger the `delegate-to-cli-agent` skill against whichever CLI you're testing.

## Code style expectations

- Plain Node.js, ESM (`server/package.json` sets `"type": "module"`) — no build step, no TypeScript, no bundler. Code in `server/index.js` must run directly under Node.
- Match the existing formatting in `server/index.js` (2-space indentation, the existing quoting/semicolon style) rather than introducing a new linter or reformatting unrelated code.
- Tool `description` strings are not documentation for humans first — Claude Code reads them to decide when and how to call each tool. Keep them precise and complete: preconditions, what each parameter does, and any defaults or gotchas (see the existing three tools for the level of detail expected).
- Adapters shell out to real CLI binaries via `nano-spawn` (chosen specifically to resolve Windows `.cmd`/`.bat` shims without `shell: true`) — don't introduce `shell: true` or raw string command construction that could reopen that problem.
- Not every adapter supports every generic parameter (`model`, `agent`, `fork`, session listing, etc.). Where a CLI doesn't support something, return a warning rather than silently ignoring it or guessing at CLI flags that might not do what's intended.

## How to add a new MCP tool

Tools are registered in `server/index.js` via `server.registerTool(name, { title, description, inputSchema }, handler)`. Use the three existing registrations — `list_available_clis`, `agent_delegate`, `agent_list_sessions` — as the pattern:

1. Pick a `snake_case` name and write a thorough `description` (see the code style note above).
2. Define `inputSchema` as an object of Zod schemas, each with a `.describe(...)` explaining the parameter.
3. Write an `async` handler that returns `{ content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] }`.
4. If the tool works across CLIs, add it to the shared `ADAPTERS` registry pattern rather than hardcoding a single CLI.
5. Update the tool list in `README.md` to describe the new tool.

## How to add a new skill

Skills live under `skills/<skill-name>/SKILL.md`. Follow the pattern of the existing `skills/delegate` and `skills/delegate-to-cli-agent` skills:

1. Create `skills/<skill-name>/SKILL.md`.
2. Start with YAML frontmatter: `name` (matches the directory) and a `description` that states what the skill does and what should trigger it — this is what Claude Code uses to decide when to invoke it.
3. Write the body as direct instructions to Claude, not documentation for a human reader — reference the actual tool names (`list_available_clis`, `agent_delegate`, `agent_list_sessions`) rather than re-describing behavior that could drift from `server/index.js`.
4. Update `README.md`'s skills section to mention the new skill.
