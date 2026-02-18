# E2E Coverage Plan: CLI -> HTTP -> Daemon -> Agent -> Back

## Goal

Add deterministic end-to-end tests that execute the real request chain:

- `bb` CLI command
- daemon HTTP API
- daemon thread/task orchestration
- provider process boundary (mocked `codex app-server`)
- events and notifications flowing back to parent/primary threads

The target is reliable coverage for the core orchestration paths:

- thread spawn
- task create
- assignment-triggered kickoff (auto-assign behavior in current model)
- primary thread spawn
- child thread spawn
- child thread done
- primary thread notification on child completion

## Current Gaps

- Existing tests are strong at unit/route level, but do not run a true cross-process e2e path.
- CLI tests do not execute real commands against a running daemon.
- Server wiring (`createServer` + `/api/v1` + `/ws`) is not covered by real network tests.
- Parent notification behavior is tested only inside `ThreadManager` unit tests, not via CLI/API end-to-end.

## Scope

In scope:

- E2E tests for the runtime currently shipped today.
- Real daemon startup with real SQLite state.
- Real CLI invocation in tests.
- Mocked provider process at the `codex app-server` boundary.

Out of scope:

- UI/browser e2e.
- New orchestration semantics beyond current behavior.
- Multi-provider support (runtime currently supports `codex` only).

## Proposed Test Architecture

### 1) E2E harness location

Add a dedicated e2e suite under daemon tests:

- `apps/daemon/src/__tests__/e2e/`

This keeps tests close to server/runtime code while still exercising CLI + network boundaries.

### 2) Daemon harness

Create a reusable harness helper that:

- builds in-memory or temp-file SQLite db
- runs migrations
- constructs repos + `createServer(...)`
- starts real HTTP server using ephemeral port (`port: 0`)
- injects websocket support
- exposes `baseUrl`, `wsUrl`, and cleanup

### 3) Mock agent at process boundary

Implement a fake `codex` executable for tests (added to front of `PATH`) that:

- accepts `codex app-server`
- reads JSON-RPC from stdin
- responds to `initialize`, `thread/start`, `thread/resume`, `turn/start`, `turn/steer`
- emits notifications required by daemon behavior:
  - `thread/started`
  - `turn/started`
  - `turn/completed`
  - optional `item/completed` for output assertions

The fake should support scenario control through env vars so each test can choose timing and event shape.

### 4) CLI harness

Add a helper that runs real CLI commands as child processes:

- execute source CLI (`tsx ../cli/src/index.ts ...`) or built CLI in CI
- set `BB_DAEMON_URL` and context env vars per test
- capture stdout/stderr/exit code

### 5) Assertion surfaces

Each e2e should assert at least two surfaces:

- API/state surface: thread/task rows and event streams via HTTP
- orchestration surface: expected notification events and/or websocket `changed` events

## Core E2E Test Matrix

### A. Thread spawn round trip

Flow:

1. Create project.
2. Run `bb thread spawn --project <id> --prompt "..."`.
3. Fake agent emits `turn/started` then `turn/completed`.

Asserts:

- thread exists and is linked to project
- thread transitions to `active` then `idle`
- events include outbound `client/thread/start` and `client/turn/start`

### B. Task create + assign kickoff (auto-assign path)

Flow:

1. Create project.
2. Run `bb task create ...`.
3. Run `bb task assign <id> --assignee agent/generic`.

Asserts:

- task state is assigned and `in_progress`
- primary thread is created with `taskRole=primary`
- task events include `task.assigned` and `task.chat.thread_created`

### C. Primary thread spawn on task chat

Flow:

1. Create assigned task with no existing primary thread.
2. Call task chat endpoint (or CLI path if added) with input.

Asserts:

- primary thread is created with deterministic title
- first chat input is delivered as initial thread input
- task receives `task.chat.message` and `task.chat.thread_created`

### D. Child thread spawn linked to primary

Flow:

1. Create primary thread context for a task.
2. Run `bb thread spawn --task <taskId> --parent-thread <primaryId> --task-role worker`.

Asserts:

- child thread persists with `taskRole=worker` and `parentThreadId=<primaryId>`
- task receives `task.chat.thread_created` for worker thread

### E. Child done -> primary notified

Flow:

1. Existing primary + child linkage.
2. Fake agent for child emits `turn/completed`.

Asserts:

- daemon sends system tell to parent thread
- parent thread event stream includes notification message containing child thread id
- duplicate completion events do not create duplicate notifications

### F. Primary receives external change signal

Flow:

1. Open websocket subscription for `thread:<primaryId>` and `task:<taskId>`.
2. Trigger child completion.

Asserts:

- websocket receives `changed` events for affected entities
- no duplicate broadcast flood for same completion

## Failure-path E2E (Phase 2)

- provider timeout during spawn produces `provisioning_failed`
- tell on archived thread returns 409
- assign conflict returns 409 with existing assignee
- parent notification skipped when parent thread is archived or missing

## Rollout Plan

### Phase 1: Harness and first passing scenario

- add daemon harness
- add fake codex executable
- add CLI runner helper
- implement test A

### Phase 2: Core orchestration coverage

- implement tests B, D, E
- add websocket assertions from F where stable

### Phase 3: Failure-path hardening

- implement failure-path tests
- remove flaky timing with polling helpers and bounded waits

## CI Integration

- Add dedicated script: `test:e2e`.
- Run e2e in CI after unit tests.
- Keep e2e suite small and deterministic (smoke coverage, not exhaustive permutations).

## Exit Criteria

- At least one passing e2e for each requested core path.
- Tests run consistently in CI without external network/provider dependencies.
- Regressions in spawn/assignment/child-completion notification paths fail fast with clear diagnostics.
