# Rebuild Plan

Implementation plan for the bb server, host-daemon, and supporting infrastructure. See `plans/architecture.md` for the full architecture, data model, protocol specs, and command flow examples.

## Context

The old server, environment-daemon, environment, core, and api-contract packages have been deleted. The contract packages (`@bb/domain`, `@bb/server-contract`, `@bb/env-daemon-contract`) have been consolidated. This plan rebuilds the backend from those contracts.

### What exists today

| Package | State |
|---|---|
| `@bb/config` | **Done** (Phase 1a) — `envsafe` with scoped exports per consumer. |
| `@bb/logger` | **Done** (Phase 1b) — pino + pino-roll, per-component log files, rotation. |
| `@bb/domain` | **Done** (Phase 1c) — entity types, event types, Zod schemas. Renames complete, View* naming, slim types. |
| `@bb/db` | **Done** (Phase 1d) — clean-slate schema, drizzle-kit migration, ID generation. |
| `@bb/core-ui` | **Done** (Phase 1e) — view transforms updated for domain renames. |
| `@bb/host-daemon-contract` | **Done** (Phase 2b) — 16 commands, session protocol, HostDaemon* naming, typed results. Needs updates: add `workspacePath` to thread.start/resume, add `isGitRepo` to provision result, add `threadHighWaterMarks` to session open response, replace export/import/reattach with promote/demote. |
| `@bb/server-contract` | **Done** (Phase 2a) — public API routes, WS protocol, type renames. |
| `@bb/workspace` | **Done** (Phase 3) — Workspace class, provisioning, promote/export/import, tested with real git. |
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

Rename from `env-daemon-contract`. Simplified session protocol. 16 commands including workspace operations (`workspace.status`, `workspace.diff`, `workspace.commit`, `workspace.squash_merge`, `workspace.reset`, `workspace.checkpoint`, `workspace.promote`, `workspace.demote`).

See `plans/architecture.md` "Host-Daemon Protocol" for full spec.

**Validation:**
- [ ] All schemas parse valid/invalid data correctly
- [ ] Hono typed client works

### 2a. Update `@bb/server-contract` (after 2b)

Route renames, type renames, new routes, WebSocket protocol changes. See `plans/architecture.md` "Route Renames" and "Type Renames".

**Validation:**
- [ ] `createPublicApiClient()` and `createInternalApiClient()` typed correctly
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
- [ ] `checkoutBranch()` / `detachHead()` / `stash()` / `stashPop()` — the promote primitives
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

### 3c. Promote/demote via export/import

Promote is server-orchestrated between two daemons. The `@bb/workspace` package provides the building blocks, not the orchestration.

**Export** (called on the source workspace's host):
```typescript
// Source daemon detaches the worktree and returns changeset info
async function exportWorkspace(workspace: Workspace): Promise<WorkspaceExport> {
  const branch = await workspace.currentBranch;
  await workspace.detachHead();
  return { type: "branch", branch };
}
// For cross-machine: checkpoint first, then export with remote info
```

**Import** (called on the target/primary checkout's host):
```typescript
// Target daemon applies the changeset to the primary checkout
async function importWorkspace(primary: Workspace, exportData: WorkspaceExport): Promise<ImportResult> {
  if (await primary.getStatus().then(s => s.hasChanges)) throw new Error("primary has uncommitted changes");
  if (exportData.remote) await primary.fetch({ remote: exportData.remote, branch: exportData.branch });
  const previousBranch = await primary.currentBranch;
  await primary.checkoutBranch(exportData.branch);
  return { previousBranch };
}
```

**Testing:**
- [ ] Export detaches worktree HEAD, returns branch info
- [ ] Import fails loudly if primary has uncommitted changes
- [ ] Import switches branch when primary is clean
- [ ] Import with remote: fetches before switching
- [ ] Demote (import back to original branch) works
- [ ] Promoted state derived: check primary's current branch matches an env branch

---

## Phase 4: `apps/host-daemon`

The daemon is the most complex component — session management, reconnection, command routing, AgentRuntime lifecycle. Build modules with injectable dependencies (HTTP client, WS factory) so each can be unit tested in isolation. Integration tests run the real daemon against a real server instance.

### 4a. Daemon skeleton + identity

```
apps/host-daemon/src/
  index.ts            -- entrypoint: validate config → acquire lock → create logger → read identity → start daemon
  daemon.ts           -- main lifecycle (session, command loop, shutdown)
  identity.ts         -- $BB_DATA_DIR/host-id (read or create), OS hostname via scutil/hostname
```

**Startup sequence:** (1) validate config (fail fast if env vars missing), (2) acquire file lock on `$BB_DATA_DIR/daemon.lock` using `proper-lockfile` with stale detection (10s) — exit immediately with code 1 if held, (3) create logger, (4) read or create `$BB_DATA_DIR/host-id` (persisted UUID), (5) generate ephemeral `instanceId` via `crypto.randomUUID()`, (6) start daemon (session open → WS → command loop).

**Shutdown:** On SIGTERM/SIGINT: flush event buffer (single attempt, 5s timeout), shutdown all AgentRuntime instances, release file lock, exit 0. Buffered events that fail to flush are lost (accepted — server handles sequence gaps).

**Validation:**
- [ ] Lock prevents second instance, exits with clear error message
- [ ] host-id persisted and stable across restarts
- [ ] Clean shutdown flushes events and releases lock

### 4b. Session management

```
apps/host-daemon/src/
  session.ts          -- ServerConnection class: HTTP client + WS + reconnection
  command-cursor.ts   -- persist/read $BB_DATA_DIR/command-cursor (atomic write-to-temp-then-rename)
  event-buffer.ts     -- in-memory buffer, flush to server, track acks
```

**ServerConnection** manages the full server relationship:

**Session open:** `POST /internal/session/open` with `{ hostId, instanceId, hostName, hostType, protocolVersion, activeThreads }`. Server returns `{ sessionId, heartbeatIntervalMs, leaseTimeoutMs, threadHighWaterMarks }`. Store sessionId for all subsequent requests. The `threadHighWaterMarks` (per-thread max event sequence on the server) are used to initialize event sequence counters — new events start from `highWaterMark + 1`. The `activeThreads` array is populated from the runtime manager (Phase 4c) if available, or `[]` on fresh startup (all processes died). ServerConnection accepts an optional `getActiveThreads` callback injected by the daemon lifecycle so 4b doesn't depend on 4c's data structures.

**WS connection:** `${BB_SERVER_URL.replace('http', 'ws')}/internal/ws?sessionId={sessionId}&token={BB_SECRET_TOKEN}`. Opened after successful session open. On message: if `commands-available`, trigger command fetch. If `session-close`, shut down (another instance took over).

**Heartbeat:** `setInterval` at server-provided `heartbeatIntervalMs`. Sends `{ type: "heartbeat", bufferDepth, lastCommandCursor }` over WS. Does not reset on other activity. If `ws.send()` throws, clear interval and start reconnection.

**Reconnection:** Daemon-driven, exponential backoff: base 1s, multiplier 2x, max 30s, jitter ±25% (`delay = min(1000 * 2^attempt, 30000) * (0.75 + Math.random() * 0.5)`). Reset attempt counter on successful WS open. If WS down >5s, fall back to polling `GET /internal/session/commands?afterCursor={N}` every ~10s. On WS reconnect, fetch from last cursor and stop polling.

**Event buffer:** In-memory only (lost on crash). Flush triggered by: (a) 100ms debounce after last event, or (b) buffer reaching 50 events, whichever first. Each flush POSTs the full buffer to `/internal/session/events`. On success, discard events at or below per-thread high-water marks from ack. On HTTP failure, retain and retry on next flush. Max buffer: 1000 events; oldest dropped with warning log if exceeded.

**Command cursor:** File `$BB_DATA_DIR/command-cursor` containing a single integer as UTF-8 text (e.g., `42\n`). Atomic write: `writeFile(path + '.tmp', ...)` then `rename(path + '.tmp', path)`. Read on startup: `parseInt(readFile(path))` or 0 if missing. Written after successfully reporting a command result (not after fetching).

**Command result delivery:** After executing a command, the daemon POSTs the result to the server with retry (exponential backoff, same as reconnection). The cursor is advanced only after a successful POST. If the server is temporarily unreachable, the daemon retries until it succeeds. If the daemon crashes before the POST succeeds, the cursor wasn't advanced — the command is re-fetched and re-executed on restart (at-least-once, commands are idempotent).

**Validation:**
- [ ] Opens session, receives sessionId, starts WS + heartbeat
- [ ] WS disconnect triggers reconnection with backoff
- [ ] Falls back to polling when WS is down >5s
- [ ] Command cursor survives process restart (write to disk, read on startup)
- [ ] Event buffer flushes, server ack discards acked events
- [ ] Reports activeThreads on session open for reconciliation

### 4c. Command routing + AgentRuntime

```
apps/host-daemon/src/
  command-router.ts   -- fetch commands, dispatch by type, sequential per-environment
  runtime-manager.ts  -- Map<environmentId, { runtime, workspace, path }>, lazy creation
```

**Runtime manager:** Maintains `Map<environmentId, { runtime: AgentRuntime, workspace: Workspace, path: string }>`. Entries created lazily:
- For `environment.provision`: entry created when provisioning completes (daemon learns the path from the provisioning result).
- For `thread.start` / `thread.resume`: these commands must include `workspacePath` in their payload so the daemon can create the runtime. (This requires adding `workspacePath: z.string()` to the `thread.start` and `thread.resume` command schemas in `@bb/host-daemon-contract`.)
- For all other commands: entry must already exist. If not, report error result with `unknown-environment`.

**AgentRuntime creation:**
```typescript
createAgentRuntime({
  workspacePath: entry.path,
  env: {},  // provider API keys inherited from process.env by the runtime
  onEvent: (event) => eventBuffer.push(environmentId, threadId, event),
  onToolCall: (req) => serverConnection.postToolCall({ ...req, sessionId }),
  onProcessExit: (info) => log.warn("provider process exited", info),
})
```

**Event sequence numbering:** The daemon assigns per-thread monotonically increasing sequence numbers. The daemon maintains `Map<threadId, number>` as the next sequence counter. On startup, the daemon initializes these from `threadHighWaterMarks` in the session open response — new events start from `highWaterMark + 1`. During normal operation, the event ack response also returns high-water marks (used to prune the buffer). This prevents post-restart sequence collisions with the server's `(threadId, sequence)` dedup.

**Command processing:**

- **Workspace/environment commands** (`workspace.*`, `environment.*`): dispatched to a per-environment async queue (one at a time via `await`, never sync-blocking). These touch the filesystem and must not run concurrently with each other.
- **Provider commands** (`thread.*`, `turn.*`, `provider.*`): dispatched directly to `AgentRuntime`, which manages concurrent threads internally. Multiple threads on the same environment can run turns concurrently — they're independent child processes.

**No sync blocking anywhere.** All I/O in the daemon is async (`execFile` not `execFileSync`, `fs.promises` not `fs.*Sync`). The event loop must never block — session heartbeats, event buffer flushes, and command fetches all continue while commands execute.

**Command dispatch:**
```
# Provider lane (concurrent per-thread)
thread.start       → runtimeManager.ensureRuntime(envId, workspacePath) → runtime.startThread(...)
thread.resume      → runtimeManager.ensureRuntime(envId, workspacePath) → runtime.resumeThread(...)
turn.run           → runtimeManager.ensureRuntime(envId, workspacePath) → runtime.runTurn(...)
turn.steer         → runtime.steerTurn(...)
thread.stop        → runtime.stopThread(...)
thread.rename      → runtime.renameThread(...)
provider.list_models → listAvailableProviders() from @bb/agent-runtime (no runtime instance needed)

# Workspace lane (serialized, blocks provider lane)
workspace.*          → workspace.method(...)
workspace.promote    → checks both clean, detachHead on source, checkoutBranch on primary
workspace.demote     → checks primary clean, checkoutBranch(default) on primary, checkoutBranch(env) on source
environment.provision → createWorktree()/createClone() + runSetupScript() → runtimeManager.register(envId, path)
environment.destroy   → runtimeManager.destroy(envId) → removeWorktree()/removeDirectory()
```

`turn.run` also calls `ensureRuntime` — if the daemon restarted and this is the first command for a thread, the runtime is lazily created and `resumeThread` is called before running the turn. This handles idle thread recovery without requiring the server to proactively queue `thread.resume` for every idle thread.

After each command completes, store result in pending buffer → POST to server → on success, remove from buffer and advance cursor on disk.

**Validation:**
- [ ] Commands routed to correct runtime/workspace by environmentId
- [ ] Runtime created lazily on first command for an environment
- [ ] Sequential execution per-environment (concurrent across environments)
- [ ] Provider events flow through buffer to server with correct sequence numbers
- [ ] Tool calls route through server and return response to provider
- [ ] Command results reported, cursor persisted after each
- [ ] Unknown environmentId returns error result
- [ ] Replayed commands (idempotent) don't duplicate side effects

### 4d. Daemon restart

```
apps/host-daemon/src/
  restart.ts          -- self-relaunch: spawn new instance (detached), exit
```

**Mechanism:** Spawn `process.argv[0]` with `process.argv.slice(1)` via `child_process.spawn({ detached: true, stdio: 'ignore', env: process.env })`. Call `child.unref()`. Release file lock explicitly. Exit with `process.exit(0)`. New process acquires lock (retry with 5s timeout, polling every 100ms to handle race window).

For v1, restart is triggered only by manual invocation (CLI command or SIGUSR2 handler). SIGTERM/SIGINT trigger clean shutdown, not restart.

**Validation:**
- [ ] Spawns new instance, old exits cleanly
- [ ] New instance acquires lock, reads cursor from disk
- [ ] Server sees reconnect (same hostId, new instanceId), runs reconciliation
- [ ] Active threads → idle (interrupted), resume via `thread.resume`

### Phase 4 testing strategy

**Unit tests:** Test each module in isolation with injected dependencies. `event-buffer.ts`: inject a fake HTTP poster, verify flush timing, ack handling, max buffer behavior. `command-cursor.ts`: use temp dir, verify atomic write/read. `command-router.ts`: inject a fake runtime manager and fake server connection, verify dispatch by command type, sequential per-environment execution, error handling.

**Integration tests:** Run a real daemon against a real server (in-memory SQLite, random port). Use `AgentRuntimeOptions.adapterFactory` to inject a fake provider adapter that returns immediately and emits canned events. Test scenarios: session open → command queued → daemon fetches and executes → result reported → events posted. Test reconnection: kill WS, verify daemon reconnects and resumes.

**E2E tests:** Stand up an isolated instance (`BB_DATA_DIR` in temp dir, random `BB_SERVER_PORT`). Start real server + real daemon. Create project, create thread, send message, verify events arrive, run workspace operations, verify git state. These overlap with Phase 7 but basic smoke tests should exist here.

---

## Phase 5: `apps/server`

By this point, `@bb/workspace` and `apps/host-daemon` are solid and well-tested. The server is mostly plumbing: CRUD routes, command queuing, event ingestion, WS hub. Framework: **Hono** on `@hono/node-server` — the contracts already define Hono-typed route schemas.

### 5a. Server skeleton

```
apps/server/src/
  index.ts    -- read config, init DB, create hub, create logger, create app, call serve()
  server.ts   -- createApp(deps): Hono — mount routes, middleware, WS upgrade handlers
  db.ts       -- initDb(): calls createConnection(BB_DATABASE_URL) + migrate(db)
```

**Mount structure:**
- `/api/v1/*` — public routes (projects, threads, environments, hosts, system)
- `/internal/*` — daemon routes (session, commands, events, tool-calls)
- `/ws` — client WebSocket (subscribe/unsubscribe notifications)
- `/internal/ws` — daemon WebSocket (heartbeat, commands-available, session-close)

**Middleware:**
- CORS on `/api/v1/*` (allow `*` in dev, configured origins in production)
- Bearer token auth on `/internal/*` routes — reject if `Authorization` header doesn't match `BB_SECRET_TOKEN`
- Session validation on `/internal/*` routes (except `/session/open`) — verify sessionId in request body/query is an active, non-expired session
- Global error handler: returns `{ code, message }` JSON. Zod validation errors → `{ code: "invalid_request", message: <zod error> }`

**Auth model:** Public routes are unauthenticated in v1 (single-user local server). Internal routes require Bearer token.

**Startup:** `index.ts` calls `initDb()`, creates `NotificationHub`, creates logger, calls `createApp({ db, hub, logger })`, runs sweeps immediately (clean up stale state from a previous crash), then starts background sweep intervals (`setInterval`), then calls `serve({ fetch: app.fetch, port: BB_SERVER_PORT })`.

**Validation:**
- [ ] Server starts, listens on configured port
- [ ] Public routes accessible without auth
- [ ] Internal routes reject without valid Bearer token
- [ ] Invalid JSON / Zod failures return structured error response

### 5b. WebSocket notification hub

Two separate WS endpoints with different protocols:

```
apps/server/src/ws/
  hub.ts              -- NotificationHub class: subscription tracking + notification dispatch
  client-protocol.ts  -- /ws handler: ClientMessage (subscribe/unsubscribe) / ServerMessage (changed)
  daemon-protocol.ts  -- /internal/ws handler: heartbeat / commands-available / session-close
```

Use `@hono/node-ws` for WebSocket upgrade support.

**NotificationHub:**
- Client subscriptions: `Map<WebSocket, Set<subscriptionKey>>` where keys are `"thread:<id>"`, `"project:<id>"`, `"system"`.
- Daemon connections: `Map<sessionId, WebSocket>`.
- `notifyThread(threadId, changes[])` — sends to clients subscribed to `thread:<threadId>`.
- `notifyProject(projectId, changes[])` — sends to clients subscribed to `project:<projectId>`.
- `notifySystem(changes[])` — sends to clients subscribed to `"system"`.
- `notifyDaemon(sessionId, message)` — sends to the daemon WS for that session.
- `addClient(ws)`, `removeClient(ws)`, `addDaemon(sessionId, ws)`, `removeDaemon(sessionId)`.

**client-protocol.ts:** Handles `/ws` upgrade. Parses `ClientMessage` (from `@bb/server-contract/websocket`), calls subscribe/unsubscribe on hub. On WS close, removes client and all its subscriptions. Unauthenticated.

**daemon-protocol.ts:** Handles `/internal/ws` upgrade. Validates `token` and `sessionId` from query params. On `heartbeat` message: update `lastHeartbeatAt` and `leaseExpiresAt` on session record. On close: remove daemon from hub (lease timeout handles session expiry separately).

**Mutation integration:** Data layer functions accept `hub: NotificationHub` as a parameter. After a successful DB write, they call `hub.notify*()`. No event emitter pattern — direct calls.

**Validation:**
- [ ] Client subscribes, receives notifications on mutation
- [ ] Client unsubscribe stops notifications
- [ ] Client disconnect cleans up subscriptions (no leak)
- [ ] Daemon WS receives `commands-available` when command is queued
- [ ] Daemon heartbeat updates session lease in DB

### 5c. Data layer

Plain exported functions, not classes. Each function takes `db: DbConnection` and optionally `hub: NotificationHub` (queries don't need hub; mutations do).

```
apps/server/src/data/
  projects.ts      -- CRUD for projects and project_sources
  threads.ts       -- CRUD + transitionThreadStatus (enforces valid transitions)
  environments.ts  -- CRUD + checkManagedCleanup
  hosts.ts         -- upsertHost, getHost, getHosts, updateHostLastSeen
  events.ts        -- insertEvents (ON CONFLICT DO NOTHING), getEvents, getThreadHighWaterMarks
  commands.ts      -- queueCommand (assign cursor), fetchCommands (mark fetched), reportCommandResult (side effects)
  sessions.ts      -- openSession, updateHeartbeat, closeSession, getActiveSessionForHost
  sweeps.ts        -- sweepExpiredCommands, sweepExpiredLeases (called from setInterval in index.ts)
```

**Thread status transitions** (enforced in `transitionThreadStatus`, reject invalid transitions):

| From | To | Trigger |
|---|---|---|
| `created` | `provisioning` | managed env creation |
| `created` | `idle` | existing path, no pending input |
| `created` | `active` | existing path + pending input → `thread.start` |
| `provisioning` | `idle` | provision success, no pending input |
| `provisioning` | `active` | provision success + pending input |
| `provisioning` | `error` | provision failure |
| `idle` | `active` | `turn.run` / `thread.start` / `thread.resume` |
| `active` | `idle` | turn complete / daemon restart (interrupted) |
| `active` | `error` | provider crash / lease timeout |
| `error` | `active` | reconciliation (daemon reports thread active) |

**Command cursor assignment:** When queuing a command, read `max(cursor)` for the target host and increment by 1, inside a transaction. Commands are **host-scoped** (not session-scoped) so they survive session replacement — the daemon persists one cursor to disk per host and resumes from it after reconnecting with a new session. The `sessionId` on the command records which session created it (for audit), but fetch and cursor are by `hostId`.

**Managed environment cleanup:** On thread archive or delete, call `checkManagedCleanup(db, hub, environmentId)`. If the environment is managed and zero non-archived threads reference it, queue `environment.destroy` command.

**Command TTL sweep:** `setInterval` 30s. Queries commands in `fetched` state past their TTL (60s standard, 300s for `environment.provision`). `retryCount < 1` → re-queue (set state to `pending`, increment `retryCount`, assign new cursor). `retryCount >= 1` → set command to `error`, transition thread to `error`.

**Lease expiry sweep:** `setInterval` 10s. Sessions where `leaseExpiresAt < now` → close session (status: `closed`, closeReason: `expired`), mark host disconnected, transition active threads on that host to `error`, notify system WS (`host-disconnected`).

**Event high-water marks:** `insertEvents` returns `Record<threadId, number>` (max sequence per thread after insert). This is the ack the daemon uses to prune its buffer. Both the dedup (DB unique constraint) and the returned high-water marks must be tested explicitly.

**Validation:**
- [ ] CRUD for all entities with in-memory SQLite
- [ ] Thread status transitions enforced (invalid transitions rejected)
- [ ] Notifications reach WS clients on mutations
- [ ] Event dedup via ON CONFLICT DO NOTHING
- [ ] Event insert returns correct high-water marks per thread
- [ ] Command cursor assigned monotonically per host
- [ ] Command TTL sweep re-queues once then errors
- [ ] Lease expiry sweep closes sessions and errors threads
- [ ] Managed environment cleanup triggers `environment.destroy`

### 5d. Public API routes (parallel with 5e)

```
apps/server/src/routes/
  projects.ts       -- /projects, /projects/:id, /projects/:id/sources, /projects/:id/managers
  threads.ts        -- /threads, /threads/:id, /threads/:id/send, /threads/:id/drafts/*, /threads/:id/stop,
                       /threads/:id/archive, /threads/:id/unarchive, /threads/:id/read, /threads/:id/events,
                       /threads/:id/timeline, /threads/:id/timeline/tool-details, /threads/:id/work-status,
                       /threads/:id/diff, /threads/:id/diff/branches
  environments.ts   -- /environments, /environments/:id, /environments/:id/actions, /environments/:id/primary-status
  hosts.ts          -- /hosts, /hosts/:id
  system.ts         -- /system/models, /system/providers, /system/shutdown, /system/voice-transcription
```

**`POST /threads` (orchestration — not simple CRUD):**
```
1. Validate request (CreateThreadRequest)
2. If environmentId provided → look up environment, verify it exists and is ready
3. Else if path + hostId provided → create environment record (status: ready, managed: false, path set)
4. Else if provisionerId + hostId provided → create environment record (status: provisioning, managed: true, path null)
   → queue environment.provision command
5. Create thread record (status: provisioning if env is provisioning, else created)
6. If environment is ready and input provided → queue thread.start command, transition thread to active
7. If environment is ready and no input → transition thread to idle
8. Return thread
```

**`POST /environments/:id/actions` (asynchronous, single command):**
Environment actions queue a single command and return immediately. No multi-step chaining — each action is one atomic daemon command.

- **commit:** queue `workspace.commit` → result creates system event, notifies app.
- **squash_merge:** queue `workspace.squash_merge` → result creates system event.
- **promote:** queue `workspace.promote { environmentId, primaryPath }` → daemon does full export+import atomically → result notifies app.
- **demote:** queue `workspace.demote { environmentId, primaryPath, defaultBranch }` → daemon does full demote atomically → result notifies app.

**`POST /threads/:id/send`:** If thread is `idle`, transition to `active`, queue `turn.run`. If thread is `active` and mode is `steer`, queue `turn.steer`. If thread is `provisioning` or `created`, queue the message as a draft for later. The `mode` field (`auto`, `start`, `steer`) determines the command type.

**`GET /threads/:id/work-status` and `GET /system/models`:** These need daemon data. For v1, the server queues a command (`workspace.status` or `provider.list_models`), waits up to 10s for the command result (polling the DB), and returns the result. If timeout, return 504. Future: cache results from daemon reports.

**Error format:** All errors return `{ code: string, message: string }`. Use a custom `ApiError` class that extends `HTTPException`. Zod validation failures caught by middleware.

**Validation:**
- [ ] `POST /threads` creates environment + thread + queues appropriate commands for each strategy
- [ ] `POST /environments/:id/actions` queues first command, returns immediately
- [ ] Command result chaining works (promote: export → import → done)
- [ ] `POST /threads/:id/send` transitions thread status and queues correct command type
- [ ] Error responses use consistent format

### 5e. Internal API routes (parallel with 5d)

```
apps/server/src/internal/
  session.ts        -- POST /internal/session/open
  commands.ts       -- GET /internal/session/commands, POST /internal/session/command-result
  events.ts         -- POST /internal/session/events
  tool-calls.ts     -- POST /internal/session/tool-call
  reconciliation.ts -- called from session open (not a separate endpoint)
```

Auth: `Authorization: Bearer <BB_SECRET_TOKEN>` on all routes. Session validation (active session check) on all routes except `/session/open`.

**`POST /internal/session/open`:**
1. Validate against `hostDaemonSessionOpenRequestSchema`
2. Upsert host record (create if new hostId, update name/type/lastSeenAt)
3. Close existing active session for this hostId (status: `closed`, closeReason: `replaced`, send `session-close` over old WS via hub)
4. Create new session record with server-assigned `heartbeatIntervalMs` (30s), `leaseTimeoutMs` (90s)
5. Run reconciliation (compare `activeThreads` + `provisioningEnvironments` against DB state — see architecture doc)
6. Compute `threadHighWaterMarks`: query max event sequence per thread for all non-archived threads on this host
7. Return `{ sessionId, heartbeatIntervalMs, leaseTimeoutMs, threadHighWaterMarks }`

**`GET /internal/session/commands`:** Validate sessionId. Query pending commands for this session's host after `afterCursor`. If commands exist, mark as `fetched` (set `fetchedAt`), return them. If no commands and `waitMs > 0`, hold request open — register a resolver with the hub; when `commands-available` fires for this session, resolve. Return 200 with commands or 200 with empty array on timeout.

**`POST /internal/session/command-result`:** Validate session (accept results from any authenticated request — match by commandId regardless of session, since the daemon may report results from a previous session after reconnect). Update command state (`success`/`error`), set `resultPayload`, `completedAt`. Run side-effect handler by command type:
- `environment.provision` success → update environment (set path, isGitRepo, status: ready), transition thread to idle, queue `thread.start` if pending input
- `environment.provision` error → transition environment to error, thread to error
- `workspace.promote` / `workspace.demote` success → create system event, notify app
- `thread.start` success → store providerThreadId
- Other results: create system events, notify WS as appropriate

**`POST /internal/session/events`:** Validate session. Insert events with ON CONFLICT DO NOTHING. Update thread status based on event types (`turn/completed` → thread idle, `error` → thread error, `thread/name/updated` → update thread title). Notify WS clients with `events-appended` for each affected thread. Return `{ threadHighWaterMarks: Record<threadId, number> }`.

**`POST /internal/session/tool-call`:** Validate session. Dispatch by `tool` name to server-side tool implementations. Known tools: `spawn_thread` (create child thread, return its ID), `delegate_to_thread` (set parentThreadId). Return `ToolCallResponse`. Unknown tools return error response.

**`reconciliation.ts`:** Called from session open handler. Compares daemon's `activeThreads` against DB state:
- Thread in `error` (lease timeout) but daemon reports active → transition to `active`
- Thread in `active` but daemon has no session → transition to `idle`
- Idle threads that lost provider sessions: no server-side action needed. The daemon lazily re-establishes provider sessions via `ensureRuntime` when the next command arrives.
- Environments stuck in `provisioning`: handled by command TTL sweep (5 min), not reconciliation.

**Validation:**
- [ ] Session open upserts host, closes old session (WS `session-close` sent), creates new session
- [ ] Command fetch returns pending commands, marks fetched, long-poll works with waitMs
- [ ] Command result updates state and runs side effects (provision → ready, export → chain import)
- [ ] Event ingestion deduplicates, returns correct high-water marks, updates thread status
- [ ] Tool call dispatches to correct handler, returns response
- [ ] Reconciliation corrects stale thread/environment states on reconnect

### Phase 5 testing strategy

**Data layer tests:** In-memory SQLite. Test each module's functions. Assert DB state after mutations. Pass a real `NotificationHub` with mock WS connections to verify notifications are emitted.

**WS hub tests:** Unit test `NotificationHub` directly with mock WS objects. Test subscribe/unsubscribe/notify/disconnect lifecycle. Test daemon notification routing by sessionId.

**Route handler tests:** Use Hono's `app.request()` test helper with in-memory DB + real hub. No HTTP server needed. Test the full request/response cycle. Key scenarios: `POST /threads` with each creation strategy, environment action chaining, send with status transitions.

**Internal API tests:** Same `app.request()` pattern. Key scenarios: session open + reconciliation, command fetch + long-poll timeout, event ingestion + dedup + high-water-mark acks, command result + chaining (promote: export → import).

**Integration tests:** Start a real server on a random port with in-memory SQLite. Exercise the full HTTP API. Verify WS notifications arrive. Test the full session lifecycle: open → commands → events → results.

**E2E tests:** Standalone isolated instance (temp `BB_DATA_DIR`, random port). Start server + daemon. Create project → thread → send message → verify events → commit → verify git state. Verify via DB queries and CLI commands.

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
  3a (Workspace class) → 3b (provisioning) → 3c (promote/export/import)
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
