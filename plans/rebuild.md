# Rebuild Plan

Implementation plan for the bb server, host-daemon, and supporting infrastructure. See `plans/architecture.md` for the full architecture, data model, protocol specs, and command flow examples.

## Context

The old server, environment-daemon, environment, core, and api-contract packages have been deleted. The contract packages (`@bb/domain`, `@bb/server-contract`, `@bb/host-daemon-contract`) have been consolidated. This plan rebuilds the backend from those contracts.

### What exists today

| Package | State |
|---|---|
| `@bb/config` | **Done** (Phase 1a) — `envsafe` with scoped exports per consumer. |
| `@bb/logger` | **Done** (Phase 1b) — pino + pino-roll, per-component log files, rotation. |
| `@bb/domain` | **Done** (Phase 1c) — entity types, event types, Zod schemas. Renames complete, View* naming, slim types. |
| `@bb/db` | **Done** (Phase 1d) — clean-slate schema, drizzle-kit migration, ID generation. |
| `@bb/core-ui` | **Done** (Phase 1e) — view transforms updated for domain renames. |
| `@bb/host-daemon-contract` | **Done** (Phase 2b) — 17 commands, session protocol, HostDaemon* naming, typed results. |
| `@bb/server-contract` | **Done** (Phase 2a) — public API routes, WS protocol, type renames. |
| `@bb/workspace` | **Done** (Phase 3) — Workspace class, provisioning, promote/demote, tested with real git. |
| `@bb/agent-runtime` | Done — provider adapters (codex, claude-code, pi), registry, runtime. Leave as-is. |
| `@bb/templates` | Done — untouched |
| `@bb/ui-core` | Done — shared React components |
| `@bb/tsconfig` | Done — untouched |
| `apps/app` | Exists — needs import updates + new UI for hosts, sources, environment creation |
| `apps/cli` | Exists — needs import updates |
| `apps/server` | **Does not exist** — needs to be created (Phase 5) |
| `apps/host-daemon` | **Does not exist** — needs to be created (Phase 4) |

### Architecture summary

```
App/CLI  <--HTTP-->  Server (cloud)  <--HTTP-->  Host-daemon (per machine)
         <--WS(notifications)-->     <--WS(notifications)-->
                                                    |
                                              Provider processes (via agent-runtime, one per thread)
```

- Server is stateless (DB is the state). Can hot-reload.
- Host-daemon is long-lived, one per machine. Manages everything: environments, provider processes, git operations.
- Provider processes are children of the daemon (one per active thread). They die on daemon restart — threads resume via `thread.resume`.
- WS is notification-only everywhere. All data flows over HTTP.
- WS notifications are automatic — fired by the data mutation layer, not route handlers.

### Sequencing philosophy

Build and test packages with complex behavior **before** wiring them into the server/daemon. Same approach as `@bb/agent-runtime`: iterate on design, build the package, test it heavily in isolation with real scenarios, then integrate.

The risk in this system is in `@bb/workspace` (real git operations, edge cases) and `apps/host-daemon` (session management, reconnection, command routing) — not in the server (mostly CRUD routing).

---

## Implementation Principles

These apply to all code written during the rebuild. The previous codebase suffered from tangled god-objects, over-configured DI, leaky package boundaries, and constant rewrites when data model assumptions changed. These principles exist to prevent that.

### Module design

- **One clear responsibility per module.** If you can't describe what a file does in one sentence, it's doing too much — split it. File length is a signal, not a rule: a long file should trigger a pause to reconsider structure.
- **Prefer plain functions over classes.** Use classes only when you genuinely need instance state (a running server, a WS connection manager, a `Workspace` representing a directory). Route handlers, business logic, data transformations, validators — all functions.
- **No god objects.** No single class/module that takes 10 dependencies and has 20 methods. Instead: focused modules composed at the entry point.

### Dependencies

- **No DI framework or container.** Dependencies are plain function parameters. If a module needs the DB, it takes `db: DbConnection`. If it needs a logger, it takes `logger: Logger`.
- **Wire once at the entry point.** `index.ts` creates dependencies, passes them to modules, starts the server. The dependency graph is visible by reading that one file.
- **Declare what you use.** Package dependencies in `package.json` must be explicit.

### Package boundaries

- **Export only through `src/index.ts`.** Internal modules are implementation details.
- **Boundary test:** if you can rename/delete an internal file and only the package's own code breaks, the boundary is clean.
- **Contracts are contracts.** `@bb/domain`, `@bb/server-contract`, `@bb/host-daemon-contract` define the interfaces. Implementation packages implement them. Contract packages never import from implementation packages.

### Data model stability

- **The architecture doc is settled.** Don't revisit relationships during a build step.
- **Code for the general case.** Even if v1 has one source per project, write queries that handle many.

### Testing

- **Test the public interface, not internals.**
- **Quality over quantity.** One real-scenario integration test > five mock-heavy unit tests.
- **Real DB in tests.** `createConnection(":memory:")` + `migrate(db)`, not mock repositories.
- **Assert outcomes, not call sequences.**
- **Three test layers.** (1) Unit tests that assert behavior (not implementation — no `expect(fn).toHaveBeenCalledWith()`). (2) Integration tests that run the real thing — if `@bb/agent-runtime` can do it, so can the server and daemon. (3) End-to-end tests against standalone isolated instances (unique `BB_DATA_DIR` + `BB_SERVER_PORT`), verified via DB queries, CLI commands, and HTTP assertions.
- **Standalone instance isolation.** A core design property is the ability to stand up an isolated bb instance in a temp dir with its own DB, logs, and host identity. E2E tests and QA passes use this: start server + daemon, exercise via API, verify via DB queries and CLI. See `plans/architecture.md` "Instance Isolation" section.
- **Tests are deliverables, not afterthoughts.** Every sub-phase lists specific tests to write. A sub-phase is not complete until its tests exist and pass. Do not move to the next sub-phase without tests for the current one.
- **Commit per sub-phase.** Each sub-phase (e.g., 4a, 4b, 5c) gets its own commit with both implementation and tests. This prevents monolithic commits that hide broken state. Before committing, verify: typecheck and tests pass. Do not combine multiple sub-phases into one commit.

### Scope discipline

- **No backward-compat aliases.** When renaming a type, route, or function, use only the new name. Don't export the old name as an alias "for convenience" — it creates two names for one thing and defers cleanup that never happens.
- **No speculative API surface.** Don't declare schemas, routes, or types until the feature that uses them is being built. A contract package should contain exactly what's needed by the code that exists today.
- **Domain types are persisted records.** Types in `@bb/domain` represent the shape of data as stored in the DB or transmitted over the wire. Runtime-only view state (work status, provisioning readiness, attached environment details, built-in actions, default execution options) belongs in the consuming layer (server views, UI projections), not in the domain type.
- **Ignore downstream consumers during package rebuilds.** Changes to `packages/*` will break `apps/server`, `apps/cli`, `apps/app`. That is expected — those consumers are rebuilt in later phases. Don't add shims, re-exports, or weakened types to keep them compiling. The passing bar for a package phase is: every package under `packages/` typechecks and its own tests pass.
- **Simplest correct implementation.** Prefer module-level singletons over factory functions with injectable parameters unless testing genuinely requires it. Prefer standard library/framework patterns (e.g., `pino-roll` for log rotation) over custom implementations. Don't add configurability, error classes, or abstraction layers until a second use case demands them.
- **No sync blocking in server or daemon.** All I/O must be async (`execFile` not `execFileSync`, `fs.promises` not `fs.*Sync`, `spawn` not `spawnSync`). The event loop must never block — heartbeats, event flushes, WS notifications, and command processing all share the same process. A single `execFileSync` call blocks everything. This was a source of bugs in the previous codebase.

---

## Stubs and Not-Implemented Boundaries

| Feature | Where it's stubbed | What the stub does |
|---|---|---|
| **GitHub repo source** | `project_sources.type = "github_repo"` | Server rejects with 400 "not implemented" |
| **E2B provisioner** | `@bb/workspace` or server | `isAvailable()` returns false unless `BB_E2B_API_KEY` is set |
| **Ephemeral hosts** | `hosts.type = "ephemeral"` | Server rejects creating ephemeral hosts |
| **Multi-machine** | `project_sources` with different `hostId` | Only one host in v1, data model is ready |
| **Remote host open-path** | `apps/app` | Disabled state with clear message |

---

## Phase 1: Foundation

Two parallel tracks: (1a → 1b) and (1c → 1d + 1e).

### 1a. Create `@bb/config`

Typed env var configuration with `envsafe`. Scoped exports per consumer.

```
packages/config/src/
  common.ts           -- BB_DATA_DIR, BB_LOG_LEVEL, BB_SECRET_TOKEN, dev defaults
  server.ts           -- BB_SERVER_PORT, BB_DATABASE_URL, BB_E2B_API_KEY (optional)
  host-daemon.ts      -- BB_SERVER_URL
  cli.ts              -- BB_SERVER_URL
```

**Exports:** `@bb/config/common`, `@bb/config/server`, `@bb/config/host-daemon`, `@bb/config/cli`

**Validation:**
- [ ] Package typechecks
- [ ] Required vars validated on import, fail fast in production
- [ ] `BB_DATA_DIR` defaults to `~/.bb`, all paths derive from it

### 1b. Create `@bb/logger` (after 1a)

Wraps `pino` with per-component log files and built-in rotation.

**API:**
```typescript
const log = createLogger({ component: "server" });
const threadLog = log.child({ threadId: "thr_abc123" });
threadLog.info("turn started");
```

**Features:** structured JSON to files, child loggers, size-based rotation (10MB/5 files), `pino-pretty` for dev, error serialization with `.cause` chains.

**Validation:**
- [ ] Writes structured JSON to `$BB_DATA_DIR/logs/<component>.log`
- [ ] Child logger inherits parent context
- [ ] Log rotation works
- [ ] `pino-pretty` works for dev

### 1c. Update `@bb/domain`

Full list of changes in `plans/architecture.md` sections "Data Model", "Type Renames", "Route Renames".

**Key changes:**
- Remove dead types (environment descriptor/properties/capabilities, old provisioning event types)
- Add new types: `ProjectSource`, `Host`, `EnvironmentStatus`
- Update: `Project` (slim down), `Environment` (hostId/path/provisionerId model), `ThreadStatus` (5 states), `ThreadExecutionOptions` (drop dead fields)
- Type renames: `ThreadDetailRow` → `TimelineRow`, `ThreadWorkStatus` → `WorkspaceStatus`, all `UI*` → `View*`, etc.
- Consolidate provisioning events: 6 types → 1 `system/provisioning` with delta-based entries
- Remove workspace events from thread events (`system/worktree/*` → these are environment actions, not thread events)

**Validation:**
- [ ] Package typechecks
- [ ] Downstream breakage expected (server-contract, host-daemon-contract, core-ui, db)

### 1d. Rewrite `@bb/db` (after 1c)

**Clean slate.** Drop all existing migrations, fresh schema.

```
hosts, projects, project_sources, environments (with isGitRepo, branchName, provisionerState),
threads, events, queued_thread_messages,
host_daemon_sessions, host_daemon_commands (with retryCount integer default 0), host_daemon_cursors
```

**Validation:**
- [ ] `createConnection(":memory:")` + `migrate(db)` succeeds
- [ ] All FK constraints valid
- [ ] ID generation functions work

### 1e. Update `@bb/core-ui` (after 1c)

Update imports for domain renames. Update provisioning helpers for new event model.

**Validation:**
- [ ] Package typechecks
- [ ] Existing tests pass

---

## Phase 2: Contracts

**2b must complete before 2a** (server-contract imports from host-daemon-contract).

### 2b. Rewrite `@bb/host-daemon-contract` (first)

Rename from `env-daemon-contract`. Simplified session protocol. 17 commands including workspace operations (`workspace.status`, `workspace.diff`, `workspace.commit`, `workspace.squash_merge`, `workspace.reset`, `workspace.checkpoint`, `workspace.promote`, `workspace.demote`).

See `plans/architecture.md` "Host-Daemon Protocol" for full spec.

**Validation:**
- [ ] All schemas parse valid/invalid data correctly
- [ ] Hono typed client works

### 2a. Update `@bb/server-contract` (after 2b)

Route renames, type renames, new routes, WebSocket protocol changes. See `plans/architecture.md` "Route Renames" and "Type Renames".

**Validation:**
- [ ] `createPublicApiClient()` and `createHostDaemonClient()` typed correctly
- [ ] All Zod schemas validate

---

## Phase 3: `@bb/workspace`

**Build and test in isolation before integrating.** Same approach as `@bb/agent-runtime`.

See `plans/architecture.md` for the full design.

### 3a. Workspace class — core git operations

```
packages/workspace/src/
  workspace.ts        -- Workspace class (constructed with path)
  index.ts            -- barrel export
```

The `Workspace` class represents a directory on the local machine:

```typescript
class Workspace {
  readonly path: string;
  constructor(path: string);

  // Queries
  get exists(): Promise<boolean>;
  get isGitRepo(): Promise<boolean>;
  get currentBranch(): Promise<string | undefined>;
  getStatus(): Promise<WorkspaceStatus>;
  getDiff(options: DiffOptions): Promise<DiffResult>;
  getBranches(): Promise<string[]>;

  // Mutations
  commit(options: CommitOptions): Promise<CommitResult>;
  reset(): Promise<void>;
  fetch(options?: FetchOptions): Promise<void>;
  checkpoint(options: CheckpointOptions): Promise<CheckpointResult>;

  // Branch operations (primitives for promote/demote)
  checkoutBranch(branchName: string): Promise<void>;
  detachHead(): Promise<void>;
  stash(message?: string): Promise<string | null>;
  stashPop(ref?: string): Promise<void>;

  // Squash merge (uses temp worktree internally)
  squashMergeInto(options: SquashMergeOptions): Promise<SquashMergeResult>;
}
```

**Testing:** Integration tests with real git repos (temp directories). Test every operation against actual git state:
- [ ] `getStatus()` on clean repo, dirty repo, untracked files
- [ ] `getDiff()` with various merge-base branches
- [ ] `commit()` stages and commits, returns sha
- [ ] `reset()` discards all changes
- [ ] `squashMergeInto()` uses temp worktree, handles missing target branch (fetch first)
- [ ] `checkoutBranch()` / `detachHead()` — the promote primitives
- [ ] `checkpoint()` commits and pushes (test with a local bare remote)
- [ ] Non-git directory: `isGitRepo` returns false, git operations throw clear errors

### 3b. Provisioning functions

```
packages/workspace/src/
  provisioning.ts     -- createWorktree, createClone, runSetupScript, removeWorktree, removeDirectory
```

Standalone functions (not on the Workspace class — these create/destroy workspaces):

```typescript
createWorktree({ sourcePath, targetPath, branchName, onProgress? })
createClone({ sourcePath, targetPath, branchName, onProgress? })
runSetupScript({ workspacePath, scriptName?, timeoutMs?, onProgress? })
removeWorktree({ path, force? })
removeDirectory({ path })
```

`onProgress` callback reports `ProvisioningTranscriptEntry` deltas for streaming provisioning status to the thread timeline.

**Testing:** Integration tests with real git repos:
- [ ] `createWorktree()` creates worktree at target path with correct branch
- [ ] `createWorktree()` idempotent — returns success if path already exists and is valid
- [ ] `createWorktree()` failure rollback — if setup script fails, worktree is cleaned up
- [ ] `createClone()` clones and creates branch
- [ ] `runSetupScript()` runs script, streams output via `onProgress`, respects timeout
- [ ] `runSetupScript()` no-op if script doesn't exist
- [ ] `removeWorktree()` removes worktree, force mode for uncommitted changes
- [ ] Path conventions: `$BB_DATA_DIR/worktrees/<projectId>/<envId>/`

### 3c. Promote/demote

Single atomic operations in `@bb/workspace`. The daemon calls these directly — no server-side orchestration.

```typescript
// Promote: switch primary checkout to the environment's branch
async function promoteWorkspace(source: Workspace, primary: Workspace, options?: { remote?: string }): Promise<void>

// Demote: switch primary back to default branch, reattach source
async function demoteWorkspace(source: Workspace, primary: Workspace, defaultBranch: string, envBranch: string): Promise<void>
```

Both check workspaces are clean upfront — fail loudly if dirty, no stashing. Same-host: detach source HEAD, checkout branch on primary. Cross-host: fetch from remote first (branch must already be on remote from a prior checkpoint).

**Testing:**
- [ ] Promote switches primary to env branch, source detached
- [ ] Promote fails if source is dirty
- [ ] Promote fails if primary is dirty
- [ ] Demote restores primary to default branch, reattaches source
- [ ] Demote fails if primary is dirty
- [ ] Promoted state derived: primary's current branch matches an env branch


---

## Phase 4: `apps/host-daemon`

The daemon is the most complex component — session management, reconnection, command routing, AgentRuntime lifecycle. Build modules with injectable dependencies (HTTP client, WS factory) so each can be unit tested in isolation.

**Each sub-phase is a separate commit with both implementation and tests. Do not proceed to the next sub-phase until the current one's tests pass.**

### 4a. Daemon skeleton + identity

**Implementation:**
- `index.ts` — entrypoint: validate config → acquire lock → create logger → read identity → start daemon
- `daemon.ts` — main lifecycle (session, command loop, shutdown)
- `identity.ts` — `$BB_DATA_DIR/host-id` (read or create UUID), OS hostname via `scutil`/`hostname`

Startup sequence: (1) validate config (fail fast if env vars missing), (2) acquire file lock on `$BB_DATA_DIR/daemon.lock` using `proper-lockfile` with stale detection (10s) — exit immediately with code 1 if held, (3) create logger, (4) read or create `$BB_DATA_DIR/host-id` (persisted UUID), (5) generate ephemeral `instanceId` via `crypto.randomUUID()`, (6) start daemon (session open → WS → command loop).

Shutdown: On SIGTERM/SIGINT: flush event buffer (single attempt, 5s timeout), shutdown all AgentRuntime instances, release file lock, exit 0.

**Tests to write (commit with implementation):**
- [ ] `identity.test.ts`: host-id created on first run, same ID returned on subsequent runs (temp `BB_DATA_DIR`)
- [ ] `identity.test.ts`: OS hostname detection returns a non-empty string
- [ ] `daemon.test.ts`: file lock prevents second instance (attempt lock twice, second fails)
- [ ] `daemon.test.ts`: clean shutdown releases lock (acquire, shutdown, acquire again succeeds)

### 4b. Command cursor + event buffer

Standalone modules with no server dependency — test in isolation.

**Implementation:**
- `command-cursor.ts` — persist/read `$BB_DATA_DIR/command-cursor` (atomic write-to-temp-then-rename). File contains a single integer as UTF-8 text. Read returns 0 if file missing.
- `event-buffer.ts` — in-memory buffer, flush via provided `postEvents` callback, track acks. Flush triggered by: (a) 100ms debounce after last event, or (b) buffer reaching 50 events. On success, discard events at/below per-thread high-water marks. On failure, retain and retry. Max 1000 events; oldest dropped if exceeded.

**Tests to write (commit with implementation):**
- [ ] `command-cursor.test.ts`: write cursor, read it back (temp dir)
- [ ] `command-cursor.test.ts`: read returns 0 when file doesn't exist
- [ ] `command-cursor.test.ts`: atomic write (write to tmp then rename)
- [ ] `event-buffer.test.ts`: push events, inject fake poster, verify flush called with correct batch
- [ ] `event-buffer.test.ts`: ack discards events at/below high-water marks, retains others
- [ ] `event-buffer.test.ts`: flush retries on poster failure, events retained
- [ ] `event-buffer.test.ts`: buffer overflow drops oldest events at max (1000)
- [ ] `event-buffer.test.ts`: assigns monotonic per-thread sequence numbers
- [ ] `event-buffer.test.ts`: sequence initialization from high-water marks (starts at hwm + 1)

### 4c. Session management

**Implementation:**
- `session.ts` — `ServerConnection` class: HTTP client + WS + reconnection

Session open: `POST /internal/session/open` with `{ hostId, instanceId, hostName, hostType, protocolVersion, activeThreads }`. Returns `{ sessionId, heartbeatIntervalMs, leaseTimeoutMs, threadHighWaterMarks }`. The `activeThreads` comes from an optional `getActiveThreads` callback or `[]` on fresh startup.

WS: `${BB_SERVER_URL.replace('http', 'ws')}/internal/ws?sessionId={sessionId}&token={BB_SECRET_TOKEN}`. `commands-available` → trigger fetch callback. `session-close` → shut down.

Heartbeat: `setInterval` at `heartbeatIntervalMs`. Sends `{ type: "heartbeat", bufferDepth, lastCommandCursor }`.

Reconnection: exponential backoff (base 1s, 2x, max 30s, jitter ±25%). If WS down >5s, poll commands every ~10s. On WS reconnect, stop polling.

Command result delivery: POST with retry (exponential backoff). Cursor advanced only after successful POST.

**Tests to write (commit with implementation):** Use a minimal in-process Hono server as a test fixture on a random port. Test against real HTTP.
- [ ] `session.test.ts`: opens session, receives sessionId and config
- [ ] `session.test.ts`: WS connects, server receives heartbeats
- [ ] `session.test.ts`: `commands-available` WS message triggers fetch callback
- [ ] `session.test.ts`: `session-close` WS message triggers shutdown callback
- [ ] `session.test.ts`: WS disconnect triggers reconnection (verify re-open after delay)
- [ ] `session.test.ts`: command result POST retries on failure, succeeds when server comes back
- [ ] `session.test.ts`: session open includes activeThreads from callback

### 4d. Command routing + AgentRuntime

**Implementation:**
- `command-router.ts` — fetch commands, dispatch by type
- `runtime-manager.ts` — `Map<environmentId, { runtime, workspace, path }>`, lazy creation

Runtime manager creates entries lazily on first command for an environment (from `workspacePath` in thread.start/resume/turn.run). Unknown environmentId with no `workspacePath` → error result.

Command processing:
- **Workspace/environment commands** (`workspace.*`, `environment.*`): per-environment async queue (serialized, never sync-blocking)
- **Provider commands** (`thread.*`, `turn.*`, `provider.*`): dispatched directly to `AgentRuntime` (concurrent per-thread)
- `provider.list_models`: calls `listAvailableProviders()` from `@bb/agent-runtime` directly
- `turn.run` calls `ensureRuntime` — lazily creates runtime and resumes thread if needed (handles idle thread recovery after restart)

Event sequence numbering: per-thread counters initialized from `threadHighWaterMarks` (session open response). New events start at `hwm + 1`.

No sync blocking anywhere.

After each command: POST result to server (with retry) → on success, advance cursor.

**Tests to write (commit with implementation):** Use `AgentRuntimeOptions.adapterFactory` for fake provider. Use temp directories.
- [ ] `runtime-manager.test.ts`: first command for an environment creates the runtime
- [ ] `runtime-manager.test.ts`: subsequent commands reuse the runtime
- [ ] `runtime-manager.test.ts`: `environment.destroy` removes the runtime entry
- [ ] `runtime-manager.test.ts`: unknown environmentId without workspacePath returns error
- [ ] `command-router.test.ts`: dispatches `thread.start` to runtime.startThread
- [ ] `command-router.test.ts`: dispatches `workspace.commit` to workspace.commit
- [ ] `command-router.test.ts`: dispatches `provider.list_models` without a runtime
- [ ] `command-router.test.ts`: workspace commands serialize per-environment
- [ ] `command-router.test.ts`: provider commands for different threads on same env run concurrently
- [ ] `command-router.test.ts`: `turn.run` for thread with no session lazily creates runtime + resumes

### 4e. Daemon restart

**Implementation:**
- `restart.ts` — spawn `process.argv[0]` with `process.argv.slice(1)` via `child_process.spawn({ detached: true, stdio: 'ignore' })`. Release lock. Exit.

For v1, restart triggered only by SIGUSR2. SIGTERM/SIGINT → clean shutdown.

**Tests to write (commit with implementation):**
- [ ] `restart.test.ts`: spawns new process, old process exits cleanly
- [ ] `restart.test.ts`: new process acquires lock after old releases it

### 4f. Daemon integration tests

Run the full daemon against a real server. Verify end-to-end flow. Use fake provider adapter.

**Tests to write (commit separately — tests only, no new implementation):**
- [ ] Session open → server returns sessionId → daemon starts WS + heartbeat
- [ ] Server queues command → daemon fetches → executes → reports result → cursor advanced
- [ ] Provider emits events → daemon buffers → posts to server → server stores → ack prunes buffer
- [ ] WS disconnect → daemon reconnects → session re-opened → commands resume from cursor
- [ ] Multiple environments → commands dispatch to correct runtimes concurrently

---

## Phase 5: `apps/server`

Framework: **Hono** on `@hono/node-server` — the contracts already define Hono-typed route schemas.

**Each sub-phase is a separate commit with both implementation and tests. Do not proceed to the next sub-phase until the current one's tests pass.**

### 5a. Server skeleton + middleware

**Implementation:**
- `index.ts` — read config, init DB, create hub, create logger, create app, run sweeps immediately, start sweep intervals, call `serve()`
- `server.ts` — `createApp(deps): Hono` — mount routes, middleware, WS upgrade handlers
- `db.ts` — `initDb()`: `createConnection(BB_DATABASE_URL)` + `migrate(db)`
- `errors.ts` — `ApiError` class extending `HTTPException`

Mount: `/api/v1/*` public, `/internal/*` daemon, `/ws` client WS, `/internal/ws` daemon WS.
Middleware: CORS, Bearer token auth on `/internal/*`, session validation, global error handler.
Auth: public routes unauthenticated in v1. Internal routes require Bearer token.

**Tests to write (commit with implementation):**
- [ ] `server.test.ts`: app responds to requests (use `app.request()`)
- [ ] `server.test.ts`: public routes accessible without auth
- [ ] `server.test.ts`: internal routes reject without valid Bearer token (401)
- [ ] `server.test.ts`: invalid JSON body returns `{ code: "invalid_request" }` error
- [ ] `db.test.ts`: `initDb()` with in-memory SQLite succeeds, migration runs

### 5b. WebSocket notification hub

**Implementation:**
- `ws/hub.ts` — `NotificationHub`: client subscriptions (`Map<WS, Set<key>>`), daemon connections (`Map<sessionId, WS>`), notify methods
- `ws/client-protocol.ts` — `/ws` handler: subscribe/unsubscribe, cleanup on disconnect
- `ws/daemon-protocol.ts` — `/internal/ws` handler: validate token+sessionId, heartbeat updates, `commands-available` dispatch

Use `@hono/node-ws`. Mutation integration: data layer calls `hub.notify*()` after DB writes.

**Tests to write (commit with implementation):**
- [ ] `hub.test.ts`: subscribe client, notify, verify message received (mock WS)
- [ ] `hub.test.ts`: unsubscribe stops notifications
- [ ] `hub.test.ts`: client disconnect cleans up subscriptions (no leak)
- [ ] `hub.test.ts`: `notifyDaemon` sends to correct sessionId's WS
- [ ] `hub.test.ts`: `notifyDaemon` for unknown sessionId is a no-op
- [ ] `hub.test.ts`: multiple clients subscribed to same thread all receive notification

### 5c. Data layer

**Implementation:** Plain exported functions. Each takes `db: DbConnection` + optionally `hub: NotificationHub`.

```
apps/server/src/data/
  projects.ts, threads.ts, environments.ts, hosts.ts,
  events.ts, commands.ts, sessions.ts, sweeps.ts
```

Thread status transitions enforced in `transitionThreadStatus` (see architecture doc for transition table).
Command cursor: `max(cursor)` for host + 1, in transaction. Host-scoped.
Managed env cleanup: on archive/delete, check zero non-archived threads → queue `environment.destroy`.
Command TTL sweep (30s): `fetched` past TTL → re-queue once, then error.
Lease expiry sweep (10s): expired → close session, disconnect host, error threads.

**Tests to write (commit with implementation):** In-memory SQLite. Assert DB state.
- [ ] `data/projects.test.ts`: CRUD for projects and project_sources
- [ ] `data/threads.test.ts`: create, get, update, delete
- [ ] `data/threads.test.ts`: `transitionThreadStatus` allows valid, rejects invalid transitions
- [ ] `data/threads.test.ts`: archive → managed env cleanup check
- [ ] `data/environments.test.ts`: CRUD, `checkManagedCleanup` queues destroy when zero threads
- [ ] `data/hosts.test.ts`: upsert creates host, second upsert updates lastSeenAt
- [ ] `data/events.test.ts`: insert events, dedup via ON CONFLICT DO NOTHING
- [ ] `data/events.test.ts`: returns correct high-water marks per thread
- [ ] `data/events.test.ts`: duplicate sequence silently ignored, hwm still correct
- [ ] `data/commands.test.ts`: queue assigns monotonic cursor per host
- [ ] `data/commands.test.ts`: fetch returns pending, marks as fetched
- [ ] `data/commands.test.ts`: report result updates state and completedAt
- [ ] `data/sessions.test.ts`: open creates record, close sets status
- [ ] `data/sessions.test.ts`: open for existing host closes old session
- [ ] `data/sweeps.test.ts`: expired command retryCount 0 → re-queued
- [ ] `data/sweeps.test.ts`: expired command retryCount 1 → errored, thread errored
- [ ] `data/sweeps.test.ts`: expired lease → session closed, host disconnected, threads errored

### 5d. Public API routes

**Implementation:**
```
apps/server/src/routes/
  projects.ts, threads.ts, environments.ts, hosts.ts, system.ts
```

Key orchestration: `POST /threads` (create env + thread + queue commands), `POST /environments/:id/actions` (queue single atomic command), `POST /threads/:id/send` (transition status + queue turn). Include `workspacePath: environment.path` on thread.start.

**Tests to write (commit with implementation):** Use Hono's `app.request()` with in-memory DB + real hub.
- [ ] `routes/projects.test.ts`: CRUD via HTTP
- [ ] `routes/threads.test.ts`: `POST /threads` with existing path → env(ready), thread created
- [ ] `routes/threads.test.ts`: `POST /threads` with provisionerId → env(provisioning), provision command queued
- [ ] `routes/threads.test.ts`: `POST /threads/:id/send` idle → active, turn.run queued
- [ ] `routes/threads.test.ts`: `POST /threads/:id/send` active + steer → turn.steer queued
- [ ] `routes/environments.test.ts`: `POST /environments/:id/actions` commit → command queued
- [ ] `routes/environments.test.ts`: `POST /environments/:id/actions` promote → promote command queued
- [ ] `routes/hosts.test.ts`: GET/list hosts

### 5e. Internal API routes

**Implementation:**
```
apps/server/src/internal/
  session.ts, commands.ts, events.ts, tool-calls.ts, reconciliation.ts
```

Session open: upsert host → close old session → create new → reconciliation → return sessionId + config + threadHighWaterMarks.
Command fetch: query pending for host after cursor. Long-poll with `waitMs`. Mark fetched.
Command result: accept from any authenticated request (match by commandId). Update state + side effects.
Event ingestion: insert with dedup. Update thread status from event types. Return high-water marks.
Tool calls: dispatch by tool name. Reconciliation: called from session open.

**Tests to write (commit with implementation):** Use Hono's `app.request()`.
- [ ] `internal/session.test.ts`: session open creates host + session, returns sessionId
- [ ] `internal/session.test.ts`: session open for existing host closes old session
- [ ] `internal/session.test.ts`: returns threadHighWaterMarks
- [ ] `internal/commands.test.ts`: fetch returns pending, marks fetched
- [ ] `internal/commands.test.ts`: long-poll returns empty on timeout
- [ ] `internal/commands.test.ts`: command result → provision success updates env to ready
- [ ] `internal/events.test.ts`: event ingestion deduplicates, returns high-water marks
- [ ] `internal/events.test.ts`: turn/completed event transitions thread to idle
- [ ] `internal/tool-calls.test.ts`: spawn_thread creates child thread
- [ ] `internal/reconciliation.test.ts`: error thread + daemon reports active → transitions to active
- [ ] `internal/reconciliation.test.ts`: active thread + no daemon session → transitions to idle

### 5f. Server integration tests

Run the full server with real HTTP/WS. No mocking.

**Tests to write (commit separately — tests only, no new implementation):**
- [ ] Start server → session open → command queued → fetch → result reported
- [ ] Event ingestion → WS client subscribed to thread receives `events-appended`
- [ ] Full thread lifecycle: create → send → command → result → events → idle
- [ ] Session replacement: open twice with same hostId → old closed, WS gets `session-close`

---

## Phase 6: Consumers

### 6a. Update `apps/app`

Import updates, route updates, new UI (host status, source management, environment creation), stubs for unimplemented features.

### 6b. Update `apps/cli`

Import and route updates.

---

## Phase 7: Integration & QA

**All tests automated.**

### 7a. End-to-end smoke test

Start server + daemon → create project → create thread with managed worktree → send message → see events → commit → archive → verify logs.

### 7b. Restart resilience

Kill server → daemon reconnects. Kill daemon → threads interrupted → resume.

### 7c. Multi-instance isolation

Two instances with different `BB_DATA_DIR` + `BB_SERVER_PORT`, concurrent smoke tests, no interference.

---

## Dependency Graph

```
Phase 1 (foundation):
  Track A: 1a (config) → 1b (logger)
  Track B: 1c (domain) → 1d (db) + 1e (core-ui)
  Parallel tracks.

Phase 2 (contracts, after Phase 1):
  2b (host-daemon-contract) → 2a (server-contract)

Phase 3 (@bb/workspace, after Phase 2):
  3a (Workspace class) → 3b (provisioning) → 3c (promote/demote)
  Tested in isolation with real git repos.

Phase 4 (host-daemon, partially parallel with Phase 3):
  4a, 4b can start after Phase 2.
  4c needs Phase 3 (workspace) + Phase 5e (server internal API).
  4d after 4c.

Phase 5 (server, after Phase 2):
  5a → 5b → 5c → 5d + 5e (parallel)
  Can start in parallel with Phase 3.

Phase 6 (consumers, after Phase 4 + 5):
  6a, 6b parallel.

Phase 7 (integration, after Phase 6):
  7a, 7b, 7c.
```

**Critical path:** Phase 1 → Phase 2 → (Phase 3 + Phase 5 in parallel) → Phase 4c (needs both) → Phase 6 → Phase 7.

---

## Out of Scope

- E2B sandbox provisioner (stubbed — data model and interface ready)
- GitHub repo project sources (stubbed — schema and API ready)
- Multi-machine support (data model ready, only local host in v1)
- Extensions system
- Docker environments (cut)
- Async context / trace ID propagation in logger (deferred)
- HTTP request logging middleware (deferred)
