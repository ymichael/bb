# Architecture

## Overview

BB is a local-first coding-agent workspace built as a pnpm/Turbo monorepo.
A local daemon is the durable coordinator: it owns the HTTP/WebSocket API,
persists state in SQLite, manages per-thread execution environments, and serves
both the React app and the `bb` CLI.

At a high level:

1. The app and CLI talk to the daemon over HTTP.
2. The daemon persists projects, threads, events, queued follow-ups, environment records, and environment-agent session state via `@bb/db`.
3. Each thread runs in a selected environment (`local`, `worktree`, or `docker`).
4. Each active environment runs a per-thread `environment-agent` beside the provider runtime.
5. The environment-agent opens a daemon-hosted session, long-polls for commands, and posts heartbeats, event batches, and command results.
6. The daemon applies those events to thread state, stores the durable history, and emits targeted WebSocket invalidations.
7. The app refreshes affected React Query queries; the CLI reads and mutates the same daemon-backed state.
8. Provider adapters currently support `codex`, `claude-code`, and `pi`, with bridge packages where needed to translate between BB's runtime contract and provider-specific CLIs/SDKs.

## Monorepo Components

### `apps/app`

React 19 + Vite frontend.

Responsibilities:

- talks only to the daemon HTTP API for reads and writes
- uses React Query for server state
- uses a small WebSocket subscription layer for invalidation messages (`thread` and `system` entities)
- keeps one canonical thread-detail rendering path based on timeline rows + UI message projection from `@bb/core`
- fetches heavier payloads such as git diffs, tool-group expansions, attachment content, and health data on demand

Notable behavior:

- realtime updates are invalidation-based, not state-replication-based
- thread timeline invalidation is throttled for bursty event streams, but status transitions flush immediately
- local UI preferences (theme, open-path preferences, auto-archive preferences, prompt draft state, panel state) remain browser-local

### `apps/cli`

`bb` CLI for daemon, project, and thread operations.

Responsibilities:

- uses the same daemon APIs as the app
- supports thread lifecycle operations, follow-ups, archive/unarchive, stop, and git-backed thread operations
- can run inside agent shells with context injected through:
  - `BB_PROJECT_ID`
  - `BB_THREAD_ID`
  - `BB_ENVIRONMENT_ID`
  - `BB_DAEMON_URL`

### `apps/server`

The daemon is the system coordinator.

Responsibilities:

- owns the HTTP API and WebSocket server
- persists projects, threads, events, queued follow-ups, environment metadata, environment-agent sessions, command queues, and command results
- owns project-level manager-thread lifecycle, including the primary manager thread pointer on projects
- provisions, restores, suspends, archives, unarchives, and deletes thread environments
- manages provider sessions through per-thread environment-agents
- normalizes provider/runtime notifications into BB thread events
- computes work status, git diffs, merge-base candidates, and thread/project summaries
- exposes system APIs for provider/environment catalogs, health reporting, restart recommendations, open-path, and voice transcription
- reconciles managed artifacts such as logs, worktrees, and stored attachments

Important daemon subsystems include:

- `Orchestrator`
- `EnvironmentService`
- `EnvironmentAgentSessionService`
- `EnvironmentAgentCommandDispatcher`
- `EnvironmentAgentEventApplier`
- `InMemorySchedulerService`
- startup reconciliation, restart recommendation, and system health reporting
- managed artifact reconciliation for logs, worktrees, and attachments

### `packages/core`

Shared contracts and projection helpers for the rest of the monorepo.

Includes:

- API request/response types
- realtime message schemas
- thread/project domain types
- event normalization helpers
- timeline/detail-row/UI message projection helpers
- shared guards, decoders, and utilities such as `assertNever`

This is the main contract boundary between the app, daemon, CLI, environment implementations, environment-agent runtime, and provider adapters.

### `packages/db`

SQLite persistence layer built on Drizzle.

Durable entities include:

- projects
- threads
- thread events
- queued follow-up messages
- persisted environment records on threads
- environment-agent sessions and event cursors
- environment-agent command queue and command results

A thread row is created immediately; provisioning and provider bootstrap continue asynchronously afterward.

### `packages/environment`

Environment implementations define where thread work runs.

Built-in environments:

- `local`
- `worktree`
- `docker`

Environment responsibilities:

- prepare or restore the workspace
- start the per-thread environment-agent
- expose workspace status, git diff, merge-base candidates, and open-path resolution
- suspend, archive, unarchive, or destroy resources as the thread lifecycle changes
- support environment-specific capabilities such as isolated workspaces and primary-checkout promotion/demotion

`docker` currently layers container execution on top of an isolated worktree-backed workspace.

### `packages/environment-daemon`

Per-thread sidecar process between the daemon and the provider runtime.

Responsibilities:

- start and supervise the provider runtime
- maintain an in-memory event/outbox stream for provider/runtime activity
- open an authenticated session back to the daemon
- pull queued daemon commands
- push heartbeats, event batches, command acknowledgements, and command results
- expose a minimal local authenticated control surface for status inspection

Important nuances:

- event/session delivery state inside the environment-agent is in-memory, not durably journaled on disk
- the main control plane is daemon-hosted and session-based
- the local HTTP surface is intentionally small; today the important endpoint is `POST /control/status`
- the package also builds the bundled `environment-agent.bundle.mjs` binary used by managed environments

### `packages/provider-adapters`

Shared built-in provider adapter layer.

Responsibilities:

- provider registry and adapter selection
- model catalog access
- title generation and commit-message generation helpers
- shared provider-side launch metadata and request/response helpers consumed by env-daemon

Current built-in provider registry:

- `codex`
- `claude-code`
- `pi`

### `packages/ui-core`

Shared React UI primitives used by the app for page shells, cards/detail rows,
collapsible sections, prompt affordances, and other reusable UI building blocks.

### Supporting packages

Additional packages round out the architecture:

- `packages/templates`: checked-in prompt and instruction templates, including manager-thread instructions
- `packages/claude-code-bridge`: bridge binary/library used by the Claude Code provider adapter
- `packages/pi-bridge`: bridge binary/library used by the PI provider adapter
- `packages/tsconfig`: shared TypeScript config base for workspace packages

## Daemon API Shape

Broadly, the daemon exposes:

- project APIs: CRUD, project file search, workspace status, and prompt attachment upload/content
- project manager APIs: create/read/delete the primary manager thread for a project
- thread APIs: spawn, tell, queued follow-up management, stop, archive/unarchive, promote/demote primary checkout, git operations, read-state updates, open-path, timeline, work status, git diff, manager workspace inspection, and environment-agent session endpoints
- system APIs: status, health, available models, provider/environment catalogs, open-path, restart/shutdown controls, and voice transcription
- realtime invalidations over `/ws`

The app proxies `/api` and `/ws` to the daemon in development.

## Thread Lifecycle

Persisted thread statuses are:

- `created`
- `provisioning`
- `provisioned`
- `provisioning_failed`
- `idle`
- `active`
- `error`

Transition rules are centralized in `apps/server/src/thread-status-machine.ts`.

Thread types are:

- `standard`
- `manager`

Manager threads are project-scoped coordinator threads. They keep a separate BB-managed workspace for plans, notes, and user-facing deliverables, can own child worker threads, and intentionally hide git/environment-specific UI that only applies to standard coding threads.

### New thread

1. App or CLI sends `POST /threads`.
2. Daemon creates the thread row immediately with status `created`.
3. Daemon schedules provisioning asynchronously and transitions to `provisioning`.
4. The selected environment prepares or restores the workspace.
5. The environment starts the per-thread environment-agent.
6. The environment-agent opens a session back to the daemon.
7. The daemon queues bootstrap commands such as `provider.ensure`, `thread.start`, and optionally `turn.start`.
8. The environment-agent pulls commands, runs them against the provider runtime, and posts resulting events/results back to the daemon.
9. The daemon persists events, updates derived thread state, and broadcasts thread invalidations.
10. The thread can pass through `provisioned`, become `active` while a turn is running, and eventually settle in `idle` or `error`.

### Follow-up on an existing thread

1. App or CLI sends `POST /threads/:id/tell`.
2. Daemon validates thread state, execution options, and prompt attachments.
3. If the thread is already active and steering is allowed, the daemon can send `turn.steer`.
4. Otherwise it sends `turn.start`.
5. If no live provider session is available, the daemon restores the environment and resumes or recreates provider state first.
6. If the thread cannot accept the follow-up immediately, the daemon can queue it for later dispatch.

Manager threads use the same durable lifecycle machinery, but their prompt/tool surface is specialized for orchestration. The daemon gates manager-only capabilities, such as publishing user messages and exposing the manager workspace APIs, by thread type.

### Queued follow-ups and thread operations

The daemon persists per-thread queues for:

- follow-up prompts
- git-backed thread operations such as commit and squash-merge

This queueing is durable across daemon restarts.

### Archive, unarchive, and primary checkout

Additional thread lifecycle behaviors include:

- `POST /threads/:id/archive` may reject with `worktree_not_clean` unless `force=true`
- archived isolated environments can later be restored through `POST /threads/:id/unarchive`
- worktree-capable environments can be promoted into the project primary checkout and later demoted back to an isolated checkout
- daemon/UI timelines surface these operations as first-class thread events

### Recovery behavior

BB treats the daemon and SQLite as the durable source of truth.

On startup the daemon reconciles threads that were previously active or provisioning, restores enough environment metadata to continue, and pokes surviving env-agents. Session heartbeats and command cursors determine whether workers are still alive.

A special reprovision fallback exists when a persisted provider thread id exists but `thread.resume` fails because the upstream provider no longer recognizes the thread. In that case the daemon reprovisions the environment, starts a fresh provider thread session, and continues the pending follow-up from the new session.

Provider-facing recovery is covered by checked-in daemon e2e/QA suites in `apps/server/src/__tests__/e2e/` and the root `qa:daemon:*` scripts. Real-provider smoke/stress runs are the default regression path for daemon and environment-agent behavior.

## Environment-Agent Session Protocol

The daemon ↔ environment-agent control plane is session-based and daemon-hosted.

### Session shape

For each active thread, the environment-agent opens a logical channel keyed by thread id. The daemon records:

- active session metadata
- heartbeat / last-seen state
- per-channel event cursors (`generation`, `sequence`)
- queued commands, command cursors, and final command result state

Sessions are heartbeat-driven:

- the daemon records protocol version, liveness settings, and channel bootstrap state when the session opens
- the environment-agent keeps the session alive with heartbeats
- heartbeat timeout invalidates the session
- a newer session for the same thread replaces the previous one

### Command flow

1. The daemon persists a command in the environment-agent command queue.
2. The environment-agent long-polls `GET /threads/:id/environment-agent/session/commands`.
3. The daemon returns commands after the last acknowledged cursor.
4. The environment-agent acknowledges receipt and executes the command against the local provider runtime.
5. The environment-agent posts lifecycle updates such as `started`, `completed`, or `failed` through `POST /threads/:id/environment-agent/session/messages`.
6. The daemon records the final result and unblocks higher-level orchestration.

### Event flow

1. The environment-agent observes provider/runtime events and assigns per-channel sequence numbers.
2. It pushes contiguous event batches through `POST /threads/:id/environment-agent/session/messages`.
3. The daemon applies unseen events in order and advances the persisted cursor.
4. The daemon replies with accepted cursors so the environment-agent can drop acknowledged in-memory outbox entries.

## Workspace, Git, and Attachments

Workspace and git data are daemon-driven.

The daemon can ask environments for:

- work status
- merge-base branch candidates
- git diffs
- commit and squash-merge execution
- open-path resolution inside the thread workspace

Important behavior:

- workspace status feeds thread badges, archive safety checks, and project-level summaries
- full git diffs are fetched on demand, not streamed over WebSocket
- worktree and docker environments can use managed isolated workspaces rooted under BB-managed storage
- prompt attachments are stored under BB-managed per-project attachment directories and then referenced as `localImage` / `localFile` inputs
- the app loads local attachment content back through daemon attachment endpoints rather than reading arbitrary filesystem paths directly

## Realtime Model

### App side

- WebSocket messages are invalidations, not a replicated event log
- clients subscribe by entity (`thread` or `system`) and optionally by id
- the app translates thread change kinds into targeted React Query invalidations for thread lists, thread detail, work status, timeline, daemon status, and restart policy

### Daemon side

The daemon emits targeted change kinds such as:

- `thread-created`
- `thread-deleted`
- `archived-changed`
- `read-state-changed`
- `title-changed`
- `queue-changed`
- `status-changed`
- `work-status-changed`
- `events-appended`

This keeps the websocket layer narrow while leaving authoritative state in HTTP + SQLite-backed reads.

## Persistence and Recovery

Durable state in SQLite includes:

- projects and threads
- thread events and read-state-related metadata
- queued follow-ups
- persisted environment records
- environment-agent sessions, cursors, commands, and command results

Non-durable state includes:

- in-memory provider child processes
- environment-agent outbox buffers and active long polls
- daemon-side timers and transient caches such as projected timeline data
- manager-thread workspace materialized files outside SQLite
- browser-local UI preferences and prompt drafts

## Summary

BB is organized around one durable coordinator (the server), one durable store (SQLite), and one per-thread execution sidecar (the environment-agent).

The most important current architectural traits are:

- daemon-hosted environment-agent sessions rather than agent-owned stream endpoints
- environment-specific workspace management (`local`, `worktree`, `docker`)
- a single durable event history projected into app/CLI views
- narrow realtime invalidations instead of full replicated client state
- daemon-managed git, attachment, and system-health services around the core thread runtime
