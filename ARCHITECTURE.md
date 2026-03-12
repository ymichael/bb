# Architecture

## Overview

Beanbag is a local-first coding-agent workspace built as a pnpm/Turbo monorepo.
The main runtime is centered around a local daemon that persists state in SQLite,
coordinates per-thread environments, and serves both the web UI and CLI.

At a high level:

1. The React app and `bb` CLI talk to the daemon over HTTP.
2. The daemon persists projects, threads, events, queued follow-ups, and environment-agent session state via `@beanbag/db`.
3. Each thread runs inside a selected environment (`local`, `worktree`, or `docker`).
4. Each active environment runs a per-thread `environment-agent` process beside the provider runtime.
5. The daemon queues commands for the environment-agent; the environment-agent opens a session back to the daemon and pulls commands.
6. The environment-agent executes commands against the provider runtime, then pushes session messages and command results back to the daemon.
7. The daemon ingests those events, updates persisted thread state, and broadcasts targeted WebSocket invalidations.
8. The app refreshes affected React Query data; the CLI can read the same daemon-backed state directly.

## Main Components

### `apps/app`

- React 19 + Vite frontend.
- Uses React Query for server state.
- Talks only to the daemon HTTP API for reads/writes.
- Opens a WebSocket to the daemon for invalidation messages.
- Keeps a single canonical thread-detail rendering path built around timeline rows and UI message projection.

Primary query families invalidated from WebSocket messages include:

- `threads`
- `thread`
- `threadTimeline`
- `threadWorkStatus`
- `status`
- `systemRestartPolicy`

Notes:

- The app does not use interval polling for live thread updates.
- React Query may still refetch on mount, focus, or reconnect depending on query settings.
- Heavy payloads like git diffs, tool-group message expansions, and health data are fetched on demand over HTTP.

### `apps/cli`

- `bb` CLI for daemon and thread operations.
- Uses the same daemon APIs as the app instead of bypassing persistence.
- Also provides context-aware commands inside agent shells through environment variables such as:
  - `BB_PROJECT_ID`
  - `BB_THREAD_ID`
  - `BB_ENVIRONMENT_ID`
  - `BB_DAEMON_URL`

### `apps/daemon`

The daemon is the system coordinator. It:

- owns the HTTP and WebSocket API
- persists projects, threads, events, queued follow-ups, and environment-agent session metadata
- provisions, restores, suspends, archives, and deletes thread environments
- manages provider sessions through per-thread environment-agents
- normalizes provider-originated notifications into Beanbag thread events
- broadcasts targeted invalidation messages to app clients

Important daemon subsystems:

- `Orchestrator`: thread lifecycle, provisioning, follow-ups, archive/unarchive, git operations, timeline projection
- `EnvironmentService`: environment startup, restore, suspend, destroy, primary-checkout handling
- `EnvironmentAgentSessionService`: session lifecycle, command long-polling, heartbeat handling, and message ingestion
- `EnvironmentAgentCommandDispatcher`: persists and dispatches daemon-to-agent commands
- `EnvironmentAgentEventApplier`: applies replayed/pushed environment-agent events into daemon thread state
- restart recommendation + system health reporting
- managed artifact reconciliation for logs, worktrees, attachments, and related on-disk state

### `packages/agent-core`

Shared contracts/types package for:

- API request/response types
- realtime message schemas
- thread and project domain types
- provider-event normalization helpers
- timeline/UI message projection helpers
- shared guards and decoders

This package is the main contract boundary between the app, daemon, CLI, and environment-agent packages.

### `packages/db`

SQLite persistence layer for:

- projects
- threads
- events
- queued follow-up messages
- environment records persisted on threads
- environment-agent sessions
- environment-agent event cursors
- environment-agent command queue and command results

A thread row is created immediately when spawning a thread; provisioning is asynchronous afterward.

### `packages/environment`

Environment implementations define where thread work runs.

Built-in environments:

- `local`
- `worktree`
- `docker`

Environment responsibilities include:

- preparing and restoring the workspace
- starting the per-thread environment-agent
- exposing workspace/git status and diffs
- suspending or destroying resources when threads go idle or archived
- supporting environment-specific capabilities such as isolated workspaces and primary-checkout promotion/demotion

### `packages/environment-agent`

The environment-agent is a per-thread sidecar process that sits between the daemon and the provider runtime.

It is responsible for:

- starting and supervising the provider runtime
- maintaining a local in-memory event stream from provider/runtime activity
- opening an authenticated session back to the daemon
- pulling queued daemon commands over the session transport
- pushing session messages, heartbeats, and command results back to the daemon

Important nuances:

- Event/session state inside the environment-agent is in memory, not durably journaled on disk.
- The environment-agent exposes only a minimal authenticated local HTTP surface today (`POST /control/status`) for inspection and startup poke handling; the main control flow goes through daemon-hosted session endpoints.
- The current shipped agent session client uses a fixed HTTP session transport: `POST /session/open`, `GET /session/commands`, and `POST /session/messages`.

### `packages/agent-server`

Provider adapter/runtime layer. It currently provides:

- provider registry and adapter selection
- Codex-specific thread/turn command building
- provider runtime supervision helpers
- model catalog access
- title generation and commit-message generation helpers
- notification normalization into Beanbag thread events

Current built-in provider registry:

- `codex`

### `packages/ui-core`

Shared React UI primitives used by the app for:

- layout shells
- cards and detail rows
- timeline/prompt affordances
- shared presentation primitives

## Thread Lifecycle

Persisted thread statuses are:

- `created`
- `provisioning`
- `provisioning_failed`
- `idle`
- `active`

Transition rules are centralized in the daemon status machine.

### New thread

1. App or CLI sends `POST /threads`.
2. Daemon creates the thread row immediately with status `created`.
3. Daemon schedules provisioning asynchronously and moves the thread to `provisioning`.
4. The selected environment prepares or restores the workspace.
5. The environment starts the per-thread environment-agent.
6. The environment-agent opens a session back to the daemon.
7. The daemon queues provider bootstrap commands (`provider.ensure`, `thread.start`, and optionally `turn.start`).
8. The environment-agent pulls those commands, executes them, and pushes resulting events back.
9. The daemon persists events, updates derived thread state, and broadcasts thread invalidations.
10. The thread settles back to `idle` when the active turn completes.

### Follow-up on an existing thread

1. App or CLI sends `POST /threads/:id/tell`.
2. Daemon validates thread state and execution options.
3. If the thread is already active and steering is allowed, the daemon can send `turn.steer`.
4. Otherwise it sends `turn.start`.
5. If no live provider session is available, the daemon restores the environment and resumes the provider thread first.
6. If the thread is active but cannot accept the message immediately, Beanbag can queue a follow-up for later dispatch.

### Queued follow-ups and thread operations

The daemon also supports per-thread queues for:

- follow-up prompts
- git-backed thread operations such as `commit` and `squash_merge`

Those queues are persisted in SQLite so dispatch decisions survive daemon restarts.

### Resume fallback when the provider thread is gone

A special reprovision fallback exists when:

- there is no usable in-memory/live provider session
- a persisted provider thread id exists
- `thread.resume` fails because the provider no longer recognizes that thread/session

When that happens, the daemon:

1. reprovisions the thread environment
2. starts a fresh provider thread session
3. continues the pending follow-up from that new session

This is the path used for errors equivalent to “missing provider thread” rather than generic timeouts or transport failures.

## Environment-Agent Session Protocol

The main daemon ↔ environment-agent control plane is now daemon-hosted and session-based.

### Session shape

For each active thread, the environment-agent opens a single logical channel keyed by the thread id.
The daemon records:

- active session row
- heartbeat / last-seen state
- per-thread event cursor (`generation`, `sequence`)
- queued commands with command cursors and result state

Sessions are heartbeat-driven:

- the daemon records a heartbeat interval and liveness timeout when the session opens
- the environment-agent keeps the session alive with heartbeats
- heartbeat timeout invalidates the session
- a newer session for the same thread replaces the previous one

### Command flow

1. The daemon persists a command in `environment_agent_commands`.
2. The environment-agent long-polls `GET /threads/:id/environment-agent/session/commands`.
3. The daemon returns commands after the last acknowledged cursor.
4. The environment-agent executes the command against the local provider runtime.
5. The environment-agent posts command lifecycle updates (`started`, `completed`, `failed`) through `POST /threads/:id/environment-agent/session/messages`.
6. The daemon records the final result and unblocks higher-level orchestration logic.

### Event flow

1. The environment-agent observes provider/runtime events and assigns per-channel sequence numbers.
2. It pushes contiguous event batches through `POST /threads/:id/environment-agent/session/messages`.
3. The daemon applies unseen events in order and advances the persisted event cursor.
4. The daemon replies with the accepted cursor so the environment-agent can drop any buffered in-memory events up to that point.

## Environment-Agent HTTP Surface

The environment-agent still exposes an authenticated local HTTP server, but it is intentionally small.

Current endpoint:

- `POST /control/status` — inspect runtime/session status from the environment sidecar

The old direct command/stream/replay endpoints are no longer the primary architecture path.
Daemon control traffic now goes through daemon-hosted session endpoints under `/api/v1/threads/:id/environment-agent/session/*`.

## Workspace, Git, and Primary Checkout Semantics

Workspace and git data are daemon-driven.

The daemon can ask environments for:

- work status
- merge-base branch candidates
- git diffs
- commit/squash-merge execution
- open-path resolution inside the thread workspace

Important behavior:

- workspace status is used for thread badges, archive safety checks, and project-level summaries
- full git diffs are fetched on demand, not streamed over WebSocket
- worktree-capable environments can promote a thread to the project's primary checkout and later demote it back to an isolated checkout
- archive may require `force=true` if Beanbag detects uncommitted or unmerged work that could be lost

## Realtime Behavior

### App side

- WebSocket messages are invalidations, not a full replicated event stream.
- Clients subscribe by entity (`thread` or `system`) and optionally by id.
- The app responds by invalidating specific React Query keys.

### Daemon side

The daemon emits targeted change kinds such as thread status/work-status changes and system restart-policy changes.
This keeps the websocket layer narrow while leaving authoritative state in HTTP + SQLite-backed reads.

## Persistence and Recovery

Beanbag is designed so the daemon remains the durable system of record.

Durable state lives in SQLite and includes:

- projects and threads
- thread events
- queued follow-ups
- persisted environment records
- environment-agent sessions, cursors, and queued commands

Non-durable state includes:

- in-memory provider child processes
- in-memory environment-agent event buffers
- active long-poll requests and timers
- daemon-side in-memory caches such as timeline projections

On boot, the daemon restores the environment metadata it needs, pokes previously active env-agents, and then relies on normal session heartbeats/timeouts to determine whether those workers survived the restart.

## System Services

Additional daemon-level services now include:

- system health reporting for database/log/worktree/attachment storage
- restart recommendation monitoring surfaced to the UI
- managed artifact cleanup for archived thread resources
- background reconciliation of active/provisioning threads after startup

## Summary

The current architecture is organized around one durable coordinator (the daemon), one durable store (SQLite), and one per-thread execution sidecar (the environment-agent).

The most important change from earlier versions is that the environment-agent control plane is now session-based and daemon-hosted: commands, acknowledgements, heartbeats, event batches, replay cursors, and lease state all flow through daemon endpoints and are partially persisted in the database instead of relying on a direct daemon subscription to agent-owned stream endpoints.
