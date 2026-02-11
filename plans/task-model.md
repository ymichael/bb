# Task Model Plan

## Goal
Introduce first-class **tasks** as an organizational layer above threads, while keeping today’s thread-first workflow fast and familiar.

A task is a container for work. Most tasks will have one thread. Some tasks may have multiple threads (research, planning, implementation, verification).
Tasks can also be hierarchical (task -> subtask -> subtask).

## Product principles
- Keep the default path lightweight: user prompt -> **orphaned thread** (no task required).
- Preserve flexibility: threads can exist without a task (unassigned/orphaned) to reduce mental overhead.
- Make structure visible: sidebar and task page provide bird’s-eye context for multi-thread work.
- Make promotion easy: orphaned threads should be one-click “convert/move into task”.
- Make both models explicit in one place: sidebar uses a **single interleaved list** of task rows and orphaned thread rows.

## What this unlocks
- Better sidebar organization than flat thread lists.
- A place to track work before agent assignment (ticket grooming / triage).
- Multiple coordinated threads inside one task (e.g. planner thread then implementer thread).
- Nested work breakdown with subtasks under larger parent tasks.
- Optional task dependencies for sequencing work.

## Scope (MVP)
- Task entities in core/db/api/web/cli.
- Optional `thread.taskId` relationship.
- Task hierarchy (`parentTaskId`) for subtasks.
- Sidebar mixed row navigation (tasks + orphaned threads).
- Task detail page with task metadata + thread list.
- Dependency graph primitives (no autonomous scheduler yet).

## Non-goals (MVP)
- Fully automated orchestration behavior (covered by orchestrator mode plan).
- Full Jira/Asana parity (custom workflows, rich permissions, due dates, etc).

---

## Key product decisions (answers to open questions)

### 1) Can threads be orphaned?
**Yes.**

Decision:
- `threads.task_id` is nullable.
- Sidebar renders one interleaved list with two row types:
  - task rows (with optional nested thread rows),
  - orphaned thread rows (same presentation as today).
- Default prompting behavior creates unassigned threads.

Why:
- Preserves today’s mental model and backward compatibility.
- Lets users stay lightweight when they don’t need task structure.

### 2) What metadata should tasks have?
Start simple, with room to grow.

Proposed v1 fields:
- `id`
- `project_id`
- `parent_task_id` (optional; supports subtasks)
- `title` (required)
- `description` (optional markdown/text)
- `status` (`todo | in_progress | blocked | done`)
- `priority` (`low | medium | high`)
- `assignee` (optional free-form string for now)
- `created_at`, `updated_at`, `started_at?`, `completed_at?`

### 3) Jira/Asana-like or simpler?
**Simpler in v1, Jira-compatible shape.**

- Include only metadata that helps local agent workflows immediately.
- Keep schema extensible for labels, due dates, estimates, custom fields later.

### 4) What does the task page look like?
Task page should be a command center with two core jobs:
1. Understand task state/context.
2. Operate its threads.

Layout (MVP):
- Header: title, status, priority, assignee, quick actions.
- Description panel: editable text/markdown.
- Dependency panel: “blocked by” / “unblocks”.
- Subtask panel:
  - list of subtasks with status + counts
  - quick create subtask
  - open subtask detail
- Thread panel:
  - list of threads in task (status + updated time)
  - “new thread in task” action
  - open thread detail
- Activity/timeline panel (optional if easy): recent status changes + thread events summary.

---

## UX changes

## Sidebar
Current: Project -> Threads

New:
- Project
  - Work list (single interleaved list)
    - Task row (status, thread count)
      - Subtask rows (expand/collapse)
      - Thread rows (expand/collapse)
    - Orphaned thread row (same visual treatment as today)

Ordering rule:
- Use a stable hybrid sort to reduce jumpiness:
  - **Active items** (active threads, in-progress tasks) sort by `created_at` (newest first).
  - **Non-active items** sort by `updated_at` (newest first).
- Keep sort behavior identical across row types (task rows and orphaned thread rows).

Task rows should show:
- task title
- status badge
- thread count (`1`, `2`, etc)
- subtask count
- dependency indicator when blocked

## Prompt entry behavior
When user starts work from project main prompt:
- Create an **unassigned thread** (same mental model as today).
- Navigate user directly to that thread.
- Provide fast “Create task from this thread” action in thread UI.

This keeps “one prompt to start work” behavior unchanged while still allowing users to add task structure when needed.

---

## Data model

### `tasks`
- `id` TEXT PK
- `project_id` TEXT FK -> projects.id
- `parent_task_id` TEXT NULL FK -> tasks.id
- `title` TEXT NOT NULL
- `description` TEXT NULL
- `status` TEXT NOT NULL DEFAULT `todo`
- `priority` TEXT NOT NULL DEFAULT `medium`
- `assignee` TEXT NULL
- `created_at` INTEGER NOT NULL
- `updated_at` INTEGER NOT NULL
- `started_at` INTEGER NULL
- `completed_at` INTEGER NULL

Indexes:
- `(project_id, updated_at desc)`
- `(project_id, status, updated_at desc)`
- `(parent_task_id, updated_at desc)`

### `task_dependencies`
- `task_id` TEXT FK -> tasks.id
- `depends_on_task_id` TEXT FK -> tasks.id
- PK `(task_id, depends_on_task_id)`

Indexes:
- `(depends_on_task_id)`

### `threads` changes
- Add nullable `task_id` FK -> tasks.id
- Index `(task_id, updated_at desc)`

Backfill/migration behavior:
- Existing threads stay `task_id = NULL`.

---

## API surface (MVP)

### Task CRUD
- `POST /api/v1/tasks`
- `GET /api/v1/tasks?projectId=...&status=...`
- `GET /api/v1/tasks/:id`
- `PATCH /api/v1/tasks/:id`
- `DELETE /api/v1/tasks/:id`

Create/update should accept optional `parentTaskId`.

### Task/thread linkage
- `POST /api/v1/tasks/:id/threads` (create thread in task)
- `POST /api/v1/threads/:id/assign-task` (set `taskId`)
- `POST /api/v1/threads/:id/unassign-task`
- `POST /api/v1/threads/:id/create-task` (create task and assign thread in one step)

### Dependencies
- `POST /api/v1/tasks/:id/dependencies` (add `depends_on_task_id`)
- `DELETE /api/v1/tasks/:id/dependencies/:dependsOnTaskId`

### Subtasks
- `GET /api/v1/tasks/:id/subtasks`
- (or rely on `GET /api/v1/tasks?parentTaskId=...`)

---

## Implementation plan

### Phase 1 — contracts (`packages/core`)
- Add `Task` types + request/response schemas.
- Extend thread type with optional `taskId`.
- Extend WS protocol to include `task` entity.

### Phase 2 — db (`packages/db`)
- Migration for `tasks`, `task_dependencies`, `threads.task_id`.
- Add repositories:
  - `TaskRepository`
  - dependency helpers
  - subtask helpers (`listByParent`, parent move validation)
- Update `ThreadRepository` for `taskId` read/write.

### Phase 3 — daemon (`apps/daemon`)
- Add task routes.
- Add thread-task assignment operations.
- Broadcast `task` and `thread` changes consistently.

### Phase 4 — web (`apps/web`)
- Sidebar refactor to single interleaved work list (task + orphaned thread row types).
- Add task page route (`/projects/:projectId/tasks/:taskId`).
- Add task create/edit flows and thread-in-task actions.
- Add subtask create/move UX.
- Add “Create task from thread” action in thread detail and unassigned thread rows.
- Keep existing thread detail route untouched.

### Phase 5 — cli (`apps/cli`)
- `bb task list --project <id>`
- `bb task create --project <id> --title "..." [--description ...]`
- `bb task show <id>`
- `bb task update <id> --status ... --priority ...`
- `bb thread assign-task --thread <id> --task <id>`
- `bb thread unassign-task --thread <id>`
- `bb thread create-task --thread <id> --title \"...\"`

---

## Hero use cases mapped

1) **Track tickets before assigning an agent**
- Create task with description and dependencies.
- No thread required yet.
- Later create/attach worker thread.

2) **Planner thread then implementer thread**
- One task with two threads:
  - thread A: planning/spec breakdown
  - thread B: implementation
- Task page gives unified view.

3) **Dependencies and sequencing**
- Task B depends on Task A.
- Dependency metadata visible now; automatic scheduling is handled in orchestrator mode.

---

## Success criteria
- Users can create tasks independent of threads.
- Users can create nested subtasks under parent tasks.
- Users can attach one or many threads to a task.
- Sidebar clearly shows one interleaved list of tasks and orphaned threads, with task thread counts.
- Task page gives quick multi-thread visibility and controls.
- Default prompting still creates unassigned threads.
- Existing thread-only workflows continue to work.
