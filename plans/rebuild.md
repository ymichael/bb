# Rebuild Plan

Implementation plan for the bb server, host-daemon, and supporting infrastructure. See `plans/architecture.md` for the full architecture and `plans/host-package.md` for the `@bb/workspace` and `@bb/sandbox-host` package designs.

## Start Here

**Phases 1–5b are complete.** All foundation packages are built, contracts are validated, consumers (app + CLI) have zero type errors. The host-daemon is built with full test coverage. The sandbox-host stub is on main. All contract gaps are resolved.

**Next phase: Phase 6** — Server (`apps/server`). The main build phase. Uses the sandbox-host stub for ephemeral host thread creation (compile-time contract satisfied, runtime throws until Phase 8).

**Then: Phase 7** — Integration & QA for persistent-host workflows (server + daemon).

**Then: Phase 8** — Flesh out `@bb/sandbox-host` (real E2B implementation, daemon bundling).

**Phase 9** — Integration & QA for ephemeral-host workflows.

## Current State

Phases 1–5b are complete. The host-daemon, sandbox-host stub, and all contract fixes are built and merged. This plan covers what remains.

### What exists today

| Package | State |
|---|---|
| `@bb/config` | **Done** — `envsafe` with scoped exports per consumer. |
| `@bb/logger` | **Done** — pino + pino-roll, per-component log files, rotation. |
| `@bb/domain` | **Done** — entity types, event types, Zod schemas, change kinds (thread/project/environment/system). |
| `@bb/db` | **Done** — schema, migrations, data functions (one per entity), `DbNotifier` with `notifyThread`/`notifyProject`/`notifyEnvironment`/`notifyCommand`/`notifySystem`. 59 tests passing. |
| `@bb/core-ui` | **Done** — view transforms, `formatEnvironmentDisplay(env, isLocalHost)`, timeline formatting. |
| `@bb/host-daemon-contract` | **Done** — 20 commands (17 original + `workspace.list_files`, `workspace.read_file`, `workspace.list_branches`), session protocol, local API contract. Unknown command types handled gracefully (per-command parsing, error reported to server). |
| `@bb/server-contract` | **Done** — public API routes, discriminated `EnvironmentArgs` union for thread creation, WS protocol. |
| `@bb/workspace` | **Done** — Workspace class, `provisionWorkspace() → IWorkspace`, promote/demote, tested with real git. |
| `@bb/agent-runtime` | Done — provider adapters (codex, claude-code, pi), registry, runtime. Leave as-is. |
| `@bb/templates` | Done — untouched |
| `@bb/ui-core` | Done — shared React components |
| `@bb/tsconfig` | Done — untouched |
| `apps/app` | **Done** — cut over to new contracts, zero type errors, 116 tests passing. Environment selector with Direct/Worktree options. `useHostDaemon` hook for daemon operations. |
| `apps/cli` | **Done** — cut over to new contracts, zero type errors, 67 tests passing. Fetches hostId from daemon, supports env reuse without daemon. |
| `apps/server` | **Not yet a package** — directory placeholder only. Needs full package setup (package.json, tsconfig, src/index.ts). Built in Phase 6. |
| `apps/host-daemon` | **Done** — daemon skeleton, session management, command routing (20 types, domain-split handlers), event buffering, runtime manager, local API. Uses `p-retry`, `partysocket/ws`, `p-debounce`. 65 tests. |
| `@bb/sandbox-host` | **Stub** — interface only (`provisionHost`, `SandboxHost`), all methods throw "Not implemented". Real implementation in Phase 8. |

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

Setup script params (`scriptName`, `timeoutMs`) — fixed in Phase 3.

### Cleanup

- `@bb/env-daemon-contract` — deleted (CLI quality merge).
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
- **Wire once at the entry point.** `index.ts` creates dependencies, passes them to modules, starts the server. The dependency graph is visible by reading that one file. For complex apps (e.g., the daemon), a dedicated `app.ts` assembly file keeps `index.ts` slim and the wiring explicit.
- **Declare what you use.** Package dependencies in `package.json` must be explicit.
- **Use proven libraries for critical infrastructure.** Retry, backoff, and reconnection logic is subtle and error-prone when hand-rolled (unbounded loops, silent failures, stale state). Use well-tested libraries: `p-retry` for HTTP retry with bounded attempts and logging hooks, `partysocket/ws` for WebSocket reconnection with backoff. Keep custom implementations only when the logic is genuinely domain-specific (e.g., event buffer sequencing/acking) or trivially simple (e.g., a 15-line per-key promise queue).

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
- **Contract-validated tests for internal APIs.** When a package exposes an HTTP API with a typed client in its contract package (e.g., `createHostDaemonLocalClient`), tests should use that client rather than raw fetch. This catches contract drift at test time.
- **Exhaustive switches on discriminated unions.** Command dispatch, route handling, and similar switch statements on a union type must include `default: { const _exhaustive: never = value; throw new Error(...); }`. This catches missing handlers at compile time when a new variant is added to the union.
- **Shared test fixtures.** Test doubles (fake servers, fake adapters) should live in `test/helpers/` and be imported. Do not copy-paste fixture code across test files — a single source of truth prevents drift and keeps tests maintainable.

### Stub routes

- **501 for unimplemented routes, never fake data.** If a route exists in the contract but cannot be implemented yet (missing daemon command, deferred feature), return `501` with `{ code: "unsupported_operation", message: "..." }`. Never return hardcoded fake data, empty arrays pretending to be real results, or stub factory objects. A 501 is honest — consumers know the feature doesn't work yet. An empty array or fake object looks like a working route that returned no data, which is a lie that hides bugs.
- **Document why a route is 501.** Add a comment: `// 501: needs workspace.list_files daemon command (Phase 5b)` or `// 501: deferred feature`. This makes it obvious what needs to happen to implement the route.

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

**Status:** Complete ✅

Wrapped existing workspace code behind `provisionWorkspace() → IWorkspace`. Three provisioning modes (unmanaged, managed-worktree, managed-clone). `IWorkspace.destroy()` cleans up managed workspaces, no-ops for unmanaged. Properties discovered via git, not declared. `scriptName`/`timeoutMs` gap fixed.

---

## Phase 4: Host-Daemon (`apps/host-daemon`)

**Status:** Complete ✅

The daemon is built with full test coverage (18 source files, 12 test files, 58 tests). Key implementation decisions captured in the Implementation Principles section above. See the source code for details — the file structure is documented in commit history.

---

## Phase 5: `@bb/sandbox-host` (stub)

**Status:** Complete ✅

Stub package with `provisionHost` and `SandboxHost` interface. All methods throw "Not implemented". Real implementation in Phase 8.

---

## Phase 5b: Contract fixes and pre-server prerequisites

**Status:** Complete ✅

Added `provider.list` daemon command (21 total), host `status` field (connected/disconnected/suspended, derived not stored), app host tracking atoms. Removed dead routes (`POST /system/shutdown`, `GET /system/providers/:id`). `ProviderInfo` schema lives in `@bb/domain` — no cross-contract dependencies.

---

## Phase 6: Server (`apps/server`)

Framework: **Hono** on `@hono/node-server`. WebSocket via `@hono/node-ws`. Data functions from `@bb/db`.

**Dependencies:** `@mariozechner/pi-ai` for title generation (provider-agnostic LLM calls, don't use OpenAI SDK directly).

**Each sub-phase is a separate commit with both implementation and tests.**

### Server-internal infrastructure (built as part of Phase 6, not standalone)

These are implementation requirements documented here so they're built correctly:

**Command-and-wait pattern.** Routes like `GET /environments/:id/status` need to queue a daemon command and wait for the result synchronously. Build a shared utility `queueCommandAndWait(deps, { hostId, command, timeoutMs })` that: queues command to DB → notifies daemon via hub → waits for result (promise resolved when command-result handler fires) → returns result. The `NotificationHub` needs a `waitForCommandResult(commandId, timeoutMs)` method. Default timeouts: 30s for workspace queries, 5min for provisioning. On timeout: `ApiError(504, "command_timeout")`. Used by: environment status/diff/branches, workspace files, system models/providers, thread stop, environment actions.

**Attachment storage.** Server stores file attachments at `$BB_DATA_DIR/attachments/<projectId>/`. No daemon involvement. Utilities: `storeAttachment(projectId, file)` (sanitized filename + timestamp + random suffix, 25MB limit, 10MB for images), `readAttachment(projectId, path)` (path traversal protection), `deleteProjectAttachments(projectId)` (cleanup on project deletion).

**Voice transcription proxy.** Simple proxy: receive multipart audio → forward to `POST https://api.openai.com/v1/audio/transcriptions` with model `gpt-4o-transcribe`, auth via `OPENAI_API_KEY` → return `{ text }`. No format conversion. 25MB limit.

**Auto-title generation.** After thread creation with input, fire-and-forget: clean prompt text → render `codexRunMetadata` template from `@bb/templates` → call `complete()` from `@mariozechner/pi-ai` with a cheap/fast model (configured via `BB_INFERENCE_MODEL`, default `gpt-4o-mini`) → parse JSON `{ title, worktreeName }` → update thread title. `titleFallback` is derived synchronously from first prompt text (no LLM).

**Timeline transformation.** `GET /threads/:id/timeline` and `/timeline/tool-details` use `toViewMessages()` and `buildTimelineRows()` from `@bb/core-ui`. These are pure functions: read events from DB → transform → return. No daemon involvement.

### Non-obvious requirements

These are behaviors that aren't obvious from the route definitions alone:

- **Attachments** are stored on the server filesystem at `$BB_DATA_DIR/attachments/<projectId>/`. Max 25MB (10MB for images). Sanitize filenames. Path traversal protection on reads. Clean up on project deletion.
- **Thread rename** triggers a `thread.rename` daemon command in addition to the DB update — so the provider session knows the new title. This applies to both manual renames (PATCH /threads/:id) and auto-generated titles.
- **Default project source.** Routes that aren't scoped to a specific environment or host (e.g., `GET /projects/:id/files`) should resolve the project's default source (the one with `isDefault = true`) to determine which host to query.
- **Disconnected host error.** When a route needs to send a command to a host that is not connected, return a consistent error: `ApiError(502, "host_disconnected", "Host is not connected")`. All daemon-proxied routes should go through the same code path (`queueCommandAndWait`) so this check is centralized.
- **Thread title generation.** When a thread is created with input and no explicit title, generate one asynchronously using `@mariozechner/pi-ai` + the `codexRunMetadata` template from `@bb/templates`. Set `titleFallback` synchronously from the first prompt text. Don't block thread creation on title generation.
- **Pending input after provisioning.** When `environment.provision` succeeds and the thread has queued input, the server must queue `thread.start` as a follow-up. This happens in the command-result handler, not at thread creation time.
- **Archive with cleanup.** Archiving checks workspace status first — rejects if work could be lost (uncommitted or unmerged changes) unless `force=true`. Stops the thread if active. If the thread's environment is managed and now has zero non-archived threads, queues `environment.destroy`.

### 6a. Server skeleton + middleware

**Implementation:**
- `index.ts` — read config, init DB, create hub, create logger, create app, run sweeps, call `serve()`
- `server.ts` — `createApp(deps): Hono` — mount routes, middleware, WS upgrade handlers. The app type must satisfy `@bb/server-contract`'s `PublicApiRoutes` at compile time (missing routes = type error).
- `db.ts` — `initDb()`: `createConnection(BB_DATABASE_URL)` + `migrate(db)`
- `errors.ts` — `ApiError` class extending `HTTPException`

Mount: `/api/v1/*` public, `/internal/*` daemon, `/ws` client WS, `/internal/ws` daemon WS.
Middleware: CORS, Bearer token auth on `/internal/*`, global error handler.

**File structure (no source file over 300 lines):**
```
apps/server/src/
  index.ts              — config, DB init, create app, serve()
  server.ts             — createApp(deps): mount routes, middleware, WS
  errors.ts             — ApiError extends HTTPException
  routes/
    projects.ts, threads.ts, environments.ts, hosts.ts, system.ts
  internal/
    session.ts, commands.ts, events.ts, tool-calls.ts
  ws/
    hub.ts, client-protocol.ts, daemon-protocol.ts
```
If `threads.ts` grows large, split into `threads/` sub-modules (list, create, actions, data).

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

Thread creation with ephemeral hosts calls `provisionHost()` from `@bb/sandbox-host`. In Phase 6, this uses the stub (throws not-implemented for `sandbox-host` type threads). The real implementation comes in Phase 8.

**Route implementation guide:** Every route in the server contract must be implemented. No returning fake data — if a route can't be implemented yet, return 501 (see Stub Routes principle). Here is the breakdown:

**DB read/write routes (implement with existing `@bb/db` functions):**
- Projects: GET/POST/PATCH/DELETE `/projects`, `/projects/:id`, project source CRUD
- Hosts: GET `/hosts`, `/hosts/:id`
- Environments: GET `/environments`, `/environments/:id`
- Threads: GET/POST/PATCH/DELETE `/threads`, `/threads/:id`
- Thread actions: POST archive, unarchive, read, unread (all DB writes via `archiveThread`, `unarchiveThread`, `updateThread`)
- Thread data: GET events, timeline, timeline/tool-details, output (all via `listEvents` + transformation)
- Thread data: GET default-execution-options (derive from thread/project config)
- Drafts: POST/DELETE `/threads/:id/drafts`, `/threads/:id/drafts/:draftId`, POST send

**Routes that queue daemon commands (implement, command types exist):**
- POST `/threads` (creates thread + queues `environment.provision` and/or `thread.start`)
- POST `/threads/:id/send` (queues `turn.run` or `turn.steer`)
- POST `/threads/:id/stop` (queues `thread.stop`)
- POST `/environments/:id/actions` (queues `workspace.commit`, `workspace.promote`, etc.)
- GET `/environments/:id/status` (queues `workspace.status`, waits for result)
- GET `/environments/:id/diff` (queues `workspace.diff`, waits for result)
- GET `/environments/:id/diff/branches` (queues `workspace.list_branches`, waits for result)
- GET `/threads/:id/workspace/files` (queues `workspace.list_files`, waits for result)
- GET `/threads/:id/workspace/file` (queues `workspace.read_file`, waits for result)
- GET `/system/models`, `/system/providers` (queues `provider.list_models`)
- POST `/projects/:id/managers` (creates manager thread, same flow as thread creation)

These "queue and wait" routes need a synchronous command pattern: queue the command, wait for the daemon to report the result (via the command result handler or a dedicated response channel), and return it to the HTTP client. This is the same pattern for all of them — implement the pattern once (e.g., `queueCommandAndWait(hub, db, command, timeoutMs)`) and reuse it.

**Important: unmanaged workspace provisioning MUST go through the daemon.** The server queues `environment.provision` with mode `unmanaged` — the daemon validates the path exists and discovers git properties. The server must NOT do filesystem I/O directly.

**Routes that return 501 (deferred features):**
- GET `/projects/:id/files` — needs project-scoped file listing (deferred, different from thread workspace files)
- POST `/projects/:id/attachments`, GET `/projects/:id/attachments/content` — file upload, deferred
- POST `/system/voice-transcription` — deferred
- POST `/system/shutdown` — implement in Phase 7 integration

**Tests (use `app.request()` with in-memory DB + real hub):**
- [ ] `POST /threads` with `{ type: "host", workspace: { type: "unmanaged" } }` → env(provisioning), provision command queued to daemon
- [ ] `POST /threads` with `{ type: "host", workspace: { type: "managed-worktree" } }` → env(provisioning), provision command queued
- [ ] `POST /threads` with `{ type: "sandbox-host" }` → returns 501 (not implemented, until Phase 8)
- [ ] `POST /threads` with `{ type: "reuse", environmentId }` → existing env, thread created
- [ ] `POST /threads/:id/send` idle → active, turn.run queued
- [ ] `POST /threads/:id/send` active + steer → turn.steer queued
- [ ] `POST /threads/:id/stop` → thread.stop queued
- [ ] `POST /threads/:id/archive` → archivedAt set
- [ ] `POST /threads/:id/unarchive` → archivedAt cleared
- [ ] `GET /threads/:id/events` → returns events from DB
- [ ] `POST /environments/:id/actions` commit → workspace.commit command queued
- [ ] `POST /environments/:id/actions` promote → workspace.promote command queued
- [ ] CRUD for projects, project sources, hosts
- [ ] 501 routes return structured error with `unsupported_operation` code

### 6d. Internal API routes

**Implementation:**
```
apps/server/src/internal/
  session.ts, commands.ts, events.ts, tool-calls.ts, reconciliation.ts
```

Session open, command fetch/result, event ingestion, tool calls, reconciliation.

**Key correctness requirements (all three Phase 6 attempts got these wrong):**
- **Heartbeat messages must update the session.** When the daemon sends `{ type: "heartbeat", bufferDepth, lastCommandCursor }` over the WS, the server must update `lastHeartbeatAt` and `leaseExpiresAt` on the session record. Without this, lease timeout sweeps will kill live sessions.
- **Server-side cursor tracking must NOT advance past incomplete commands.** The `setCursor` call must only advance when all prior commands have completed. Do NOT use `Math.max(getCursor, report.cursor)` — this skips commands that complete out of order, violating the at-least-once delivery guarantee.
- **Use the real `NotificationHub` for command result recording.** Don't pass noop notifiers to `setCursor` or data functions called during command result handling — the hub must fire `notifyCommand` and `notifyThread` so WS clients get real-time updates.
- **Reconciliation queries must be efficient.** Do NOT load all environments and all threads into memory then filter in JS. Use targeted queries with WHERE clauses joining environments to the host. This is O(host's environments) not O(all environments).

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

## Phase 7: Integration & QA (persistent host)

Validate the server + daemon working together for persistent-host workflows. No ephemeral/sandbox hosts yet.

**All tests automated.**

### 7a. End-to-end smoke test (persistent host)

Start server + daemon → create project → create thread with managed worktree → send message → see events → commit → archive → verify logs.

### 7b. Restart resilience

Kill server → daemon reconnects. Kill daemon → threads interrupted → resume.

### 7c. Multi-instance isolation

Two instances with different `BB_DATA_DIR` + `BB_SERVER_PORT`, concurrent smoke tests, no interference.

---

## Phase 8: `@bb/sandbox-host` (real implementation)

Flesh out the stub from Phase 5 with the real E2B implementation. Porting from [terragon-oss](https://github.com/terragon-labs/terragon-oss).

The package provisions an E2B sandbox, bundles and installs the daemon, starts it, and waits for it to connect back to the server. Daemon bundling (esbuild single-file + bridge bundling) is owned by this phase. After provisioning, the server talks to the daemon through the normal protocol. `@bb/sandbox-host` is only for lifecycle management (suspend/resume/destroy).

Workspace provisioning inside the sandbox goes through the normal path: server sends `environment.provision` command → daemon calls `provisionWorkspace()` from `@bb/workspace`.

**Dependencies:** `@bb/domain`, E2B SDK (`@e2b/code-interpreter`)

**Implementation:**
- Replace stub methods with real E2B SDK calls
- Daemon bundling: esbuild single-file build of `apps/host-daemon`
- Install + start daemon inside sandbox, wait for session open callback
- Update server's `POST /threads` with `{ type: "sandbox-host" }` route to call the real `provisionHost()` instead of returning 501

**Validation:**
- [ ] `provisionHost` creates an E2B sandbox
- [ ] Daemon bundle is installed and started inside the sandbox
- [ ] Daemon connects back to server via normal session protocol
- [ ] `suspend()` pauses the sandbox
- [ ] `resume()` restores the sandbox, daemon reconnects
- [ ] `destroy()` tears down the sandbox
- [ ] Tests run against real E2B API (with API key) or mock

---

## Phase 9: Integration & QA (ephemeral host)

Validate sandbox-host end-to-end. Requires Phase 7 (persistent host QA passing) + Phase 8 (real sandbox-host).

### 9a. End-to-end smoke test (ephemeral host)

Start server → create project → create thread with cloud host → sandbox provisioned → daemon connects → send message → see events → suspend → resume → destroy.

### 9b. Mixed-host smoke test

Run persistent-host and ephemeral-host threads concurrently against the same server. Verify no interference.

---

## Dependency Graph

```
Phases 1–5: ✅ Complete

Phase 5b (contract fixes + pre-server prerequisites):
  5b-1 (provider.list command) + 5b-2 (host status + app atoms) — can be parallel
  Must complete before Phase 6.

Phase 6 (server, needs Phase 5b):
  6a → 6b → 6c + 6d (parallel) → 6e

Phase 7 (integration & QA, persistent host):
  Needs Phase 6 (server) + Phase 4 (daemon). Validates the core loop works.

Phase 8 (sandbox-host real implementation):
  Needs working server + daemon (validated by Phase 7). Owns daemon bundling.

Phase 9 (integration & QA, ephemeral host):
  Needs Phase 8. Validates sandbox-host end-to-end.
```

**Critical path:** Phase 5b (prerequisites) → Phase 6 (server) → Phase 7 (persistent QA) → Phase 8 (sandbox-host real) → Phase 9 (ephemeral QA).

---

## Out of Scope

- GitHub repo project sources (stubbed — schema and API ready)
- Multi-machine support (data model ready, only local host in v1)
- Extensions system
- Docker environments (cut)
- Async context / trace ID propagation in logger (deferred)
- HTTP request logging middleware (deferred)
