# Orchestrator Mode Plan

## Goal
Build an optional **orchestrator mode** that plans and executes multi-step work using the task model.

Task model is the foundation. Orchestrator mode adds automation, coordination, retries, and dependency-aware execution.

## Relationship to prompt modes and Task Skills
This should fit the same prompt-level mode model:

- **Agent mode:** direct thread workflow.
- **Task mode:** task-first workflow driven by a selected Task Skill.

Orchestrator mode can be modeled as:
- either a dedicated top-level mode, or
- an advanced Task Skill selected inside Task mode.

Product intent: keep this concept simple for users — “structured kickoff + coordinated execution.”

> Planning note: this document is product-behavior first; implementation details can follow once interaction design is settled.

## Dependency on task model
Orchestrator mode assumes:
- tasks exist as first-class records
- threads can be attached to tasks
- dependencies exist between tasks
- task status transitions are authoritative

Without task model, orchestrator mode should not ship.

## MVP UX
1. User enters Task mode and selects an orchestrator-style kickoff (mode or task skill).
2. User provides objective.
3. Orchestrator generates/updates a task plan.
4. User approves plan.
5. Orchestrator executes ready tasks by creating task threads.
6. User watches run + task + thread progress live.

## Scope (MVP)
- Orchestration run entity + lifecycle.
- Plan generation and approval gate.
- Dependency-aware task scheduling.
- Task attempts and retries.
- Read/write run controls in web + cli + api.

## Non-goals (MVP)
- Cross-project orchestration.
- Unbounded replanning loops.
- Complex optimization scheduling.
- Human multi-user permissions/workflows.

---

## Data model additions

### `orchestration_runs`
- `id`
- `project_id`
- `title`
- `objective`
- `status` (`draft | awaiting_approval | running | blocked | completed | failed | cancelled`)
- `planner_thread_id` (nullable)
- `summary` (nullable)
- `created_at`, `updated_at`, `started_at`, `completed_at`

### `task_attempts`
- `id`
- `task_id`
- `thread_id`
- `attempt`
- `status` (`running | succeeded | failed | interrupted`)
- `output` (nullable)
- `created_at`, `updated_at`, `completed_at`

Note: tasks themselves come from task model plan.

---

## Orchestrator responsibilities
- Convert objective into candidate tasks + dependencies.
- Validate plan integrity (no cycles, no missing refs).
- Respect approval gate before execution.
- Schedule ready tasks subject to concurrency caps.
- Start task threads via existing `ThreadManager`.
- Observe task thread completion/failure and update task status.
- Run completion logic:
  - done when all tasks done
  - failed/blocked when progress cannot continue

## Scheduling semantics (MVP)
- A task is runnable when:
  - status is `todo` or `in_progress` (configurable), and
  - all dependencies are `done`, and
  - task has no running attempt.
- Default per-run concurrency: 2 worker threads.
- Retry policy: manual retry first; optional auto-retry later.

---

## API surface

### Run endpoints
- `POST /api/v1/orchestrations`
- `GET /api/v1/orchestrations?projectId=...`
- `GET /api/v1/orchestrations/:id`
- `POST /api/v1/orchestrations/:id/approve`
- `POST /api/v1/orchestrations/:id/cancel`

### Execution controls
- `POST /api/v1/tasks/:id/retry`
- `POST /api/v1/orchestrations/:id/replan` (optional in MVP; likely phase 2)

### Observability
- WS entities: `orchestration`, `task`, `thread`

---

## Web UX

### Run list + detail
- Run list on project page (optional tab or section).
- Run detail page:
  - objective/status/concurrency header
  - task board grouped by status
  - dependency warnings/blockers
  - per-task attempts + linked threads
  - approve/cancel controls

### Task integration
- Reuse task page and thread views from task model.
- Orchestrator-specific badges: “planned by orchestrator”, “attempt #”.

---

## CLI UX
- `bb orchestrator run --project <id> --objective "..."`
- `bb orchestrator list --project <id>`
- `bb orchestrator show <runId>`
- `bb orchestrator approve <runId>`
- `bb orchestrator cancel <runId>`
- `bb task retry <taskId>`

---

## Guardrails
- Approval required by default.
- Explicit run status transitions only.
- Hard cap on concurrent worker threads.
- Manual override controls (cancel, retry, mark blocked/done).
- Full attempt/thread audit trail.

---

## Implementation phases
1. Build on shipped task model.
2. Add run + attempt tables and repositories.
3. Add orchestrator manager in daemon.
4. Add routes and WS broadcasts.
5. Add web run views + controls.
6. Add CLI coverage.
7. Harden with restart/recovery tests.

## Validation
- Unit: DAG validation + scheduler logic + lifecycle transitions.
- Integration: objective -> plan -> approval -> execution -> completion.
- Recovery: daemon restart during run keeps state coherent.

## Success criteria
- User can run a multi-task objective with clear approval and observability.
- Orchestrator executes via task threads, not a separate runtime.
- Failures are diagnosable from run/task/attempt/thread records.
