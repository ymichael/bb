# bb Architecture

Reference document for the bb system architecture, data model, and feature set. See `plans/rebuild.md` for the phased implementation plan.

---

## System Overview

```
App/CLI  <--HTTP-->  Server (cloud)  <--HTTP-->  Host-daemon (per machine)
         <--WS(notifications)-->     <--WS(notifications)-->
                                                    |
                                              Provider processes (via agent-runtime, one per thread)
```

| Component | Where | Lifecycle | Role |
|---|---|---|---|
| **Server** | Cloud (or local for dev) | Always on, stateless (DB is the state) | HTTP API, DB, WebSocket hub, routes commands to hosts |
| **Host-daemon** | On each machine | Long-lived, started by CLI/app or as a service | Registers host, provisions environments, runs provider processes, does git operations, relays events to server |
| **App / CLI** | User's machine | Ephemeral | Pure clients, talk only to server |

The host-daemon manages everything on the machine: one `AgentRuntime` instance per environment (from `@bb/agent-runtime`), provider processes (one per active thread), git workspace operations, and environment provisioning. No separate env worker processes.

All connections use the same pattern: **HTTP for data, WebSocket for notifications only.** WS never carries payloads — just change hints so clients know to refetch. WS notifications are fired automatically by the server's data mutation layer, not by route handlers.

---

## Data Model

### Projects

A project knows what the code is and where it can be found.

```
projects:       id, name, createdAt, updatedAt
project_sources: id, projectId, type, hostId, path, repoUrl, timestamps
```

- `project_sources.hostId` — FK to hosts, NOT NULL, CASCADE on delete (source is meaningless without its host)
- `project_sources.path` — text, NOT NULL for `local_path` type
- `project_sources.repoUrl` — text, nullable (set for `github_repo` type)
- Index: `project_sources(projectId)`

Source types: `local_path` (v1), `github_repo` (future). In v1, a project has exactly one source. All code paths needing "the project root" resolve this single source. Multi-source support adds a `primary` flag later.

### Hosts

A host is a machine that can run environments.

```
hosts: id, name, type, provider, externalId, lastSeenAt, timestamps
```

- `id` is stable, generated once per machine, persisted at `$BB_DATA_DIR/host-id`
- `name` is auto-populated from the OS (e.g., `scutil --get ComputerName` on macOS), user can rename
- `type`: `persistent` (user's machine) or `ephemeral` (cloud sandbox like E2B), NOT NULL (set explicitly at registration)
- `lastSeenAt` — integer (epoch ms), NOT NULL. Index: `hosts(lastSeenAt)`
- Auto-registered when a host-daemon connects to the server

### Threads

Threads are where work gets done.

```
threads: id, projectId, environmentId, providerId, type, title, status,
         mergeBaseBranch, parentThreadId, archivedAt, lastReadAt, timestamps
```

- `environmentId` — FK to environments, nullable (set after environment creation)
- `providerId` — text, NOT NULL (set explicitly at creation time)
- `lastReadAt` — integer (epoch ms), nullable (null = never read)
- `archivedAt` — integer (epoch ms), nullable
- Indexes: `threads(projectId, updatedAt)`, `threads(parentThreadId)`

**Types:** `standard` (regular work) and `manager` (delegation-oriented, durable workspace, special rendering — users only see messages sent via a special tool).

**Ownership:** Threads are managed by the user (unparented) or by another thread (`parentThreadId`). This is a handoff primitive — user → manager or manager → user. When a managed thread reaches a terminal state (idle, error), its manager is notified.

**Statuses:** Exactly 5 values: `created`, `provisioning`, `idle`, `active`, `error`. Flow: `created → provisioning → idle ↔ active → error`. Provisioning failures set status to `error` with a distinguishing error code. Do not add intermediate statuses like `provisioned` or `provisioning_failed` — the environment's status and error codes carry that detail.

**Features:**
- Archive/unarchive — inbox model. Unarchived = active work. Archived = done.
- Read/unread (`lastReadAt`) — for user-managed threads. Manager threads track read state based on new user messages or errors only.
- Queued messages — queue-then-send two-step for preparing messages before sending.
- Tell modes — `auto`, `start`, `steer`.

**Execution options:** model, serviceTier, reasoningLevel, sandboxMode. sandboxMode controls the Codex adapter's sandbox policy (read-only / workspace-write / danger-full-access), defaults to `danger-full-access`.

### Environments

An environment is where a thread runs — a filesystem path on a specific host.

```
environments: id, projectId, hostId, path, managed, isGitRepo, provisionerId, provisionerState, branchName, status, timestamps
```

- `hostId` — FK to hosts, NOT NULL, CASCADE on delete
- `path` — text, **nullable**. NULL during provisioning (daemon reports path in command result). Set when provisioning completes.
- `managed` — integer (boolean), NOT NULL, default `0`
- `isGitRepo` — integer (boolean), NOT NULL, default `0`
- `provisionerState` — text (JSON), nullable
- `branchName` — text, nullable (set for managed worktree environments)
- Indexes: `environments(hostId, path)` UNIQUE (when path is not null), `environments(status)`, `environments(projectId)`

**Environment statuses:** `provisioning → ready → error | destroying`

Multiple threads can share one environment. Managed environments (created by the system) are cleaned up only when zero non-archived threads reference them. Unmanaged environments (user-provided paths) are never cleaned up by the system.

**Creation strategies:**

| Strategy | What happens | Managed? | Handled by |
|---|---|---|---|
| **Existing path** | Point at any path on a host. No provisioning. | No | **Server** — creates env record directly with `status: ready` |
| **Managed worktree** | System creates worktree + branch, runs setup script. | Yes | **Host-daemon** — via `environment.provision` command |
| **E2B sandbox** | Creates ephemeral cloud sandbox, clones repo, starts host-daemon inside. | Yes | **Server** — calls E2B API directly (stubbed in v1) |

Provisioners run where they need access: managed worktree needs the host filesystem (runs on daemon), E2B needs an API key (runs on server), existing path needs nothing (server creates the DB record). The `environment.provision` command is only for daemon-side provisioners.

**Actions (environment-scoped, extensible later):** commit, squash merge, promote to primary checkout (server-orchestrated via workspace export/import, not a single daemon command). Future: run workflow, open PR.

**Thread actions (thread-scoped):** archive/unarchive, follow-up/stop, assign/unassign to another thread.

### Events

```
events: id, threadId, environmentId, turnId, providerThreadId, type, sequence, data, createdAt
```

- `threadId` — FK to threads, NOT NULL, CASCADE on delete
- `environmentId` — FK to environments, nullable (thread may not have environment yet)
- `turnId` — text, nullable (correlates events within a conversation turn)
- `providerThreadId` — text, nullable (links to provider's thread identifier)
- `sequence` — integer, NOT NULL
- `data` — text (JSON), NOT NULL
- Unique constraint: `events(threadId, sequence)` (dedup key)
- Indexes: `events(threadId, createdAt)`, `events(environmentId)`

### Queued Thread Messages

```
queued_thread_messages: id, threadId, content, mode, reasoningLevel, sandboxMode, createdAt, updatedAt
```

- `threadId` — FK to threads, NOT NULL, CASCADE on delete
- `content` — text, NOT NULL
- `mode` — text, NOT NULL (`auto`, `start`, `steer`)
- `reasoningLevel` — text, NOT NULL (always set explicitly when queuing)
- `sandboxMode` — text, NOT NULL (always set explicitly when queuing)

### Host-Daemon Sessions

```
host_daemon_sessions: id, hostId, instanceId, protocolVersion, status, hostName, hostType,
                      heartbeatIntervalMs, leaseTimeoutMs, leaseExpiresAt, lastHeartbeatAt,
                      closedAt, closeReason, createdAt, updatedAt
```

- `hostId` — FK to hosts, NOT NULL
- `status` — text, NOT NULL (`active`, `closed`)
- `hostName`, `hostType` — text, NOT NULL (reported by daemon at session open)
- `heartbeatIntervalMs`, `leaseTimeoutMs` — integer, NOT NULL (set by server in session open response)
- `closedAt` — integer (epoch ms), nullable
- `closeReason` — text, nullable (`replaced`, `expired`, `daemon-disconnect`)
- Index: `host_daemon_sessions(hostId, status)`

### Host-Daemon Commands

```
host_daemon_commands: id, hostId, sessionId, cursor, type, payload, state, resultPayload,
                      retryCount, createdAt, fetchedAt, completedAt
```

- `hostId` — FK to hosts, NOT NULL. Commands are **host-scoped** so they survive session replacement.
- `sessionId` — FK to sessions, NOT NULL (records which session queued the command, for audit/cleanup)
- `cursor` — integer, NOT NULL. Unique constraint: `host_daemon_commands(hostId, cursor)` (per-host monotonic cursor). The daemon persists one cursor to disk per host; this works because the cursor space is per-host, not per-session.
- `state` — text, NOT NULL (`pending`, `fetched`, `success`, `error`)
- `retryCount` — integer, NOT NULL, default `0`
- Index: `host_daemon_commands(hostId, state)`

**Why host-scoped, not session-scoped:** The daemon persists a single cursor to `$BB_DATA_DIR/command-cursor` and resumes from it after reconnecting (which creates a new session). If commands were session-scoped, the old session's pending commands would be stranded and the new session's cursor space would start empty. Host-scoped commands ensure the "read cursor from disk and refetch" path works correctly across session replacement.

### Host-Daemon Cursors

```
host_daemon_cursors: hostId, cursor, updatedAt
```

- `hostId` — FK to hosts, PRIMARY KEY
- `cursor` — integer, NOT NULL (last successfully reported command cursor)

---

## Host-Daemon Protocol

### Session lifecycle

1. Daemon starts, reads `$BB_DATA_DIR/host-id` (creates if missing)
2. Opens session: `POST /internal/session/open` with hostId, instanceId (ephemeral, per-process), hostName, hostType, protocolVersion
3. Server returns sessionId, heartbeatIntervalMs, leaseTimeoutMs
4. Daemon maintains WS connection for notifications and sends periodic heartbeats
5. If existing session for same hostId, server closes old WS with `{ type: "session-close", reason: "replaced" }`

Auth: `BB_SECRET_TOKEN` env var, sent as `Authorization: Bearer` on HTTP and as query param on WS. The `sessionId` is passed in request body or query params (not as a custom header) — simpler, easier to test.

**Session replacement:** When a new session opens for the same hostId, the server invalidates the old session ID. All HTTP requests from the old session are rejected (401). The old WS gets `{ type: "session-close", reason: "replaced" }`. This prevents overlapping daemon instances from both fetching commands or posting events.

### Commands (server → daemon)

Server queues commands in DB (host-scoped), sends `{ type: "commands-available" }` over WS. Daemon fetches via `GET /internal/session/commands?afterCursor={N}` (server resolves the host from the session and returns commands for that host). Reports results via `POST /internal/session/command-result`.

**Delivery semantics: at-least-once.** Daemon persists cursor to disk after reporting command results, not after fetching. This ensures at-least-once delivery — if the daemon crashes after fetch but before reporting, it re-fetches the same commands on restart. All commands must be idempotent:
- `thread.start` — checks if a provider process already exists for this thread before spawning
- `environment.provision` — checks if the target path already exists before creating
- `environment.destroy` — no-op if path doesn't exist
- All others are naturally idempotent (sending input, querying status)

16 command types:
```
// Thread/provider
thread.start, thread.resume, turn.run, turn.steer, thread.stop, thread.rename,
provider.list_models

// Environment lifecycle
environment.provision, environment.destroy

// Workspace (git repos only)
workspace.status, workspace.diff, workspace.commit, workspace.squash_merge,
workspace.promote, workspace.demote, workspace.reset, workspace.checkpoint
```

Each command carries `environmentId` and `threadId` inside its own payload (not in a wrapper/meta envelope), so each command is self-describing and can be validated in isolation. `environmentId` is nullable for `provider.list_models` (which the daemon handles without a runtime — it calls `listAvailableProviders()` / adapter-level model listing directly from `@bb/agent-runtime`, not through an environment-scoped `AgentRuntime` instance). The command envelope is a flat `{ id, cursor, command }` structure.

`thread.start` and `thread.resume` must include `workspacePath` in their payload. The daemon needs this to create an `AgentRuntime` (which requires `workspacePath` at construction time). For environments created via provisioning, the server learns the path from the provision command result. For existing-path environments, the server knows the path from the creation request. The daemon caches the path per environment after the first command.

**Provisioning timeout:** `environment.provision` has a configurable timeout (default: 5 minutes, much longer than the generic 60s command TTL) because large repo checkouts and setup scripts can be slow. Other commands use the standard 60s TTL.

### Events (daemon → server)

Daemon posts batches via `POST /internal/session/events`. Each event carries `environmentId`, `threadId`, `sequence`. Server acks with per-thread high-water marks.

**Event flow:** Provider processes emit events via stdout → agent-runtime translates them → daemon buffers and posts to server via HTTP. Server acks with per-thread high-water marks. Daemon discards acked events from its buffer. Server deduplicates by `(threadId, sequence)` for safety on retries.

### Tool calls

Synchronous: daemon posts `POST /internal/session/tool-call`, blocks on HTTP response. No retries — tool calls may have side effects.

**Timeout chain:**
- Provider → daemon: provider has its own tool call timeout (provider-specific, typically 30-60s)
- Daemon → server: HTTP with 120s timeout. If exceeded, daemon returns `ok: false` to provider.
- Server processing: should complete well within 120s for any tool call.

**Failure modes:**
- Server restarts mid-call → daemon gets connection error → returns `ok: false` to provider → provider handles failure
- Daemon crashes mid-call → provider process dies (child of daemon) → turn interrupted

### WS notifications

**Server → Daemon:** `commands-available`, `session-close` (with reason)
**Daemon → Server:** `heartbeat` (with bufferDepth, lastCommandCursor)

### Reconnection

Daemon-driven, server never nudges. On WS drop:
1. Buffer events, retry HTTP with exponential backoff + jitter
2. Reconnect WS with backoff + jitter
3. If WS down >5s, fall back to polling commands every ~10s
4. On WS reconnect, fetch from last cursor, stop polling

### Resilience invariants

- **Event ingestion is idempotent** on `(threadId, sequence)`. Server silently accepts already-seen events.
- **Command cursor persisted to disk.** Daemon writes to `$BB_DATA_DIR/command-cursor` after reporting command results (atomic write: write to temp, rename). On restart, reads from disk and re-fetches from that cursor.
- **Command result delivery with retry.** After executing a command, the daemon POSTs the result to the server with retry (exponential backoff). The cursor is advanced only after successful POST. If the daemon crashes mid-retry, the cursor wasn't advanced — the command is re-fetched and re-executed on restart. Commands are idempotent.
- **Command TTL.** Server tracks commands that were fetched but never got a `command-result`. Standard commands: 60s timeout. `environment.provision`: 5 minute timeout. Abandoned commands re-queue once, then error the thread.
- **Protocol version mismatch** → 400 rejection with supported versions.
- **File locking.** Daemon acquires an exclusive lock on `$BB_DATA_DIR/daemon.lock` at startup. If lock is held, another daemon instance is running — the new instance waits or exits.

### State reconciliation on reconnect

When the daemon reconnects after a network partition or restart, the server and daemon may have diverged. Reconciliation happens during session open:

1. **Daemon reports active provider sessions** as part of session open: `{ activeThreads: [{ environmentId, threadId, providerThreadId }] }`. Empty on fresh restart (all processes died).
2. **Server compares** against its DB state:
   - Thread in `error` (due to lease timeout) but daemon reports it active → server transitions thread back to `active`
   - Thread in `active` but daemon has no session for it → server transitions thread to `idle`
   - **Idle threads without provider sessions** → the daemon handles this lazily: when a command arrives for a thread with no provider session, the daemon calls `ensureRuntime` + `resumeThread` before executing. No server-side action needed.
   - Environment in `provisioning` with no in-flight provision command → handled by command TTL (5 min). No special reconciliation needed.
3. **Server returns** `{ sessionId, heartbeatIntervalMs, leaseTimeoutMs, threadHighWaterMarks }` — the high-water marks allow the daemon to resume event sequence numbering without collisions.

This ensures that after any failure, a single reconnect brings the system back to a consistent state.

### Environment provisioning handshake

1. Client calls `POST /threads` with creation args (provisioner, host, optional path)
2. Server creates environment record (status: provisioning) and thread
3. Server queues `environment.provision` command
4. Daemon runs provisioner, reports result
5. Server updates environment (sets path, status → ready) or errors the thread
6. If thread has pending input, server queues `thread.start`

For existing environments: skip provisioning, just queue `thread.start`.

**Provisioning failure cleanup:**
- If provisioner fails (e.g., setup script errors), the provisioner's `provision()` method is responsible for rolling back partial state (deleting the worktree it created). The provisioner owns its own cleanup on failure.
- If daemon crashes mid-provisioning, the command TTL expires and the server marks the thread as `error`. The partially-created worktree is cleaned up when the environment record is deleted (triggers `environment.destroy`, which the provisioner handles idempotently).
- `environment.provision` is idempotent — provisioner checks if the target path already exists. If it does and is valid, it reports success. If it exists but is invalid (partial state), it cleans up and re-provisions.
- **Errored environment cleanup:** When a thread errors due to provisioning failure, the environment is also marked as `error`. The managed environment cleanup rule applies: when zero non-archived threads reference a managed environment, the server queues `environment.destroy`. For errored environments with no threads (e.g., user deletes the thread), the server should also clean up. The lease expiry sweep or a dedicated errored-environment sweep handles this — query for managed environments in `error` status with zero referencing threads, queue `environment.destroy`. This prevents leaked worktrees on disk.

### Command flow examples

**Creating a thread with an existing path:**
```
App → POST /threads { path, hostId }
Server → creates environment record optimistically (status: ready), creates thread, queues thread.start
Daemon → runs thread.start; if path is bad, reports error
Server → if error: marks environment as error, thread as error
```

**Creating a thread with a managed worktree:**
```
App → POST /threads { provisionerId: "worktree", hostId }
Server → creates environment record (status: provisioning), creates thread (status: provisioning)
Server → queues environment.provision command with { mode: "worktree", sourcePath, targetPath, branchName }
Daemon → calls createWorktree() + runSetupScript() from @bb/workspace
Daemon → reports command-result with { path, isGitRepo: true }
Server → updates environment (status: ready, path), transitions thread to idle
Server → queues thread.start if pending input
```

**Workspace operations (e.g., commit):**
```
App → POST /environments/:id/actions { type: "commit", message: "fix bug" }
Server → resolves environment's host and path from DB
Server → queues workspace.commit command { environmentId, threadId, message, includeUnstaged: true }
Daemon → workspace.commit(options) on Workspace instance
Daemon → reports command-result with { sha, subject }
Server → creates system event, notifies app via WS
```

**Promote (same host, single command):**
```
App → POST /environments/:id/actions { type: "promote" }
Server → resolves source env path + project source (primary checkout) path on same host
Server → queues workspace.promote command { environmentId, primaryPath }
Daemon → checks both workspaces clean, detaches source HEAD, checks out env branch on primary
Daemon → returns { ok: true }
```

**Demote (same host, single command):**
```
App → POST /environments/:id/actions { type: "demote" }
Server → resolves source env path + primary path + project's default branch
Server → queues workspace.demote command { environmentId, primaryPath, defaultBranch }
Daemon → checks primary clean, checks out default branch, reattaches source to its branch
Daemon → returns { ok: true }
```

Promote and demote are **single daemon commands** — no multi-step chaining, no server-side state machine, no partial failure recovery. The daemon executes the full operation atomically. If any step fails (dirty workspace, git error), the command fails and nothing is modified (checks are upfront).

**Idempotency:**
- Promote when already promoted (primary already on env branch) → no-op success.
- Demote when not promoted (primary already on default branch) → no-op success.
- **Both workspaces must be clean.** Fail loudly if either has uncommitted changes. No stashing.

**Promoted state is derived.** The daemon checks what branch the primary checkout is on. If it matches a known environment branch, that environment is promoted. No application state to track. Demote always restores the project's default branch.

**Cross-host promote:** Works only if the branch is already available on the remote (from a prior `workspace.checkpoint`). The daemon fetches the branch and checks it out. No pushing as part of promote — if the branch isn't on the remote, the command fails with a clear error ("branch not available on remote — run checkpoint first"). This means promote/demote is the same command regardless of same-host vs cross-host — the daemon figures out the right approach based on whether the branch is locally visible or needs a fetch.

### Non-git environments

bb works with any directory. If the environment's `isGitRepo` is false:
- Thread runs normally — agent writes code, runs commands
- Server doesn't send workspace commands for non-git environments
- UI shows the thread without the git panel

---

## Host-Daemon Lifecycle

### What the daemon manages

The host-daemon is a single process that manages everything on the machine:

```
Host-daemon
  ├── AgentRuntime for Environment A (workspacePath: /path/to/env-a)
  │     ├── Provider process for Thread 1 (child process, stdio)
  │     └── Provider process for Thread 2 (child process, stdio)
  ├── AgentRuntime for Environment B (workspacePath: /path/to/env-b)
  │     └── Provider process for Thread 3 (child process, stdio)
  ├── Workspace class (git status, diff, commit, merge, export/import — per-environment instance)
  └── Provisioners (create/destroy managed environments)
```

One `AgentRuntime` instance per environment (since `workspacePath` is per-environment). Multiple threads on the same environment share one runtime. Provider processes are child processes of the daemon, communicating over stdio.

### Restart (dev code reloading)

**Provider processes are children of the daemon — they die on restart.** This is the accepted tradeoff for architectural simplicity.

**State on disk:** `$BB_DATA_DIR/command-cursor`

**Restart flow:**
1. Daemon spawns a new instance of itself (detached)
2. Old process exits — all provider processes die
3. New daemon reads `command-cursor` from disk, reconnects WS to server
4. Server detects reconnect, runs state reconciliation
5. Server transitions active threads to `idle` (interrupted, not errored)
6. Server re-queues `thread.resume` commands for threads that need provider sessions re-established
7. Daemon spawns new provider processes, sessions resume

**Impact on active threads:** turns in progress are interrupted. The thread goes to `idle`, not `error`. The user can send another message to start a new turn. Events from the interrupted turn that were already posted to the server are preserved. Events that were buffered in the daemon but not yet posted are lost (small window).

**Impact on idle threads:** seamless. `thread.resume` re-establishes the provider session. User doesn't notice.

**Future improvement:** a socket shim process between daemon and provider could make provider processes survive daemon restarts. Deferred — not needed for v1.

### Failure detection and thread recovery

**Two distinct scenarios with different thread outcomes:**

1. **Daemon restarts (reconnects before lease expires):** Daemon opens a new session, reports `activeThreads` (empty after restart — all provider processes died). Reconciliation runs: threads in `active` that the daemon has no session for → transition to `idle`, server queues `thread.resume`. **Threads go to `idle`, not `error`.** The user's work is interrupted but recoverable.

2. **Daemon dies (lease timeout expires without reconnect):** Server's lease expiry sweep detects the session has timed out. Server marks host as `disconnected`, transitions all active threads on that host to `error`. **Threads go to `error`.** The user sees an error state. When the daemon eventually reconnects, reconciliation can recover threads if appropriate, but the default path is error.

**The distinguishing factor is whether the daemon reconnects before the lease expires.** Restart is designed to be fast enough that it always reconnects in time. Unintentional death (crash, laptop sleep, network loss) may exceed the lease.

Server detects daemon death via WS drop + lease timeout (no heartbeat). Marks host disconnected.

**Host statuses:**
```
Host statuses:
  connected — daemon has active session, heartbeat is current
  disconnected — WS dropped + lease timeout exceeded (any host)
  suspended — cloud host intentionally paused to save cost (server-initiated)

Transitions:
  connected → disconnected (heartbeat timeout — unintentional, e.g., crash, laptop sleep)
  connected → suspended (server suspends cloud host on idle)
  disconnected → connected (daemon reconnects)
  suspended → connected (server resumes cloud host on command)
```

**Host status is derived, not persisted.** The `hosts` table has no `status` column. The server derives status at query time by checking whether the host has an active, non-expired session. `connected` = active session with current heartbeat. `disconnected` = no active session or lease expired. `suspended` = server-initiated pause (cloud hosts only, v2).

---

## Configuration

**Package: `@bb/config`** — uses `envsafe` with scoped exports per consumer.

| Scope | Import | Key vars |
|---|---|---|
| Common | `@bb/config/common` | `BB_DATA_DIR`, `BB_LOG_LEVEL`, `BB_SECRET_TOKEN` |
| Server | `@bb/config/server` | `BB_SERVER_PORT`, `BB_DATABASE_URL`, `BB_E2B_API_KEY` (optional), `BB_E2B_TEMPLATE` (optional) |
| Host-daemon | `@bb/config/host-daemon` | `BB_SERVER_URL` |
| CLI | `@bb/config/cli` | `BB_SERVER_URL` |

`BB_DATA_DIR` is used by both server and host-daemon. Server: `bb.db`, `logs/server.log`. Host-daemon: `host-id`, `command-cursor`, `daemon.lock`, `logs/host-daemon.log`.

Config sources: env vars and `.env` files. `~/.bb/config.json` deferred (easy to add — just merge into `process.env` before envsafe runs). No per-project settings in DB.

---

## Logger

**Package: `@bb/logger`** — wraps `pino` with per-component log files and built-in rotation. Replaces the old custom rotating JSON line writer (deleted in clean-slate). Less code, better features.

```
$BB_DATA_DIR/logs/
  server.log, host-daemon.log
```

**API:**
```typescript
import { createLogger } from "@bb/logger";

// Root logger — writes to file + optionally stdout
const log = createLogger({ component: "server" });

// Child logger — inherits file destination, adds context fields
const threadLog = log.child({ threadId: "thr_abc123" });
threadLog.info("turn started");  // includes { component: "server", threadId: "thr_abc123" }
```

**Features:**
- Structured JSON to files (one JSON object per line, greppable)
- `pino-pretty` for dev terminal output (controlled by `BB_LOG_FORMAT=json|pretty`)
- Size-based rotation via `pino-roll` (configurable max size + file count, defaults: 10MB / 5 files)
- Child loggers with inherited context (threadId, environmentId, hostId, etc.)
- Standard log levels: `trace`, `debug`, `info`, `warn`, `error`, `fatal`
- Error serialization with stack traces (pino handles this natively, including `.cause` chains)

**What it does NOT have** (not needed for v1):
- Async context propagation / trace IDs (was in an unmerged branch, never shipped)
- HTTP request logging middleware (add later if needed)
- Console interception (the old system hijacked console.log — fragile, unnecessary with pino)
- Performance monitoring hooks (add later if needed)

**Dependencies:** `pino`, `pino-roll`, `pino-pretty` (dev). Minimal surface.

---

## Instance Isolation

All state lives under `BB_DATA_DIR` (default: `~/.bb`). Concurrent isolated instances via different `BB_DATA_DIR` + `BB_SERVER_PORT`:

```bash
BB_DATA_DIR=/tmp/bb-test-1 BB_SERVER_PORT=3001 bb start
BB_DATA_DIR=/tmp/bb-test-2 BB_SERVER_PORT=3002 bb start
```

Each gets its own DB, logs, host identity. Tests use temp dirs + in-memory SQLite.

---

## Real-time / WebSocket (App/CLI)

Subscribe/unsubscribe per entity, server pushes change-kind arrays. Notification-only — client refetches via HTTP.

| Entity | Change kinds |
|---|---|
| **Thread** (by ID) | thread-created, thread-deleted, events-appended, status-changed, title-changed, queue-changed, work-status-changed, archived-changed, read-state-changed |
| **System** (global) | host-connected, host-disconnected, environment-created, environment-deleted |
| **Project** (by ID) | sources-changed, threads-changed |

---

## System / Operational

**Client-side (app/CLI handles directly):** pick-folder (native dialog), open-path (open in editor). Disabled with clear error states for threads on remote hosts.

**Host status in UI:** connection status (connected/disconnected/reconnecting), manual restart button.

**Server-side:** shutdown with blocking thread detection, voice transcription, file attachment upload.

---

## Providers

Three built-in: codex, claude-code, pi. Process-based via `@bb/agent-runtime` (mostly done, left as-is). Extensions system deferred. Capabilities: `supportsRename`, `supportsServiceTier`.

---

## Package Map

| Package | Purpose | Dependencies |
|---|---|---|
| `@bb/domain` | Entity types, event types, Zod schemas | zod |
| `@bb/config` | Typed env var config, scoped exports | envsafe |
| `@bb/logger` | Structured logging, rotation, per-component files | pino, pino-roll, @bb/config |
| `@bb/db` | Schema, migrations, connection, IDs | @bb/domain, drizzle, better-sqlite3 |
| `@bb/server-contract` | Public + internal API routes, WS protocol, error types, hc() clients | @bb/domain, zod, hono |
| `@bb/host-daemon-contract` | Commands, events, session protocol, hc() client | @bb/domain, zod, hono |
| `@bb/agent-runtime` | Provider adapters, registry, runtime | @bb/domain, @bb/templates |
| `@bb/templates` | Prompt templates | gray-matter, handlebars |
| `@bb/core-ui` | View transforms (toViewMessages, formatTimeline, detail rows) | @bb/domain, @bb/templates |
| `@bb/workspace` | Provisioning (worktree, clone), git operations (status, diff, commit, merge, promote), setup scripts | @bb/domain |
| `@bb/ui-core` | Shared React components | react |
| `@bb/tsconfig` | Shared TS config | — |
| `apps/server` | Server implementation | @bb/domain, @bb/config, @bb/logger, @bb/db, @bb/server-contract, @bb/host-daemon-contract |
| `apps/host-daemon` | Host-daemon implementation | @bb/domain, @bb/config, @bb/logger, @bb/host-daemon-contract, @bb/agent-runtime, @bb/workspace |
| `apps/app` | Electron/web app | @bb/domain, @bb/core-ui, @bb/ui-core, @bb/server-contract |
| `apps/cli` | CLI | @bb/domain, @bb/core-ui, @bb/server-contract |

### Code ownership

| Code | Location |
|---|---|
| `Workspace` class, provisioning functions | `@bb/workspace` |
| Promote/demote orchestration (export/import/reattach) | `apps/host-daemon` (daemon composes Workspace primitives) |
| E2B sandbox create/suspend/resume/destroy | `apps/server` (stubbed in v1) |
| Host registration, identity, heartbeat | `apps/host-daemon` |
| Command routing, AgentRuntime management | `apps/host-daemon` |
| Environment DB records, thread lifecycle, command queuing | `apps/server` |
| Workspace types (WorkspaceStatus, DiffResult, etc.) | `@bb/domain` |

The server never imports `@bb/workspace`. It sends commands to daemons. The daemon imports `@bb/workspace` and uses it when processing commands.

---

## Route Renames

Taking this opportunity to clean up route naming for clarity and consistency.

### Routes to remove
- `/system/pick-folder` — client-side now
- `/system/open-path` — client-side now
- `/threads/:id/open-path` — client-side now
- `/system/restart-policy` — dropped
- `/system/environments` — replaced by hosts + provisioners
- `/system/provider` (singular) — redundant with `/system/providers`
- `/environments/:id/env-daemon/sessions` — replaced by host-scoped sessions

### Routes to rename

| Current | New | Why |
|---|---|---|
| `/threads/:id/tell` | `/threads/:id/send` | "tell" is jargon, "send" is universal |
| `/threads/:id/queue` | `/threads/:id/drafts` | "queue" sounds like a job system, "drafts" matches the UX |
| `/threads/:id/queue/:queuedMessageId/send` | `/threads/:id/drafts/:draftId/send` | follows from above |
| `/threads/:id/queue/:queuedMessageId` | `/threads/:id/drafts/:draftId` | follows from above |
| `/projects/:id/workspace-status` | `/projects/:id/work-status` | consistency with thread work-status |
| `/projects/:id/manager` | `/projects/:id/managers` | plural, POST to collection |
| `/threads/:id/tool-group-messages` | `/threads/:id/timeline/tool-details` | sub-resource of timeline |
| `/threads/:id/git-diff` | `/threads/:id/diff` | shorter, clear enough |
| `/threads/:id/merge-base-branches` | `/threads/:id/diff/branches` | sub-resource of diff |
| `/threads/:id/primary-status` | `/environments/:id/primary-status` | environment concern, not thread |
| `/environments/:id/operations` | `/environments/:id/actions` | matches "environment actions" terminology |

---

## Type Renames

**Clean break — no aliases.** When renaming, use only the new name. Do not export the old name as a backward-compat alias. There are no external consumers to maintain compatibility for during the rebuild.

### Domain types

**Timeline/view types (rename from "Detail" to "Timeline"):**

| Current | New |
|---|---|
| `ThreadDetailRow` | `TimelineRow` |
| `ThreadDetailToolGroupRow` | `TimelineToolGroupRow` |
| `ThreadDetailToolGroupStatus` | `TimelineToolGroupStatus` |
| `ThreadDetailMessageRow` | `TimelineMessageRow` |

**Workspace types (rename from "Work" to "Workspace"):**

| Current | New |
|---|---|
| `ThreadWorkStatus` | `WorkspaceStatus` |
| `ThreadWorkState` | `WorkspaceState` |
| `ThreadWorkFileChange` | `WorkspaceFileChange` |

**Event data types (clarify what they represent):**

| Current | New |
|---|---|
| `ClientOutboundStartEventData` | `TurnRequestEventData` |
| `ClientExecutionOptionsSnapshot` | `TurnRequestOptions` |
| `AppThreadEventType` | `SystemEventType` |

**Provider event types (drop redundant "Thread"):**

| Current | New |
|---|---|
| `ProviderThreadEvent` | `ProviderEvent` |
| `SystemThreadEvent` | `SystemEvent` |

Keep `ThreadEvent` as-is (union type — "event on a thread" is correct). Keep all `ThreadEvent*` sub-types (e.g., `ThreadEventItem`, `ThreadEventFileChange`, `ThreadEventTokenUsage`) — the `Thread` prefix is meaningful to distinguish from future `EnvironmentEvent*` types.

**UI types (rename prefix from "UI" to "View"):**

| Current | New |
|---|---|
| `UIMessage` | `ViewMessage` |
| `UIUserMessage` | `ViewUserMessage` |
| `UIAssistantTextMessage` | `ViewAssistantTextMessage` |
| `UIAssistantReasoningMessage` | `ViewAssistantReasoningMessage` |
| `UIToolCallMessage` | `ViewToolCallMessage` |
| `UIToolExploringMessage` | `ViewToolExploringMessage` |
| `UIToolCallSummary` | `ViewToolCallSummary` |
| `UIToolParsedIntent` | `ViewToolParsedIntent` |
| `UIWebSearchMessage` | `ViewWebSearchMessage` |
| `UIFileEditMessage` | `ViewFileEditMessage` |
| `UIFileEditChange` | `ViewFileEditChange` |
| `UIOperationMessage` | `ViewOperationMessage` |
| `UIErrorMessage` | `ViewErrorMessage` |
| `UIDebugRawEventMessage` | `ViewDebugRawEventMessage` |
| `UIMessageBase` | `ViewMessageBase` |
| `UIMessageStatus` | `ViewMessageStatus` |
| `UIProvisioningMetadata` | `ViewProvisioningMetadata` |
| `ToUIMessagesOptions` | `ToViewMessagesOptions` |

### Server-contract types

| Current | New | Why |
|---|---|---|
| `SpawnThreadRequest` | `CreateThreadRequest` | matches REST (`POST /threads`) |
| `TellThreadRequest` | `SendMessageRequest` | matches route rename |
| `TellThreadMode` | `SendMessageMode` | follows |
| `EnqueueThreadMessageRequest` | `CreateDraftRequest` | matches route rename |
| `SendQueuedThreadMessageRequest` | `SendDraftRequest` | follows |
| `SendQueuedThreadMessageResponse` | `SendDraftResponse` | follows |
| `ThreadToolGroupMessagesRequest` | `TimelineToolDetailsRequest` | matches route rename |
| `ThreadToolGroupMessagesResponse` | `TimelineToolDetailsResponse` | follows |
| `EnvironmentOperationRequest` | `EnvironmentActionRequest` | matches terminology |
| `EnvironmentOperationType` | `EnvironmentActionType` | follows |
| `EnvironmentOperationResponse` | `EnvironmentActionResponse` | follows |
| `EnvironmentOperationApiError` | `EnvironmentActionApiError` | follows |
| `EnvironmentOperationFailureDetails` | `EnvironmentActionFailureDetails` | follows |
| `SystemHealthEnvironmentDaemon*` | `SystemHealthDaemon*` | shorter, daemon is always host-daemon now |
| All `SystemRestart*` / `SystemRestartPolicy` types | remove | restart policy dropped |
| `ThreadOperationRequest` / `ThreadOperationType` | remove | now environment actions |

### Host-daemon-contract types

Full rewrite — strip old `environmentDaemon*` prefix. Use `HostDaemon*` prefix on all exported types: `HostDaemonCommand`, `HostDaemonCommandType`, `HostDaemonEventEnvelope`, `HostDaemonSessionOpenRequest`, etc. Generic names like `Command` or `Event` collide when both `@bb/server-contract` and `@bb/host-daemon-contract` are imported in the same file (which happens in the server). The `HostDaemon*` prefix avoids this.

Define typed result schemas per command type (a record mapping command type to its result schema) rather than a single generic result shape. This catches contract mismatches at parse time.

Use typed event envelopes (reuse `threadEventSchema` from `@bb/domain`) rather than untyped `z.record()` payloads.

Event ack format: `Record<string, number>` (threadId → high-water mark), not an array of objects.

---

## Out of scope (v1)

- GitHub repo project sources
- Multi-machine (data model ready, only local host in v1)
- Docker environments
- Extensions system
- Per-project DB settings
