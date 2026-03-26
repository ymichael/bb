# Rebuild Plan

Implementation plan for the bb server, host-daemon, and supporting infrastructure. See `plans/architecture.md` for the full architecture and `plans/host-package.md` for the `@bb/workspace` and `@bb/sandbox-host` package designs.

## Start Here

**Phases 1–6 are complete.** All foundation packages, contracts, consumers, host-daemon, sandbox-host stub, and the server are built and merged with full test coverage.

**Next phase: Phase 7** — Integration & QA for persistent-host workflows (server + daemon).

**Then: Phase 8** — Flesh out `@bb/sandbox-host` (real E2B implementation, daemon bundling).

**Phase 9** — Integration & QA for ephemeral-host workflows.

## Current State

Phases 1–6 are complete. The server is built with services layer architecture, authorization hardening, 128 tests, and all Phase 6 plan requirements met. This plan covers what remains.

### What exists today

| Package | State |
|---|---|
| `@bb/config` | **Done** — `envsafe` with scoped exports per consumer. |
| `@bb/logger` | **Done** — pino + pino-roll, per-component log files, rotation. |
| `@bb/domain` | **Done** — entity types, event types, Zod schemas, change kinds (thread/project/environment/system). |
| `@bb/db` | **Done** — schema, migrations, data functions (one per entity), `DbNotifier` with `notifyThread`/`notifyProject`/`notifyEnvironment`/`notifyCommand`/`notifySystem`. 59 tests passing. |
| `@bb/core-ui` | **Done** — view transforms, `formatEnvironmentDisplay(env, isLocalHost)`, timeline formatting. |
| `@bb/host-daemon-contract` | **Done** — 21 commands (17 original + `workspace.list_files`, `workspace.read_file`, `workspace.list_branches`, `provider.list`), session protocol, local API contract. Unknown command types handled gracefully (per-command parsing, error reported to server). |
| `@bb/server-contract` | **Done** — public API routes, discriminated `EnvironmentArgs` union for thread creation, WS protocol. |
| `@bb/workspace` | **Done** — Workspace class, `provisionWorkspace() → IWorkspace`, promote/demote, tested with real git. |
| `@bb/agent-runtime` | Done — provider adapters (codex, claude-code, pi), registry, runtime. Leave as-is. |
| `@bb/templates` | Done — untouched |
| `@bb/ui-core` | Done — shared React components |
| `@bb/tsconfig` | Done — untouched |
| `apps/app` | **Done** — cut over to new contracts, zero type errors, 116 tests passing. Environment selector with Direct/Worktree options. `useHostDaemon` hook for daemon operations. |
| `apps/cli` | **Done** — cut over to new contracts, zero type errors, 67 tests passing. Fetches hostId from daemon, supports env reuse without daemon. |
| `apps/server` | **Done** — Hono on `@hono/node-server`, services layer architecture, authorization hardening, command-and-wait pattern, WS notification hub, sweeps. 128 tests. |
| `apps/host-daemon` | **Done** — daemon skeleton, session management, command routing (21 types, domain-split handlers), event buffering, runtime manager, local API. Uses `p-retry`, `partysocket/ws`, `p-debounce`. 65 tests. |
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

**Auto-title generation.** After thread creation with input, fire-and-forget: clean prompt text → render `generateThreadMetadata` template from `@bb/templates` → call `complete()` from `@mariozechner/pi-ai` with a cheap/fast model (configured via `BB_INFERENCE_MODEL`, default `gpt-4o-mini`) → parse JSON `{ title, branchName }` → update thread title (branchName can be used for managed worktree branch naming). `titleFallback` is derived synchronously from first prompt text (no LLM).

**Timeline transformation.** `GET /threads/:id/timeline` and `/timeline/tool-details` use `toViewMessages()` and `buildTimelineRows()` from `@bb/core-ui`. These are pure functions: read events from DB → transform → return. No daemon involvement. Use `extractThreadContextWindowUsage()` from `@bb/core-ui` for the `contextWindowUsage` field in `ThreadTimelineResponse`.

**Thread output.** `GET /threads/:id/output` returns the last assistant text output. Query the most recent event with assistant text content for the thread, ordered by sequence DESC with a limit — not a full scan of all events.

**Default execution options.** `GET /threads/:id/default-execution-options` returns the last used execution options (model, reasoningLevel, sandboxMode) for the thread. Derived from the most recent `turn.run` command's options stored on the thread's events. Returns null if no turns have been run yet.

### Non-obvious requirements

These are behaviors that aren't obvious from the route definitions alone:

- **Attachments** are stored on the server filesystem at `$BB_DATA_DIR/attachments/<projectId>/`. Max 25MB (10MB for images). Sanitize filenames. Path traversal protection on reads. Clean up on project deletion.
- **Thread rename** triggers a `thread.rename` daemon command in addition to the DB update — so the provider session knows the new title. This applies to both manual renames (PATCH /threads/:id) and auto-generated titles.
- **Default project source.** Routes that aren't scoped to a specific environment or host (e.g., `GET /projects/:id/files`) should resolve the project's default source (the one with `isDefault = true`) to determine which host to query.
- **Disconnected host error.** When a route needs to send a command to a host that is not connected, return a consistent error: `ApiError(502, "host_disconnected", "Host is not connected")`. All daemon-proxied routes should go through the same code path (`queueCommandAndWait`) so this check is centralized.
- **Thread title generation.** When a thread is created with input and no explicit title, generate one asynchronously using `@mariozechner/pi-ai` + the `generateThreadMetadata` template from `@bb/templates`. Set `titleFallback` synchronously from the first prompt text. Don't block thread creation on title generation.
- **Pending input after provisioning.** When `environment.provision` succeeds and the thread has queued input, the server must queue `thread.start` as a follow-up. This happens in the command-result handler, not at thread creation time.
- **Thread creation flow.** Step-by-step:
  1. Create thread record (status `created`), add input as a thread event if provided.
  2. If environment type is `reuse`: attach to existing environment, queue `thread.start` immediately if input was provided.
  3. If environment type is `host` (any workspace type): create environment record (status `provisioning`), queue `environment.provision` command to the daemon.
  4. If environment type is `sandbox-host`: return 501.
  5. On `environment.provision` success (in command-result handler): update environment to `ready`, queue `thread.start` with the input from the thread's input event.
  6. Fire-and-forget: generate title asynchronously. Set `titleFallback` synchronously from first prompt text.
- **Send message mode.** `mode` on `POST /threads/:id/send` controls turn behavior: `auto` (default) — server decides based on thread status (idle → `turn.run`, active → `turn.steer`). `start` — force a new turn (reject if thread is active). `steer` — force steer (reject if thread is idle). For `turn.steer`, the server resolves `expectedTurnId` from the thread's most recent event with a `turnId` — this is a safety guard against steering the wrong turn.
- **Host status derivation.** To compute the `status` field on `Host` responses: query `host_daemon_sessions` for an active session for the hostId where `leaseExpiresAt > now()`. If found → `connected`, otherwise → `disconnected`. Ephemeral hosts (type `ephemeral`) may be `suspended` in Phase 8.
- **Environment cleanup (`maybeCleanupEnvironment`).** After archiving or deleting a thread, check if the thread's environment is managed and now has zero non-archived threads. If so, queue `environment.destroy`. Extract this as a shared function used by both archive and delete flows.
- **Archive guards.** Archiving checks workspace status first — rejects if work could be lost (uncommitted or unmerged changes) unless `force=true`. Stops the thread if active.
- **Thread deletion.** Deleting a thread also calls `maybeCleanupEnvironment` for its environment.

**DB functions to add in Phase 6.** These don't exist yet in `@bb/db` and must be added with tests:
- `unarchiveThread(db, notifier, id)` — clears `archivedAt`
- `updateProjectSource(db, notifier, id, input)` — updates path/repoUrl
- `getDefaultProjectSource(db, projectId)` — returns the source with `isDefault = true`
- Extend `listThreads` to support `type`, `parentThreadId`, `archived` query filters
- `heartbeatSession(db, sessionId, leaseExpiresAt)` — updates `lastHeartbeatAt` and `leaseExpiresAt`

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

**Config additions.** Add to `@bb/config/server`:
- `BB_INFERENCE_MODEL` — format `provider/model` (e.g., `openai/gpt-4o-mini`). Split on `/` for pi-ai's `getModel(provider, modelId)`. Default: `openai/gpt-4o-mini`.
- `OPENAI_API_KEY` — required for voice transcription proxy (and for title generation if using an OpenAI model).

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
- Environments: GET `/environments/:id`
- Threads: GET/POST/PATCH/DELETE `/threads`, `/threads/:id`
- Thread actions: POST archive, unarchive, read, unread (all DB writes via `archiveThread`, `unarchiveThread`, `updateThread`)
- Thread data: GET events, timeline, timeline/tool-details, output (all via `listEvents` + transformation)
- Thread data: GET default-execution-options (derive from thread/project config)
- Drafts: POST/DELETE `/threads/:id/drafts`, `/threads/:id/drafts/:draftId`, POST send
- Attachments: POST `/projects/:id/attachments` (store file), GET `/projects/:id/attachments/content` (serve file)
- Voice: POST `/system/voice-transcription` (proxy to OpenAI Whisper)

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
- GET `/system/models`, `/system/providers` (queues `provider.list_models` / `provider.list`)
- GET `/projects/:id/files` (resolves default project source, queues `workspace.list_files`)
- POST `/projects/:id/managers` (creates manager thread, same flow as thread creation)

These "queue and wait" routes need a synchronous command pattern: queue the command, wait for the daemon to report the result (via the command result handler or a dedicated response channel), and return it to the HTTP client. This is the same pattern for all of them — implement the pattern once (e.g., `queueCommandAndWait(hub, db, command, timeoutMs)`) and reuse it.

**Important: unmanaged workspace provisioning MUST go through the daemon.** The server queues `environment.provision` with mode `unmanaged` — the daemon validates the path exists and discovers git properties. The server must NOT do filesystem I/O directly.

**Routes that return 501:**
- POST `/threads` with `{ type: "sandbox-host" }` — real sandbox-host in Phase 8

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
- [ ] `GET /system/config` → returns server configuration
- [ ] `PATCH /threads/:id` with title change → thread.rename command queued
- [ ] `DELETE /threads/:id` with environment → environment.destroy queued (if managed + no other threads)
- [ ] `POST /threads/:id/drafts/:draftId/send` → turn command queued, draft deleted
- [ ] `POST /projects/:id/managers` → manager thread created with provisioning
- [ ] `POST /environments/:id/actions` squash_merge → workspace.squash_merge queued
- [ ] `POST /environments/:id/actions` demote → workspace.demote queued
- [ ] `POST /threads/:id/send` with mode=auto on idle thread → turn.run queued
- [ ] `POST /threads/:id/send` with mode=steer on active thread → turn.steer queued with expectedTurnId

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
- **Daemon WS disconnect should immediately close the session.** When the daemon's WebSocket disconnects, the server should close the session with reason `"daemon-disconnect"` immediately — don't wait for the lease expiry sweep. This makes daemon restart detection responsive instead of delayed by the sweep interval.
- **No N+1 query patterns.** All data access must use targeted queries with appropriate WHERE clauses and JOINs. Never load all rows and filter in JS. The `@bb/db` data functions already have proper indexes — use them.

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

**Each sub-phase is a separate commit.**

### Organizational framework

The old `qa/` folder organized testing by *owning surface* (server, daemon, environments, providers, CLI, product) with three *pass levels* (smoke, core, recovery). That structure worked well for manual QA but mixed concerns. Phase 7 reorganizes along two axes:

**Axis 1: Automation vs manual.**
- **Automated tests** (vitest) — deterministic, run in CI, no human judgment needed. Both fake and real providers.
- **Manual QA** (standalone server + CLI) — exploratory, provider-specific quirks, visual inspection, scenarios that are hard to automate (timing-dependent behavior, log inspection, process tree behavior).

**Axis 2: Complexity gradient.**
- **Basic flows** — one thread, one environment, one provider at a time. Validates the happy path.
- **Multi-thread, single environment** — sibling threads sharing a workspace. Validates that the daemon's environment-lane routing, event stamping, and environment lifecycle work with shared state.
- **Multi-thread, multiple environments** — concurrent threads in isolated workspaces. Validates that parallel command lanes don't interfere.
- **Multi-provider** — threads with different providers in the same or different environments. Validates that the runtime manager handles multiple adapter processes, events route to correct threads, and no cross-contamination.
- **Recovery** — restart, crash, reconnect, cursor continuity, state convergence after failure.

**Axis 3: Provider reality.**
- **Fake provider** — deterministic, fast, no API keys. Used for all automated structural tests where provider behavior doesn't matter.
- **Real providers** — codex, claude-code, pi. Used for end-to-end validation that real provider processes produce correct events through the full stack. All three are required — credentials are available (see below).

### What we learned from the old qa/ folder

The deleted `qa/` directory contained rich scenario catalogs organized by surface. Key patterns and scenarios we're carrying forward:

**From `qa/e2e/smoke.md`:** The assembled-system smoke test covered project creation → thread spawn → follow-up after idle → one worktree or shared-environment flow → one provider-backed path. This is the minimum confidence check.

**From `qa/env-daemon/core.md`:** Multi-thread scenarios were the highest-value tests. Specifically: two threads in the same environment running follow-ups simultaneously; one completing while the other continues; archiving one sibling while the other works; multi-provider threads in a shared environment with no event cross-contamination. These are the scenarios most likely to find real bugs.

**From `qa/env-daemon/recovery.md`:** Recovery scenarios distinguished between *surviving daemon reconnect* (server restarts, daemon is still alive) and *missing worker* (daemon dies, threads need explicit error state). Also covered: late stale traffic after session replacement, queued work not silently lost, no split-brain control.

**From `qa/environments/core.md`:** Environment lifecycle was richer than just create/destroy. Key flows: worktree promotion/demotion, promote-status reflecting git state, implicit local-environment reuse (two threads automatically attaching to the same environment), archive/unarchive not leaving stale environment state.

**From `qa/server/invariants.md`:** Four durable properties: (1) CLI-visible state always converges to match DB truth, (2) no silent lifecycle skipping (every transition is explicit), (3) restarted thread state remains inspectable, (4) control-plane commands (stop/archive/unarchive) always produce operator-visible outcomes.

**From `qa/env-daemon/invariants.md`:** Five durable properties: (1) at most one live session per thread, (2) active work converges after restart/reconnect, (3) explicit recovery from worker loss (no silent hanging), (4) clean idle → follow-up → session retirement, (5) no silent loss of queued work.

**From `qa/shared/coverage-audit.md`:** Known gaps were: server restart coverage was thin, provider depth beyond smoke was thin, CLI depth beyond basic commands was thin, environment attachment/reuse behavior was under-tested, and regression catalogs weren't normalized. Phase 7 addresses these gaps.

**From `qa/providers/core.md`:** The shared provider test matrix covered: single-turn, multi-turn, context preservation, system instructions, dynamic tools, and error handling. Each provider had an overlay doc for setup quirks and exclusions.

### 7a. Infrastructure

Build the test harness, extract the fake provider, set up the standalone QA workflow, and create assertion helpers. No test scenarios in this sub-phase — just the machinery.

**Package setup:**

```
tests/integration/
  package.json            — @bb/integration-tests, depends on server + daemon + contracts
  tsconfig.json
  vitest.config.ts        — two configs: default (fake provider), real-provider (separate)
  helpers/
    harness.ts            — createIntegrationHarness(), IntegrationHarness type
    assertions.ts         — polling helpers (waitForThreadStatus, waitForEvents, etc.)
    seed.ts               — createTestGitRepo(), createTestFile(), etc.
  fake/
    smoke.test.ts         — 7b: basic lifecycle
    multi-thread.test.ts  — 7c: shared env, multi-env, multi-provider, isolation
    recovery.test.ts      — 7d: restart, crash, reconnect
  real/
    provider-smoke.test.ts — 7e: real provider end-to-end
scripts/qa/
  start-standalone.mjs    — provision standalone server + daemon
  stop-standalone.mjs     — cleanup
```

**Extract fake provider to shared location:**

The fake provider script and adapter in `packages/agent-runtime/src/runtime.test.ts` (lines 15–310) are production-quality test infrastructure. Extract to importable locations:

- `packages/agent-runtime/src/test/fake-provider-script.cjs` — standalone Node.js JSON-RPC server. Supports: `initialize`, `thread/start`, `thread/resume`, `turn/start` (with configurable delay via `call_tool:delay:<ms>` in input), `turn/steer`, `thread/stop`, `thread/name/set`. Emits: `thread/identity`, `turn/started`, `turn/completed`, `item/completed`. Supports tool calls.
- `packages/agent-runtime/src/test/fake-adapter.ts` — `createFakeAdapter(scriptPath): ProviderAdapter`. Exported from package via `@bb/agent-runtime/test` sub-export.
- Update `packages/agent-runtime/src/runtime.test.ts` to import from new location.

**Validation:**
- [ ] `pnpm exec turbo run test --filter=@bb/agent-runtime` still passes
- [ ] Fake adapter is importable from `@bb/agent-runtime/test`

**`IntegrationHarness` type:**

```typescript
interface IntegrationHarness {
  // Server
  server: RunningTestServer
  serverUrl: string
  db: DbConnection
  hub: NotificationHub

  // Daemon
  daemon: HostDaemon
  daemonApp: HostDaemonApp    // runtimeManager, eventBuffer, router, connection
  hostId: string

  // Clients
  api: PublicApiClient        // typed HTTP client from @bb/server-contract
  internal: HostDaemonClient  // typed internal client from @bb/host-daemon-contract

  // Test repo
  repoDir: string             // path to the initialized git repo

  // Lifecycle
  cleanup(): Promise<void>
}

interface CreateHarnessOptions {
  adapterFactory?: (providerId: string) => ProviderAdapter  // default: fake
}
```

**What `createIntegrationHarness(options?)` does:**

1. Creates a temp directory for `BB_DATA_DIR`.
2. Initializes a git repo at `BB_DATA_DIR/repos/test-project/` with sample files (`alpha.txt`, `beta.md`) and an initial commit on `main`. This is the project root for unmanaged workspaces and the source for managed worktrees.
3. Starts the server via `startTestServer()` on a random port (in-memory SQLite, real HTTP + WS).
4. Starts the daemon via `startHostDaemon()` with:
   - `serverUrl` → test server
   - `authToken` → `TEST_AUTH_TOKEN`
   - `dataDir` → temp directory
   - `adapterFactory` → `options.adapterFactory` or the fake provider adapter
   - `enableLocalApi: false`
   - `hostType: "persistent"`
5. Waits for daemon session (poll `GET /hosts` until host appears `connected`, timeout 10s).
6. Creates typed API clients.
7. Returns harness. Cleanup: shutdown daemon → close server → rm temp dir.

**Key design properties:**
- Each test gets its own harness — full isolation.
- In-memory SQLite — fast, no file contention.
- Real HTTP, real WS, real child processes for providers.
- Harnesses can run in parallel (unique ports, unique dirs).
- The `adapterFactory` option allows real providers for 7e tests.

**Assertion helpers:**

```typescript
// Poll until thread reaches target status
waitForThreadStatus(api, threadId, status, timeoutMs = 10_000): Promise<ViewThread>

// Poll until N events exist for a thread
waitForEvents(api, threadId, minCount, timeoutMs = 10_000): Promise<ViewThreadEvent[]>

// Poll until specific event type appears
waitForEventType(api, threadId, eventType, timeoutMs = 10_000): Promise<ViewThreadEvent>

// Poll until host appears connected
waitForHostConnected(api, timeoutMs = 10_000): Promise<ViewHost>

// Poll until host appears disconnected
waitForHostDisconnected(api, hostId, timeoutMs = 10_000): Promise<void>

// Poll until environment reaches target status
waitForEnvironmentStatus(api, envId, status, timeoutMs = 10_000): Promise<ViewEnvironment>

// Wait for a specific command type in the DB
waitForCommand(db, predicate, timeoutMs = 10_000): Promise<QueuedCommand>

// Wait for all commands to complete (no pending/fetched left)
waitForCommandsDrained(db, hostId, timeoutMs = 10_000): Promise<void>
```

All poll at 100ms intervals. Timeouts throw with current vs expected state for debugging.

**Standalone QA scripts** (for manual QA in 7f):

- `scripts/qa/start-standalone.mjs` — allocates random port, creates temp dirs, initializes git repo, starts `node apps/server/dist/index.js`, waits for health check, starts `node apps/host-daemon/dist/index.js`, waits for daemon connection, creates project. Outputs JSON: `{ serverUrl, projectId, hostId, tmpRoot, bbRoot, projectRoot, serverPid, daemonPid, cleanupCommand }`.
- `scripts/qa/stop-standalone.mjs` — kills server + daemon, removes temp dirs.

For diagnostics during manual QA, use the CLI, server API, query the DB directly, and look at the log files for the server / host-daemon.

**Manual QA runbook:**

Write `qa/manual-runbook.md` consolidating the runbook content from 7f below into a standalone document. This is the file a human operator follows when running manual QA. It should include:

- Prerequisites (build commands, provider auth verification)
- Standalone instance setup (start-standalone.mjs) and teardown
- Smoke pass runbook (project create, thread spawn, follow-up, worktree, archive/unarchive)
- Multi-thread and shared environment runbook (sibling threads, interleaved follow-ups, multi-provider)
- Recovery runbook (kill daemon, restart, kill during active turn)
- Provider-specific runbook (single turn, multi-turn, tools, stop mid-turn — for each of codex, claude-code, pi)

The runbook should be self-contained — someone reading only that file can execute the full manual QA pass.

**Validation:**
- [x] `createIntegrationHarness()` starts server + daemon, daemon connects, `waitForHostConnected()` succeeds
- [x] `cleanup()` stops everything, temp dir removed
- [x] `start-standalone.mjs` provisions a working standalone instance, `stop-standalone.mjs` cleans it up
- [x] `qa/manual-runbook.md` exists and covers all manual QA scenarios from 7f
- [x] Smoke, multi-thread, and recovery passes are documented in `qa/manual-pass-log.md`

### 7b. Fake provider — basic lifecycle (smoke + core)

One thread at a time. Validates the happy path end-to-end with the fake provider. This is the smoke pass — if these fail, nothing else matters.

**Test: project and thread creation with unmanaged workspace**

- [ ] `POST /projects` → creates project with source pointing to test repo dir
- [ ] `POST /threads` with `{ type: "host", workspace: { type: "unmanaged", path: repoDir } }` → thread created
- [ ] `waitForThreadStatus(threadId, "idle")` — provision command sent, daemon provisioned, server transitioned
- [ ] `GET /environments/:id` → status `ready`, path matches repo, `isGitRepo: true`
- [ ] Host shows as `connected` in `GET /hosts`

**Test: project and thread creation with managed worktree**

- [ ] `POST /threads` with `{ type: "host", workspace: { type: "managed-worktree" } }` → provisioning begins
- [ ] `waitForThreadStatus(threadId, "idle")`
- [ ] `GET /environments/:id` → status `ready`, `isWorktree: true`, `branchName` set
- [ ] Worktree directory exists on disk and is a valid git worktree (verify with `git worktree list`)

**Test: send message → provider runs → events flow back**

- [ ] `POST /threads/:id/send` with `{ content: "hello" }` on idle thread → 200
- [ ] `waitForThreadStatus(threadId, "active")` → turn.run dispatched, provider started
- [ ] `waitForThreadStatus(threadId, "idle")` → provider completed, thread settled
- [ ] `GET /threads/:id/events` → contains `turn/started` and `turn/completed`
- [ ] Events have correct `threadId`, monotonically increasing `sequence`, valid `turnId`
- [ ] `GET /threads/:id/timeline` → non-empty timeline data

**Test: follow-up after idle (new turn, not steer)**

- [ ] Send first message, wait for idle
- [ ] Send second message with `mode: "auto"` → queues `turn.run` (thread was idle)
- [ ] Wait for idle
- [ ] Events contain two complete turns (two `turn/started`, two `turn/completed`)
- [ ] Second turn has different `turnId` from first

**Test: stop active thread**

- [ ] Send message, wait for `active`
- [ ] `POST /threads/:id/stop` → 200
- [ ] `waitForThreadStatus(threadId, "idle")`
- [ ] Events include `turn/completed` with interrupted/stopped status

**Test: workspace status, diff, branches**

- [ ] Thread with provisioned environment: `GET /environments/:id/status` → workspace status (clean, branch info)
- [ ] `GET /environments/:id/diff` → diff result (empty if clean)
- [ ] `GET /environments/:id/diff/branches` → branch list includes `main`

**Test: workspace commit**

- [ ] Write a test file to workspace path (`fs.writeFile`)
- [ ] `GET /environments/:id/status` → workspace is dirty
- [ ] `POST /environments/:id/actions` with `{ action: "commit", message: "test commit" }` → success
- [ ] `GET /environments/:id/status` → workspace is clean
- [ ] `git log` on workspace shows the commit

**Test: worktree promote and demote**

- [ ] Create thread with managed worktree, wait for idle
- [ ] Write a file, commit it on the worktree branch
- [ ] `POST /environments/:id/actions` with `{ action: "promote" }` → merges worktree branch into main
- [ ] Verify main branch in the source repo contains the new commit
- [ ] `POST /environments/:id/actions` with `{ action: "demote" }` → resets worktree branch to main
- [ ] `GET /environments/:id/status` → clean

**Test: archive and unarchive**

- [ ] `POST /threads/:id/archive` → archived
- [ ] `GET /threads/:id` → `archivedAt` set
- [ ] `POST /threads/:id/send` → rejected (thread is archived)
- [ ] `POST /threads/:id/unarchive` → unarchived
- [ ] `GET /threads/:id` → `archivedAt` null
- [ ] `POST /threads/:id/send` → accepted, turn completes

**Test: archive managed worktree triggers environment cleanup**

- [ ] Create thread with managed worktree, wait for idle
- [ ] Note environment path on disk
- [ ] `POST /threads/:id/archive`
- [ ] `waitForCommand(db, cmd => cmd.type === "environment.destroy")` → destroy queued
- [ ] Wait briefly, verify worktree directory removed

**Test: thread deletion cleans up**

- [ ] Create thread with unmanaged workspace, wait for idle, send a message, wait for idle
- [ ] `DELETE /threads/:id` → 200
- [ ] `GET /threads/:id` → 404

**Test: environment reuse (type: "reuse")**

Validates the `reuse` thread creation mode — attaching a new thread to an existing environment without provisioning.

- [ ] Create first thread with unmanaged workspace, wait for idle
- [ ] Note the `environmentId`
- [ ] `POST /threads` with `{ type: "reuse", environmentId }` → new thread created, immediately idle (no provisioning)
- [ ] Both threads share the same `environmentId`
- [ ] Send message on second thread → completes successfully

### 7c. Fake provider — multi-thread scenarios

Multiple threads running through the same daemon. These are the scenarios the old `qa/env-daemon/core.md` identified as highest-value: sibling behavior, shared environments, and provider isolation.

**Test: two threads, same environment, same provider**

The core shared-environment scenario. Two threads attached to the same workspace, both using the fake provider.

- [ ] Create first thread with unmanaged workspace, wait for idle
- [ ] Create second thread via `{ type: "reuse", environmentId }`, wait for idle
- [ ] Send messages to both threads concurrently (`Promise.all`)
- [ ] Both threads go active, both return to idle
- [ ] Events for thread A have only thread A's `threadId` — no cross-contamination
- [ ] Events for thread B have only thread B's `threadId`
- [ ] Both threads' events have valid, non-overlapping `turnId` values

**Test: two threads, same environment — interleaved follow-ups**

- [ ] Create two threads sharing an environment
- [ ] Send message to thread A, wait for idle
- [ ] Send message to thread B, wait for idle
- [ ] Send follow-up to thread A, wait for idle
- [ ] Send follow-up to thread B, wait for idle
- [ ] Each thread has exactly two complete turns
- [ ] No events leak between threads

**Test: archive one sibling, other continues working**

- [ ] Create two threads sharing an environment
- [ ] Send message to both, wait for both idle
- [ ] Archive thread A
- [ ] Send message to thread B → succeeds, completes normally
- [ ] Environment is NOT destroyed (thread B still exists)

**Test: archive all siblings in managed worktree → environment destroyed → unarchive reprovisions**

- [ ] Create thread A with managed worktree, wait for idle
- [ ] Create thread B via reuse, wait for idle
- [ ] Archive thread A
- [ ] Archive thread B → environment has zero non-archived threads
- [ ] `waitForCommand(db, cmd => cmd.type === "environment.destroy")` → destroy queued
- [ ] Unarchive thread A
- [ ] Send message to thread A → should trigger reprovisioning (new environment)
- [ ] `waitForThreadStatus(threadA.id, "idle")` → thread works in new environment

**Test: two threads, different environments, same provider**

Concurrent threads in isolated workspaces. Validates environment-lane isolation in the daemon's command router.

- [ ] Create thread A with unmanaged workspace (repo dir A)
- [ ] Create thread B with unmanaged workspace (repo dir B — separate git repo)
- [ ] Send messages to both concurrently
- [ ] Both complete successfully
- [ ] Write different files to each workspace, commit each
- [ ] Each workspace has only its own commit

**Test: two threads, same environment, different providers**

Validates the runtime manager handles multiple adapter processes correctly and events don't cross-contaminate.

- [ ] Create `fakeFastAdapter` and `fakeSlowAdapter` — two fake adapters with different `id` values (e.g., "fake-alpha" and "fake-beta"). Both use the same fake provider script but with distinct adapter IDs.
- [ ] Set `adapterFactory` to return the appropriate adapter based on `providerId`
- [ ] Create thread A with `providerId: "fake-alpha"`, wait for idle
- [ ] Create thread B with `{ type: "reuse", environmentId }` and `providerId: "fake-beta"`, wait for idle
- [ ] Send messages to both concurrently
- [ ] Both complete, events are correctly stamped with respective `threadId`
- [ ] The daemon's `runtimeManager` has two separate runtime entries (one per provider process)

**Test: three threads — stress test for daemon routing**

A higher-cardinality test to validate the daemon handles realistic concurrency.

- [ ] Create three threads: two sharing environment A, one in environment B
- [ ] Send messages to all three concurrently
- [ ] All three complete
- [ ] Verify event correctness for each thread
- [ ] Verify the daemon processed commands in environment lanes (environment A commands serialized, environment B independent)

**Test: two isolated instances run concurrently (multi-instance isolation)**

Validates the standalone-instance isolation property — two completely independent bb stacks don't interfere.

- [ ] Create two harnesses (separate ports, separate data dirs, separate DBs)
- [ ] On each, in parallel:
  - Create project
  - Create thread with unmanaged workspace
  - Wait for idle, send message, wait for idle
  - Write unique file, commit with unique message
- [ ] Each instance's DB has exactly one thread (no cross-contamination)
- [ ] Each instance's `GET /hosts` returns exactly one host
- [ ] Different `hostId` values
- [ ] Each workspace has only its own commit

### 7d. Fake provider — recovery

Restart, crash, reconnect, and state convergence. Uses fake provider for determinism. These tests have longer timeouts (30s) because they involve shutdown/startup cycles.

**Test: graceful daemon shutdown → restart → session resumes**

- [ ] Create harness, create thread, send message, wait for idle
- [ ] `daemonApp.daemon.shutdown()` → graceful shutdown (flushes events, releases lock)
- [ ] `waitForHostDisconnected(api, hostId)` → server detects WS close, session closed
- [ ] Start new daemon against same `BB_DATA_DIR` and server (reuses persisted `hostId`)
- [ ] `waitForHostConnected(api)` → new session, same `hostId`
- [ ] Send message on existing thread → `waitForThreadStatus(idle)` → thread still works

**Test: daemon crash (ungraceful) → server detects → restart**

- [ ] Create harness, create thread, send message, wait for idle
- [ ] Simulate crash: destroy daemon's WS socket without calling shutdown
- [ ] Server detects WS disconnect immediately (daemon-disconnect handler), closes session
- [ ] Start new daemon against same data dir
- [ ] `waitForHostConnected(api)` → new session
- [ ] Send message on thread → completes normally

**Test: daemon dies with active thread → thread errors → resumable after restart**

- [ ] Create harness, send message, wait for `active` (turn running)
- [ ] Shutdown daemon while thread is active
- [ ] Server detects disconnect → thread transitions to `error`
- [ ] `waitForThreadStatus(threadId, "error")`
- [ ] Start new daemon
- [ ] `POST /threads/:id/send` with new input → thread goes active → idle
- [ ] Events show the interrupted turn and the new completed turn

**Test: cursor continuity after restart**

- [ ] Create harness, send message, wait for idle
- [ ] Read persisted cursor from `BB_DATA_DIR/command-cursor`
- [ ] Cursor > 0 (commands were processed)
- [ ] Shutdown daemon, start new daemon
- [ ] Send another message, wait for idle
- [ ] No duplicate command processing: each command in DB has exactly one `success` result
- [ ] New cursor > old cursor

**Test: event high-water marks after reconnect — no duplicates**

- [ ] Create harness, send message, wait for events
- [ ] Count events for the thread
- [ ] Shutdown daemon, start new daemon
- [ ] Send another message, wait for idle
- [ ] `GET /threads/:id/events` → total events = previous + new turn. Sequence numbers are monotonically increasing with no gaps or duplicates

**Test: reconciliation — daemon reports active threads on session open**

- [ ] Create harness, create two threads, send messages to both, wait for both idle
- [ ] Shutdown daemon
- [ ] Manually transition one thread to `error` in DB (simulating server-side staleness)
- [ ] Start new daemon — session open includes reconciliation
- [ ] The errored thread that the daemon knows is idle should remain in its current state (daemon has no active thread for it)
- [ ] Verify no spurious state transitions

**Test: queued work not silently lost**

From old `qa/env-daemon/invariants.md`: queued follow-up work must not be silently lost during recovery.

- [ ] Create harness, create thread, send message, wait for idle
- [ ] Send a second message (queues turn.run command)
- [ ] Immediately shutdown daemon before command is fetched
- [ ] Start new daemon
- [ ] The queued command should be fetched and executed by the new daemon
- [ ] `waitForThreadStatus(threadId, "idle")` → turn completed
- [ ] Events include the second turn

**Test: stale traffic after session replacement is ignored**

From old `qa/env-daemon/recovery.md`: late traffic from an old daemon session must not mutate state.

- [ ] Create harness, create thread, send message, wait for idle
- [ ] Record the current session ID
- [ ] Shutdown daemon, start new daemon (new session ID)
- [ ] Verify old session is closed in DB
- [ ] Any events or command results referencing the old session ID should be rejected by the server
- [ ] Thread state reflects only the new session's work

### 7e. Real provider — end-to-end

Real providers running through the full stack: server → daemon → provider process → events → back to server → API response. These tests are slower and non-deterministic, but they catch integration issues that fake providers can't: real process lifecycle, real event formats, real streaming behavior, real tool execution.

**All three providers are required.** Credentials are available in this checkout:

- **Codex:** `OPENAI_API_KEY` in `.env` + `~/.codex/auth.json` on disk. Binary at `~/.bun/bin/codex`.
- **Claude Code:** `CLAUDE_CODE_OAUTH_TOKEN` in `.env`. Uses the Claude Agent SDK bridge (no external binary).
- **Pi:** `~/.pi/agent/auth.json` on disk. Binary at `/opt/homebrew/bin/pi`.

The harness must load `.env` from the project root (e.g., via `dotenv`) so that `OPENAI_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` are available in the daemon's environment. The daemon spawns provider child processes — these inherit the daemon's env, so the keys propagate automatically.

**Test configuration:** Uses `createIntegrationHarness({ adapterFactory: undefined })` — no adapter override, so the daemon uses the real provider registry. The daemon resolves adapters from the installed provider binaries.

**Timeouts:** Real providers are slower. Use 60s for turn completion, 120s per test.

**For each provider (codex, claude-code, pi), run:**

**Test: single turn end-to-end**

- [ ] Create project and thread with unmanaged workspace
- [ ] `POST /threads/:id/send` with `{ content: "Say exactly: hello world" }`
- [ ] `waitForThreadStatus(threadId, "idle", 60_000)` → turn completes
- [ ] `GET /threads/:id/events` → contains `turn/started` and `turn/completed`
- [ ] `GET /threads/:id/timeline` → timeline has at least one assistant message
- [ ] `GET /threads/:id/output` → non-empty output text

**Test: multi-turn end-to-end**

- [ ] Create thread, send first message, wait for idle
- [ ] Send follow-up message, wait for idle
- [ ] Events contain two complete turns
- [ ] Second turn's events reference the same thread

**Test: stop mid-turn**

- [ ] Send a message that will take a while (e.g., "Write a detailed essay about the history of computing")
- [ ] Wait for `active`
- [ ] `POST /threads/:id/stop`
- [ ] `waitForThreadStatus(threadId, "idle", 30_000)` → thread stopped
- [ ] Thread is in a recoverable state (can send new messages after stop)

**Test: workspace interaction with real provider**

Real providers may or may not modify files, but we can verify the workspace plumbing works:

- [ ] Create thread with managed worktree
- [ ] Wait for idle (provisioning works with real daemon)
- [ ] `GET /environments/:id/status` → returns valid workspace status
- [ ] `GET /environments/:id/diff/branches` → returns branches
- [ ] Send a coding task (e.g., "Create a file called hello.txt with the content 'hello world'")
- [ ] Wait for idle
- [ ] `GET /environments/:id/status` → may show changes if provider wrote files

**Test: two real providers concurrently**

- [ ] Create two threads in different environments — one with codex, one with claude-code
- [ ] Send messages to both concurrently
- [ ] Both complete without interference
- [ ] Events are correctly stamped per-thread

**Test: all three providers sequentially**

- [ ] For each of codex, claude-code, pi: create thread, send message, wait for idle, verify events
- [ ] All three succeed
- [ ] Validates that the full adapter registry works end-to-end

### 7f. Manual QA — standalone workflow and runbook

Scenarios that benefit from human judgment, exploratory testing, or CLI-driven interaction. Uses the standalone server + daemon provisioned by `scripts/qa/start-standalone.mjs`.

**Standalone setup:**

```bash
# Build all packages
pnpm exec turbo run build --filter=@bb/server --filter=@bb/host-daemon --filter=@bb/cli

# Start standalone instance
node scripts/qa/start-standalone.mjs
# → outputs: serverUrl, projectId, hostId, daemonPid, serverPid, paths

# Set environment
export BB_SERVER_URL=http://127.0.0.1:<port>
alias bb="node apps/cli/dist/index.js"
```

**Runbook: Smoke pass** (5-10 minutes, run after any server/daemon change)

```
1. Verify health
   bb server health

2. Spawn thread (unmanaged, direct workspace)
   bb thread spawn <projectId> --provider codex "Say hello"
   bb thread wait <threadId> --status idle --timeout 90
   bb thread show <threadId>
   bb thread output <threadId>
   ✓ Thread reaches idle, output is visible

3. Follow-up after idle
   bb thread tell <threadId> "Now say goodbye"
   bb thread wait <threadId> --status idle --timeout 90
   bb thread output <threadId>
   ✓ Second turn completes, output reflects follow-up

4. Spawn worktree thread
   bb thread spawn <projectId> --workspace-type managed-worktree --provider codex "Create a test file"
   bb thread wait <threadId> --status idle --timeout 120
   bb thread show <threadId>
   ✓ Thread reaches idle, environment shows isWorktree=true

5. Archive and unarchive
   bb thread archive <threadId>
   bb thread show <threadId>  # archivedAt set
   bb thread tell <threadId> "test"  # should fail
   bb thread unarchive <threadId>
   bb thread tell <threadId> "Say something"
   bb thread wait <threadId> --status idle --timeout 90
   ✓ Archive blocks work, unarchive restores it
```

**Runbook: Multi-thread and shared environment** (15-20 minutes)

```
1. Two threads, same environment (implicit local reuse)
   bb thread spawn <projectId> --provider codex "Thread A: say hello"
   bb thread wait <threadA> --status idle
   bb thread spawn <projectId> --provider codex "Thread B: say world"
   bb thread wait <threadB> --status idle
   ✓ Compare environmentId on both threads (bb thread show) — should match

2. Interleaved follow-ups
   bb thread tell <threadA> "Follow up A"
   bb thread tell <threadB> "Follow up B"
   bb thread wait <threadA> --status idle
   bb thread wait <threadB> --status idle
   ✓ Both complete, outputs are distinct

3. Archive sibling
   bb thread archive <threadA>
   bb thread tell <threadB> "Still working"
   bb thread wait <threadB> --status idle
   ✓ Thread B works after A is archived

4. Multi-provider
   bb thread spawn <projectId> --provider codex "Codex thread"
   bb thread spawn <projectId> --provider claude-code "Claude thread"
   bb thread wait <threadA> --status idle
   bb thread wait <threadB> --status idle
   ✓ Both complete, no event cross-contamination (check bb thread log for each)

5. Worktree promotion
   bb thread spawn <projectId> --workspace-type managed-worktree --provider codex "Write a file"
   bb thread wait <threadId> --status idle
   bb environment promote-status <envId>
   bb environment promote <envId>
   bb environment demote <envId>
   ✓ Promote-status reflects git state, promote/demote succeed
```

**Runbook: Recovery** (20-30 minutes)

```
1. Kill daemon, verify server detects it
   kill <daemonPid>
   bb server health  # server still up
   bb thread show <threadId>  # thread may show error if was active
   ✓ Server detects daemon loss, thread state is explicit

2. Restart daemon
   node apps/host-daemon/dist/index.js  # with same BB_DATA_DIR, BB_SERVER_URL
   bb thread show <threadId>  # host reconnected
   bb thread tell <threadId> "Resume"
   bb thread wait <threadId> --status idle
   ✓ Thread resumes after daemon restart

3. Kill daemon during active turn
   bb thread tell <threadId> "Write a very detailed analysis of..."
   # Wait a few seconds for active status
   kill <daemonPid>
   bb thread show <threadId>  # should transition to error
   # Restart daemon
   bb thread tell <threadId> "Continue"
   bb thread wait <threadId> --status idle
   ✓ Interrupted thread recovers

4. Inspect thread state for diagnostics
   bb thread show <threadId>
   bb thread log <threadId>
   bb thread output <threadId>
   ✓ Thread state, events, and output are inspectable via CLI
```

**Runbook: Provider-specific** (per provider, 10 minutes each)

For each provider (codex, claude-code, pi):

```
1. Single turn
   bb thread spawn <projectId> --provider <providerId> "Say hello"
   bb thread wait <threadId> --status idle --timeout 120
   bb thread output <threadId>
   ✓ Output is coherent

2. Multi-turn with context
   bb thread tell <threadId> "What did I just ask you?"
   bb thread wait <threadId> --status idle
   bb thread output <threadId>
   ✓ Provider remembers context from first turn

3. Dynamic tools (if provider supports)
   bb thread spawn <projectId> --provider <providerId> "Create a file called test.txt"
   bb thread wait <threadId> --status idle
   ✓ Provider used tools, workspace has changes

4. Stop mid-turn
   bb thread tell <threadId> "Write a very long essay..."
   # Wait for active
   bb thread stop <threadId>
   bb thread show <threadId>
   ✓ Thread returns to idle/error, not stuck
```

### Timeout strategy

| Context | Polling interval | Default timeout |
|---|---|---|
| Fake provider: status transitions | 100ms | 10s |
| Fake provider: environment provisioning | 100ms | 15s |
| Fake provider: daemon connection | 100ms | 10s |
| Fake provider: test timeout (vitest) | — | 60s |
| Recovery tests: reconnection | 100ms | 30s |
| Real provider: turn completion | 200ms | 60s |
| Real provider: test timeout (vitest) | — | 120s |
| Manual QA: CLI `--timeout` | — | 90-120s |

Timeouts configurable via `BB_TEST_TIMEOUT_SCALE` env var (multiplier, default 1).

### Invariants to verify across all test types

These are the durable properties from the old QA invariants docs. Every test scenario should implicitly validate these:

**Server invariants:**
1. **State convergence.** Thread status visible via API always matches the DB truth. No stale reads after a transition completes.
2. **No silent lifecycle skipping.** Every thread transition (created → provisioning → idle → active → idle, or → error) is explicit and observable.
3. **Inspectability.** After any restart or failure, thread state is inspectable — never stuck in an ambiguous state.
4. **Control-plane correctness.** Stop, archive, unarchive always produce visible outcomes.

**Daemon invariants:**
1. **At most one live session per thread.** No split-brain — one daemon, one session, one provider process per thread.
2. **Active work convergence.** After restart/reconnect, active threads either continue or converge to explicit error.
3. **Explicit worker loss.** If a provider process dies, the thread transitions to error — never silently hangs.
4. **Clean follow-up retirement.** Idle → follow-up → active → idle cycle always completes, session is clean afterward.
5. **No silent loss of queued work.** Commands queued before a crash are re-fetched after restart.

### Exit criteria

Phase 7 is complete when:

1. **Fake provider tests (7b–7d):** All pass. Deterministic — 5 consecutive green runs with no flakes. Run in under 3 minutes total.
2. **Real provider tests (7e):** All three providers (codex, claude-code, pi) pass. These are required, not optional — credentials are available.
3. **Standalone QA scripts (7f):** `start-standalone.mjs` and `stop-standalone.mjs` work. All three runbooks (smoke, multi-thread, recovery) have been executed manually at least once with at least one real provider and documented as passing.
4. **No regressions:** Existing tests in `@bb/agent-runtime`, `apps/server`, and `apps/host-daemon` continue to pass.
5. **Fake provider extraction** doesn't break existing agent-runtime tests.

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
