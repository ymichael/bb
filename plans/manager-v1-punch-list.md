# Goal

Consolidate remaining manager-agent work into a single actionable punch list for shipping a credible V1.

The core manager feature is implemented: data model, lifecycle, `message_user` tool, CLI commands, sidebar hierarchy, hire modal, manager prompt, and ownership handoff. This plan covers what's left to make V1 feel complete and coherent.

# Scope

In scope:

- Multi-manager support (remove single-manager assumption)
- Inter-agent / inter-manager communication primitives
- Manager default provider/model configuration
- Hire manager modal improvements
- Manager `@`-mention support
- Prompt and behavioral quality
- Thread lifecycle management (archival, clutter)
- UI surface language audit (thread vs manager copy)
- `@`-mention interaction polish
- Sidebar polish (collapsed-manager cues)
- UI handoff actions
- QA scenarios

Out of scope:

- Sub-managers (managers managing other managers hierarchically)
- Rich deliverable cards beyond file links
- Replacing the `bb` CLI with a separate manager control plane
- Full autonomous planning/memory systems

---

# Work Items

## P0 — Core V1 Gaps

### 1. Multi-manager support

Remove the `primaryManagerThreadId` single-manager assumption and allow multiple managers per project.

**Data model changes:**
- Drop `projects.primaryManagerThreadId` column
- Manager threads are already typed (`threads.type = "manager"`) and linked to a project via `threads.projectId` — this is sufficient for discovery
- Query managers per project by filtering threads where `type = "manager"` and `projectId = X` and not archived
- The hire route should always create a new manager (no "reopen existing" logic)

**API changes:**
- `POST /projects/:id/manager` → creates a new manager, returns it
- Add `GET /projects/:id/managers` → list active managers for a project
- Remove the "if existing manager, return it" guard from the hire route
- Keep stale/archived manager cleanup logic

**CLI changes:**
- `bb manager hire` → creates a new manager (prompt for name)
- `bb manager list [projectId]` → list managers for a project
- Existing `bb manager show/status/send/log/delete/threads` should work with manager IDs as-is

**UI changes:**
- Sidebar: show all managers for a project, each with their managed thread hierarchy underneath
- "Hire Manager" always creates a new one
- Remove any "reopen existing manager" UX paths

**App layout changes:**
- The `AppLayout` hire-manager button currently checks for an existing manager and either opens it or shows the modal — update to always show the modal (creating a new manager) while still listing existing managers in the sidebar

### 2. Inter-agent messaging tool

Add a first-class tool for threads and managers to message each other, beyond shelling out to `bb` CLI.

**Use cases:**
- Manager asks another manager about user preferences
- Worker thread escalates a question to its parent manager
- Manager sends follow-up instructions to a worker
- Cross-project manager coordination

**Design:**
- Add a `message_agent` custom tool available to manager threads (and optionally to managed worker threads)
- Parameters: `targetThreadId`, `message`
- Execution: delivers the message as a system event to the target thread, similar to `tell`
- The target thread sees it as a `[bb system]` message with sender context

**Subscription / notification model:**
- For parent-child (manager-worker), the existing `parentThreadId` completion notification works
- For peer messaging (manager-to-manager, worker-to-manager-of-another-project), the tool delivers a one-shot message — no persistent subscription needed in V1
- If the target thread is idle, the message queues as a pending turn trigger
- Prompt guidance should teach managers when to use `message_agent` vs waiting for completion signals

**Open question:** Should worker threads be able to message arbitrary threads, or only their parent manager? Start with parent-only for workers, any-manager for managers.

### 3. Manager default provider/model

Managers should default to a specific provider/model rather than inheriting the project default (which is optimized for worker threads).

**Current behavior:** Manager hire uses the project's `defaultProviderId` resolution chain (explicit → project default → system default). The system default picks the first available provider.

**Desired behavior:** Managers should default to `claude-code` provider with `claude-opus-4-6` model unless the user explicitly picks something else.

**Implementation:**
- In the hire route (`projects.ts`), if no explicit `providerId`/`model` is provided, default to `claude-code` + `claude-opus-4-6` (or the best available model from that provider)
- Fall back to the normal resolution chain if `claude-code` is not available
- The hire modal should pre-select this default rather than the first provider in the list

### 4. Hire manager modal improvements

Align with the commit/squash-merge modal pattern.

**Current state:** The modal has a provider/model picker and a hire button. No name input.

**Changes:**
- Add an optional text input for manager name (placeholder: "Manager", label: "Name")
- If provided, use it as the thread title instead of the hardcoded "Manager"
- Pre-select `claude-code` + `claude-opus-4-6` as the default provider/model
- Match the visual layout of the commit/squash-merge modals (input field above provider picker, consistent spacing and button treatment)

### 5. Manager `@`-mention support

Users should be able to `@`-mention managers in thread prompts (especially useful in manager-to-manager and thread-to-manager contexts).

**Implementation:**
- The `@`-mention suggestion source should include manager threads for the current project
- Manager suggestions should be visually distinct from file and regular thread suggestions (e.g., manager icon)
- Mentioning a manager should insert a thread reference token (same format as thread mentions)
- In manager threads, `@`-mentioning another manager should be a natural way to initiate the `message_agent` flow

### 6. Prompt quality pass

Validate and improve the manager prompt against the hero workflows defined in `plans/manager-hero-workflows.md`. If the manager doesn't understand bb, the CLI, and the system model, none of the UI work matters.

The prompt currently only teaches simple delegation (W1). It needs to cover:

- **Pipeline workflows (W2):** Chaining threads (code → review → feedback), reusing environments, triage between threads, storing workflow preferences for automatic reuse.
- **Mid-flight takeover with goals (W3):** Taking over a user's thread, evaluating goal completion (not just idle status), kicking off follow-on workflows.
- **Status survey (W4):** Efficiently inspecting all managed threads and synthesizing an actionable summary.
- **Iterative follow-up (W5):** Knowing when to reuse an existing thread vs spawning a new one.
- **Parallel task management (W6):** Managing multiple independent tasks in flight, reporting on each as they complete.
- **Error triage (W7):** Diagnosing worker errors, deciding what to handle autonomously vs escalate to the user.
- **Plan decomposition and fan-out (W8):** Breaking a plan into parallelizable units, avoiding file conflicts across workers, sequencing dependent work.
- **Retrospective (W9):** Surveying past work, extracting learnings, proposing improvements.
- **Cross-manager coordination (W10):** Discovering and messaging other managers for context sharing.

**Also needed:**
- Expand runtime context to include project name, project id, project root, manager thread id, workspace path.
- Add handoff-language examples ("take over", "@thread...", pasted URLs).

### 7. ~~Environment reuse for pipeline workflows~~ RESOLVED

Resolved by `f25219a2` (Allow CLI attachment to existing environments). A manager can now spawn a thread into an existing environment with `bb thread spawn --environment <environment-id>`. Multiple threads can share the same environment via the `threadEnvironmentAttachments` table. W2 pipeline workflows are unblocked.

### 8. Thread lifecycle / archival guidance

Ensure the manager actively manages thread clutter.

- Prompt should teach when to archive (one-off research done, temporary execution done) vs keep (branch/worktree still relevant, ongoing work)
- Manager should proactively suggest archival after reviewing completed work
- QA scenario: after a coding task completes, does the manager archive the worker thread or explain why it's keeping it?

---

## P1 — UI Polish

### 9. Surface language audit

Some confirmation modals and UI surfaces use "thread" language where "manager" would be more appropriate.

**Audit targets:**
- Delete confirmation modals (e.g., "Delete this thread?" → "Delete this manager?" for manager threads)
- Archive confirmation
- Thread info panel labels
- Any toast/notification copy that says "thread" generically

**Implementation:** Add type-aware copy that checks `thread.type` and uses "manager" vs "thread" accordingly. Low priority but important for product coherence.

### 10. Sidebar collapsed-manager status cues

When a manager is collapsed in the sidebar, surface enough status to be useful without expanding.

- Show a count of active managed child threads beside the manager name
- Show a spinner/activity indicator if any managed child is actively running a turn
- Keep it minimal — no heavy tree chrome

### 11. UI handoff actions

Add explicit handoff buttons to the thread info panel.

- For unmanaged threads: "Assign to Manager" action (with a picker if multiple managers exist)
- For manager-managed threads: "Take Over" action (removes `parentThreadId`, moves to regular thread list)
- These complement the chat-driven handoff path (asking the manager in conversation)

### 12. `@`-mention interaction polish

Clean up the prompt mention interaction for both file and thread mentions.

**File mention improvements:**
- Fix suggestion duplication (avoid rendering same path as both title and subtitle)
- Single-line suggestions when there's no useful secondary context
- Primary label = basename or relative path, secondary = parent directory only when helpful

**Thread/manager mention improvements:**
- Reduce thread suggestions to minimum context needed to disambiguate (title, type indicator)
- Don't show full thread IDs in visible subtitle by default
- Manager suggestions should be visually distinct (icon or type label)

**Menu copy:**
- Query hint should reflect actual search surface (files only vs files + threads)
- Loading/empty states should match the active mention context
- Manager thread prompt should have especially clean thread-mention UX since it's the highest-value surface

**Icon treatment:**
- Audit whether suggestion row icons are needed
- If kept, reduce visual weight — keep them secondary to text
- If rows read better without, prefer removing

### 13. Dedicated manager routes (evaluation)

Currently manager-specific operations (workspace files, workspace file content, preferences) live under the threads route (`/threads/:id/manager-workspace/*`). Evaluate whether managers should have their own top-level route namespace.

**Arguments for separate routes:**
- Cleaner API surface — manager-specific operations don't need thread-route guards
- Easier to add manager-specific endpoints without cluttering threads
- Aligns with multi-manager support (managers are a distinct concept)

**Arguments against:**
- Managers are threads under the hood — sharing the route keeps this simple
- More routes to maintain

**Decision:** Evaluate during multi-manager work. If manager-specific endpoints grow beyond workspace access, extract to `/managers/*` routes.

---

## P3 — Validation

### 14. Manager QA scenarios

Create a dedicated manager QA doc with scenarios derived from `plans/manager-hero-workflows.md`.

**Tier 1 scenarios (must pass):**
- W1: Simple delegation — spawn worker, wait, review, report
- W2: Pipeline workflow — code → review → feedback loop with environment reuse
- W3: Mid-flight takeover — take over user thread, monitor for goal, kick off follow-on
- W4: Status survey — "what's going on?" across all managed threads
- W5: Iterative follow-up — send adjustments to existing worker
- W6: Multiple independent tasks — parallel spawning and independent reporting
- W7: Worker error — triage and decide to handle or escalate

**Tier 2 scenarios:**
- W8: Plan → parallel execution — decompose and fan out
- W9: Retrospective — survey past work and extract learnings
- W10: Cross-manager coordination — ask another manager for context
- W11: Memory across sessions — recall preferences and past work

**Anti-pattern checks:**
- Manager shouldn't poll workers
- Manager shouldn't micromanage active threads
- Manager shouldn't leave stale threads indefinitely
- Manager shouldn't dump raw status without synthesis

---

# Recommended Build Order

1. **CLI audit P0s** — unblock manager quality (`--title`, `--model`, `--json` on list). See `plans/cli-audit.md`.
2. **Prompt quality pass** — teach the manager the hero workflows (W1–W10), not just simple delegation. See `plans/manager-hero-workflows.md`. Environment reuse (W2 blocker) is now resolved.
4. **Multi-manager support** — foundational data model change that unblocks the rest.
5. **Inter-agent messaging tool** — core V1 primitive, enables manager-to-manager workflows (W10).
6. **Manager default provider/model** + **Hire modal improvements** — can ship together, quick wins.
7. **Manager `@`-mention support** — natural companion to inter-agent messaging.
8. **UI polish** (surface language audit, sidebar cues, handoff actions, mention interaction) — parallel work.
9. **QA scenarios** — derived from hero workflows, run as final validation.

# Related Plans

- `plans/cli-audit.md` — CLI flag gaps and task list
- `plans/manager-hero-workflows.md` — definitive workflow definitions driving prompt and CLI work

# Open Questions/Risks

- ~~**Environment reuse:**~~ RESOLVED by `f25219a2`. `bb thread spawn --environment <env-id>` attaches to existing environments.
- **Notification → turn trigger:** When a managed thread completes, does the system message actually start a new manager turn? If not, W7 (error handling) is reactive only. Needs verification.
- **Workflow preferences:** Should pipeline workflows be stored as structured config or natural language in `PREFERENCES.md`?
- **Multi-manager:** Should the sidebar have a single "Managers" section or show each manager as a top-level entry?
- **Inter-agent messaging:** Should workers message arbitrary threads or only their parent?
- **Manager defaults:** If `claude-code` provider isn't configured, should we warn or silently fall back?
- **Route separation:** Defer decision until multi-manager work reveals whether the thread-route approach is becoming awkward.
