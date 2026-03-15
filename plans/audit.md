# Codebase Audit — 2026-03-14

Full-codebase audit covering daemon core, database layer, environment agent subsystem, frontend app, agent-core, and CLI.

---

## Part 1: Bugs

Confirmed or likely-to-manifest defects that can cause incorrect behavior, data loss, crashes, or resource leaks at runtime.

### Critical

**1. Concurrent `_tell` race condition — duplicate thread activation**
- `apps/daemon/src/orchestrator.ts:1324-1510`
- Two concurrent `_tell` calls read the same `lifecycleEpochBeforeSend`, both activate the thread, and on failure both try rollback using the same stale epoch. The `awaitProviderStart=false` path (line 1507) makes this fire-and-forget with no interleaving protection.

**2. Lock starvation in environment agent ensure — second caller silently skipped**
- `packages/environment/src/host-environment-agent.ts:67-86`
- `packages/environment/src/docker-environment-agent.ts:70-89`
- When a second caller arrives while the lock is held, it `await`s the promise then `return`s without executing its action. The managed agent target is never set, causing downstream "Missing managed environment-agent target" errors.

**4. Port allocation TOCTOU — intermittent port conflicts**
- `packages/environment/src/docker-environment.ts:594-613`
- `packages/environment/src/host-environment-agent.ts:229-248`
- Port is allocated by binding to port 0, reading the assigned port, then closing the server before Docker/agent binds to it. Another process can grab the port in between.

**5. Deleting a project orphans all child rows — no cascade on `threads.project_id`**
- `packages/db/src/schema.ts:48-49`
- `threads.project_id` references `projects.id` with no `onDelete` behavior (defaults to `no action`). Deleting a project leaves all threads, events, sessions, cursors, and commands as permanent orphans.

**6. Deleting a thread orphans events — no cascade on `events.thread_id`**
- `packages/db/src/schema.ts:116-118`
- `events.thread_id` has no cascade. `ThreadRepository.delete()` (`repositories.ts:939-944`) only cleans up `queuedThreadMessages`. Events, which can be numerous, become permanent orphans.

**11. Cursor `advanceIfNext` TOCTOU — concurrent callers can produce lost updates**
- `packages/db/src/environment-agent-repositories.ts:827-857`
- Reads current cursor, evaluates `canAdvanceCursorTo`, then writes — all without a transaction. Two callers can both pass the check and both write, with the second overwriting the first.

**12. Cursor `upsert` TOCTOU — concurrent inserts cause PK violation**
- `packages/db/src/environment-agent-repositories.ts:798-825`
- `getByThreadId()` then conditionally INSERT or UPDATE. Without a transaction, two callers seeing "no row" both attempt INSERT.

**13. Session `touchHeartbeat`/`markExpired`/`markClosed` read-then-write without transactions**
- `packages/db/src/environment-agent-repositories.ts:561-644`
- Same TOCTOU pattern. Concurrent calls to `markClosed` can both see `status === "active"` and both proceed.

**18. Docker agent process not tracked by PID — cleanup uses fragile `pkill -f` pattern**
- `packages/environment/src/docker-environment-agent.ts:329-362`
- The detached `docker exec -d` process has no PID tracking. Cleanup pattern-matches the command name, which could hit wrong processes if multiple agents run in the same container.

**19. Managed agent process map lost on daemon restart — detached children become orphans**
- `packages/environment/src/host-environment-agent.ts:55`
- In-memory `managedHostEnvironmentAgents` map is lost on restart. Child processes launched with `detached: true` / `child.unref()` continue running with no rediscovery mechanism.

**20. Zombie agent not killed — dispose gives up if agent refuses shutdown but responds to pings**
- `packages/environment/src/host-environment-agent.ts:455-476`
- When a managed agent has no PID (reconnected), dispose tries `requestShutdown`. If that fails but the agent is still reachable, the record is kept and the agent runs forever.

**21. Docker `suspend()` kills agent but leaves container running**
- `packages/environment/src/docker-environment.ts:227-239`
- Only `destroy()` calls `removeContainerAsync()`. If the daemon crashes after suspend but before destroy, the container is orphaned.

**22. Worktree `destroy()` ignores `git worktree remove` failure**
- `packages/environment/src/worktree-environment.ts:380-388`
- Return value of `git worktree remove --force` is not checked. If it fails, the subsequent `rm -rf` deletes the workspace but leaves stale git metadata in `.git/worktrees/`.

**25. Follow-up ack uses 2-second clock-skew heuristic**
- `apps/app/src/views/ThreadDetailView.tsx:398-417`
- `createdAt + 2_000 >= submittedAt` to match timeline rows to pending follow-ups. Clock skew or delay can cause the prompt draft to never clear (or incorrectly clear a new draft).

---

## Part 2: Code Quality

Design flaws, code smells, and maintainability concerns that don't cause immediate runtime failures but degrade the codebase over time.

### Architectural

**Q1. Orchestrator God Object — 6300 lines, 30+ Maps/Sets, 16+ constructor params**
- `apps/daemon/src/orchestrator.ts`
- Single class manages thread lifecycle, environment provisioning, provider sessions, WS broadcasting, git operations, timeline caching, noise pruning, primary checkout, and parent-thread notification. Impossible to unit-test or reason about concurrency. Constructor takes 16+ positional parameters.
- **Recommendation:** Extract thread lifecycle, environment provisioning, provider management, and timeline caching into separate services with explicit interfaces.

**Q2. `ThreadDetailView` is a 1687-line God Component**
- `apps/app/src/views/ThreadDetailView.tsx`
- 30+ hooks, 20+ state variables. Any state change triggers a full re-render. Inline render functions defeat `React.memo` on children.

**Q3. `ThreadSecondaryPanel` takes 40+ props**
- `apps/app/src/views/ThreadSecondaryPanel.tsx:322-397`
- Strong signal of insufficient decomposition. Hard to maintain and test.

**Q4. `renderThreadRow` called as function, not component**
- `apps/app/src/components/layout/ProjectList.tsx:381-530`
- Returns JSX but called as `renderThreadRow(...)`, not `<ThreadRow />`. Prevents efficient React reconciliation and forces all rows to re-render on any `ProjectList` state change.

### Performance

**Q14. `markThreadRead` mutation in useEffect deps causes unnecessary re-runs**
- `apps/app/src/views/ThreadDetailView.tsx:419-432`
- React Query mutation objects are referentially unstable. Effect body re-runs on every render where identity changes.

**Q16. Complex correlated subquery with `json_extract` in event pruning**
- `packages/db/src/repositories.ts:1299-1336`
- DELETE with correlated EXISTS subquery doing JSON parsing in SQLite. Slow under load, holds write lock.

**Q18. `getProjectById` fetches all projects then filters client-side**
- `apps/cli/src/commands/manager.ts:215-227`
- Uses list endpoint and filters, instead of a direct `GET /projects/:id`.

### Missing Constraints & Indexes

**Q19. No unique index on `environments(project_id, descriptor)` — allows duplicates**
- `packages/db/src/schema.ts:24-41`

**Q20. Missing FK constraints on several thread/project fields**
- `threads.environmentId` — no FK to `environments.id`
- `threads.parentThreadId` — no self-referencing FK to `threads.id`
- `projects.primaryCheckoutThreadId` — no FK to `threads.id`
- `projects.primaryManagerThreadId` — no FK to `threads.id`

**Q21. Missing composite index on `(status, leaseExpiresAt)` for active session queries**
- `packages/db/src/environment-agent-repositories.ts:513-526`
- Query filters on both but no matching index exists.

### Misc Smells

**Q28. Inconsistent API calling patterns in CLI — raw `fetch` vs typed client**
- `apps/cli/src/commands/manager.ts:186` — `delete` uses raw `fetch`
- `apps/cli/src/commands/thread.ts:575-583` — `archive` uses raw `fetch`
- Other commands in the same files use the typed Hono client

**Q30. `window.prompt` / `window.confirm` for project rename/delete**
- `apps/app/src/components/layout/ProjectList.tsx:228-243,272-291`
- Blocks main thread, not brand-consistent. The app already has dialog component patterns.

**Q31. No down-migrations or rollback SQL**
- `packages/db/drizzle/*.sql`
- Several migrations are destructive (column/table drops). No way to roll back schema.

**Q34. Inconsistent identity key between host/docker agent maps**
- `packages/environment/src/host-environment-agent.ts:60-65` — excludes `threadId`
- `packages/environment/src/docker-environment-agent.ts:59-67` — includes `threadId`
- Two threads sharing a docker environment get separate agent records; host environments correctly share.

---

## Part 3: Validation Pass (2026-03-14)

Legend:
- `confirmed`: claim is supported by current code.
- `likely`: core concern is plausible, but impact/manifestation is not fully proven by static inspection.
- `denied`: claim is not supported as written, or key parts are incorrect.

### Part 1 Validation (Bugs)

| Item | Verdict | Evidence (quick) | Second opinion | Third opinion |
| --- | --- | --- | --- | --- |
| 1 | likely | `_tell` has no per-thread lock and can run concurrently; rollback gate uses stale epoch checks (`apps/daemon/src/orchestrator.ts:1324-1510`). | confirmed — no per-thread lock/in-flight set for `_tell`; two concurrent calls capture same epoch, both activate, both satisfy rollback epoch-equality guard; `awaitProviderStart=false` fires detached promise with no interleaving protection. | fixed — per-thread promise chain serializes concurrent _tell calls. |
| 2 | confirmed | lock helper returns after awaiting existing promise and does not run second action (`host-environment-agent.ts:67-86`, `docker-environment-agent.ts:70-89`). | confirmed — both `withManagedHostEnvironmentAgentLock` and `withManagedDockerEnvironmentAgentLock` await existing promise then `return` without executing second caller's action. | fixed — removed early return in lock helpers, second caller now executes. |
| 4 | confirmed | `allocatePort()` bind-close-return pattern in both host/docker env paths (`docker-environment.ts:594-613`, `host-environment-agent.ts:229-248`). | confirmed — both `allocatePort` functions bind to port 0, read assigned port, close server, then return; TOCTOU window between close and actual bind. | wontfix — inherent TOCTOU across process boundaries, no clean fix. |
| 5 | confirmed | `threads.project_id` FK has no `onDelete` clause (`packages/db/src/schema.ts:47-49`). | confirmed — `.references(() => projects.id)` with no `onDelete` option; Drizzle defaults to no action. | TBD |
| 6 | confirmed | `events.thread_id` FK has no cascade; thread delete only clears queued messages then deletes thread (`schema.ts:116-118`, `repositories.ts:939-944`). | confirmed — no `onDelete: "cascade"` on `events.threadId`; `ThreadRepository.delete()` only cleans up `queuedThreadMessages`. | TBD |
| 11 | confirmed | `advanceIfNext` does read-check-write without transaction (`environment-agent-repositories.ts:827-857`). | confirmed — `getByThreadId` at line 834, `canAdvanceCursorTo` at line 846, `upsert` at line 855 — all outside any transaction; no compare-and-swap at DB level. | fixed — wrapped in db.transaction(). |
| 12 | confirmed | cursor `upsert` does get-then-insert/update without transaction (`environment-agent-repositories.ts:798-825`). | confirmed — plain `getByThreadId()` then conditional INSERT or UPDATE with no transaction or `ON CONFLICT` clause; concurrent "no row" reads both attempt INSERT causing PK violation. | fixed — wrapped in db.transaction(). |
| 13 | confirmed | session heartbeat/close/expire methods do read-then-write without transaction (`environment-agent-repositories.ts:561-644`). | confirmed — all three methods do `getById` then conditional `UPDATE` without transaction; `replaceActiveForThread` (line 652) correctly uses `db.transaction()`, showing the pattern is known but inconsistently applied. | fixed — wrapped in db.transaction(). |
| 18 | confirmed | docker agent launched detached with no PID tracking and disposed via `pkill -f` (`docker-environment-agent.ts:329-362,393-421`). | confirmed — `docker exec -d` returns no PID; cleanup at line 411 uses `pkill -f 'environment-agent.bundle.mjs'` which would kill all matching processes in the container indiscriminately. | wontfix — one agent per container, pkill-f is sufficient. |
| 19 | confirmed | managed host agent map is in-memory only; detached child + `unref` means restart loses handles (`host-environment-agent.ts:55,394-399`). | confirmed — plain in-memory `Map` with no persistence; spawn uses `detached: true` + `child.unref()`; restart means empty map with no rediscovery of running children. | wontfix — reconnect path handles restart; OS cleans crashed children. |
| 20 | confirmed | dispose path keeps record if shutdown fails but ping succeeds (`host-environment-agent.ts:455-476`). | confirmed — when `requestShutdown` throws and ping succeeds, code `return`s early skipping `managedHostEnvironmentAgents.delete()`; agent process never forcibly killed, runs indefinitely. | wontfix — narrow scenario (adopted agent, shutdown fails, ping succeeds); agent eventually dies on its own. |
| 21 | likely | `suspend()` removes agent only; container removal only in `destroy()` (`docker-environment.ts:227-245`). Could be intentional lifecycle split. | confirmed — `suspend()` (lines 227-238) only disposes managed agent + calls `inner.suspend()`; `destroy()` is sole caller of `removeContainerAsync()`; crash after suspend orphans container. | wontfix — intentional lifecycle split; suspend preserves container for resumption. |
| 22 | confirmed | `destroy()` ignores `runGitAtPathAsync` result then force-removes workspace (`worktree-environment.ts:380-388`). | confirmed — `runGitAtPathAsync` resolves with `{ ok: boolean }` and never throws; return value discarded in `destroy()`; `rm -rf` runs unconditionally leaving stale `.git/worktrees/` entry on failure. | wontfix — rm -rf still cleans up files; stale .git/worktrees entry is cosmetic. |
| 25 | likely | 2s timestamp heuristic is real (`ThreadDetailView.tsx:398-417`), but specific false-ack behavior is plausible rather than proven here. | confirmed — exact heuristic `row.message.createdAt + 2_000 >= pendingSubmittedFollowUp.submittedAt` at line 408; >2s lag means `promptDraft.clear()` never called; reverse skew clears wrong draft. | wontfix — low severity UX annoyance; draft not clearing is not data loss. |

### Part 2 Validation (Code Quality)

| Item | Verdict | Evidence (quick) | Second opinion | Third opinion |
| --- | --- | --- | --- | --- |
| Q1 | confirmed | file is 6317 lines; constructor has many deps (`apps/daemon/src/orchestrator.ts`, `:600-618`). | confirmed — 6317 lines, 17 constructor params, 26+ `new Map`/`new Set` instantiations; responsibilities span all listed concerns. | TBD |
| Q2 | confirmed | `ThreadDetailView.tsx` is 1686 lines with dense state/hook usage. | confirmed — 1686 lines; 8 `useState`, but 30+ custom hook invocations (`useThread`, `useThreadTimeline`, `usePromptDraftStorage`, etc.); God Component pattern confirmed. | TBD |
| Q3 | confirmed | `ThreadSecondaryPanel` prop list is very large (`ThreadSecondaryPanel.tsx:322-397`). | confirmed — 38 props destructured (lines 322-359); many git-diff-specific props could be grouped into sub-component or object prop. | TBD |
| Q4 | confirmed | `renderThreadRow` returns JSX but is called as plain function (`ProjectList.tsx:381-530,726,736,744`). | confirmed — defined as plain function, called as `renderThreadRow(...)` at lines 726/736/744; React cannot track identity or bail out via `memo`. | TBD |
| Q14 | likely | effect depends on mutation object (`ThreadDetailView.tsx:419-432`); potential extra reruns depends on hook identity stability. | confirmed — `markThreadRead` in useEffect deps array; React Query mutations are referentially unstable; `markedReadKeysRef` guard prevents duplicate calls but effect body still re-runs. | wontfix — guard ref prevents duplicate calls; practical impact near-zero. |
| Q16 | confirmed | correlated `EXISTS` + many `json_extract` operations in delete pruning query (`repositories.ts:1299-1336`). | confirmed — DELETE with correlated EXISTS + up to 9 `json_extract()` per outer row, 6 per inner row; unindexed JSON parsing holds write lock. | TBD |
| Q18 | confirmed | `getProjectById` lists all projects then filters (`apps/cli/src/commands/manager.ts:215-227`). | confirmed — calls `client.api.v1.projects.$get()` (list) then `.find()` by ID; contrast `getThreadById` directly below which correctly uses `threads[“:id”].$get()`. | deferred — needs GET /projects/:id route added first. |
| Q19 | confirmed | no unique index on `(project_id, descriptor)` in schema (`packages/db/src/schema.ts:24-41`). | confirmed — only non-unique index on `(project_id, updated_at)`; no unique constraint on `(project_id, descriptor)`. | TBD |
| Q20 | confirmed | listed fields are not FK-constrained in schema (`packages/db/src/schema.ts:54-57`, `projects` table fields). | confirmed — all four fields (`environmentId`, `parentThreadId`, `primaryCheckoutThreadId`, `primaryManagerThreadId`) are plain `text()` with no `.references()` calls. | TBD |
| Q21 | confirmed | active-session queries filter status + lease expiry without composite index (`environment-agent-repositories.ts:513-526`; schema indexes differ). | confirmed — `listActive` queries `WHERE status = 'active' AND leaseExpiresAt > now`; only separate indexes exist, no composite `(status, leaseExpiresAt)`. | TBD |
| Q28 | confirmed | mixed raw `fetch` and typed client in same command files (`manager.ts:186`, `thread.ts:575-583`). | confirmed — `delete` (manager.ts:186) and `archive` (thread.ts:575-583) use raw `fetch`; other commands in same files use typed Hono client via `createClient`. | fixed — replaced 3 raw fetch calls with typed client; archive remains raw (untyped body). |
| Q30 | confirmed | `window.prompt`/`window.confirm` used for project rename/delete (`ProjectList.tsx:228-243,272-291`). | confirmed — `window.prompt` (line 231), `window.alert` (line 236), and `window.confirm` (line 274) all used for project operations; blocking native dialogs. | TBD |
| Q31 | confirmed | drizzle SQL folder contains forward migrations only; no rollback/down migration scripts present. | confirmed — only forward SQL files; 7+ destructive DROP operations (e.g., `0010_remove_task_model.sql`, `0042_drop_thread_environment_record.sql`) with no rollback scripts. | TBD |
| Q34 | confirmed | identity key differs: host excludes `threadId`, docker includes it (`host-environment-agent.ts:60-65`, `docker-environment-agent.ts:63-67`). | confirmed — host key: `[projectId, environmentId, workspaceRootPath]`; docker key: `[projectId, threadId, environmentId, workspaceRootPath]`; two threads sharing docker env get separate agent records. | fixed — removed threadId from docker identity key to match host pattern. Both now exclude threadId to support shared agent reuse across threads. |

---

## Part 4: Tech Debt & Migration Debt

Disproportionately large files that concentrate risk and impede maintainability.

### Disproportionately Large Files

| File | Lines | % of package | Notes |
|------|-------|-------------|-------|
| `apps/daemon/src/orchestrator.ts` | 6,317 | 43% of daemon | God object. Largest file in codebase by 2x. Contains most migration debt markers. |
| `packages/agent-core/src/to-ui-messages.ts` | 3,576 | 47% of agent-core | Handles every event type in one module. Legacy compat for old field names embedded inline. |
| `apps/app/src/views/ThreadDetailView.tsx` | 1,686 | 9% of app | God component. No debt markers but needs decomposition. |
| `packages/environment/src/git-workspace.ts` | 1,534 | 30% of environment | Diff computation + workspace management. 14 fallback paths (functional, not debt). |
| `packages/db/src/repositories.ts` | 1,517 | 52% of db | All repositories in one file. High concentration risk. |
| `apps/daemon/src/routes/threads.ts` | 1,288 | 9% of daemon | Route handler accumulating scope. |
| `apps/app/src/hooks/useApi.ts` | 1,170 | 6% of app | All API hooks in one file. |
| `apps/cli/src/commands/thread.ts` | 1,080 | 48% of CLI | All thread subcommands in one file. |
| `packages/db/src/environment-agent-repositories.ts` | 1,062 | 36% of db | Large but cohesive. |
| `packages/environment-agent/src/runtime.ts` | 998 | 20% of env-agent | Large but cohesive. |

---

## Part 5: Fix Scope Assessment (2026-03-14)

Scope estimates for all doubly-confirmed items (both first and second opinion = `confirmed`). Items where either opinion was `denied` or `likely` are excluded.

### Quick Wins — S, Low Risk

These can each be done in a single focused PR with minimal review burden.

| Item | ~Lines | Files | Fix |
|------|--------|-------|-----|
| **2** (lock starvation) | 6 | `host-environment-agent.ts`, `docker-environment-agent.ts` | Remove early `return` after lock await; fall through to re-execute action. |
| **20** (zombie agent) | 5 | `host-environment-agent.ts` | Remove `stillReachable` early-return; always delete record from map regardless of ping result. |
| **22** (worktree destroy) | 5 | `worktree-environment.ts` | Check `ok` flag from `runGitAtPathAsync` before running `rm -rf`; log `stderr` on failure. |

### Small but Notable — S, Medium Risk

| Item | ~Lines | Files | Risk factor | Fix |
|------|--------|-------|-------------|-----|
| **5+6** (FK cascade) | 20 | `schema.ts`, new migration SQL | SQLite table rebuild needed for FK changes; `events` table may be large. | Add `onDelete: "cascade"` to `threads.projectId` and `events.threadId`; generate Drizzle migration that rebuilds both tables. |
| **11+12+13** (TOCTOU ×3) | 60 | `environment-agent-repositories.ts`, test file | Must inline `this.db` → `tx` inside lambdas; `replaceActiveForThread` already uses `db.transaction()` as template. | Wrap 5 methods in `this.db.transaction(tx => { ... })`; replace inner `this.db`/`this.getById` calls with `tx`-based reads. |
| **4** (port TOCTOU) | 40 | `docker-environment.ts`, `host-environment-agent.ts` | Can't hold socket across process boundaries (Docker, agent). | Add retry-on-EADDRINUSE at consumer level, or let consumer bind to the same port with `SO_REUSEADDR`. |
| **18** (docker PID) | 30 | `docker-environment-agent.ts` | Must verify PID-file write succeeds inside container. | Write agent PID to known path inside container on launch; replace `pkill -f` with `kill $(cat /tmp/bb-env-agent.pid)`. |
| **19** (agent map lost) | 20 | `host-environment-agent.ts`, `startup-tasks.ts` | Lazy re-adoption via `reconnectTarget` may already cover restart case; needs verification. | Seed `managedHostEnvironmentAgents` from active DB sessions on boot, or verify lazy reconnect path covers all cases. |
| Q34 (identity key) | 1 | `host-environment-agent.ts` | Behavioral change: threads that previously shared an agent process will get separate ones. | Add `args.threadId` to host identity key array, matching docker implementation. Docker's inclusion is correct; host's omission is the bug. |

### Medium Effort — M

| Item | ~Lines | Files | Risk | Fix |
|------|--------|-------|------|-----|
| Q3 (38 props) | 80 | `ThreadSecondaryPanel.tsx`, `ThreadDetailView.tsx` | Medium — tightly coupled props across high-traffic file. | Group 20 git-diff props into `gitDiff?: GitDiffPanelProps` object prop or extract `<GitDiffPanelContent>` sub-component. |
| Q16 (json_extract perf) | 50 | `repositories.ts`, `schema.ts`, new migration | Medium — needs stored generated column + SQLite table rebuild migration on `events` table. | Add stored generated column for extracted item ID with covering index; rewrite correlated EXISTS to join against indexed column. |
| Q18 (getProjectById) | 25 | `routes/projects.ts`, `manager.ts`, test file | Low — repo method `getById` already exists. | Add `GET /:id` route handler (identical pattern to `PATCH /:id`); swap CLI caller to use typed client. |
| Q19+Q20+Q21 (schema) | 25 | `schema.ts`, new migration SQL | Medium — FK additions require SQLite table rebuild; unique index may fail on existing duplicates. | Single migration: table-rebuild for 4 FK constraints + `CREATE UNIQUE INDEX` on `environments(project_id, descriptor)` + composite index on `(status, leaseExpiresAt)`. |
| Q28 (fetch vs client) | 15 | `thread.ts`, `manager.ts` | Low — typed client already supports both endpoints. | Replace 3 raw `fetch` calls with `client.api.v1.threads[":id"].$delete()` and `...archive.$post()`. Each call site already has `client` in scope. |
| Q30 (window.prompt) | 130 | `ProjectList.tsx`, 2 new dialog files | Low — app already has `ThreadRenameDialog`/`ThreadDeleteDialog` built on same Radix Dialog. | Create `ProjectRenameDialog` and `ProjectDeleteDialog` mirroring thread counterparts; wire via `useState` open/close pattern. |
| Q31 (down migrations) | 600 | `packages/db/drizzle/` | Medium-high — only practical for 28 additive migrations; 17 destructive migrations are point-of-no-return. | Write down-migration SQL for additive-only migrations. Document destructive ones as irreversible. Drizzle has no native down-migration support for SQLite. |

### Large / XL Effort

| Item | ~Lines | Files | Risk | Fix |
|------|--------|-------|------|-----|
| **Q1** (orchestrator god object) | 3500 relocated | 8 new service files + orchestrator shrinks to ~1000 lines | **XL, high** — 30+ shared Maps create coupling; callback topology risk. | Extract leaf-first: `timeline-cache.ts` → `thread-title-service.ts` → `ws-broadcast-coordinator.ts` → `thread-operation-queue.ts` → `parent-notification-service.ts` → `thread-provisioner.ts` → `provider-session-manager.ts` → `thread-hydrator.ts`. Each extraction = own commit. |
| **Q2** (ThreadDetailView) | 1686 total | New hook + component files extracted from single file | **XL, medium** — many tightly inter-dependent values; 3-6 cross-references per callback. | Extract 3 custom hooks: `useThreadActions` (~120 lines), `useThreadGitState` (~220 lines), `useThreadComposerState` (~110 lines). Promote `renderThreadMetadataCard` and `managerWorkspaceContent` to proper components. Target: main component under 400 lines. |

### Summary by Size

| Size | Count | Total ~Lines |
|------|-------|-------------|
| S (low risk) | 3 | ~16 |
| S (medium risk) | 6 | ~171 |
| M | 7 | ~925 |
| XL | 2 | ~5186 |
| **Total** | **18** | **~6298** |
