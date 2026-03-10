# Architecture

## Overview

Beanbag is split into a React app, a daemon, environment implementations, an environment-agent control plane, and a provider adapter/runtime.

At a high level:

1. The app submits commands to the daemon over HTTP.
2. The daemon creates and manages threads, events, environments, and provider sessions.
3. Each thread runs inside a selected environment (`local`, `worktree`, or `docker`).
4. Each active environment exposes an `environment-agent` HTTP control API.
5. The daemon talks to the environment-agent, and the environment-agent talks to the provider runtime.
6. Provider events flow back through the environment-agent and are ingested by the daemon.
7. The app refreshes data through React Query, primarily driven by daemon WebSocket invalidation messages.

## Main Components

### `apps/app`

- React app using React Query for server state.
- Uses daemon HTTP APIs for reads/writes.
- Opens a WebSocket to the daemon.
- On thread/system change messages, invalidates specific query keys rather than maintaining a parallel client-side event model.

Primary query families invalidated from WebSocket messages:

- `threads`
- `thread`
- `threadTimeline`
- `threadWorkStatus`
- `status`
- `systemRestartPolicy`

Notes:

- The app does **not** use interval polling for live thread updates.
- Some React Query fetches can still happen on mount, focus, or reconnect depending on query options/defaults.
- Git diff payloads are fetched on demand over HTTP; they are not pushed over the WebSocket.

### `apps/daemon`

The daemon is the system coordinator. It:

- owns the HTTP and WebSocket API
- persists threads/events/projects via `@beanbag/db`
- provisions and restores thread environments
- connects to per-thread environment-agent instances
- translates daemon-level operations into environment-agent commands
- ingests provider-originated events and persists/broadcasts them

Key daemon responsibilities:

- create thread records
- track thread status (`created`, `provisioning`, `active`, `idle`, `provisioning_failed`)
- maintain provider thread ids / active turn ids
- replay or resume sessions after restart/suspend
- fan out WebSocket invalidations to the app

### `packages/db`

Persistence layer for:

- projects
- threads
- events
- queued follow-up messages
- persisted environment records
- environment-agent replay cursor

A new thread row is created immediately when spawning a thread; provisioning happens asynchronously afterward.

### `packages/environment`

Environment implementations define where thread work runs.

Current built-in environments:

- `local`
- `worktree`
- `docker`

Each environment is responsible for:

- preparing/restoring its workspace
- exposing an environment-agent connection target
- suspending/destroying resources when idle/archived
- reporting workspace status / diffs / commit metadata

### `packages/environment-agent`

The environment-agent is a per-environment control plane process with an HTTP API.

It is responsible for:

- starting and supervising the provider runtime
- translating daemon commands into provider JSON-RPC
- capturing provider stdout/stderr/events
- assigning sequence numbers to emitted events
- exposing live event streaming and replay
- attempting batched delivery of buffered events back to the daemon

Important nuance:

- Event buffering inside the environment-agent is **in memory**, not durable on disk.
- The environment-agent is generally **long-lived per thread environment**, not one-shot per turn.

### `packages/agent-server`

The daemon-side adapter layer that knows how to:

- build provider launch specs
- initialize the provider
- send `thread.start`, `thread.resume`, `turn.start`, `turn.steer`, and rename commands
- normalize provider notifications into Beanbag thread events

Provider selection is currently daemon-global. The built-in registry currently supports only:

- `codex`

## Thread Lifecycle

### New thread

1. App sends `POST /threads`.
2. Daemon creates a thread row in the DB with status `created`.
3. Daemon schedules provisioning asynchronously.
4. Daemon provisions the selected environment.
5. Environment starts/restores the environment-agent.
6. Daemon opens a live environment-agent subscription.
7. Daemon asks the environment-agent to ensure the provider is running.
8. Daemon sends `thread.start`.
9. If an initial prompt was included, daemon then sends `turn.start`.
10. Provider events are ingested, persisted, and broadcast as thread changes.
11. Thread eventually transitions to `idle` when the turn completes.

### Follow-up on an existing thread

1. App sends `POST /threads/:id/tell`.
2. Daemon validates thread state.
3. Daemon tries to locate an in-memory provider session.
4. If none exists, daemon restores the environment runtime and tries `thread.resume` using the persisted provider thread id.
5. If resume succeeds, daemon sends either:
   - `turn.steer` when there is an active turn and steering is allowed, or
   - `turn.start` otherwise.

### Reprovision fallback when resume fails

A special fallback exists when `thread.resume` fails because the provider no longer recognizes the persisted provider thread id.

This happens only on the resume path:

- no in-memory provider session is available
- a persisted provider thread id exists
- `thread.resume` returns `missing_provider_thread`

When that happens, the daemon:

1. reprovisions the thread environment with reason `resume-missing-provider-thread`
2. starts a fresh provider thread session
3. continues the pending follow-up from that fresh session

Known concrete trigger recognized by the current code:

- provider reports something equivalent to `no rollout found for thread id ...`

Practical examples:

- daemon restart followed by resume of an old provider session
- idle suspend / environment-agent restart followed by resume
- provider-side rollout/session eviction

Timeouts or provider-unavailable errors do **not** take this reprovision path.

## Environment-Agent Control Plane

The daemon talks to the environment-agent over HTTP.

Important endpoints exposed by the environment-agent:

- `GET /stream` — live event stream
- `POST /control/command` — execute commands (`thread.start`, `thread.resume`, `turn.start`, `turn.steer`, etc.)
- `POST /control/provider/ensure` — ensure provider runtime is up
- `POST /control/replay` — replay buffered events after a sequence cursor
- `POST /control/status` — inspect runtime state
- `POST /control/delivery/retry` — nudge daemon delivery retry

The environment-agent itself is protected by a bearer token. That same token is also used when the environment-agent delivers events back to the daemon.

## Event Flow

There are **two** daemon-facing event paths from the environment-agent:

### 1. Live stream path

- Daemon subscribes to `GET /stream`
- Environment-agent emits sequenced events live
- Daemon ingests contiguous unseen events and advances its replay cursor

### 2. Delivery path

- Environment-agent batches pending events and POSTs them to:
  - `POST /threads/:id/environment-agent/deliver`
- Delivery is in-order and cursor-based
- Daemon acknowledges the highest accepted sequence

### Replay path

- Daemon can request replay from a stored cursor
- Used after reconnect/restart to close gaps

## Delivery, Retry, and Buffering Semantics

Environment-agent delivery is event-driven, with timer-based batching/retry:

- bursty events are debounced into batched delivery
- failed delivery is retried with backoff
- after the automatic retry budget is exhausted, delivery becomes `stalled`
- daemon can later nudge retry explicitly

Important caveats:

- This is **not durable queueing**; buffered environment-agent events live in memory.
- If the environment-agent exits before the daemon ingests buffered events, only events already streamed/ingested are guaranteed to survive.

## Environment Lifetime

The environment-agent usually stays alive after a turn completes.

After a thread becomes `idle`, the daemon may auto-suspend the environment after a timeout (default: 5 minutes).

On suspend:

- the live daemon subscription is closed
- environment runtime is detached/suspended
- environment-agent receives shutdown / SIGTERM
- environment-agent attempts a best-effort flush of pending daemon delivery before exit

## Workspace Status and Git Data Flow

Workspace status updates are daemon-side and watch-driven:

- environments with host filesystem access install filesystem watches over git metadata paths
- when those files change, Beanbag recomputes workspace status
- if the computed status changed, daemon broadcasts `work-status-changed`
- app invalidates/refetches the `threadWorkStatus` query

Important nuance:

- This watcher flow is for **workspace status**, not full diff payload streaming.
- Full git diffs are still requested over HTTP by the app when needed.

## Polling vs Event-Driven Behavior

### App side

- No interval polling for live thread updates.
- Live freshness is driven by daemon WebSocket invalidation.
- React Query may still refetch on mount/focus/reconnect depending on configuration.

### Daemon side

For domain data flow, the daemon is primarily **event/watch driven**, not polling driven.

Event/watch-driven examples:

- environment-agent live event stream
- environment-agent push delivery + replay
- WebSocket broadcasts to the app
- filesystem watches for workspace status
- filesystem watches for restart recommendation files

However, there are a few timer-based mechanisms that are **not** periodic data polling but are still worth knowing about:

- short startup health-check loops while waiting for an environment-agent to come up
- delivery debounce timers
- delivery retry backoff timers
- idle environment suspend timers
- queued broadcast debounce timers

So the most accurate statement is:

> Beanbag does not rely on steady-state polling loops for thread/project/event/workspace data synchronization. It is primarily event-driven, with timer-based debouncing, retries, and startup health checks.

## Test Coverage Snapshot

Current coverage is strongest in daemon and control-plane layers.

Notable tests:

- `apps/daemon/src/__tests__/e2e/thread-spawn-roundtrip.test.ts`
  - CLI -> HTTP -> daemon -> provider roundtrip
- `apps/daemon/src/__tests__/e2e/docker-thread-roundtrip.test.ts`
  - daemon -> docker environment -> in-container environment-agent -> provider
- `apps/daemon/src/__tests__/e2e/environment-agent-delivery-roundtrip.test.ts`
  - authenticated delivery path
- `apps/daemon/src/__tests__/e2e/environment-agent-replay-roundtrip.test.ts`
  - replay path
- `apps/daemon/src/__tests__/e2e/environment-agent-restart-roundtrip.test.ts`
  - daemon restart recovery
- `apps/daemon/src/__tests__/orchestrator.test.ts`
  - resume-missing-provider-thread reprovision fallback
- `packages/agent-server/src/__tests__/environment-agent-session.test.ts`
  - daemon <-> environment-agent command protocol

Known gap:

- There is no single browser-level test that spans React app UI + daemon WebSocket invalidation + environment-agent + provider end-to-end.

## Current Limitations / Important Caveats

- Provider selection is currently global and effectively `codex`-only.
- Environment-agent buffered events are not durable.
- Git diff contents are on-demand, not live-pushed.
- App freshness is mostly event-driven, but React Query focus/remount behavior still exists.

