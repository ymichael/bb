# Manager V1 QA

Behavioral QA scenarios for the manager feature. Each scenario maps to a hero workflow (W1–W11) and tests whether the manager behaves correctly end-to-end.

## What shipped

| Item | What shipped |
|------|-------------|
| Multi-manager support | Multiple managers per project, hire always creates |
| Manager defaults | claude-code + opus-4-6, name input, improved modal |
| Manager @-mentions | Thread suggestion modes, type-aware rendering |
| Prompt quality | Hero workflows W1–W10, runtime context, sub-templates, Handlebars partials |
| Environment reuse | `bb thread spawn --environment <env-id>` |
| CLI audit | `--json` everywhere (enforced by test), `--self` flag, `bb guide`, `bb status` enrichment, show/status merge, steer merge, environment display, project CRUD |
| Templates | Auto-generated types, build-time variable validation, partials |
| UI | Surface language audit, sidebar cues, handoff actions, mention polish |

## Tier 1 scenarios — must pass

### W1: Simple delegation

**Setup:** Hire a manager for a project.

**Test:**
1. Ask the manager to fix a bug or implement a small feature
2. Verify: manager scopes the task, spawns a worker thread with `--title`
3. Verify: manager sends a kickoff update via `message_user`
4. Verify: manager waits for completion (no polling loops)
5. Verify: manager reviews the result and sends a completion update

**Anti-patterns to check:**
- Manager should not do the work directly in its own thread
- Manager should not poll `bb thread status` in a loop
- Manager should not send raw CLI output to the user

### W2: Pipeline workflow (coding → review → feedback)

**Setup:** Hire a manager. Tell it: "After coding work is done, I want a review thread to check it. Triage the review and send feedback back to the original thread."

**Test:**
1. Ask the manager to implement something
2. Verify: coding worker spawns and completes
3. Verify: manager spawns a review thread in the **same environment** (`--environment <env-id>`)
4. Verify: manager triages the review output
5. Verify: manager sends actionable feedback back to the coding thread via `bb thread tell`
6. Verify: manager stores the review workflow preference in `PREFERENCES.md`

**Key thing to verify:** The review thread can see the coding thread's files (environment reuse works).

### W3: Mid-flight takeover with goals

**Setup:** Start a thread directly (not via manager). Then ask the manager to take it over.

**Test:**
1. Say: "Take over this thread and let me know when X is done"
2. Verify: manager takes ownership with `bb thread update --parent-thread`
3. Verify: manager inspects the thread's current state
4. Verify: when the thread completes, manager evaluates whether the goal is met (not just idle status)
5. Verify: if goal met, manager kicks off follow-on workflows and updates the user

### W4: Status survey

**Setup:** Have a manager with several managed threads in various states.

**Test:**
1. Ask: "What's the status of everything?"
2. Verify: manager lists threads with `bb thread list --parent-thread <id> --json`
3. Verify: manager synthesizes a summary grouped by state (active/completed/blocked)
4. Verify: manager does NOT dump raw CLI output

### W5: Iterative follow-up

**Setup:** Manager has completed a task via a worker thread.

**Test:**
1. Say: "That looks good but can you also add tests?"
2. Verify: manager identifies the relevant existing thread
3. Verify: manager sends a follow-up via `bb thread tell` (not spawning a new thread)
4. Verify: manager reviews and reports on the follow-up result

### W6: Multiple independent tasks

**Setup:** Hire a manager.

**Test:**
1. Say: "Fix the login bug, add the settings page, and update the README"
2. Verify: manager spawns 3 separate worker threads (not serialized)
3. Verify: each thread gets a descriptive `--title`
4. Verify: manager reports on each as they complete (not waiting for all to finish)

### W7: Worker error

**Setup:** A managed worker thread hits an error.

**Test:**
1. Verify: manager receives a system notification about the error
2. Verify: manager inspects the thread with `bb thread show` and `bb thread log`
3. Verify: manager decides to retry, provide context, or escalate to the user
4. Verify: manager escalates when the error needs user input

**Open question to verify:** Does a worker error/completion actually trigger a new manager turn, or does the manager only see it on the next user message?

## Tier 2 scenarios — important for quality

### W8: Plan → parallel execution

**Test:**
1. Give the manager a plan and ask it to parallelize the work
2. Verify: manager identifies independent work units
3. Verify: manager spawns workers for independent units, sequences dependent ones
4. Verify: manager is aware that worktree merges can conflict

### W9: Retrospective / learning

**Test:**
1. After several tasks, ask: "Look through recent work and extract learnings"
2. Verify: manager lists recent threads and inspects logs
3. Verify: manager writes a report to its workspace
4. Verify: manager shares the report via `message_user`

### W10: Cross-manager coordination

**Test:**
1. Have managers in two projects
2. Ask one manager to check with the other about preferences
3. Verify: manager uses `bb thread tell` to message the other manager
4. Note: response loop is awkward in V1 — manager can't cleanly read the reply

### W11: Manager memory across sessions

**Test:**
1. Have a conversation with a manager, establish preferences
2. Verify: manager creates `PREFERENCES.md` with durable info
3. Start a new session with the same manager
4. Verify: manager reads preferences and applies them
5. Verify: manager can summarize active threads from prior sessions

## Anti-pattern checks

Run across all scenarios:

- Manager should not poll workers (`bb thread status` in a loop)
- Manager should not micromanage active threads
- Manager should not leave stale threads indefinitely
- Manager should not dump raw CLI output to the user
- Manager should use `message_user` for all user-facing output
- Manager should not do substantive coding work directly
