# Task Mode Plan

## 1) Goal
Introduce a **Task mode** where prompts create and drive tasks (not just standalone threads).

- **Threads** remain the unit that does work.
- **Tasks** become the unit that organizes, tracks, and coordinates work.

## 2) Product mental model
Users can work in two modes:

- **Agent mode (default):** prompt -> thread (current behavior)
- **Task mode:** prompt -> task (then thread(s) attached to that task)

Task mode is for structured work (planning, implementation, review, dependencies). Agent mode stays fast for ad-hoc work.

## 3) Core behavior

### Agent mode
- Works exactly like today.
- Prompts create orphaned/unassigned threads.

### Task mode
- Available on the **project main page prompt box**.
- Prompt creates a task and kicks off its execution flow.
- Execution flow can be simple (one thread) or multi-step.

### Thread/task relationship
- `threads.task_id` is nullable.
- Orphaned threads are allowed.
- Any orphaned thread can be converted into a task containing that thread.

## 4) Task kickoff flow (Task Skill concept)
Task mode can invoke a **Task Skill** that defines how work starts.

Default example:
1. Create task
2. Flesh out plan in a planning thread
3. Create implementation thread
4. Create review thread

This should be configurable over time, but we can start with one default skill.

## 5) Information architecture

## Sidebar
Current: `Project -> Threads`

Proposed: one **interleaved work list**:
- Task rows (with optional nested subtasks + task threads)
- Orphaned thread rows (same visual treatment as today)

Task row should show:
- title
- active thread count
- optional status/dependency indicators

Sorting rule:
- Active work (active threads, in-progress tasks): sort by `created_at` (newest first)
- Non-active work: sort by `updated_at` (newest first)

## 6) Task page concept
Task page should be a task command center.

Suggested layout:
- **Header**: title, status, key actions
- **Context column**: description, dependencies, subtasks
- **Execution column**: threads attached to the task + activity/history
- **Task control thread**: special thread for modifying/orchestrating the task itself

User should be able to:
- see all task threads and history
- jump into any specific thread
- stay at task level for bird’s-eye progress

## 7) Task data shape (v1)
Keep it minimal:
- `id`
- `project_id`
- `parent_task_id` (optional, enables subtasks)
- `title` (required)
- `description` (optional markdown)
- `created_at`
- `updated_at`
- `archived_at?`

Also support task-to-task dependencies.

## 8) Hero use cases
- Track and flesh out tickets before assigning an agent
- Use one thread to plan, another to implement, another to review
- Encode dependency order so tasks can start after prerequisite work is done

## 9) Open product questions
- Should Task mode always create a planning thread first, or allow “single-thread task” quick start?
- Should task status be explicit in v1, or inferred from attached thread activity?
- Should the task control thread always exist, or only after user invokes “orchestrate task”?
- How visible should mode choice be in the composer UI?

## 10) Rollout stance
- Keep Agent mode default and unchanged.
- Introduce Task mode as opt-in.
- Let users promote orphaned threads into tasks as a bridge.
