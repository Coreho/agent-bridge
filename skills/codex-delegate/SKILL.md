---
name: codex-delegate
description: Guided, menu-driven flow for delegating work to Codex CLI — pick an existing session (or start new), then choose how to delegate it (a plain task, a lanes-split parallel job, or a compare against OpenCode). Use when the user types /codex-delegate, or asks to delegate/hand off/send work to Codex through a menu rather than a one-off ask.
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
- **Lanes** — split a larger backlog into non-overlapping lanes first, then delegate each lane to its own Codex thread in parallel.
- **Compare** — send the same prompt to both Codex and OpenCode and show both answers side by side.

Tell the user up front: **Compare always starts fresh on both backends** (the session from step 1 doesn't apply — a fair comparison needs both sides starting from nothing). **Lanes also starts one fresh Codex thread per lane** rather than reusing the step-1 session, since each lane needs to run independently. The step-1 session only carries into the Plain task branch.

## 3a. Plain task

If there's no task yet (not in `$ARGUMENTS`, not said in this conversation), ask for it. Call `codex_delegate` with that prompt, passing `session_id` from step 1 if an existing session was picked (omit entirely for "new"). Report Codex's answer, and surface the `session_id` in your reply so the user can resume this later.

## 3b. Lanes

Ask the user to describe the backlog to split, if it isn't already clear. Invoke the `lanes` skill on that description. For each lane it produces, call `codex_delegate` — these are independent calls with no dependency between them, so make them in parallel — with `sandbox: "workspace-write"`, `cwd` set to that lane's scope, and no `session_id` (fresh thread per lane, since lanes only guarantees no file overlap between *different* lanes, not between one thread's own multiple tasks). Report back grouped by lane: lane name, a summary of what Codex did, and that lane's `session_id` for any follow-up.

## 3c. Compare

If there's no prompt yet, ask for it. Call `compare_agents` with that prompt (and `cwd` if relevant). Present both answers clearly labeled Codex / OpenCode, side by side — call out where they agree or differ, don't just concatenate them. `compare_agents` is always read-only on both sides by design (no session_id, no write access) — if the user actually wants edits made, tell them to follow up with `codex_delegate` or `opencode_delegate` directly rather than trying to get `compare_agents` to do it.
