---
name: codex-delegate
description: Guided, menu-driven flow for delegating work — pick an existing Codex session (or start new), then choose how to delegate it (a plain task to Codex, a lanes-split job spread across Claude/Codex/OpenCode, or a compare against OpenCode). Use when the user types /codex-delegate, or asks to delegate/hand off/send work through a menu rather than a one-off ask.
argument-hint: "[optional task description]"
---

This command exists for exactly one reason: to make Codex (not you) do the work, through an explicit menu, every single time it's invoked — including when the task looks trivial enough that you could just answer it yourself. **Never answer the task directly. Never skip straight to calling `codex_delegate`.** Run the two menus below first, every time, with no exceptions for simplicity or triviality. If a user typed `/codex-delegate`, they typed it *because* they want the menu, not a shortcut around it.

Run this as a multi-step guided flow — don't collapse it into a single tool call. Follow these steps in order, using the AskUserQuestion tool for the two menus. If AskUserQuestion isn't available in this environment (e.g. headless/print mode), ask the same two questions as plain text and stop there for this turn — do not guess an answer and proceed, and do not fall back to answering the task yourself.

## 1. Pick a session

Call `codex_list_sessions` with `max_count: 5`. Build an AskUserQuestion with:
- Option 1 (recommended): "Start a new session"
- Then up to 3 more options, one per most-recently-updated session returned — label with the (truncated) title, description with the id and `updated_at`.

If `codex_list_sessions` comes back empty, skip the question entirely and proceed as "new session."

## 2. Pick how to delegate

Ask a second AskUserQuestion: "What would you like to delegate?" with these options:
- **Plain task (Recommended)** — send one task/prompt straight to Codex.
- **Lanes** — split a larger backlog into non-overlapping lanes first, then run every lane in parallel across whichever workers fit — you (Claude) directly, Codex, and/or OpenCode, mixed as needed.
- **Compare** — send the same prompt to both Codex and OpenCode and show both answers side by side.

Tell the user up front: **Compare always starts fresh on both backends** (the session from step 1 doesn't apply — a fair comparison needs both sides starting from nothing). **Lanes assigns each lane to whichever worker fits it best and runs all of them in parallel** — this is genuine cross-tool orchestration, not a Codex-only fan-out: a lane can go to you directly with no delegation at all, or to Codex/OpenCode as a fresh thread. The step-1 session only carries into the Plain task branch; it has no bearing on Lanes or Compare.

## 3a. Plain task

If there's no task yet (not in `$ARGUMENTS`, not said in this conversation), ask for it. Call `codex_delegate` with that prompt, passing `session_id` from step 1 if an existing session was picked (omit entirely for "new"). Report Codex's answer, and surface the `session_id` in your reply so the user can resume this later.

## 3b. Lanes

Ask the user to describe the backlog to split, if it isn't already clear. Invoke the `lanes` skill on that description. For each lane it produces, decide which worker should run it — **yourself** (edit the files directly with your own tools, no delegation at all), **`codex_delegate`**, or **`opencode_delegate`** — using judgment: a lane that's simple and benefits from the context you already have in this conversation is a good fit to keep for yourself; a lane you want a different model's take on, or want to genuinely run off your own attention in parallel, goes to Codex or OpenCode. State the lane → worker assignment to the user before running, so they can redirect it if you got it wrong.

Then run every lane at once, in parallel, regardless of which worker it went to — don't wait for delegated lanes to finish before starting your own, and don't wait for one delegated lane before starting another:
- **Your own lane(s)**: just do the work directly with your normal tools.
- **Codex lanes**: `codex_delegate` with `sandbox: "workspace-write"`, `cwd` set to that lane's scope, no `session_id` (fresh thread per lane — lanes only guarantees no file overlap between *different* lanes, not shared context across calls).
- **OpenCode lanes**: `opencode_delegate` with `auto_approve: true` (non-interactive — it needs write access and there's no one to approve a permission prompt), `cwd` set to that lane's scope, no `session_id`.

Report back grouped by lane: lane name, which worker handled it, a summary of what happened, and — for delegated lanes — the `session_id` (for follow-up) and `log_file` (so the user can tail it live or after the fact).

## 3c. Compare

If there's no prompt yet, ask for it. Call `compare_agents` with that prompt (and `cwd` if relevant). Present both answers clearly labeled Codex / OpenCode, side by side — call out where they agree or differ, don't just concatenate them. `compare_agents` is always read-only on both sides by design (no session_id, no write access) — if the user actually wants edits made, tell them to follow up with `codex_delegate` or `opencode_delegate` directly rather than trying to get `compare_agents` to do it.
