# Rebuild Plan

Implementation plan for the bb server, host-daemon, and supporting infrastructure. See `plans/architecture.md` for the full architecture and `plans/host-package.md` for the `@bb/workspace` and `@bb/sandbox-host` package designs.

## Start Here

**Phases 1 and 2 are complete.** All foundation packages are built, contracts are validated, consumers (app + CLI) have zero type errors.

**Next phase: Phase 3** — wrap `@bb/workspace` behind `provisionWorkspace() → IWorkspace`. See `plans/host-package.md` for the interface design.

**Can also begin in parallel: Phases 4a–4c** — daemon skeleton, command cursor, session management. These don't need `IWorkspace`.

## Current State

Foundation packages are built and validated. Phases 1 and 2 are complete. Consumers (app + CLI) are cut over to new contracts with zero type errors. This plan covers what remains.

### What exists today

| Package | State |
|---|---|
| `@bb/config` | **Done** — `envsafe` with scoped exports per consumer. |
| `@bb/logger` | **Done** — pino + pino-roll, per-component log files, rotation. |
| `@bb/domain` | **Done** — entity types, event types, Zod schemas, change kinds (thread/project/environment/system). |
| `@bb/db` | **Done** — schema, migrations, data functions (one per entity), `DbNotifier` with `notifyThread`/`notifyProject`/`notifyEnvironment`/`notifyCommand`/`notifySystem`. 59 tests passing. |
| `@bb/core-ui` | **Done** — view transforms, `formatEnvironmentDisplay(env, isLocalHost)`, timeline formatting. |
| `@bb/host-daemon-contract` | **Done** — 17 commands, session protocol, local API contract (`/host-id`, `/open`, `/pick-folder`, `/status`, `/restart`). |
| `@bb/server-contract` | **Done** — public API routes, discriminated `EnvironmentArgs` union for thread creation, WS protocol. |
| `@bb/workspace` | **Done** — Workspace class, provisioning, promote/demote, tested with real git. New `IWorkspace` interface in Phase 3. |
| `@bb/agent-runtime` | Done — provider adapters (codex, claude-code, pi), registry, runtime. Leave as-is. |
| `@bb/templates` | Done — untouched |
| `@bb/ui-core` | Done — shared React components |
| `@bb/tsconfig` | Done — untouched |
| `apps/app` | **Done** — cut over to new contracts, zero type errors, 116 tests passing. Environment selector with Direct/Worktree options. `useHostDaemon` hook for daemon operations. |
| `apps/cli` | **Done** — cut over to new contracts, zero type errors, 67 tests passing. Fetches hostId from daemon, supports env reuse without daemon. |
| `apps/server` | **Not yet a package** — directory placeholder only. Needs full package setup (package.json, tsconfig, src/index.ts). Built in Phase 6. |
| `apps/host-daemon` | **Not yet a package** — directory placeholder only. Needs full package setup. Built in Phase 4. |
| `@bb/sandbox-host` | **Does not exist** — E2B host lifecycle, daemon bootstrap. See `plans/host-package.md`. |

### Key schema notes

The environment schema has these fields (relevant for Phase 3+):
- `isWorktree` — boolean, whether this is a git worktree environment
- `workspaceProvisionType` — enum (`unmanaged`, `managed-worktree`, `managed-clone`), nullable
- `managed` — boolean, whether the system manages the environment lifecycle

The `DbNotifier` interface has 5 methods:
- `notifyThread(threadId, changes)` — thread-scoped WS notifications
- `notifyProject(projectId, changes)` — project-scoped WS notifications
- `notifyEnvironment(environmentId, changes)` — environment-scoped WS notifications (`status-changed`, `work-status-changed`)
- `notifyCommand(hostId)` — triggers `commands-available` WS notification to daemon
- `notifySystem(changes)` — system-wide WS notifications

Setup script params (`scriptName`, `timeoutMs`) gap remains — fix in Phase 3.

### Cleanup

- `@bb/env-daemon-contract` — dead package, nothing imports it. Delete when convenient.
- `plans/extensions-system.md` — out of scope for rebuild, can be deleted or deferred.

### Architecture summary

```
App/CLI  <--HTTP-->  Server (cloud)  <--HTTP-->  Host-daemon (per machine)
         <--WS(notifications)-->     <--WS(notifications)-->
                                                    |
                                              Provider processes (via agent-runtime, one per thread)
```

- Server is stateless (DB is the state). Can hot-reload.
- Host-daemon is long-lived, one per machine. Manages everything: workspaces, provider processes, git operations.
- Provider processes are children of the daemon (one per active thread). They die on daemon restart — threads resume via `thread.resume`.
- WS is notification-only everywhere. All data flows over HTTP.
- The daemon is the same binary on persistent and ephemeral hosts.

---

## Implementation Principles

These apply to all code written during the rebuild.

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
- **Three test layers.** (1) Unit tests that assert behavior. (2) Integration tests that run the real thing. (3) End-to-end tests against standalone isolated instances (unique `BB_DATA_DIR` + `BB_SERVER_PORT`).
- **Standalone instance isolation.** A core design property is the ability to stand up an isolated bb instance in a temp dir with its own DB, logs, and host identity. E2E tests and QA passes use this.
- **Tests are deliverables, not afterthoughts.** Every sub-phase lists specific tests to write. A sub-phase is not complete until its tests exist and pass.
- **Commit per sub-phase.** Each sub-phase gets its own commit with both implementation and tests.
- **Use contract schemas for request validation.** Route handlers must import and use Zod schemas from `@bb/server-contract` — no inline ad-hoc parsing.

### Scope discipline

- **No backward-compat aliases.** When renaming a type, route, or function, use only the new name.
- **No speculative API surface.** Don't declare schemas, routes, or types until the feature that uses them is being built.
- **Simplest correct implementation.** Prefer module-level singletons over factory functions with injectable parameters unless testing genuinely requires it.
- **No sync blocking in server or daemon.** All I/O must be async.

---

## Phase 1: Foundation Fixes

Fix known gaps in completed packages. Small, surgical changes.

**Status:** All complete ✅

### 1a. Move change kinds to `@bb/domain` ✅

Moved change kind constants and types to `@bb/domain`. Added `ENVIRONMENT_CHANGE_KINDS`. Deleted `@bb/server-contract/src/websocket.ts` (was only re-exports, no consumers).

**Validation:**
- [ ] `@bb/domain` exports all change kind constants and types
- [ ] `@bb/server-contract` re-exports them (no consumer breakage)
- [ ] Both packages typecheck

### 1b. Add `DbNotifier` interface and data functions to `@bb/db` ✅

Add a `DbNotifier` interface and a `noopNotifier` to `@bb/db`. Then add data functions (one file per entity) that take `db: DbConnection` and `notifier: DbNotifier`:

```
packages/db/src/data/
  projects.ts, project-sources.ts, threads.ts, environments.ts, hosts.ts,
  events.ts, commands.ts, sessions.ts, cursors.ts, drafts.ts, sweeps.ts
```

Key deliverables:
- `transitionThreadStatus` with explicit allowed-transitions map — throws on invalid transitions
- Command queuing with monotonic per-host cursor assignment (in transaction)
- Event insertion with dedup (ON CONFLICT DO NOTHING on threadId+sequence)
- High-water mark queries (max sequence per thread)
- Sweep functions: command TTL (with provision timeout differentiation), lease expiry, managed environment cleanup

**Tests (in-memory SQLite, assert DB state):**
- [ ] `transitionThreadStatus` allows valid, rejects invalid transitions
- [ ] Command cursor is monotonic per host, across multiple queued commands
- [ ] Command fetch returns pending, marks as fetched
- [ ] Command result updates state and completedAt
- [ ] Event insert deduplicates on (threadId, sequence)
- [ ] High-water marks return correct max sequence per thread
- [ ] Session open creates record, close sets status
- [ ] Session open for existing host closes old session
- [ ] Expired command retryCount 0 → re-queued, retryCount 1 → errored
- [ ] Expired lease → session closed, host disconnected, threads errored
- [ ] Managed environment with zero non-archived threads → flagged for cleanup
- [ ] Thread archive → triggers managed environment cleanup check
- [ ] Host upsert creates host, second upsert updates lastSeenAt
- [ ] Project source CRUD (create, list by project, delete)
- [ ] Server-side cursor tracking (read/write per host)
- [ ] Draft CRUD (create, list by thread, delete, send)

### 1c. Contract audit ✅

Audit `@bb/host-daemon-contract` and `@bb/server-contract` against `plans/architecture.md`:
- Verify `workspacePath` on `thread.start` and `thread.resume` schemas
- Verify all routes from the "Route Renames" table exist in server-contract
- Verify `scriptName`/`timeoutMs` on workspace provisioning args
- Add any missing route response schemas (e.g., `environmentPrimaryStatusResponse`, `/threads/:id/diff`)

**Validation:**
- [ ] All 17 command schemas match architecture doc
- [ ] All public API routes from architecture exist in server-contract
- [ ] Both packages typecheck

### 1d. Host-daemon local API contract ✅

Added `@bb/host-daemon-contract/local` with schemas, typed routes, and `createHostDaemonLocalClient()` for `/host-id`, `/open`, `/pick-folder`, `/status`, `/restart`.

### 1e. Server contract additions ✅

Added all missing routes: `/system/providers/:id`, `/system/config`, `/threads/:id/default-execution-options`, `/threads/:id/workspace/files`, `/threads/:id/workspace/file`, `/threads/:id/output`, `/threads/:id/diff`, `/threads/:id/diff/branches`, `/environments/:id/status`, project source CRUD. Thread list uses `archived` query param.

---

## Phase 2: Consumers (contract validation)

Cut over CLI and app to new contracts. Validates contracts from a real consumer perspective before building the backend.

**Status:** All complete ✅. Both consumers cut over with zero type errors. Dead code swept. Environment selector functional with Direct/Worktree options. CLI supports `--archived` flag, env reuse without daemon, explicit `--new-environment` validation.

### 2a. Cut over `apps/cli` to new contracts

Update `apps/cli` imports from old packages (`@bb/env-daemon-contract`, old `@bb/core` types) to new ones (`@bb/server-contract`, `@bb/domain`, `@bb/host-daemon-contract`).

**Mechanical:** renames (import paths, type names like `UI*` → `View*`, route name changes), straightforward type migrations.

**Flag for discussion:** missing routes, fields, or behavioral mismatches. Don't silently add things to the contracts to make it compile — surface these as findings.

**Validation:**
- [ ] `apps/cli` typechecks against new contracts
- [ ] No imports from `@bb/env-daemon-contract` or deleted packages remain
- [ ] Findings doc: list of any missing routes, types, or behavioral mismatches discovered

### 2b. Cut over `apps/app` to new contracts

Same approach as 2a but for the web app. Larger surface — WS subscriptions, timeline types, draft management, workspace status.

**Mechanical:** import path changes, type renames (`UI*` → `View*`, `ThreadWorkStatus` → `WorkspaceStatus`, etc.), route reference updates.

**Flag for discussion:** routes or response shapes the app depends on that aren't in the new contracts, WS message types that don't match, UI state that assumed fields the domain types no longer have.

**Validation:**
- [ ] `apps/app` typechecks against new contracts
- [ ] No imports from deleted packages remain
- [ ] Findings doc: list of any mismatches discovered (append to CLI findings)

---

## Phase 3: `@bb/workspace` (new interface)

Wrap existing workspace code behind `provisionWorkspace() → IWorkspace`. See `plans/host-package.md` for the full interface design.

Fix the `scriptName`/`timeoutMs` gap. Internals stay mostly the same — the change is the external contract.

**Validation:**
- [ ] All existing `@bb/workspace` tests still pass
- [ ] `provisionWorkspace` returns `IWorkspace` for each provisioning type (unmanaged, worktree, clone)
- [ ] `IWorkspace.destroy()` cleans up managed workspaces, no-ops for unmanaged
- [ ] `scriptName` and `timeoutMs` params work in provisioning
- [ ] Workspace properties (`isGitRepo`, `isWorktree`, `branchName`) are discovered, not declared
- [ ] Package typechecks

---

## Phase 4: Host-Daemon (`apps/host-daemon`)

The daemon is the most complex component — session management, reconnection, command routing, AgentRuntime lifecycle. Build modules with injectable dependencies so each can be tested in isolation.

Uses `provisionWorkspace() → IWorkspace` from `@bb/workspace`. Same binary runs on persistent and ephemeral hosts.

**Each sub-phase is a separate commit with both implementation and tests.**

### 4a. Daemon skeleton + identity

**Implementation:**
- `index.ts` — entrypoint: validate config → acquire lock → create logger → read identity → start daemon
- `daemon.ts` — main lifecycle (session, command loop, shutdown)
- `identity.ts` — `$BB_DATA_DIR/host-id` (read or create UUID), OS hostname via `scutil`/`hostname`

Startup: (1) validate config, (2) acquire file lock via `proper-lockfile`, (3) create logger, (4) read or create host-id, (5) generate ephemeral instanceId, (6) start daemon.

Shutdown: On SIGTERM/SIGINT: flush event buffer, shutdown all AgentRuntime instances, release file lock, exit 0.

**Tests:**
- [ ] Host-id created on first run, same ID returned on subsequent runs
- [ ] OS hostname detection returns non-empty string
- [ ] File lock prevents second instance
- [ ] Clean shutdown releases lock

### 4b. Command cursor + event buffer

Standalone modules with no server dependency — test in isolation.

**Implementation:**
- `command-cursor.ts` — persist/read `$BB_DATA_DIR/command-cursor` (atomic write-to-temp-then-rename). Returns 0 if file missing.
- `event-buffer.ts` — in-memory buffer, flush via provided `postEvents` callback, track acks. Flush on: 100ms debounce or 50 events. Max 1000 events; oldest dropped if exceeded.

**Tests:**
- [ ] Write cursor, read it back
- [ ] Read returns 0 when file doesn't exist
- [ ] Atomic write (write to tmp then rename)
- [ ] Push events, inject fake poster, verify flush called with correct batch
- [ ] Ack discards events at/below high-water marks
- [ ] Flush retries on poster failure, events retained
- [ ] Buffer overflow drops oldest events
- [ ] Per-thread monotonic sequence numbers
- [ ] Sequence initialization from high-water marks (starts at hwm + 1)

### 4c. Session management

**Implementation:**
- `server-connection.ts` — `ServerConnection` class: HTTP client + WS + reconnection

Session open: `POST /internal/session/open`. Returns sessionId, heartbeat config, threadHighWaterMarks.

WS: connects to `/internal/ws?sessionId={sessionId}&token={BB_SECRET_TOKEN}`. `commands-available` → trigger fetch callback. `session-close` → shut down.

Heartbeat: `setInterval` at `heartbeatIntervalMs`. Sends `{ type: "heartbeat", bufferDepth, lastCommandCursor }`.

Reconnection: exponential backoff (base 1s, 2x, max 30s, jitter ±25%). If WS down >5s, poll commands every ~10s. On WS reconnect, stop polling.

Command result delivery: POST with retry (exponential backoff). Cursor advanced only after successful POST.

**Tests (use minimal in-process Hono server as test fixture on random port):**
- [ ] Opens session, receives sessionId and config
- [ ] WS connects, server receives heartbeats
- [ ] `commands-available` WS message triggers fetch callback
- [ ] `session-close` WS message triggers shutdown callback
- [ ] WS disconnect triggers reconnection
- [ ] Command result POST retries on failure
- [ ] Session open includes activeThreads from callback

### 4d. Command routing + AgentRuntime

**Implementation:**
- `command-router.ts` — fetch commands, dispatch by type, per-environment serialization for workspace commands
- `runtime-manager.ts` — `Map<environmentId, { runtime, workspace, path }>`, lazy creation

Contiguous cursor advancement: if commands 5, 6, 7 are fetched and 7 completes first, cursor stays at 4 until 5 and 6 complete. Uses lane-based queuing per environment.

`turn.run` calls `ensureRuntime` — lazily creates runtime and resumes thread if needed (handles idle thread recovery after restart).

`provider.list_models`: calls `listAvailableProviders()` from `@bb/agent-runtime` directly — no runtime needed.

`environment.destroy`: shuts down the AgentRuntime for that environment (kills provider processes), then calls `workspace.destroy()`. If provider processes are active, they are killed — the server has already transitioned threads to error/idle before sending destroy.

**Tests (use `AgentRuntimeOptions.adapterFactory` for fake provider, temp directories):**
- [ ] First command for an environment creates the runtime
- [ ] Subsequent commands reuse the runtime
- [ ] `environment.destroy` shuts down runtime, calls workspace.destroy()
- [ ] Unknown environmentId without workspacePath returns error
- [ ] Dispatches thread commands to runtime methods
- [ ] Dispatches workspace commands to IWorkspace methods
- [ ] Workspace commands serialize per-environment
- [ ] Provider commands for different threads run concurrently
- [ ] Contiguous cursor advancement (early completion doesn't skip)
- [ ] `turn.run` for thread with no session lazily creates runtime + resumes

### 4e. Daemon restart

**Implementation:**
- `restart.ts` — spawn `process.argv[0]` with `process.argv.slice(1)` via `child_process.spawn({ detached: true, stdio: 'ignore' })`. Release lock. Exit.

Triggered by SIGUSR2. SIGTERM/SIGINT → clean shutdown.

**Tests:**
- [ ] Spawns new process, old process exits cleanly
- [ ] New process acquires lock after old releases it

### 4f. Daemon integration tests

Run the full daemon against a **minimal test fixture server** (in-process Hono app that implements the internal API contract: session open, command fetch, command result, event ingestion). This is NOT the real server — it's a lightweight test double that speaks the right protocol. Keeps Phase 4 independent of Phase 5.

Use fake provider adapter.

**Tests (no new implementation — tests only):**
- [ ] Session open → server returns sessionId → daemon starts WS + heartbeat
- [ ] Server queues command → daemon fetches → executes → reports result → cursor advanced
- [ ] Provider emits events → daemon buffers → posts to server → server stores → ack prunes buffer
- [ ] WS disconnect → daemon reconnects → session re-opened → commands resume from cursor
- [ ] Multiple environments → commands dispatch to correct runtimes concurrently

---

## Phase 5: `@bb/sandbox-host` (E2B)

Ephemeral host lifecycle — provision, suspend, resume, destroy. See `plans/host-package.md` for the interface design. Porting from [terragon-oss](https://github.com/terragon-labs/terragon-oss).

The package provisions an E2B sandbox, bundles and installs the daemon, starts it, and waits for it to connect back to the server. Daemon bundling (esbuild single-file + bridge bundling) is owned by this phase. After provisioning, the server talks to the daemon through the normal protocol. `@bb/sandbox-host` is only for lifecycle management (suspend/resume/destroy).

Workspace provisioning inside the sandbox goes through the normal path: server sends `environment.provision` command → daemon calls `provisionWorkspace()` from `@bb/workspace`.

**Dependencies:** `@bb/domain`, E2B SDK (`@e2b/code-interpreter`)

**Validation:**
- [ ] `provisionHost` creates an E2B sandbox
- [ ] Daemon bundle is installed and started inside the sandbox
- [ ] Daemon connects back to server via normal session protocol
- [ ] `suspend()` pauses the sandbox
- [ ] `resume()` restores the sandbox, daemon reconnects
- [ ] `destroy()` tears down the sandbox
- [ ] Tests run against real E2B API (with API key) or mock

---

## Phase 6: Server (`apps/server`)

Framework: **Hono** on `@hono/node-server`. WebSocket via `@hono/node-ws`. Data functions from `@bb/db`.

**Each sub-phase is a separate commit with both implementation and tests.**

### 6a. Server skeleton + middleware

**Implementation:**
- `index.ts` — read config, init DB, create hub, create logger, create app, run sweeps, call `serve()`
- `server.ts` — `createApp(deps): Hono` — mount routes, middleware, WS upgrade handlers. The app type must satisfy `@bb/server-contract`'s `PublicApiRoutes` at compile time (missing routes = type error).
- `db.ts` — `initDb()`: `createConnection(BB_DATABASE_URL)` + `migrate(db)`
- `errors.ts` — `ApiError` class extending `HTTPException`

Mount: `/api/v1/*` public, `/internal/*` daemon, `/ws` client WS, `/internal/ws` daemon WS.
Middleware: CORS, Bearer token auth on `/internal/*`, global error handler.

**Tests:**
- [ ] App responds to requests (use `app.request()`)
- [ ] Public routes accessible without auth
- [ ] Internal routes reject without valid Bearer token (401)
- [ ] Invalid JSON body returns structured error
- [ ] `initDb()` with in-memory SQLite succeeds, migration runs
- [ ] Compile-time: missing route from contract causes type error

### 6b. WebSocket notification hub

**Implementation:**
- `ws/hub.ts` — `NotificationHub` implements `DbNotifier`: client subscriptions, daemon connections, notify methods, `waitForCommands` (for long-poll support)
- `ws/client-protocol.ts` — `/ws` handler: subscribe/unsubscribe, cleanup on disconnect
- `ws/daemon-protocol.ts` — `/internal/ws` handler: validate token+sessionId, heartbeat updates, `commands-available` dispatch

Use `@hono/node-ws` with `createNodeWebSocket()`. Separate protocol handlers for client and daemon connections.

**Tests:**
- [ ] Subscribe client, notify, verify message received
- [ ] Unsubscribe stops notifications
- [ ] Client disconnect cleans up subscriptions (no leak)
- [ ] `notifyDaemon` sends to correct sessionId's WS
- [ ] `notifyDaemon` for unknown sessionId is a no-op
- [ ] Multiple clients subscribed to same thread all receive notification
- [ ] `waitForCommands` resolves when `notifyDaemon` fires commands-available
- [ ] Concurrent subscribe/unsubscribe doesn't corrupt state

### 6c. Public API routes

**Implementation:**
```
apps/server/src/routes/
  projects.ts, threads.ts, environments.ts, hosts.ts, system.ts
```

All request parsing uses Zod schemas from `@bb/server-contract`. Data functions from `@bb/db`.

Thread creation with ephemeral hosts calls `provisionHost()` from `@bb/sandbox-host` to create the sandbox, then proceeds with the normal flow (create environment record, queue `environment.provision` command to the daemon inside the sandbox).

**Tests (use `app.request()` with in-memory DB + real hub):**
- [ ] `POST /threads` with `{ type: "host", workspace: { type: "unmanaged" } }` → env(provisioning), provision validates path, env(ready), thread created
- [ ] `POST /threads` with `{ type: "host", workspace: { type: "managed-worktree" } }` → env(provisioning), provision command queued
- [ ] `POST /threads` with `{ type: "sandbox-host" }` → sandbox provisioned, env(provisioning), provision command queued
- [ ] `POST /threads` with `{ type: "reuse", environmentId }` → existing env, thread created
- [ ] `POST /threads/:id/send` idle → active, turn.run queued
- [ ] `POST /threads/:id/send` active + steer → turn.steer queued
- [ ] `POST /environments/:id/actions` commit → command queued
- [ ] `POST /environments/:id/actions` promote → promote command queued
- [ ] CRUD for projects, hosts

### 6d. Internal API routes

**Implementation:**
```
apps/server/src/internal/
  session.ts, commands.ts, events.ts, tool-calls.ts, reconciliation.ts
```

Session open, command fetch/result, event ingestion, tool calls, reconciliation.

**Tests (use `app.request()`):**
- [ ] Session open creates host + session, returns sessionId
- [ ] Session open for existing host closes old session
- [ ] Returns threadHighWaterMarks
- [ ] Fetch returns pending, marks fetched
- [ ] Long-poll returns empty on timeout
- [ ] Command result → provision success updates env to ready
- [ ] Command result → provision failure errors env + thread
- [ ] Event ingestion deduplicates, returns high-water marks
- [ ] `turn/completed` event transitions thread to idle
- [ ] `spawn_thread` tool call creates child thread
- [ ] Reconciliation: error thread + daemon reports active → transitions to active
- [ ] Reconciliation: active thread + daemon has no session → transitions to idle

### 6e. Server integration tests

Run the full server with real HTTP/WS. No mocking.

**Tests (no new implementation — tests only):**
- [ ] Start server → session open → command queued → fetch → result reported
- [ ] Event ingestion → WS client subscribed to thread receives `events-appended`
- [ ] Full thread lifecycle: create → send → command → result → events → idle
- [ ] Session replacement: open twice with same hostId → old closed, WS gets `session-close`

---

## Phase 7: Integration & QA

**All tests automated.**

### 7a. End-to-end smoke test (persistent host)

Start server + daemon → create project → create thread with managed worktree → send message → see events → commit → archive → verify logs.

### 7b. End-to-end smoke test (ephemeral host)

Start server → create project → create thread with cloud host → sandbox provisioned → daemon connects → send message → see events → suspend → resume → destroy.

### 7c. Restart resilience

Kill server → daemon reconnects. Kill daemon → threads interrupted → resume.

### 7d. Multi-instance isolation

Two instances with different `BB_DATA_DIR` + `BB_SERVER_PORT`, concurrent smoke tests, no interference.

---

## Dependency Graph

```
Phase 1 (foundation fixes):
  1a (change kinds) → 1b (data layer + DbNotifier)
  1c (contract audit) — parallel with 1a/1b

Phase 2 (consumers, after Phase 1):
  2a (CLI cutover) + 2b (app cutover) — parallel

Phase 3 (@bb/workspace interface, after Phase 1):
  standalone — parallel with Phase 2

Phase 4 (host-daemon, after Phase 3 for 4d+):
  4a → 4b → 4c can start in parallel with Phase 3 (no IWorkspace needed yet)
  4d needs Phase 3 (command router uses IWorkspace)
  4d → 4e → 4f

Phase 5 (@bb/sandbox-host, after Phase 4 — needs working daemon):
  standalone — parallel with Phase 6. Owns daemon bundling.

Phase 6 (server, after Phase 1b — needs data functions):
  6a → 6b → 6c + 6d (parallel) → 6e
  6c needs @bb/sandbox-host (Phase 5) for ephemeral host thread creation

Phase 7 (integration, after Phase 4 + 5 + 6):
  7a, 7b, 7c, 7d
```

**Two parallel critical paths:**
- Phase 1 → Phase 3 → Phase 4 → Phase 7
- Phase 1 → Phase 6 → Phase 7

Phase 7 waits for both. Phase 4a-4c can start before Phase 3 finishes. Phase 6 can start as soon as Phase 1b is done. Phase 5 slots in after Phase 4 (needs a working daemon to bundle), and 6c needs it for ephemeral host routes.

**Triage gate after Phase 2:** Phase 2 (consumer cutover) produces a findings doc of contract mismatches. Review findings before proceeding — if contracts need changes, fix them before Phases 4/6 build against them.

---

## Out of Scope

- GitHub repo project sources (stubbed — schema and API ready)
- Multi-machine support (data model ready, only local host in v1)
- Extensions system
- Docker environments (cut)
- Async context / trace ID propagation in logger (deferred)
- HTTP request logging middleware (deferred)
- Voice transcription endpoint (stub returns 501)
- File attachment upload (deferred)
