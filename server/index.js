import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import spawn, { SubprocessError } from "nano-spawn";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// nano-spawn resolves .cmd/.bat shims on Windows internally (no shell:true
// needed), so LLM-generated prompt text never gets re-parsed by cmd.exe.
async function runCli(command, args, { cwd, timeoutMs } = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs)
    : null;

  try {
    // stdio: give the child an already-closed stdin. Both codex and opencode
    // will otherwise block waiting for stdin EOF even when a prompt is passed
    // as an argument (codex appends piped stdin as an extra <stdin> block).
    const result = await spawn(command, args, { cwd, signal: controller.signal, stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, code: 0, stdout: result.stdout, stderr: result.stderr, timedOut: false, spawnError: null };
  } catch (err) {
    if (err instanceof SubprocessError) {
      return {
        ok: false,
        code: err.exitCode ?? null,
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? "",
        timedOut,
        spawnError: timedOut ? null : err.cause?.message ?? err.message,
      };
    }
    return { ok: false, code: null, stdout: "", stderr: "", timedOut, spawnError: err.message };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseJsonLines(text) {
  const events = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // stray non-JSON stdout line (shouldn't normally happen with --json/--format json) — skip it
    }
  }
  return events;
}

function extractCodexResult(events) {
  let threadId = null;
  let text = "";
  const warnings = [];
  let usage = null;
  for (const ev of events) {
    if (ev.type === "thread.started") threadId = ev.thread_id;
    if (ev.type === "item.completed" && ev.item) {
      if (ev.item.type === "agent_message" && typeof ev.item.text === "string") text += ev.item.text;
      else if (ev.item.type === "error") warnings.push(ev.item.message);
    }
    if (ev.type === "turn.completed") usage = ev.usage ?? usage;
    if (ev.type === "turn.failed") warnings.push(JSON.stringify(ev.error ?? ev));
  }
  return { threadId, text, warnings, usage };
}

function extractOpencodeResult(events) {
  let sessionId = null;
  let text = "";
  let usage = null;
  for (const ev of events) {
    if (ev.sessionID) sessionId = ev.sessionID;
    if (ev.type === "text" && ev.part?.text) text += ev.part.text;
    if (ev.type === "step_finish" && ev.part) {
      usage = { tokens: ev.part.tokens ?? null, cost: ev.part.cost ?? null };
    }
  }
  return { sessionId, text, usage };
}

// Codex has no non-interactive session-list command (`codex agents`/`resume --all`
// are TUI pickers only), so this reads its own on-disk index directly. That index
// is an append-only log — one line per time a thread's title/timestamp changed —
// so we fold it by id, keeping the last (most recent) entry per id. This is an
// undocumented internal file; if a future Codex version changes its shape or
// location, this degrades to an empty list with a warning rather than throwing.
async function readCodexSessionIndex() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const indexPath = path.join(codexHome, "session_index.jsonl");

  let raw;
  try {
    raw = await readFile(indexPath, "utf8");
  } catch (err) {
    return { sessions: [], warning: `Could not read ${indexPath}: ${err.message}` };
  }

  const byId = new Map();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed);
      if (entry.id) byId.set(entry.id, entry);
    } catch {
      // skip a malformed line rather than failing the whole read
    }
  }

  const sessions = [...byId.values()]
    .map((e) => ({ id: e.id, title: e.thread_name ?? null, updated_at: e.updated_at ?? null }))
    .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));

  return { sessions, warning: null };
}

// Shared core so codex_delegate and compare_agents run identical logic —
// compare_agents' safety guarantee (always read-only) depends on this being
// the only path that talks to the codex CLI.
async function delegateToCodex({ prompt, cwd, sandbox, model, session_id, fork, timeoutMs }) {
  const effectiveTimeout = timeoutMs ?? 300000;
  const warnings = [];

  const args = ["exec"];
  if (session_id) {
    args.push(fork ? "fork" : "resume", session_id, prompt);
    args.push("--json", "--skip-git-repo-check");
    if (model) args.push("--model", model);
    if (sandbox || cwd) {
      warnings.push(
        "sandbox/cwd are ignored when continuing via session_id (codex exec resume/fork don't accept them); " +
          "the thread keeps whatever sandbox/cwd it was created with."
      );
    }
  } else {
    args.push(prompt);
    args.push("--json", "--skip-git-repo-check", "--sandbox", sandbox ?? "read-only");
    if (model) args.push("--model", model);
    if (cwd) args.push("-C", cwd);
  }

  const result = await runCli("codex", args, { cwd, timeoutMs: effectiveTimeout });
  const events = parseJsonLines(result.stdout);
  const parsed = extractCodexResult(events);

  return {
    ok: result.ok && parsed.text.length > 0,
    session_id: parsed.threadId ?? session_id ?? null,
    text: parsed.text,
    warnings: [...warnings, ...parsed.warnings],
    usage: parsed.usage,
    sandbox: session_id ? null : sandbox ?? "read-only",
    timed_out: result.timedOut,
    exit_code: result.code ?? null,
    spawn_error: result.spawnError ?? null,
    stderr_tail: result.stderr ? result.stderr.slice(-2000) : "",
  };
}

// Shared core so opencode_delegate and compare_agents run identical logic —
// compare_agents' safety guarantee (auto_approve always off) depends on this
// being the only path that talks to the opencode CLI.
async function delegateToOpencode({ message, cwd, model, agent, session_id, fork, autoApprove, timeoutMs }) {
  const effectiveTimeout = timeoutMs ?? 300000;

  const args = ["run", message, "--format", "json"];
  if (session_id) {
    args.push("--session", session_id);
    if (fork) args.push("--fork");
  }
  if (model) args.push("--model", model);
  if (agent) args.push("--agent", agent);
  if (cwd) args.push("--dir", cwd);
  if (autoApprove) args.push("--auto");

  const result = await runCli("opencode", args, { cwd, timeoutMs: effectiveTimeout });
  const events = parseJsonLines(result.stdout);
  const parsed = extractOpencodeResult(events);

  return {
    ok: result.ok && parsed.text.length > 0,
    session_id: parsed.sessionId ?? session_id ?? null,
    text: parsed.text,
    usage: parsed.usage,
    auto_approve: !!autoApprove,
    timed_out: result.timedOut,
    exit_code: result.code ?? null,
    spawn_error: result.spawnError ?? null,
    stderr_tail: result.stderr ? result.stderr.slice(-2000) : "",
  };
}

const server = new McpServer({ name: "agent-bridge", version: "0.1.0" });

server.registerTool(
  "codex_delegate",
  {
    title: "Delegate a task to Codex CLI",
    description:
      "Run OpenAI's `codex` CLI non-interactively on a coding task and return its final answer as text. " +
      "Codex keeps its own conversation state: pass session_id (the thread_id returned from a prior " +
      "codex_delegate call) to continue that exact conversation with full prior context, or set fork:true " +
      "alongside it to branch a new thread off that point instead of continuing in place. " +
      "sandbox and cwd only take effect when starting a NEW thread (no session_id) — Codex's resume/fork " +
      "subcommands don't accept them, so a continued thread keeps whatever sandbox/cwd it was created with. " +
      "sandbox defaults to 'read-only' (Codex can read files and run read-only shell commands but cannot " +
      "write anything) — pass 'workspace-write' when the task requires Codex to actually edit files under cwd. " +
      "Never silently escalates to unsandboxed execution; danger-full-access must be requested explicitly.",
    inputSchema: {
      prompt: z.string().describe("The task or instructions to send to Codex"),
      cwd: z.string().optional().describe("Working directory Codex should treat as its workspace root"),
      sandbox: z
        .enum(["read-only", "workspace-write", "danger-full-access"])
        .optional()
        .describe("Sandbox policy for shell commands Codex runs. Default: read-only"),
      model: z.string().optional().describe("Override model, e.g. 'gpt-5.1-codex'"),
      session_id: z
        .string()
        .optional()
        .describe("thread_id from a previous codex_delegate call, to continue that conversation"),
      fork: z
        .boolean()
        .optional()
        .describe("If session_id is set, fork into a new thread instead of resuming in place. Default: false"),
      timeout_ms: z.number().optional().describe("Kill Codex if it runs longer than this. Default: 300000 (5 min)"),
    },
  },
  async ({ prompt, cwd, sandbox, model, session_id, fork, timeout_ms }) => {
    const payload = await delegateToCodex({ prompt, cwd, sandbox, model, session_id, fork, timeoutMs: timeout_ms });
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
  }
);

server.registerTool(
  "codex_list_sessions",
  {
    title: "List Codex sessions",
    description:
      "List Codex thread ids and their auto-generated titles, most recently updated first — including " +
      "threads created outside this plugin (e.g. from interactive `codex` use). Use this to find the right " +
      "session_id for codex_delegate when it isn't already in this conversation (e.g. after compaction, or " +
      "in a fresh conversation). Reads Codex's own session index file directly since Codex has no " +
      "non-interactive list command; if that file is missing or unreadable this returns an empty list with " +
      "a warning instead of failing. Does not include cwd — Codex's index doesn't track it.",
    inputSchema: {
      max_count: z.number().optional().describe("Max sessions to return. Default: 20"),
    },
  },
  async ({ max_count }) => {
    const { sessions, warning } = await readCodexSessionIndex();
    const limited = sessions.slice(0, max_count ?? 20);
    const payload = {
      ok: warning === null,
      sessions: limited,
      count: limited.length,
      warning,
    };
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
  }
);

server.registerTool(
  "opencode_delegate",
  {
    title: "Delegate a task to OpenCode CLI",
    description:
      "Run the `opencode` CLI non-interactively on a coding task and return its final answer as text. " +
      "OpenCode keeps its own session state: pass session_id (the sessionID returned from a prior " +
      "opencode_delegate call) to continue that exact conversation, or set fork:true alongside it to branch " +
      "into a new session instead of continuing in place. auto_approve maps to OpenCode's --auto flag " +
      "(auto-approves any permission that isn't explicitly denied) and defaults to false; only set it true if " +
      "the task needs a tool permission that would otherwise hang or fail waiting on an interactive approval " +
      "that can never arrive here.",
    inputSchema: {
      message: z.string().describe("The task or instructions to send to OpenCode"),
      cwd: z.string().optional().describe("Directory to run OpenCode in"),
      model: z.string().optional().describe("provider/model, e.g. 'anthropic/claude-sonnet-5'"),
      agent: z.string().optional().describe("Named OpenCode agent to use"),
      session_id: z
        .string()
        .optional()
        .describe("sessionID from a previous opencode_delegate call, to continue that conversation"),
      fork: z
        .boolean()
        .optional()
        .describe("If session_id is set, fork into a new session instead of continuing in place. Default: false"),
      auto_approve: z
        .boolean()
        .optional()
        .describe("Auto-approve OpenCode permission prompts that aren't explicitly denied. Default: false"),
      timeout_ms: z.number().optional().describe("Kill OpenCode if it runs longer than this. Default: 300000 (5 min)"),
    },
  },
  async ({ message, cwd, model, agent, session_id, fork, auto_approve, timeout_ms }) => {
    const payload = await delegateToOpencode({
      message,
      cwd,
      model,
      agent,
      session_id,
      fork,
      autoApprove: auto_approve,
      timeoutMs: timeout_ms,
    });
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
  }
);

server.registerTool(
  "opencode_list_sessions",
  {
    title: "List OpenCode sessions",
    description:
      "List OpenCode session ids, titles (auto-generated from each session's first message), and working " +
      "directories, most recently updated first — including sessions created outside this plugin. Use this " +
      "to find the right session_id for opencode_delegate when it isn't already in this conversation. " +
      "Optionally filter to sessions whose directory contains cwd_contains.",
    inputSchema: {
      max_count: z.number().optional().describe("Max sessions to return. Default: 20"),
      cwd_contains: z.string().optional().describe("Only return sessions whose directory includes this substring"),
    },
  },
  async ({ max_count, cwd_contains }) => {
    const result = await runCli("opencode", ["session", "list", "--format", "json", "--max-count", String(max_count ?? 20)]);

    if (!result.ok) {
      const payload = {
        ok: false,
        sessions: [],
        count: 0,
        exit_code: result.code ?? null,
        spawn_error: result.spawnError ?? null,
        stderr_tail: result.stderr ? result.stderr.slice(-2000) : "",
      };
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
    }

    let raw;
    try {
      raw = JSON.parse(result.stdout);
    } catch (err) {
      const payload = { ok: false, sessions: [], count: 0, spawn_error: `Failed to parse session list JSON: ${err.message}` };
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
    }

    let sessions = raw.map((s) => ({
      id: s.id,
      title: s.title ?? null,
      cwd: s.directory ?? null,
      created_at: s.created ? new Date(s.created).toISOString() : null,
      updated_at: s.updated ? new Date(s.updated).toISOString() : null,
    }));
    if (cwd_contains) sessions = sessions.filter((s) => s.cwd?.includes(cwd_contains));

    const payload = { ok: true, sessions, count: sessions.length };
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
  }
);

server.registerTool(
  "compare_agents",
  {
    title: "Get a second opinion from both Codex and OpenCode",
    description:
      "Send the SAME prompt to both Codex and OpenCode concurrently and return both answers side by side, " +
      "for a genuine second opinion or comparing how two backends approach the same problem. Always starts a " +
      "fresh conversation on both sides (no session continuation, so there's no session_id/fork param) so the " +
      "comparison stays fair and reproducible. Always runs Codex with sandbox 'read-only' and OpenCode with " +
      "auto_approve off — there is deliberately no write-enabled variant of this tool, since running two " +
      "independent agents with write access against the same files would race them against each other (this " +
      "matters especially if cwd is a lane a 'lanes' split assigned exclusively to one worker — never point " +
      "this tool at a lane's files expecting it to do that lane's actual edit; use codex_delegate directly for " +
      "that). For a task that needs real edits, follow up with codex_delegate or opencode_delegate directly.",
    inputSchema: {
      prompt: z.string().describe("The task or question to send to both Codex and OpenCode"),
      cwd: z.string().optional().describe("Working directory both agents should read from"),
      timeout_ms: z.number().optional().describe("Per-agent timeout. Default: 300000 (5 min)"),
    },
  },
  async ({ prompt, cwd, timeout_ms }) => {
    const [codex, opencode] = await Promise.all([
      delegateToCodex({ prompt, cwd, sandbox: "read-only", timeoutMs: timeout_ms }),
      delegateToOpencode({ message: prompt, cwd, autoApprove: false, timeoutMs: timeout_ms }),
    ]);
    const payload = { ok: codex.ok && opencode.ok, prompt, codex, opencode };
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
