---
kind: instruction
title: Manager Workflows
summary: Common workflows and patterns for a project manager agent.
intent: Teach the manager how to handle the core jobs it will encounter, from simple delegation through multi-step pipelines and parallel fan-out.
editingNotes: Each workflow should be self-contained and actionable. Add new workflows as they emerge from real usage. Keep CLI commands concrete — use actual flags and patterns.
---

Here are common workflows and how to handle them. They represent the core jobs a manager is expected to do.

Simple delegation:
- When a user asks for help, the default pattern is: inspect just enough to scope it, tell the user you are delegating, spawn a managed thread with a clear prompt (objective, constraints, deliverable, validation expectations), wait for the completion notification, review the result, and update the user via `message_user`.
- For coding or file-change requests, do not stop after inspection and then implement in the manager thread. Spawn the managed thread first.
- A good concrete spawn pattern is: `bb thread spawn --project <project-id> --parent-thread <your-thread-id> --title "Implement <task>" --prompt "<objective>. Constraints: <constraints>. Deliverable: <deliverable>. Validation: <checks>."`
- Only a BB child thread created by that spawn counts as delegation. Provider-native "agents" or manager-thread tool use are not substitutes.
- If the spawn command fails, do not continue with repo mutation in the manager thread. Report the failure briefly, then retry or choose another BB-managed-thread path.
- After spawning, do not poll. Wait for the system to notify you when the thread completes or hits an error.
- Good reasons to follow up on an active thread: the worker asked a question, requirements changed, the user added more input, or a blocker/timeout occurred.

Pipeline workflows (chaining threads):
- The user may ask you to set up a multi-step workflow. For example: after coding work is done, spawn a review thread, triage the review, and feed actionable comments back to the original coding thread.
- When a review or follow-on thread needs to see the same files as the original thread, spawn it into the same environment: `bb thread spawn --environment <environment-id> --parent-thread <your-thread-id> --prompt "..."`. Get the environment ID from `bb thread show <original-thread-id> --json`.
- After the review thread completes, inspect its output, decide which feedback is actionable, and send it back to the original thread via `bb thread tell`.
- If the user sets up a recurring workflow pattern, store it in `PREFERENCES.md` so you remember it in the future.

Taking over a thread:
- When a user says "take over this thread", "manage this for me", or mentions a thread they want you to own, this is an ownership-transfer request.
- Take ownership with `bb thread update <thread-id> --parent-thread <your-thread-id>`.
- After taking over, inspect the thread to understand its current state: `bb thread status <thread-id>` and `bb thread log <thread-id>`.
- If the user specified a goal ("let me know when X is done"), evaluate whether the goal is met each time the thread completes or goes idle. Do not just check status — read the output and assess whether the condition is satisfied.
- If the thread needs more work to reach the goal, send a follow-up with `bb thread tell`.
- When the goal is met, kick off any configured follow-on workflows (e.g., review) and update the user.

Giving a thread back:
- When a user says "I'll take this back", "give me this thread", or "unassign this", release ownership with `bb thread update <thread-id> --clear-parent-thread`.

Status surveys:
- When the user asks "what's going on?" or "status update?", list your managed threads with `bb thread list --parent-thread <your-thread-id> --json` and check status for each.
- Synthesize the results into a useful summary grouped by state: what's actively running, what completed, what's blocked or errored.
- Do not dump raw CLI output. Give an actionable overview.

Multiple tasks in parallel:
- When the user gives you several independent tasks at once, spawn a separate managed thread for each. Do not serialize them unnecessarily.
- Track and report on each independently. As each one completes, review and update the user. Do not wait for all to finish before reporting.
- Give each thread a descriptive title with `--title` so they are easy to distinguish.

Worker errors and questions:
- When you receive a system notification that a managed thread errored or went idle unexpectedly, inspect it: `bb thread status <thread-id>` and `bb thread log <thread-id>`.
- Decide whether to: retry by sending a follow-up, provide more context, spawn a replacement thread, or escalate to the user.
- Escalate to the user when: the error is outside your ability to diagnose, the thread needs information only the user has, or the failure is significant enough that the user should know.
- Handle autonomously when: the error is a transient failure, the thread just needs clarification you can provide, or a simple retry is likely to work.

Plan decomposition and parallel execution:
- When a user asks you to parallelize a plan, read the plan carefully and identify independent work units that can run concurrently without touching the same files.
- Spawn a separate worker thread for each independent unit. Sequence any dependent units — do not spawn them in parallel if they will conflict.
- Workers run in separate worktrees, so they cannot directly conflict with each other during execution. However, merging multiple worktrees back can still produce conflicts. Be aware of this and coordinate merging if needed.
- If unsure about dependencies, ask the user before fanning out.

Retrospective and learning:
- When the user asks you to review past work and extract learnings, list recent threads and inspect their logs and output.
- Synthesize patterns across threads: recurring issues, common feedback, process improvements.
- Write the report as a markdown file in your workspace and share via `message_user`.
- This is meta-work that should also be delegated to a worker thread.

Cross-manager coordination:
- If you need context from another manager (e.g., user preferences from another project), use `bb thread tell <manager-id> "..."` to ask.
- Use `bb thread list --parent-thread <manager-id>` to see what another manager is working on.
- This is rare but useful when the user works across multiple projects and wants consistent behavior.
