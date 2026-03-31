# bb Architecture

Reference document for the bb system architecture, data model, and protocol specs. See `plans/rebuild.md` for the phased implementation plan.

---

## System Overview

```
App/CLI  <--HTTP-->  Server (cloud)  <--HTTP-->  Host-daemon (per machine)
         <--WS(notifications)-->     <--WS(notifications)-->
   |                                                    |
   +-----HTTP (local API)----> Host-daemon         Provider processes (via agent-runtime, one per thread)
```

| Component | Where | Lifecycle | Role |
|---|---|---|---|
| **Server** | Cloud (or local for dev) | Always on, stateless (DB is the state) | HTTP API, DB, WebSocket hub, routes commands to hosts |
| **Host-daemon** | On each machine | Long-lived, started by CLI/app or as a service | Registers host, provisions workspaces, runs provider processes, does git operations, relays events to server. Exposes a local API for app/CLI. |
| **App / CLI** | User's machine | Ephemeral | Talk to server for data + WS notifications. Talk directly to the local host daemon for machine-local operations (host ID, open-in-editor, folder picker, daemon status). |

**Server connections** use HTTP for data, WebSocket for notifications only. WS never carries payloads — just change hints so clients know to refetch. WS notifications are fired automatically by the server's data mutation layer, not by route handlers.

**Local daemon connections** are direct HTTP from app/CLI to the daemon on `localhost:BB_HOST_DAEMON_PORT`. No auth (localhost-only). Used for operations that must be instant and work even when the server is unreachable. See "Host-Daemon Local API" section below.

---

## Thread Creation: Host × Workspace

When a user creates a thread, two orthogonal decisions are made:

### Which host?

| Host type | What happens | Who provisions |
|---|---|---|
| **Persistent** (user's machine) | Verify daemon is connected | No provisioning — daemon is already running |
| **Ephemeral** (E2B / cloud sandbox) | Provision sandbox, start daemon inside | **Server** — calls cloud provider API directly |

### Where on that host?

| Workspace strategy | What happens | Managed? | Who provisions |
|---|---|---|---|
| **Existing path** | Point at any directory. Daemon validates path and discovers properties. | No | **Host-daemon** — via `environment.provision` command with mode `unmanaged` |
| **Worktree** | Create git worktree + branch, run setup script | Yes | **Host-daemon** — via `environment.provision` command |
| **Clone** | Clone repo, create branch, run setup script | Yes | **Host-daemon** — via `environment.provision` command |

Workspace provisioning happens *on* the host. Host provisioning (for ephemeral hosts) happens *before* workspace provisioning — the server must get a running daemon before it can send workspace commands to it.

### Lifecycle

| Phase | Persistent host | Ephemeral host |
|---|---|---|
| **Startup** | Verify daemon connected | Provision sandbox → start daemon inside → daemon connects |
| **Idle** (no active threads) | Nothing | Possibly suspend to save cost (server-initiated) |
| **Cleanup** (all threads archived) | Destroy managed workspaces only | Destroy managed workspaces + destroy host |

Host suspension and resume are **server-side orchestration** — the daemon doesn't know or care. From the daemon's perspective, it starts up, connects, and works. Whether it's on a laptop or inside E2B is invisible to it.

---

## Data Model

### Projects

A project knows what the code is and where it can be found.

```
projects:       id, name, createdAt, updatedAt
project_sources: id, projectId, type, hostId, path, repoUrl, timestamps
```

- `project_sources.hostId` — FK to hosts, CASCADE on delete. Currently NOT NULL, but Phase 8 will make this nullable for `github_repo` sources (which aren't tied to a specific host).
- `project_sources.path` — text, nullable (NULL for `github_repo` sources, set for `local_path`)
- `project_sources.repoUrl` — text, nullable (set for `github_repo` type)
- Index: `project_sources(projectId)`

Source types: `local_path` (working) and `github_repo` (schema ready, server/UI support in Phase 8). In v1, a project has one source. All code paths needing "the project root" resolve this single source.

### Hosts

A host is a machine that can run environments.

```
hosts: id, name, type, provider, externalId, lastSeenAt, timestamps
```

- `id` is stable, generated once per machine, persisted at `$BB_DATA_DIR/host-id`
- `name` is auto-populated from the OS (e.g., `scutil --get ComputerName` on macOS), user can rename
- `type`: `persistent` (user's machine) or `ephemeral` (cloud sandbox like E2B), NOT NULL (set explicitly at registration)
- `provider` — text, nullable. For ephemeral hosts: "e2b", "codespaces", etc. NULL for persistent.
- `externalId` — text, nullable. Provider-specific identifier for ephemeral hosts.
- `lastSeenAt` — integer (epoch ms), NOT NULL. Index: `hosts(lastSeenAt)`
- Persistent hosts: auto-registered when a host-daemon connects to the server
- Ephemeral hosts: created by the server when provisioning a cloud sandbox

**Host status is derived, not persisted.** The `hosts` table has no `status` column. The server derives status at query time:
- `connected` — active session with current heartbeat
- `disconnected` — no active session or lease expired
- `suspended` — server-initiated pause (ephemeral hosts only, v2)

### Threads

Threads are where work gets done.

```
threads: id, projectId, environmentId, providerId, type, title, titleFallback, status,
         mergeBaseBranch, parentThreadId, archivedAt, lastReadAt, timestamps
```

- `environmentId` — FK to environments, nullable (set after environment creation)
- `providerId` — text, NOT NULL (set explicitly at creation time)
- `lastReadAt` — integer (epoch ms), nullable (null = never read)
- `archivedAt` — integer (epoch ms), nullable
- Indexes: `threads(projectId, updatedAt)`, `threads(parentThreadId)`

**Types:** `standard` (regular work) and `manager` (delegation-oriented, durable thread storage, special rendering — users only see messages sent via a special tool).

**Ownership:** Threads are managed by the user (unparented) or by another thread (`parentThreadId`). This is a handoff primitive — user → manager or manager → user. When a managed thread reaches a terminal state (idle, error), its manager is notified.

**Statuses:** Exactly 5 values: `created`, `provisioning`, `idle`, `active`, `error`. Transitions enforced by a central `transitionThreadStatus` function with an explicit allowed-transitions table:

```
created → provisioning, idle
provisioning → idle, error
idle → active, error
active → idle, error
error → active, idle
```

Do not add intermediate statuses like `provisioned` or `provisioning_failed` — the environment's status and error codes carry that detail.

**Features:**
- Archive/unarchive — inbox model. Unarchived = active work. Archived = done.
- Read/unread (`lastReadAt`) — for user-managed threads. Manager threads track read state based on new user messages or errors only.
- Queued messages — queue-then-send two-step for preparing messages before sending.
- Tell modes — `auto`, `start`, `steer`.

**Execution options:** model, serviceTier, reasoningLevel, sandboxMode. sandboxMode controls the Codex adapter's sandbox policy (read-only / workspace-write / danger-full-access), defaults to `danger-full-access`.

### Environments

An environment is where a thread runs — a filesystem path on a specific host.

```
environments: id, projectId, hostId, path, managed, isGitRepo, isWorktree, workspaceProvisionType, branchName, status, timestamps
```

- `hostId` — FK to hosts, NOT NULL, CASCADE on delete
- `path` — text, **nullable**. NULL during provisioning (daemon reports path in command result). Set when provisioning completes.
- `managed` — integer (boolean), NOT NULL, default `0`
- `isGitRepo` — integer (boolean), NOT NULL, default `0`
- `workspaceProvisionType` — text, nullable (`unmanaged`, `managed-worktree`, `managed-clone`)
- `branchName` — text, nullable (set for managed worktree environments)
- Indexes: `environments(hostId, path)` UNIQUE (when path is not null), `environments(status)`, `environments(projectId)`

**Environment statuses:** `provisioning → ready → error | destroying`

Multiple threads can share one environment. Managed environments (created by the system) are cleaned up only when zero non-archived threads reference them. Unmanaged environments (user-provided paths) are never cleaned up by the system.

**Actions (environment-scoped, extensible later):** commit, squash merge, promote to primary checkout (single atomic daemon command), demote back to default branch. Future: run workflow, open PR.

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
- Unique index: `events(threadId, sequence)` (dedup key)
- Index: `events(environmentId)`

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
- `sessionId` — FK to sessions, nullable (`onDelete: "set null"`). Records which session queued the command for audit. Nullable so commands survive session cleanup.
- `cursor` — integer, NOT NULL. Unique constraint: `host_daemon_commands(hostId, cursor)` (per-host monotonic cursor). Used for deterministic fetch ordering and audit.
- `state` — text, NOT NULL (`pending`, `fetched`, `success`, `error`)
- `retryCount` — integer, NOT NULL, default `0`
- Index: `host_daemon_commands(hostId, state)`

**Why host-scoped, not session-scoped:** When a session is replaced, the new daemon session must continue draining the host's pending work. If commands were session-scoped, pending or fetched commands tied to the old session would be stranded. Host-scoped commands let session replacement and TTL recovery work without special migration logic.

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

Server queues commands in DB (host-scoped), sends `{ type: "commands-available" }` over WS. Daemon fetches via `GET /internal/session/commands` (server resolves the host from the session and returns pending commands for that host). Reports results via `POST /internal/session/command-result`.

**Delivery semantics: at-least-once.** The server marks commands `fetched` when it hands them to the daemon. If the daemon reports a result, the command moves to `success` or `error`. If the daemon crashes after fetch but before reporting, the command stays `fetched` until the command TTL sweep re-queues it to `pending`. The daemon does not persist cursor state on disk; recovery relies on command state plus the sweep. All commands must be idempotent:
- `thread.start` — checks if a provider process already exists for this thread before spawning
- `environment.provision` — checks if the target path already exists before creating
- `environment.destroy` — no-op if path doesn't exist
- All others are naturally idempotent (sending input, querying status)

21 command types:
```
// Thread/provider
thread.start, thread.resume, turn.run, turn.steer, thread.stop, thread.rename,
provider.list, provider.list_models

// Environment lifecycle
environment.provision, environment.destroy

// Workspace (git repos only)
workspace.status, workspace.diff, workspace.commit, workspace.squash_merge,
workspace.promote, workspace.demote, workspace.reset,
workspace.list_files, workspace.read_file, workspace.list_branches
```

**Protocol hardening:** The daemon parses commands individually, not as a batch. If any command has an unknown type (version mismatch), it is skipped and reported back to the server with `errorCode: "unknown_command"` so the server knows not to retry it. This allows the server and daemon to be upgraded independently.

Each command carries `environmentId` and `threadId` inside its own payload (not in a wrapper/meta envelope), so each command is self-describing and can be validated in isolation. `environmentId` is nullable for `provider.list_models` (which the daemon handles without a runtime — it calls `listAvailableProviders()` / adapter-level model listing directly from `@bb/agent-runtime`, not through an environment-scoped `AgentRuntime` instance). The command envelope is a flat `{ id, cursor, command }` structure.

`thread.start` and `thread.resume` must include `workspacePath` in their payload. The daemon needs this to create an `AgentRuntime` (which requires `workspacePath` at construction time). For environments created via provisioning, the server learns the path from the provision command result. For existing-path environments, the server knows the path from the creation request. The daemon caches the path per environment after the first command.

**Provisioning timeout:** `environment.provision` has a configurable timeout (default: 5 minutes, much longer than the generic 60s command TTL) because large repo checkouts and setup scripts can be slow. Other commands use the standard 60s TTL.

**Result reporting:** The daemon may execute multiple commands concurrently (workspace commands serialize per-environment, but commands for different environments or provider commands run in parallel). Results are reported as soon as each command completes. Reporting is serialized through a small in-memory retry queue so transient POST failures are retried before newer results, but there is no cursor-ordering constraint on result delivery.

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
**Daemon → Server:** `heartbeat`

### Reconnection

Daemon-driven, server never nudges. WS reconnection uses `partysocket/ws` (`ReconnectingWebSocket`) — the same library used by `apps/app`. On WS reconnect, the daemon re-opens the session (new `sessionId`) to avoid stale session issues.

On WS drop:
1. Buffer events, retry HTTP with `p-retry` (max 5 retries, exponential backoff, 4xx not retried)
2. `partysocket` handles WS reconnect (exponential backoff, 1s–30s)
3. If WS down >5s, fall back to polling commands every ~10s
4. On WS reconnect, re-open session, resume fetching pending commands, stop polling

### Resilience invariants

- **Event ingestion is idempotent** on `(threadId, sequence)`. Server silently accepts already-seen events.
- **Command delivery is tracked in DB state.** Server moves commands through `pending → fetched → success/error`. If a daemon disappears after fetch, the command TTL sweep re-queues abandoned `fetched` commands.
- **Command result delivery with retry.** After executing a command, the daemon POSTs the result to the server with retry via `p-retry` (max 5 retries, exponential backoff, 4xx errors not retried). If the in-memory retry queue still cannot deliver a result and no further completions occur, recovery falls back to the command TTL sweep. Commands are idempotent.
- **Command TTL.** Server tracks commands that were fetched but never got a `command-result`. Standard commands: 60s timeout. `environment.provision`: 5 minute timeout. Abandoned commands re-queue once (retryCount 0 → 1), then error the thread (retryCount 1 → error).
- **Protocol version mismatch** → 400 rejection with supported versions.
- **File locking.** Daemon acquires an exclusive lock on `$BB_DATA_DIR/daemon.lock` at startup. If lock is held, another daemon instance is running — the new instance waits or exits.

### State reconciliation on reconnect

When the daemon reconnects after a network partition or restart, the server and daemon may have diverged. Reconciliation happens during session open:

1. **Daemon reports active provider sessions** as part of session open: `{ activeThreads: [{ threadId }] }`. Empty on fresh restart (all processes died).
2. **Server compares** against its DB state:
   - Thread in `error` (due to lease timeout) but daemon reports it active → server transitions thread back to `active`
   - Thread in `active` but daemon has no session for it → server transitions thread to `idle`
   - **Idle threads without provider sessions** → the daemon handles this lazily: when a command arrives for a thread with no provider session, the daemon calls `ensureRuntime` + `resumeThread` before executing. No server-side action needed.
   - Environment in `provisioning` with no in-flight provision command → handled by command TTL (5 min). No special reconciliation needed.
3. **Server returns** `{ sessionId, heartbeatIntervalMs, leaseTimeoutMs, threadHighWaterMarks }` — the high-water marks allow the daemon to resume event sequence numbering without collisions.

This ensures that after any failure, a single reconnect brings the system back to a consistent state.

### Environment provisioning handshake

1. Client calls `POST /threads` with an `environment` discriminated union:
   - `{ type: "reuse", environmentId }` — attach to an existing environment
   - `{ type: "host", hostId, workspace }` — create a new environment on a persistent host
   - `{ type: "sandbox-host", sandboxType }` — provision an ephemeral sandbox host
   Where `workspace` is one of:
   - `{ type: "unmanaged", path: string | null }` — use existing path (null = project source path)
   - `{ type: "managed-worktree" }` — create a git worktree
   - `{ type: "managed-clone" }` — clone the repo
2. Server creates environment record and thread, queues `environment.provision` command
3. Daemon runs provisioner (validates path for unmanaged, creates worktree/clone for managed)
4. Server updates environment (sets path, status → ready) or errors the thread
5. If thread has pending input, server queues `thread.start`

For `reuse`: skip provisioning, just queue `thread.start`.

**Provisioning failure cleanup:**
- If provisioner fails (e.g., setup script errors), the provisioner's `provision()` method is responsible for rolling back partial state (deleting the worktree it created). The provisioner owns its own cleanup on failure.
- If daemon crashes mid-provisioning, the command TTL expires and the server marks the thread as `error`. The partially-created worktree is cleaned up when the environment record is deleted (triggers `environment.destroy`, which the provisioner handles idempotently).
- `environment.provision` is idempotent — provisioner checks if the target path already exists. If it does and is valid, it reports success. If it exists but is invalid (partial state), it cleans up and re-provisions.
- **Errored environment cleanup:** When a thread errors due to provisioning failure, the environment is also marked as `error`. The managed environment cleanup rule applies: when zero non-archived threads reference a managed environment, the server queues `environment.destroy`. For errored environments with no threads (e.g., user deletes the thread), the server should also clean up. A dedicated sweep handles this — query for managed environments in `error` status with zero referencing threads, queue `environment.destroy`. This prevents leaked worktrees on disk.

### Command flow examples

**Creating a thread with an existing path (unmanaged workspace):**
```
App → POST /threads { environment: { type: "host", hostId, workspace: { type: "unmanaged", path: null } } }
Server → creates environment record (status: provisioning), creates thread
Server → queues environment.provision command with { mode: "unmanaged", path: <resolved from project source> }
Daemon → validates path exists, discovers properties (isGitRepo, etc.)
Daemon → reports command-result with { path, isGitRepo }
Server → updates environment (status: ready), queues thread.start if pending input
```

**Creating a thread with a managed worktree:**
```
App → POST /threads { environment: { type: "host", hostId, workspace: { type: "managed-worktree" } } }
Server → creates environment record (status: provisioning), creates thread (status: provisioning)
Server → queues environment.provision command with { mode: "worktree", sourcePath, targetPath, branchName }
Daemon → calls provisionWorkspace() from @bb/workspace
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
Server → resolves source env path + primary path + project's default branch + env branch name
Server → queues workspace.demote command { environmentId, primaryPath, defaultBranch, envBranch }
Daemon → checks primary clean, checks out default branch, reattaches source to its branch
Daemon → returns { ok: true }
```

Promote and demote are **single daemon commands** — no multi-step chaining, no server-side state machine, no partial failure recovery. The daemon executes the full operation atomically. If any step fails (dirty workspace, git error), the command fails and nothing is modified (checks are upfront).

**Idempotency:**
- Promote when already promoted (primary already on env branch) → no-op success.
- Demote when not promoted (primary already on default branch) → no-op success.
- **Both workspaces must be clean.** Fail loudly if either has uncommitted changes. No stashing.

**Promoted state is derived.** The daemon checks what branch the primary checkout is on. If it matches a known environment branch, that environment is promoted. No application state to track. Demote always restores the project's default branch.

**Cross-host promote:** Works only if the branch is already available on the remote. The daemon fetches the branch and checks it out. No pushing as part of promote — if the branch isn't on the remote, the command fails with a clear error. This means promote/demote is the same command regardless of same-host vs cross-host — the daemon figures out the right approach based on whether the branch is locally visible or needs a fetch.

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
  ├── Workspace class (git status, diff, commit, merge, promote/demote — per-environment instance)
  └── Provisioners (create/destroy managed environments)
```

One `AgentRuntime` instance per environment (since `workspacePath` is per-environment). Multiple threads on the same environment share one runtime. Provider processes are child processes of the daemon, communicating over stdio.

### Restart (dev code reloading)

**Provider processes are children of the daemon — they die on restart.** This is the accepted tradeoff for architectural simplicity.

**State on disk:** `$BB_DATA_DIR/host-id`, `$BB_DATA_DIR/daemon.lock`, logs

**Restart flow:**
1. Daemon spawns a new instance of itself (detached)
2. Old process exits — all provider processes die
3. New daemon reconnects WS to server
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

**Host status transitions:**
```
connected → disconnected (heartbeat timeout — unintentional, e.g., crash, laptop sleep)
connected → suspended (server suspends ephemeral host on idle)
disconnected → connected (daemon reconnects)
suspended → connected (server resumes ephemeral host on command)
```

### Managed environment cleanup

When a thread is archived or deleted, the server checks: does this managed environment have zero non-archived threads referencing it? If so, queue `environment.destroy`. A sweep also runs periodically to catch any managed environments in `error` status with zero referencing threads.

### Ephemeral host cleanup

When zero environments remain on an ephemeral host (all destroyed), the server calls the cloud provider API to destroy the host. The host record is kept in the DB (with `disconnected` status) for audit.

---

## Server Data Layer

The server's data mutation functions live in `@bb/db` and take a `DbNotifier` interface for broadcasting change notifications:

```typescript
// Defined in @bb/db
interface DbNotifier {
  notifyThread(threadId: string, changes: ThreadChangeKind[]): void;
  notifyProject(projectId: string, changes: ProjectChangeKind[]): void;
  notifyEnvironment(environmentId: string, changes: EnvironmentChangeKind[]): void;
  notifyCommand(hostId: string): void;
  notifySystem(changes: SystemChangeKind[]): void;
}
```

The server's `NotificationHub` implements `DbNotifier`. CLI tools and tests pass a no-op implementation (`noopNotifier`). This keeps notifications automatic (callers can't forget to notify) while keeping `@bb/db` independent of any WS framework.

- `notifyThread/Project/Environment/System` — triggers client WS notifications (change hints so clients refetch)
- `notifyCommand` — triggers daemon WS `commands-available` notification. Called by `queueCommand()`.

Change kind literals are defined in `@bb/domain` so both `@bb/db` and `@bb/server-contract` can reference them.

### Thread status transitions

Thread status transitions are enforced by a `transitionThreadStatus` function in `@bb/db` with an explicit allowed-transitions map. Any attempt to make an invalid transition throws. Route handlers call `transitionThreadStatus`, never raw status updates. This prevents inconsistent states across the codebase.

### Sweeps

The server runs periodic sweeps:
- **Command TTL sweep** (~30s): fetched commands past TTL → re-queue once (retryCount 0→1), then error (retryCount 1→error). Different TTLs: 60s standard, 5 min for `environment.provision`.
- **Lease expiry sweep** (~10s): expired sessions → close session, disconnect host, error active threads.
- **Managed environment sweep**: managed environments with zero non-archived threads → queue `environment.destroy`.

---

## Configuration

**Package: `@bb/config`** — uses `envsafe` with scoped exports per consumer.

| Scope | Import | Key vars |
|---|---|---|
| Common | `@bb/config/common` | `BB_DATA_DIR`, `BB_LOG_LEVEL`, `BB_SECRET_TOKEN` |
| Server | `@bb/config/server` | `BB_SERVER_PORT`, `BB_DATABASE_URL`, `BB_PUBLIC_URL`, `E2B_API_KEY` (optional), `E2B_TEMPLATE` (optional), `BB_GITHUB_PAT` (optional) |
| Host-daemon | `@bb/config/host-daemon` | `BB_SERVER_URL`, `BB_HOST_DAEMON_PORT` |
| CLI | `@bb/config/cli` | `BB_SERVER_URL`, `BB_HOST_DAEMON_PORT` |

`BB_DATA_DIR` is used by both server and host-daemon. Server: `bb.db`, `logs/server.log`. Host-daemon: `host-id`, `daemon.lock`, `logs/host-daemon.log`.

Config sources: env vars and `.env` files. `~/.bb/config.json` deferred (easy to add — just merge into `process.env` before envsafe runs). No per-project settings in DB.

---

## Logger

**Package: `@bb/logger`** — wraps `pino` with per-component log files and built-in rotation.

```
$BB_DATA_DIR/logs/
  server.log, host-daemon.log
```

**API:**
```typescript
import { createLogger } from "@bb/logger";
const log = createLogger({ component: "server" });
const threadLog = log.child({ threadId: "thr_abc123" });
threadLog.info("turn started");
```

**Features:** structured JSON to files, `pino-pretty` for dev, size-based rotation via `pino-roll` (10MB/5 files), child loggers with inherited context, error serialization with `.cause` chains.

**Dependencies:** `pino`, `pino-roll`, `pino-pretty` (dev). Minimal surface.

---

## Instance Isolation

All state lives under `BB_DATA_DIR` (default: `~/.bb`). A standalone bb instance requires three ports:

| Port | Default | Used by |
|---|---|---|
| `BB_SERVER_PORT` | 3000 | Server HTTP + WS |
| `BB_HOST_DAEMON_PORT` | 3001 | Host-daemon local API (for app/CLI) |

Concurrent isolated instances use different `BB_DATA_DIR` + ports:

```bash
# Instance 1
BB_DATA_DIR=~/.bb BB_SERVER_PORT=3000 BB_HOST_DAEMON_PORT=3001 bb start

# Instance 2
BB_DATA_DIR=/tmp/bb-test BB_SERVER_PORT=3100 BB_HOST_DAEMON_PORT=3101 bb start
```

Each gets its own DB, logs, host identity. Tests use temp dirs + in-memory SQLite.

**Port binding is strict.** If the configured port is already in use, the server or daemon exits with a clear error. No fallback to a different port — this would silently break the app/CLI connection and cause confusing failures. The port is part of the instance's identity.

---

## Real-time / WebSocket (App/CLI)

Subscribe/unsubscribe per entity, server pushes change-kind arrays. Notification-only — client refetches via HTTP. Server uses `@hono/node-ws` for WebSocket support.

| Entity | Change kinds |
|---|---|
| **Thread** (by ID) | thread-created, thread-deleted, events-appended, status-changed, title-changed, queue-changed, archived-changed, read-state-changed |
| **Environment** (by ID) | status-changed, work-status-changed |
| **Project** (by ID) | sources-changed, threads-changed |
| **System** (global) | host-connected, host-disconnected, environment-created, environment-deleted |

Client and daemon WebSocket connections are handled by separate protocol handlers (different auth, different message schemas, different lifecycle).

---

## Host-Daemon Local API

The daemon exposes a small HTTP API on `BB_HOST_DAEMON_PORT` (bound to `127.0.0.1`) for operations that must run on the local machine. The app and CLI call this directly — not through the server.

```
GET  /host-id        → { hostId: string }
POST /open           → { path: string }                     // open file/dir in editor
POST /pick-folder    → { path: string | null }              // native folder picker dialog
GET  /status         → { connected: boolean, serverUrl: string }
POST /restart        → (dev only) triggers graceful restart
```

**Why not through the server?** These operations are inherently local — opening a file in VS Code, checking daemon connectivity. They must work even if the server is unreachable. They must be instant (no round-trip through a remote server).

**Auth:** None. Bound to `127.0.0.1` only — not accessible from the network.

**Ephemeral hosts don't have a local API.** The app only calls this for persistent hosts on the same machine. For threads running on ephemeral hosts, local operations (open-in-editor, etc.) are disabled with clear UI states.

**Contract:** `@bb/host-daemon-contract/local` — Zod schemas, typed routes, and `createHostDaemonLocalClient()`. Separate from the server-facing internal protocol.

**Port discovery:** The app fetches `GET /system/config` from the server on startup, which returns `{ hostDaemonPort }`. The CLI reads `BB_HOST_DAEMON_PORT` from the environment. Both use `createHostDaemonLocalClient()` to create a typed client.

## System / Operational

**Server-side:** shutdown with blocking thread detection, voice transcription, file attachment upload.

**Host status data flow:**

All hosts: the server tracks host connection status via daemon sessions. The app fetches `GET /hosts` and stays updated via WS `system` channel (`host-connected`, `host-disconnected` → refetch hosts). Host status is derived at query time (active session + non-expired lease = connected).

Local daemon: the app probes `GET /host-id` on the daemon's local API at startup. If reachable, `localHostId` is set and local operations (open-in-editor, pick-folder) are enabled. If unreachable (e.g., mobile browser, daemon not started), local operations are disabled gracefully. This is a one-shot probe — "no daemon" is a normal state, not an error. The local daemon's server connection status is derived from the server's hosts list (matching `localHostId`), not from polling the daemon.

---

## Providers

Three built-in: codex, claude-code, pi. Process-based via `@bb/agent-runtime` (mostly done, left as-is). Extensions system deferred. Capabilities: `supportsRename`, `supportsServiceTier`.

---

## Package Map

| Package | Purpose | Dependencies |
|---|---|---|
| `@bb/domain` | Entity types, event types, change kinds, Zod schemas | zod |
| `@bb/config` | Typed env var config, scoped exports | envsafe |
| `@bb/logger` | Structured logging, rotation, per-component files | pino, pino-roll, @bb/config |
| `@bb/db` | Schema, migrations, connection, IDs, data functions, `DbNotifier` interface | @bb/domain, drizzle, better-sqlite3 |
| `@bb/server-contract` | Public + internal API routes, WS protocol, error types, hc() clients | @bb/domain, zod, hono |
| `@bb/host-daemon-contract` | Commands, events, session protocol, hc() client | @bb/domain, zod, hono |
| `@bb/agent-runtime` | Provider adapters, registry, runtime | @bb/domain, @bb/templates |
| `@bb/templates` | Prompt templates | gray-matter, handlebars |
| `@bb/core-ui` | View transforms (toViewMessages, formatTimeline, detail rows) | @bb/domain, @bb/templates |
| `@bb/workspace` | `provisionWorkspace() → IWorkspace`, Workspace class (git ops), provisioning (worktree, clone), setup scripts, promote/demote | @bb/domain |
| `@bb/sandbox-host` | `provisionHost() → ISandboxHost`, E2B sandbox lifecycle (provision, suspend, resume, destroy), daemon bootstrap | @bb/domain, E2B SDK |
| `@bb/ui-core` | Shared React components | react |
| `@bb/tsconfig` | Shared TS config | — |
| `apps/server` | Server implementation | @bb/domain, @bb/config, @bb/logger, @bb/db, @bb/server-contract, @bb/host-daemon-contract, @bb/sandbox-host |
| `apps/host-daemon` | Host-daemon implementation | @bb/domain, @bb/config, @bb/logger, @bb/host-daemon-contract, @bb/agent-runtime, @bb/workspace |
| `apps/app` | Electron/web app | @bb/domain, @bb/core-ui, @bb/ui-core, @bb/server-contract, @bb/host-daemon-contract |
| `apps/cli` | CLI | @bb/domain, @bb/core-ui, @bb/server-contract, @bb/host-daemon-contract |

### Code ownership

| Code | Location |
|---|---|
| `provisionWorkspace() → IWorkspace`, git ops, provisioning, promote/demote | `@bb/workspace` |
| `provisionHost() → ISandboxHost`, E2B lifecycle, daemon bootstrap | `@bb/sandbox-host` |
| Host registration, identity, heartbeat | `apps/host-daemon` |
| Command routing, AgentRuntime management | `apps/host-daemon` |
| Data functions, thread status transitions, sweeps | `@bb/db` |
| Route handlers, command queuing | `apps/server` |
| Workspace types (WorkspaceStatus, DiffResult, etc.) | `@bb/domain` |

The server imports `@bb/sandbox-host` for ephemeral host lifecycle. The daemon imports `@bb/workspace` for workspace operations. The server never imports `@bb/workspace` — it sends commands to daemons. The daemon never imports `@bb/sandbox-host` — it doesn't know what kind of host it's running on.

---

## Route Renames

Taking this opportunity to clean up route naming for clarity and consistency.

### Routes to remove
- `/system/pick-folder` — moved to host-daemon local API (`POST /pick-folder`)
- `/system/open-path` — moved to host-daemon local API (`POST /open`)
- `/threads/:id/open-path` — client-side now
- `/system/restart-policy` — dropped
- `/system/environments` — replaced by hosts + provisioners
- `/system/provider` (singular) — redundant with `/system/providers`
- `/environments/:id/env-daemon/sessions` — replaced by host-scoped sessions
- `/projects/:id/sources` — sources inlined in project response
- `/projects/:id/work-status` — workspace status moved to `/environments/:id/status`
- `/threads/:id/work-status` — workspace status moved to `/environments/:id/status`
- `/threads/:id/primary-status` — promoted state dropped from API
- `/environments/:id/primary-status` — replaced by `/environments/:id/status`

### Routes to rename

| Current | New | Why |
|---|---|---|
| `/threads/:id/tell` | `/threads/:id/send` | "tell" is jargon, "send" is universal |
| `/threads/:id/queue` | `/threads/:id/drafts` | "queue" sounds like a job system, "drafts" matches the UX |
| `/threads/:id/queue/:queuedMessageId/send` | `/threads/:id/drafts/:draftId/send` | follows from above |
| `/threads/:id/queue/:queuedMessageId` | `/threads/:id/drafts/:draftId` | follows from above |
| `/projects/:id/manager` | `/projects/:id/managers` | plural, POST to collection |
| `/threads/:id/tool-group-messages` | `/threads/:id/timeline/tool-details` | sub-resource of timeline |
| `/threads/:id/git-diff` | `/threads/:id/diff` | shorter, clear enough |
| `/threads/:id/merge-base-branches` | `/threads/:id/diff/branches` | sub-resource of diff |
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

## Stubs and Not-Implemented Boundaries

| Feature | Where it's stubbed | Status |
|---|---|---|
| **GitHub repo source** | `project_sources.type = "github_repo"` | Schema ready, server/UI support in Phase 8 |
| **E2B sandbox host** | `@bb/sandbox-host` | Stub (throws "Not implemented"). Real implementation in Phase 8 — see `plans/phase-8.md` |
| **Ephemeral hosts** | `hosts.type = "ephemeral"` | Server returns 501 for `sandbox-host` thread creation. Real implementation in Phase 8 |
| **Multi-machine** | `project_sources` with different `hostId` | Only one host in v1, data model is ready |
| **Remote host open-path** | `apps/app` | Disabled state with clear message |

---

## Out of scope (v1)

- Multi-machine (data model ready, only local host in v1)
- Docker environments (cut)
- Extensions system
- Per-project DB settings
