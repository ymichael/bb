# Goal

Define the definitive set of hero workflows that a project manager must handle well. These workflows drive prompt quality, CLI requirements, and backend capabilities. If a workflow can't be done cleanly, that's a gap to close.

# Workflows

## Tier 1 — Must work well for V1

### W1: Simple delegation

User gives a task, manager spawns a worker, worker completes, manager reviews and reports back.

- User: "Fix the login redirect bug"
- Manager: scopes the task, spawns a worker thread, waits for completion, reviews the result, updates the user via `message_user`.

**What this tests:** Basic spawn → wait → review → report loop. The foundation everything else builds on.

**Status:** Prompt and CLI ready. Needs behavioral QA.

---

### W2: Pipeline workflow (coding → review → feedback loop)

User sets up a workflow: after coding work is done, a separate thread should review it, the manager triages the review, and feeds actionable comments back to the original thread.

- User: "After coding work is done, I want a review thread to check it. Triage the review and send feedback back to the original thread."
- Manager: spawns coding worker → on completion, spawns a review thread in the **same environment/worktree** → triages review output → sends follow-up to original coding thread with actionable items → repeats if needed.

**What this tests:**
- Multi-step chained delegation
- Environment reuse across threads (review thread needs the coding thread's worktree)
- Manager as triage layer between threads
- Iterative follow-up to an existing thread

**Status:** Environment reuse, prompt guidance, and preference storage all addressed. Needs behavioral QA.

---

### W3: Mid-flight takeover with goals

User started a thread directly, now wants the manager to take over, monitor it toward a specific goal, and kick off follow-on workflows when the goal is reached.

- User: "I started this thread working on the API migration. Take it over and let me know when the endpoints are all converted. Then run our review workflow on it."
- Manager: takes ownership (`bb thread update --parent-thread`), monitors the thread, evaluates whether the goal is met when the thread completes or goes idle, then kicks off the configured follow-on workflow (e.g., review).

**What this tests:**
- Thread takeover from user
- Goal-based evaluation (not just "is it idle" but "did it achieve X")
- Chaining into follow-on workflows after goal is met
- Manager remembering configured workflows from preferences

**Status:** Prompt guidance added. Needs behavioral QA.

---

### W4: Status survey

User comes back and asks "what's going on?" Manager needs to quickly survey all managed threads and give a useful summary.

- User: "What's the status of everything?"
- Manager: lists managed threads, checks status of each, synthesizes a summary grouped by active/completed/blocked.

**What this tests:**
- Efficient multi-thread inspection
- Synthesis and summarization
- Not just dumping raw status but giving an actionable overview

**Status:** CLI gaps (`--json`, `--include-work-status`) and prompt guidance all addressed. Needs behavioral QA.

---

### W5: Iterative follow-up

Work is mostly done but needs adjustments. Manager sends follow-up instructions to an existing worker rather than spawning a new one.

- User: "That looks good but can you also add tests?"
- Manager: identifies the relevant worker thread, sends a follow-up via `bb thread tell`, waits for completion, reviews and reports.

**What this tests:**
- Reusing existing threads instead of always spawning new ones
- Knowing when to follow up vs when to spawn fresh
- Correct thread identification from context

**Status:** CLI and prompt ready. Needs behavioral QA.

---

### W6: Multiple independent tasks

User gives the manager several things to do. Manager spawns multiple workers, tracks them independently, reports on each as they finish.

- User: "Fix the login bug, add the settings page, and update the README."
- Manager: spawns 3 workers, reports on each as they complete, doesn't block one on another.

**What this tests:**
- Parallel task management
- Independent tracking and reporting
- Not serializing work unnecessarily

**Status:** Prompt guidance added. Needs behavioral QA.

---

### W7: Worker error or question

A worker thread errors out or reaches a point where it needs clarification. Manager needs to find out, diagnose, and decide what to do.

- Worker hits an error or goes idle with a question.
- Manager receives a system notification, inspects the thread, decides whether to retry, send more context, or escalate to the user.

**What this tests:**
- Error handling and recovery
- Manager as a triage layer between worker problems and user attention
- Deciding what's worth escalating vs handling autonomously

**Status:** Prompt guidance added. Notification → turn trigger still needs verification during QA.

---

## Tier 2 — Important for V1 quality

### W8: Plan → parallel execution

User has a thread with a plan. They want the manager to take the plan, break it into parallelizable units, and fan out across multiple workers to speed up completion while avoiding conflicts.

- User: "This thread has a plan for the refactor. Can you take it and parallelize the work?"
- Manager: reads the plan, identifies independent work units, identifies dependencies and potential file conflicts, spawns workers for independent units, sequences dependent work, coordinates merging.

**What this tests:**
- Plan decomposition and dependency analysis
- Parallel fan-out with conflict awareness
- Coordination across multiple workers touching related code
- Sequencing dependent work correctly

**Status:** Prompt guidance added (including worktree merge conflict awareness). Needs behavioral QA.

---

### W9: Retrospective / learning

User asks the manager to look through recent work, extract learnings, and propose improvements.

- User: "Look through the threads from the past day and see if there are patterns we should improve in our workflow or codebase."
- Manager: lists recent threads, inspects their logs/output, synthesizes learnings, writes a report to workspace, shares via `message_user`. May delegate the analysis to a worker thread.

**What this tests:**
- Historical thread inspection
- Synthesis across multiple threads
- Deliverable creation (report in workspace)
- Meta-work about the work itself

**Status:** CLI gaps (`--include-archived`) and prompt guidance addressed. Thread time-range filtering deferred (low priority). Needs behavioral QA.

---

### W10: Cross-manager coordination

Manager asks another project's manager for context — preferences, working style, past decisions.

- User: "Ask my other project's manager how I like my commit messages."
- Manager: identifies the other manager, sends a message via `bb thread tell`, reads the response, applies the context.

**What this tests:**
- Cross-project manager discovery
- Inter-manager communication
- Context sharing without the user repeating themselves

**Status:** Inter-agent messaging deferred (CLI `bb thread tell` covers V1). Prompt guidance added. Response loop remains awkward — the sending manager can't cleanly read the reply. Needs behavioral QA.

---

### W11: Manager memory across sessions

User comes back days later. Manager should remember preferences, past work patterns, and what threads are still relevant.

- User returns and says "let's pick up where we left off."
- Manager: reads `PREFERENCES.md`, checks active threads, gives a contextual summary.

**What this tests:**
- Durable memory via workspace files
- Session continuity
- Knowing what's still relevant vs stale

**Status:** `PREFERENCES.md` mechanism and prompt guidance in place. Needs behavioral QA on quality of recall.

---

# Status

All backend/CLI gaps and prompt gaps identified by these workflows have been addressed. This document is now a QA reference for manager behavioral testing (#17 in the punch list).

# Open Questions

- **Notification → turn:** When a managed thread completes, does the system message to the manager actually kick off a new manager turn, or does the manager only see it next time the user messages? This determines whether W7 error handling is proactive or reactive. Needs verification during QA.
