import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import spawn, { SubprocessError } from "nano-spawn";
import { readFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Live per-call logs so a call in progress can be watched in a second terminal
// (`Get-Content -Wait <file>` / `tail -f <file>`) instead of only seeing the
// result once the whole call finishes — useful for slow calls and essential
// for telling concurrent lanes' output apart.
const LOG_DIR = path.join(os.tmpdir(), "agent-bridge-logs");

// A Windows .cmd batch shim (what npm generates for every globally-installed
// CLI) is interpreted by cmd.exe's own batch processor, which reads its
// command line one LINE at a time — a literal newline inside an argument
// (a multi-paragraph prompt, near-guaranteed for any real task) silently
// truncates everything after the first line, flags included, no matter how
// nano-spawn quotes it. Found live: a multi-line prompt to Codex got cut to
// its first line, --skip-git-repo-check and the rest vanished, and it
// surfaced as an unrelated-looking "not inside a trusted directory" error.
// A real .exe/node process's own argv parsing preserves embedded newlines
// fine (verified) — only the batch-file hop is broken — so this resolves an
// npm shim's actual `node <script>.js` target from its own source and
// invokes that directly, bypassing cmd.exe entirely. Non-npm binaries (no
// .cmd found, e.g. Antigravity's native installer) fall through unchanged.
const shimCache = new Map();
async function resolveWindowsCmdShim(command) {
  if (process.platform !== "win32") return null;
  if (shimCache.has(command)) return shimCache.get(command);

  let resolved = null;
  try {
    const whereResult = await spawn("where", [command]);
    const cmdPath = whereResult.stdout
      .split("\n")
      .map((l) => l.trim())
      .find((p) => p.toLowerCase().endsWith(".cmd"));
    if (cmdPath) {
      const content = await readFile(cmdPath, "utf8");
      const match = content.match(/"%dp0%\\?([^"]+\.c?js)"/i);
      if (match) resolved = { script: path.join(path.dirname(cmdPath), match[1]) };
    }
  } catch {
    // where.exe failed or the shim doesn't match npm's usual pattern — fall
    // back to spawning the original command unchanged.
  }
  shimCache.set(command, resolved);
  return resolved;
}

async function runCli(command, args, { cwd, timeoutMs, logLabel } = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs)
    : null;

  await mkdir(LOG_DIR, { recursive: true });
  const logFile = path.join(LOG_DIR, `${logLabel ?? command}-${Date.now()}-${process.pid}.log`);
  const logStream = createWriteStream(logFile, { flags: "a" });
  logStream.write(`$ ${command} ${args.join(" ")}\n${cwd ? `cwd: ${cwd}\n` : ""}\n`);

  const shim = await resolveWindowsCmdShim(command);
  if (shim) logStream.write(`(bypassing .cmd shim, invoking node "${shim.script}" directly)\n`);
  const [spawnCommand, spawnArgs] = shim ? ["node", [shim.script, ...args]] : [command, args];

  // stdio: give the child an already-closed stdin. Several of these CLIs
  // (codex, opencode) block waiting for stdin EOF even when a prompt is
  // passed as an argument — closing stdin up front avoids that hang.
  const subprocess = spawn(spawnCommand, spawnArgs, { cwd, signal: controller.signal, stdio: ["ignore", "pipe", "pipe"] });

  // Consuming subprocess.stdout/.stderr as async iterables drains them, so the
  // Result/SubprocessError's own .stdout/.stderr come back empty afterward —
  // these accumulated buffers are the real source of truth from here on.
  let stdoutBuf = "";
  let stderrBuf = "";
  const teeStdout = (async () => {
    for await (const line of subprocess.stdout) {
      stdoutBuf += line + "\n";
      logStream.write(`[stdout] ${line}\n`);
    }
  })();
  const teeStderr = (async () => {
    for await (const line of subprocess.stderr) {
      stderrBuf += line + "\n";
      logStream.write(`[stderr] ${line}\n`);
    }
  })();

  try {
    await subprocess;
    await Promise.allSettled([teeStdout, teeStderr]);
    logStream.end("\n[done] exit 0\n");
    return { ok: true, code: 0, stdout: stdoutBuf, stderr: stderrBuf, timedOut: false, spawnError: null, logFile };
  } catch (err) {
    await Promise.allSettled([teeStdout, teeStderr]);
    if (err instanceof SubprocessError) {
      logStream.end(`\n[failed] exit ${err.exitCode ?? "?"}${timedOut ? " (timed out)" : ""}\n`);
      return {
        ok: false,
        code: err.exitCode ?? null,
        stdout: stdoutBuf,
        stderr: stderrBuf,
        timedOut,
        spawnError: timedOut ? null : err.cause?.message ?? err.message,
        logFile,
      };
    }
    logStream.end(`\n[spawn error] ${err.message}\n`);
    return { ok: false, code: null, stdout: stdoutBuf, stderr: stderrBuf, timedOut, spawnError: err.message, logFile };
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

// ---------------------------------------------------------------------------
// Adapter registry. Each adapter knows how to run ONE cli non-interactively.
// Adding support for a new CLI coding agent means adding one entry here —
// the generic tools below (list_available_clis / agent_delegate /
// agent_list_sessions) never need to change.
//
// Adapter shape:
//   id, label, bin
//   checkAvailable()                         -> Promise<boolean>
//   buildRun({ prompt, cwd, permission, model, session_id, fork })
//                                             -> { args, warnings }
//   extractResult(stdout)                    -> { sessionId, text, warnings, usage }
//   listSessions(max_count)                  -> Promise<{ sessions, warning }> | null if unsupported
//   permissions: array of accepted `permission` values, first is the default
// ---------------------------------------------------------------------------

function extractCodexEvents(stdout) {
  const events = parseJsonLines(stdout);
  let sessionId = null;
  let text = "";
  const warnings = [];
  let usage = null;
  for (const ev of events) {
    if (ev.type === "thread.started") sessionId = ev.thread_id;
    if (ev.type === "item.completed" && ev.item) {
      if (ev.item.type === "agent_message" && typeof ev.item.text === "string") text += ev.item.text;
      else if (ev.item.type === "error") warnings.push(ev.item.message);
    }
    if (ev.type === "turn.completed") usage = ev.usage ?? usage;
    if (ev.type === "turn.failed") warnings.push(JSON.stringify(ev.error ?? ev));
  }
  return { sessionId, text, warnings, usage };
}

function extractOpencodeEvents(stdout) {
  const events = parseJsonLines(stdout);
  let sessionId = null;
  let text = "";
  const warnings = [];
  let usage = null;
  for (const ev of events) {
    if (ev.sessionID) sessionId = ev.sessionID;
    if (ev.type === "text" && ev.part?.text) text += ev.part.text;
    if (ev.type === "error" && ev.error) warnings.push(ev.error.message ?? JSON.stringify(ev.error));
    if (ev.type === "step_finish" && ev.part) {
      usage = { tokens: ev.part.tokens ?? null, cost: ev.part.cost ?? null };
    }
  }
  return { sessionId, text, warnings, usage };
}

// Qwen Code's --output-format stream-json is JSONL of message events, the last
// of which is `{type:"result", subtype:"success"|..., result, session_id, usage}`.
function extractQwenEvents(stdout) {
  const events = parseJsonLines(stdout);
  let sessionId = null;
  let text = "";
  const warnings = [];
  let usage = null;
  for (const ev of events) {
    if (ev.session_id) sessionId = ev.session_id;
    if (ev.type === "result") {
      if (!ev.is_error && typeof ev.result === "string") text += ev.result;
      else if (ev.is_error) warnings.push(ev.error?.message ?? JSON.stringify(ev));
      usage = ev.usage ?? usage;
    }
  }
  return { sessionId, text, warnings, usage };
}

// Antigravity's --output-format json prints a single envelope (not NDJSON),
// but it's exactly one line so the existing line-based parser still works.
function extractAntigravityEvents(stdout) {
  const events = parseJsonLines(stdout);
  let sessionId = null;
  let text = "";
  const warnings = [];
  let usage = null;
  for (const ev of events) {
    if (ev.conversation_id) sessionId = ev.conversation_id;
    if (typeof ev.response === "string") text += ev.response;
    if (ev.status && ev.status !== "SUCCESS") warnings.push(ev.error ? JSON.stringify(ev.error) : `status: ${ev.status}`);
    if (ev.usage) usage = ev.usage;
  }
  return { sessionId, text, warnings, usage };
}

// Codex has no non-interactive session-list command (`codex agents`/`resume --all`
// are TUI pickers only), so this reads its own on-disk index directly. That index
// is an append-only log — one line per time a thread's title/timestamp changed —
// so we fold it by id, keeping the last (most recent) entry per id. This is an
// undocumented internal file; if a future Codex version changes its shape or
// location, this degrades to an empty list with a warning rather than throwing.
async function listCodexSessions(max_count) {
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
    .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))
    .slice(0, max_count ?? 20);

  return { sessions, warning: null };
}

// Shared by opencode and kilo (kilo's CLI is a direct fork of opencode's, same
// `session list --format json` shape).
function makeOpencodeStyleSessionLister(bin) {
  return async function listSessions(max_count) {
    const result = await runCli(bin, ["session", "list", "--format", "json", "--max-count", String(max_count ?? 20)]);
    if (!result.ok) {
      return { sessions: [], warning: result.spawnError ?? `${bin} session list exited ${result.code}` };
    }
    if (!result.stdout.trim()) {
      return { sessions: [], warning: null }; // no sessions yet — prints nothing rather than "[]"
    }
    let raw;
    try {
      raw = JSON.parse(result.stdout);
    } catch (err) {
      return { sessions: [], warning: `Failed to parse session list JSON: ${err.message}` };
    }
    const sessions = raw.map((s) => ({
      id: s.id,
      title: s.title ?? null,
      cwd: s.directory ?? null,
      created_at: s.created ? new Date(s.created).toISOString() : null,
      updated_at: s.updated ? new Date(s.updated).toISOString() : null,
    }));
    return { sessions, warning: null };
  };
}
const listOpencodeSessions = makeOpencodeStyleSessionLister("opencode");
const listKiloSessions = makeOpencodeStyleSessionLister("kilo");

// qwen's `sessions list --json` prints JSONL (one transcript-summary object
// per line), not a JSON array — parseJsonLines already treats empty stdout
// (no sessions yet) as an empty list with no special-casing needed.
async function listQwenSessions(max_count) {
  const result = await runCli("qwen", ["sessions", "list", "--limit", String(max_count ?? 20), "--json"]);
  if (!result.ok) {
    return { sessions: [], warning: result.spawnError ?? `qwen sessions list exited ${result.code}` };
  }
  const raw = parseJsonLines(result.stdout);
  const sessions = raw.map((s) => ({
    id: s.sessionId ?? null,
    title: s.customTitle ?? s.prompt ?? null,
    cwd: s.cwd ?? null,
    created_at: s.startTime ?? null,
    updated_at: s.mtime ?? null,
  }));
  return { sessions, warning: null };
}

const ADAPTERS = {
  codex: {
    id: "codex",
    label: "Codex CLI",
    bin: "codex",
    permissions: ["read-only", "workspace-write", "danger-full-access"],
    async checkAvailable() {
      const r = await runCli("codex", ["--version"], { timeoutMs: 10000, logLabel: "codex-check" });
      return r.ok;
    },
    buildRun({ prompt, cwd, permission, model, session_id, fork }) {
      const warnings = [];
      const args = ["exec"];
      if (session_id) {
        args.push(fork ? "fork" : "resume", session_id, prompt, "--json", "--skip-git-repo-check");
        if (model) args.push("--model", model);
        if (permission || cwd) {
          warnings.push(
            "permission/cwd are ignored when continuing via session_id (codex exec resume/fork don't accept " +
              "them); the thread keeps whatever sandbox/cwd it was created with."
          );
        }
      } else {
        args.push(prompt, "--json", "--skip-git-repo-check", "--sandbox", permission ?? "read-only");
        if (model) args.push("--model", model);
        if (cwd) args.push("-C", cwd);
      }
      return { args, warnings };
    },
    extractResult: extractCodexEvents,
    listSessions: listCodexSessions,
  },
  opencode: {
    id: "opencode",
    label: "OpenCode CLI",
    bin: "opencode",
    permissions: ["read-only", "workspace-write"],
    async checkAvailable() {
      const r = await runCli("opencode", ["--version"], { timeoutMs: 10000, logLabel: "opencode-check" });
      return r.ok;
    },
    buildRun({ prompt, cwd, permission, model, agent, session_id, fork }) {
      const args = ["run", prompt, "--format", "json"];
      if (session_id) {
        args.push("--session", session_id);
        if (fork) args.push("--fork");
      }
      if (model) args.push("--model", model);
      if (agent) args.push("--agent", agent);
      if (cwd) args.push("--dir", cwd);
      if (permission === "workspace-write") args.push("--auto");
      return { args, warnings: [] };
    },
    extractResult: extractOpencodeEvents,
    listSessions: listOpencodeSessions,
  },
  qwen: {
    id: "qwen",
    label: "Qwen Code CLI",
    bin: "qwen",
    permissions: ["read-only", "workspace-write", "danger-full-access"],
    async checkAvailable() {
      const r = await runCli("qwen", ["--version"], { timeoutMs: 10000, logLabel: "qwen-check" });
      return r.ok;
    },
    buildRun({ prompt, cwd, permission, model, fork, session_id }) {
      const warnings = [];
      // approval-mode maps loosely to Codex's three-tier sandbox concept: plan
      // (won't act) / auto-edit (can write files) / yolo (approve everything).
      const approvalMap = { "read-only": "plan", "workspace-write": "auto-edit", "danger-full-access": "yolo" };
      const args = ["-p", prompt, "--output-format", "stream-json", "--approval-mode", approvalMap[permission ?? "read-only"] ?? "plan"];
      if (session_id) {
        args.push("--resume", session_id);
        if (fork) warnings.push("fork is not confirmed supported for qwen; resuming in place instead.");
      }
      if (model) warnings.push("model override is not confirmed supported for qwen; ignored.");
      return { args, warnings };
    },
    extractResult: extractQwenEvents,
    listSessions: listQwenSessions,
  },
  // Note: observed hanging (never exiting) after a provider auth error rather
  // than failing fast like the others — the timeout reclaims it correctly,
  // but expect auth failures here to surface only once timeout_ms elapses.
  kilo: {
    id: "kilo",
    label: "Kilo Code CLI",
    bin: "kilo",
    permissions: ["read-only", "workspace-write"],
    async checkAvailable() {
      const r = await runCli("kilo", ["--version"], { timeoutMs: 10000, logLabel: "kilo-check" });
      return r.ok;
    },
    buildRun({ prompt, cwd, permission, model, agent, session_id, fork }) {
      const warnings = [];
      const args = ["run", prompt, "--format", "json"];
      if (session_id) {
        args.push("--session", session_id);
        if (fork) args.push("--fork");
      }
      if (permission === "workspace-write") args.push("--auto");
      if (model) warnings.push("model override is not confirmed supported for kilo; ignored.");
      if (agent) warnings.push("agent is not confirmed supported for kilo; ignored.");
      return { args, warnings };
    },
    extractResult: extractOpencodeEvents, // kilo's CLI is a direct fork of opencode's — identical event shape
    listSessions: listKiloSessions,
  },
  antigravity: {
    id: "antigravity",
    label: "Antigravity CLI (agy)",
    bin: "agy",
    permissions: ["read-only", "workspace-write", "danger-full-access"],
    async checkAvailable() {
      const r = await runCli("agy", ["--version"], { timeoutMs: 10000, logLabel: "antigravity-check" });
      return r.ok;
    },
    buildRun({ prompt, cwd, permission, model, session_id, fork }) {
      const warnings = [];
      const args = ["-p", prompt, "--output-format", "json"];
      if (session_id) {
        args.push("--conversation", session_id);
        if (fork) warnings.push("fork is not confirmed supported for antigravity; continuing the existing conversation instead.");
        if (permission) warnings.push("permission is ignored when continuing via session_id for antigravity (unconfirmed whether resume accepts mode/sandbox flags, so they're not sent).");
      } else if (permission === "danger-full-access") {
        args.push("--dangerously-skip-permissions");
      } else {
        const modeMap = { "read-only": "plan", "workspace-write": "accept-edits" };
        args.push(`--mode=${modeMap[permission ?? "read-only"] ?? "plan"}`);
        args.push("--sandbox");
      }
      if (model) warnings.push("model override is not confirmed supported for antigravity; ignored.");
      return { args, warnings };
    },
    extractResult: extractAntigravityEvents,
    // No real non-interactive session history exists for antigravity — only a
    // last-conversation-per-workspace cache file, not a log. Left unsupported
    // rather than guessing that file's exact shape.
    listSessions: null,
  },
};

// Shared core so every CLI's delegate call and every safety guarantee (default
// read-only permission, warnings on dropped flags) runs through identical logic.
async function delegateTo(adapter, { prompt, cwd, permission, model, agent, session_id, fork, timeoutMs }) {
  const effectiveTimeout = timeoutMs ?? 300000;
  const { args, warnings } = adapter.buildRun({ prompt, cwd, permission, model, agent, session_id, fork });
  const result = await runCli(adapter.bin, args, { cwd, timeoutMs: effectiveTimeout, logLabel: adapter.id });
  const parsed = adapter.extractResult(result.stdout);

  // A CLI can ignore its own --format/--output-format json flag under some
  // conditions (observed live: opencode fell back to plain text with a
  // free-tier model) and print an unparseable plain-text answer instead.
  // parseJsonLines silently skips non-JSON lines, so zero JSON events parsed
  // at all (not just zero with a text field) means the output likely wasn't
  // JSON in the first place — fall back to the raw stdout as the answer
  // rather than reporting a false empty/failed result.
  let text = parsed.text;
  const warningsOut = [...warnings, ...parsed.warnings];
  if (!text && result.ok && result.stdout.trim() && parseJsonLines(result.stdout).length === 0) {
    text = result.stdout.trim();
    warningsOut.push(`${adapter.label}'s output wasn't valid JSON despite requesting it — falling back to raw stdout as the answer.`);
  }

  return {
    ok: result.ok && text.length > 0,
    cli: adapter.id,
    session_id: parsed.sessionId ?? session_id ?? null,
    text,
    warnings: warningsOut,
    usage: parsed.usage,
    permission: session_id ? null : permission ?? adapter.permissions[0],
    timed_out: result.timedOut,
    exit_code: result.code ?? null,
    spawn_error: result.spawnError ?? null,
    stderr_tail: result.stderr ? result.stderr.slice(-2000) : "",
    log_file: result.logFile,
  };
}

const server = new McpServer({ name: "agent-bridge", version: "0.2.0" });

server.registerTool(
  "list_available_clis",
  {
    title: "Detect which CLI coding agents are installed",
    description:
      "Probe every CLI coding agent this plugin knows how to drive (currently: codex, opencode, qwen, kilo, " +
      "antigravity) and report " +
      "which ones are actually installed on this machine, plus each available one's most recently updated " +
      "session (if it supports session listing) so a prior conversation can be offered as a 'continue' option. " +
      "Always call this before asking the user which CLI(s) to delegate to — don't assume a fixed set is " +
      "installed.",
    inputSchema: {},
  },
  async () => {
    const results = await Promise.all(
      Object.values(ADAPTERS).map(async (adapter) => {
        const available = await adapter.checkAvailable();
        if (!available) return { id: adapter.id, label: adapter.label, available: false };
        const sessionsSupported = typeof adapter.listSessions === "function";
        let mostRecentSession = null;
        let sessionsWarning = null;
        if (sessionsSupported) {
          const { sessions, warning } = await adapter.listSessions(1);
          mostRecentSession = sessions[0] ?? null;
          sessionsWarning = warning;
        }
        return {
          id: adapter.id,
          label: adapter.label,
          available: true,
          permissions: adapter.permissions,
          sessions_supported: sessionsSupported,
          most_recent_session: mostRecentSession,
          sessions_warning: sessionsWarning,
        };
      })
    );
    const payload = { ok: true, clis: results };
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
  }
);

server.registerTool(
  "agent_delegate",
  {
    title: "Delegate a task to a CLI coding agent",
    description:
      "Run the given CLI coding agent non-interactively on a task and return its final answer as text — call " +
      "list_available_clis first to see which cli values are actually installed on this machine. Each CLI " +
      "keeps its own conversation state: pass session_id (the session_id returned from a prior agent_delegate " +
      "call to the SAME cli) to continue that exact conversation with full prior context, or set fork:true " +
      "alongside it to branch a new session off that point instead of continuing in place. permission and cwd " +
      "only take effect when starting a NEW session (no session_id) for CLIs whose resume mechanism doesn't " +
      "accept them (e.g. Codex) — a continued session keeps whatever permission/cwd it was created with, and " +
      "a warning is returned if this was silently dropped. permission defaults to that CLI's most restrictive " +
      "option ('read-only' for both codex and opencode currently) — never escalate to a write-enabled or " +
      "full-access permission unless the task genuinely requires editing files or the user explicitly asks for " +
      "unsandboxed execution. The response includes log_file: a path this call's raw stdout/stderr was " +
      "streamed to live as the CLI ran, so the user can tail it in another terminal " +
      "(`Get-Content -Wait <path>` / `tail -f <path>`) to watch it happen in real time instead of waiting for " +
      "the final result.",
    inputSchema: {
      cli: z.enum(Object.keys(ADAPTERS)).describe("Which CLI coding agent to delegate to"),
      prompt: z.string().describe("The task or instructions to send"),
      cwd: z.string().optional().describe("Working directory the agent should treat as its workspace root"),
      permission: z
        .string()
        .optional()
        .describe(
          "Permission level for this run — accepted values vary per cli (codex: read-only/workspace-write/" +
            "danger-full-access; opencode: read-only/workspace-write). Defaults to the most restrictive option."
        ),
      model: z.string().optional().describe("Override model, if the cli supports it"),
      agent: z.string().optional().describe("Named sub-agent profile, if the cli supports it (opencode only)"),
      session_id: z.string().optional().describe("session_id from a previous agent_delegate call to the SAME cli, to continue that conversation"),
      fork: z.boolean().optional().describe("If session_id is set, fork into a new session instead of resuming in place. Default: false"),
      timeout_ms: z.number().optional().describe("Kill the CLI if it runs longer than this. Default: 300000 (5 min)"),
    },
  },
  async ({ cli, prompt, cwd, permission, model, agent, session_id, fork, timeout_ms }) => {
    const adapter = ADAPTERS[cli];
    if (!adapter) {
      const payload = { ok: false, spawn_error: `Unknown cli '${cli}'. Known: ${Object.keys(ADAPTERS).join(", ")}` };
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
    }
    const payload = await delegateTo(adapter, { prompt, cwd, permission, model, agent, session_id, fork, timeoutMs: timeout_ms });
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
  }
);

server.registerTool(
  "agent_list_sessions",
  {
    title: "List sessions for a CLI coding agent",
    description:
      "List a CLI coding agent's existing sessions (id, title, timestamps), most recently updated first — " +
      "including sessions created outside this plugin (e.g. from that CLI's own interactive use). Use this to " +
      "find the right session_id for agent_delegate when it isn't already in this conversation (e.g. after " +
      "compaction, or in a fresh conversation). Not every cli supports this — check sessions_supported from " +
      "list_available_clis first, or check the ok field here.",
    inputSchema: {
      cli: z.enum(Object.keys(ADAPTERS)).describe("Which CLI coding agent's sessions to list"),
      max_count: z.number().optional().describe("Max sessions to return. Default: 20"),
    },
  },
  async ({ cli, max_count }) => {
    const adapter = ADAPTERS[cli];
    if (!adapter) {
      const payload = { ok: false, sessions: [], count: 0, warning: `Unknown cli '${cli}'. Known: ${Object.keys(ADAPTERS).join(", ")}` };
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
    }
    if (typeof adapter.listSessions !== "function") {
      const payload = { ok: false, sessions: [], count: 0, warning: `${adapter.label} does not support non-interactive session listing.` };
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
    }
    const { sessions, warning } = await adapter.listSessions(max_count ?? 20);
    const payload = { ok: warning === null, sessions, count: sessions.length, warning };
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
