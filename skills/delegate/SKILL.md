---
name: delegate
description: Guided, menu-driven flow for delegating work across every installed CLI coding agent (and optionally Claude itself) — detects what's installed, asks which workers to use and which session to continue for each, then asks how to delegate (a plain task to one or all workers, a lanes-split job spread across the chosen workers, or a compare across them). Use when the user types /agent-bridge:delegate, or asks to delegate/hand off/send work through a menu rather than a one-off ask.
argument-hint: "[optional task description]"
---

This command exists to make the *right* worker(s) — not necessarily you — do the work, through an explicit menu, every single time it's invoked, including when the task looks trivial enough to answer yourself. **Never answer the task directly and never skip straight to a tool call.** Run every step below, in order, with no shortcuts for simplicity. If a user typed `/agent-bridge:delegate`, they typed it *because* they want the menu.

Run this as a multi-step guided flow using the AskUserQuestion tool. If AskUserQuestion isn't available in this environment (e.g. headless/print mode), ask the same questions as plain text and stop there for this turn — do not guess an answer and proceed, and do not fall back to answering the task yourself.

## 1. Detect what's available

Call `list_available_clis`. This tells you which CLIs are actually installed on this machine right now (never assume a fixed set) and, for each one that supports it, its most recently updated session.

## 2. Pick the worker pool

Ask a multi-select AskUserQuestion: "Which workers would you like to delegate to?" with one option per CLI `list_available_clis` reported as `available: true`, plus one more option: "Include Claude (this session)". If `list_available_clis` found nothing installed, skip this question and proceed with Claude as the only worker.

**AskUserQuestion allows at most 4 options per question.** If the available-CLI count plus the Claude option exceeds 4, split it into multiple sequential AskUserQuestion calls up front (e.g. "(1/2)"/"(2/2)" in the question text) rather than trying to fit them all in one call — don't find this out by hitting an error first.

The set the user picks here — one or more CLIs, optionally plus Claude — is "the pool" for the rest of this flow. Every later step (session picks, Lanes assignment, Compare, Plain task) only ever uses workers from this pool.

## 3. Pick a session, per CLI in the pool

For each CLI (not Claude — it has no session concept here) in the pool, call `agent_list_sessions` with `cli` set to it and `max_count: 3`. Ask an AskUserQuestion per CLI: "Which <CLI label> session?" with:
- Option 1 (recommended): "Start a new session"
- Then up to 3 more options, one per returned session — label with the (truncated) title, description with the id and `updated_at`.

If a CLI doesn't support session listing (e.g. Antigravity) or the list comes back empty, skip its question and treat it as "new session."

## 4. Pick how to delegate

Ask an AskUserQuestion: "What would you like to delegate?" with:
- **Plain task (Recommended)** — send one task to some or all of the pool.
- **Lanes** — split a larger backlog into non-overlapping lanes, then run every lane in parallel across whichever pool members fit each lane best.
- **Compare** — send the same prompt to every pool member and show all the answers side by side.

Tell the user up front: **Compare and Lanes both ignore the step-3 sessions** — Compare always starts fresh on every pool member for a fair comparison, and Lanes starts a fresh session per delegated lane since each needs to run independently. Step-3 sessions only carry into the Plain task branch.

## 5a. Plain task

If there's no task yet (not in `$ARGUMENTS`, not said in this conversation), ask for it. Then ask: "Send this to a single worker, or to all of them?"
- **Single worker**: ask which one from the pool (skip this sub-question if the pool only has one member). Call `agent_delegate` for that CLI (passing its step-3 `session_id` if one was picked; omit for "new"), or answer directly yourself if Claude was picked.
- **All workers**: run the SAME full task independently on every pool member in parallel — not a lanes split, every worker gets the whole task. Delegated members use their step-3 session if one was picked; Claude (if in the pool) does the task directly, in parallel with the others rather than waiting on them.

Report back grouped by worker: which worker, its answer, and (for delegated ones) `session_id`/`log_file` for follow-up.

## 5b. Lanes

Ask the user to describe the backlog to split, if it isn't already clear. Invoke the `lanes` skill on that description. For each lane it produces, assign it to whichever pool member fits best — using judgment (a lane that benefits from context you already have is a good fit for yourself if Claude is in the pool; a lane you want a different model's take on, or want to genuinely run in parallel with your own attention, goes to whichever CLI in the pool suits it). State the lane → worker assignment to the user before running, so they can redirect it if you got it wrong.

Then dispatch every lane at once, in parallel:
- **Your own lane(s)** (if Claude is in the pool and got one): do the work directly with your normal tools.
- **Each delegated lane**: call `agent_delegate` with that lane's CLI, `permission: "workspace-write"`, `cwd` set to that lane's scope, and no `session_id` (fresh session per lane — lanes only guarantees no file overlap between *different* lanes, not shared context across calls). Give it a clear, complete instruction in the prompt — what to do, any constraints, and what to report back when done — since it has no access to this conversation beyond what you put there.

Once every lane finishes (including your own), **review the delegated lanes' work before reporting done** — don't just relay each CLI's own self-reported summary uncritically. At minimum, read back the files that lane was supposed to touch and check they match what was asked and don't touch anything outside that lane's scope; flag anything that looks wrong rather than passing it through. Report back grouped by lane: lane name, which worker handled it, a summary of what happened, your own check of the result, and — for delegated lanes — the `session_id` and `log_file`.

## 5c. Compare

If there's no prompt yet, ask for it. Call `agent_delegate` once per CLI in the pool with `permission: "read-only"` (always — Compare never writes), in parallel, and answer the same prompt yourself directly if Claude is in the pool. Present every answer clearly labeled by worker, side by side — call out where they agree or differ, don't just concatenate them. If the user actually wants edits made based on what Compare showed, follow up with a real `agent_delegate` (or do it yourself) rather than trying to get Compare to do it.
