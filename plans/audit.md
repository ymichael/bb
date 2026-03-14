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

**3. Unbounded event log growth — OOM on long-running environments**
- `packages/environment-agent/src/runtime.ts:58,123`
- The `events[]` array is append-only and never trimmed. Events are delivered via subscribers and never read from the array afterward. Long-lived environments will exhaust memory.

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

**7. `ThreadRepository.update()` writes to a dropped column**
- `packages/db/src/repositories.ts:889,918-922`
- Accepts `environmentRecord` in its input and conditionally writes it to the row, but migration `0042_drop_thread_environment_record.sql` dropped that column. Silently no-ops or throws depending on driver version.

**8. Unsafe `method as ThreadEventType` cast erases type safety for all provider events**
- `packages/agent-server/src/agent-server.ts:82`
- Any arbitrary provider method string is cast to `ThreadEventType`. Unrecognized methods bypass exhaustive match checks downstream, causing incorrect event handling or silent data loss.

**9. `SpawnThreadRequest.type` not validated by Zod schema — clients can spawn manager threads unchecked**
- `packages/agent-core/src/schemas.ts:26-39` vs `packages/agent-core/src/api-types.ts:49`
- The `type` field exists on the TypeScript interface but is absent from the Zod schema. Any value passes validation, including `"manager"`.

**10. Foreign keys disabled during migration with no integrity check afterward**
- `packages/db/src/migrate.ts:31-37`
- `PRAGMA foreign_keys = OFF` is set before migration, then turned back on, but no `PRAGMA foreign_key_check` is run. Broken references introduced during migration persist silently.

**11. Cursor `advanceIfNext` TOCTOU — concurrent callers can produce lost updates**
- `packages/db/src/environment-agent-repositories.ts:827-857`
- Reads current cursor, evaluates `canAdvanceCursorTo`, then writes — all without a transaction. Two callers can both pass the check and both write, with the second overwriting the first.

**12. Cursor `upsert` TOCTOU — concurrent inserts cause PK violation**
- `packages/db/src/environment-agent-repositories.ts:798-825`
- `getByThreadId()` then conditionally INSERT or UPDATE. Without a transaction, two callers seeing "no row" both attempt INSERT.

**13. Session `touchHeartbeat`/`markExpired`/`markClosed` read-then-write without transactions**
- `packages/db/src/environment-agent-repositories.ts:561-644`
- Same TOCTOU pattern. Concurrent calls to `markClosed` can both see `status === "active"` and both proceed.

**14. `child.pid!` non-null assertion after spawn can corrupt record**
- `packages/environment/src/host-environment-agent.ts:401`
- If spawn fails to launch (command not found), `child.pid` is `undefined`. The `!` assertion stores `undefined` as a number, causing unpredictable behavior in subsequent `isProcessAlive` calls.

**15. `withExecutionOptions` silently drops `sandboxMode` when `reasoningLevel` is set**
- `packages/agent-server/src/codex-provider-adapter.ts:63-84`
- Early `return` on line 79 when `reasoningLevel` is truthy means `sandboxMode` is never checked. Per-turn sandbox overrides are lost when combined with reasoning level.

**16. Provisioning tasks not cancelled on `stopAll` — continue running against cleared state**
- `apps/daemon/src/orchestrator.ts:3481-3487,3533-3578`
- `stopAll` calls `provisioningTasks.clear()` without awaiting or cancelling in-flight promises. Provisioning callbacks continue executing against stale/cleared state.

**17. `stopAll` doesn't await environment destruction — process can exit mid-cleanup**
- `apps/daemon/src/environment-service.ts:1029-1075`
- Fires `destroyDetachedRuntime` with `void ... .catch()`. The `index.ts` shutdown handler uses the non-awaiting `stopAll` variant.

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

**23. Supervisor event subscription leak if `start()` throws**
- `packages/environment-agent/src/session-supervisor.ts:105,117-130`
- Constructor subscribes to runtime events. If `start()` throws during `openSession()` and the caller abandons the supervisor without calling `close()`, the subscription is never cleaned up.

**24. `thread wait --event` polls ALL events every cycle — O(n) growth**
- `apps/cli/src/commands/thread.ts:253-269`
- No `afterSeq` parameter passed. Each poll fetches the full event log, which grows over the thread's lifetime.

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

### Duplication

**Q5. `checkoutSnapshotsMatch` defined identically in two files**
- `apps/daemon/src/orchestrator.ts:261-274` (dead — never called)
- `apps/daemon/src/environment-service.ts:77-90` (used)

**Q6. `confirmDestructiveAction` duplicated across CLI commands**
- `apps/cli/src/commands/thread.ts:160-179`
- `apps/cli/src/commands/manager.ts:196-213`

**Q7. `buildThreadUrl` duplicated across CLI commands**
- `apps/cli/src/commands/thread.ts:188-189`
- `apps/cli/src/commands/manager.ts:262-264`

**Q8. `stopAll` / `stopAllAndWait` duplicate long cleanup sequences**
- `apps/daemon/src/orchestrator.ts:3481-3531`
- `apps/daemon/src/environment-service.ts:1029-1127`
- Both pairs duplicate long lists of `.clear()` calls. A shared `_resetInMemoryState()` helper would reduce drift.

### Type Safety

**Q9. `EnvironmentRepository.update()` uses `Record<string, unknown>`**
- `packages/db/src/repositories.ts:523`
- Bypasses Drizzle's type checking. Typos in key names silently produce no-op updates. Same pattern in `ProjectRepository.update()` (line 398) and `ThreadRepository.update()` (line 907).

**Q10. Unsafe type cast for optional repo method**
- `apps/daemon/src/orchestrator.ts:6030-6064`
- Casts `eventRepo` to ad-hoc inline type with `as { pruneHistoricalNoiseByThread?: ... }`. Bypasses TypeScript and breaks silently if the method signature changes.

**Q11. `rowToThread` uses forced `as Thread` cast**
- `packages/db/src/repositories.ts:1063`
- If `Thread` type adds required fields, this cast hides the type error at compile time.

**Q12. `Thread.attachedEnvironment` type field never populated**
- `packages/agent-core/src/types.ts:115`
- `rowToThread()` does not populate `attachedEnvironment`. API consumers always receive `undefined`. Either remove the field or eagerly load it.

### Performance

**Q13. MutationObserver watching `attributes: true` on entire timeline subtree**
- `apps/app/src/views/useThreadTimelineController.ts:305-324`
- Any CSS class change, animation attribute, or `data-*` toggle on any descendant fires `scheduleReconcile`. Causes layout thrashing on threads with many messages.

**Q14. `markThreadRead` mutation in useEffect deps causes unnecessary re-runs**
- `apps/app/src/views/ThreadDetailView.tsx:419-432`
- React Query mutation objects are referentially unstable. Effect body re-runs on every render where identity changes.

**Q15. Thread status machine recreated per check**
- `apps/daemon/src/thread-status-machine.ts:76-86`
- Creates a new xstate machine, initializes, and transitions it on every `canTransitionThreadStatus` call. Multiple code paths bypass it entirely with `force: true`.

**Q16. Complex correlated subquery with `json_extract` in event pruning**
- `packages/db/src/repositories.ts:1299-1336`
- DELETE with correlated EXISTS subquery doing JSON parsing in SQLite. Slow under load, holds write lock.

**Q17. `_resolvePersistedProviderThreadId` fallback scans all events**
- `apps/daemon/src/orchestrator.ts:4308-4323`
- If indexed lookup fails, iterates all events in reverse. O(n) on long-lived threads.

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

### Dead Code

**Q22. `_startPrimaryPromotionWatch` / `_stopPrimaryPromotionWatch` are no-op stubs**
- `apps/daemon/src/orchestrator.ts:842-848`
- Both are `void projectId;`. Logic moved to `EnvironmentService`.

**Q23. `resolveDefaultBranch` always returns `undefined`**
- `packages/environment/src/worktree-environment.ts:227-229`

**Q24. `shouldRenderThreadStartInput` returns `true` for all valid statuses**
- `packages/agent-core/src/to-ui-messages.ts:503-519`
- Exists only as a type-safety guardrail, never returns `false`.

### Misc Smells

**Q25. `repairCriticalSchema` runs every startup — shadow migration system**
- `packages/db/src/migrate.ts:40-57`
- Patches schema outside the migration system. If a future migration legitimately removes a column this function repairs, it will silently re-add it.

**Q26. `_setThreadStatus` has 4 near-identical branches**
- `apps/daemon/src/orchestrator.ts:6073-6147`
- Handles combinatorics of `connection` and `touchUpdatedAt` with copy-pasted branches.

**Q27. `enqueueQueuedMessage` returns hardcoded `seq: 0`**
- `packages/db/src/repositories.ts:968`
- Returns `seq: 0` instead of the actual auto-incremented value from SQLite.

**Q28. Inconsistent API calling patterns in CLI — raw `fetch` vs typed client**
- `apps/cli/src/commands/manager.ts:186` — `delete` uses raw `fetch`
- `apps/cli/src/commands/thread.ts:575-583` — `archive` uses raw `fetch`
- Other commands in the same files use the typed Hono client

**Q29. Pervasive `(err as Error).message` in CLI without type checking**
- `apps/cli/src/commands/thread.ts`, `apps/cli/src/commands/manager.ts` (30+ instances)
- Non-Error throws produce "Error: undefined" with no diagnostic value. Not a runtime bug per se, but degrades error reporting.

**Q30. `window.prompt` / `window.confirm` for project rename/delete**
- `apps/app/src/components/layout/ProjectList.tsx:228-243,272-291`
- Blocks main thread, not brand-consistent. The app already has dialog component patterns.

**Q31. No down-migrations or rollback SQL**
- `packages/db/drizzle/*.sql`
- Several migrations are destructive (column/table drops). No way to roll back schema.

**Q32. `handleAttachFiles` breaks on first error — no partial-upload feedback**
- `apps/app/src/views/ThreadDetailView.tsx:650-666`
- If 5 files dropped and 2nd fails, files 3-5 are silently never uploaded.

**Q33. No SIGTERM handler in environment-agent runtime**
- `packages/environment-agent/src/runtime.ts`
- If the process receives SIGTERM, it exits without calling `shutdown()`. Pending provider requests leak and the provider child gets orphaned.

**Q34. Inconsistent identity key between host/docker agent maps**
- `packages/environment/src/host-environment-agent.ts:60-65` — excludes `threadId`
- `packages/environment/src/docker-environment-agent.ts:59-67` — includes `threadId`
- Two threads sharing a docker environment get separate agent records; host environments correctly share.

**Q35. `EnvironmentProvisioningEvent` is a single-variant union**
- `packages/agent-core/src/runtime-contracts.ts:181-193`
- Only `{ type: "env-setup" }` exists. Premature abstraction or incomplete implementation.

---

## Part 3: Validation Pass (2026-03-14)

Legend:
- `confirmed`: claim is supported by current code.
- `likely`: core concern is plausible, but impact/manifestation is not fully proven by static inspection.
- `denied`: claim is not supported as written, or key parts are incorrect.

### Part 1 Validation (Bugs)

| Item | Verdict | Evidence (quick) | Second opinion | Third opinion |
| --- | --- | --- | --- | --- |
| 1 | likely | `_tell` has no per-thread lock and can run concurrently; rollback gate uses stale epoch checks (`apps/daemon/src/orchestrator.ts:1324-1510`). | confirmed — no per-thread lock/in-flight set for `_tell`; two concurrent calls capture same epoch, both activate, both satisfy rollback epoch-equality guard; `awaitProviderStart=false` fires detached promise with no interleaving protection. | TBD |
| 2 | confirmed | lock helper returns after awaiting existing promise and does not run second action (`host-environment-agent.ts:67-86`, `docker-environment-agent.ts:70-89`). | confirmed — both `withManagedHostEnvironmentAgentLock` and `withManagedDockerEnvironmentAgentLock` await existing promise then `return` without executing second caller's action. | TBD |
| 3 | confirmed | runtime appends to `events[]` and never reads/trims it (`environment-agent/src/runtime.ts:58,123`). | confirmed — `events[]` is append-only via `push()` at line 123; array is never read back, spliced, or capped; events dispatched to subscribers immediately but array grows unbounded. | TBD |
| 4 | confirmed | `allocatePort()` bind-close-return pattern in both host/docker env paths (`docker-environment.ts:594-613`, `host-environment-agent.ts:229-248`). | confirmed — both `allocatePort` functions bind to port 0, read assigned port, close server, then return; TOCTOU window between close and actual bind. | TBD |
| 5 | confirmed | `threads.project_id` FK has no `onDelete` clause (`packages/db/src/schema.ts:47-49`). | confirmed — `.references(() => projects.id)` with no `onDelete` option; Drizzle defaults to no action. | TBD |
| 6 | confirmed | `events.thread_id` FK has no cascade; thread delete only clears queued messages then deletes thread (`schema.ts:116-118`, `repositories.ts:939-944`). | confirmed — no `onDelete: "cascade"` on `events.threadId`; `ThreadRepository.delete()` only cleans up `queuedThreadMessages`. | TBD |
| 7 | confirmed | code still writes `environmentRecord`; migration `0042` drops column (`repositories.ts:918-922`, `drizzle/0042_drop_thread_environment_record.sql`). | confirmed — migration 0042 drops `environment_record`; column absent from schema; `ThreadRepository.update()` still conditionally writes it into `updates` object passed to `db.update().set()`. | TBD |
| 8 | likely | `method as ThreadEventType` is unsafe cast (`agent-server.ts:81-82`), but downstream data-loss impact is not directly proven. | denied — cast exists but no exhaustive switch/match on `eventType` downstream; value flows to `_appendEvent` as a DB label and `_cacheProvisioningStateFromEvent` which uses `===` guards; unknown methods stored as-is without incorrect branching. | TBD |
| 9 | denied | `type` is absent from Zod schema, but route uses `c.req.valid("json")`; unknown keys are stripped before `spawn()` call (`routes/threads.ts:438-457`). | denied — Zod strips unknown keys silently (no validation error), and route handler never forwards `type` to `spawn()` anyway; sending `type: "manager"` gets 201 success but field is silently dropped, not unchecked pass-through. | TBD |
| 10 | confirmed | migrations disable FKs and re-enable, with no `foreign_key_check` (`packages/db/src/migrate.ts:31-37`). | confirmed — `PRAGMA foreign_keys = OFF` before migration, restored in `finally`, but no `PRAGMA foreign_key_check` ever called afterward. | TBD |
| 11 | confirmed | `advanceIfNext` does read-check-write without transaction (`environment-agent-repositories.ts:827-857`). | confirmed — `getByThreadId` at line 834, `canAdvanceCursorTo` at line 846, `upsert` at line 855 — all outside any transaction; no compare-and-swap at DB level. | TBD |
| 12 | confirmed | cursor `upsert` does get-then-insert/update without transaction (`environment-agent-repositories.ts:798-825`). | confirmed — plain `getByThreadId()` then conditional INSERT or UPDATE with no transaction or `ON CONFLICT` clause; concurrent "no row" reads both attempt INSERT causing PK violation. | TBD |
| 13 | confirmed | session heartbeat/close/expire methods do read-then-write without transaction (`environment-agent-repositories.ts:561-644`). | confirmed — all three methods do `getById` then conditional `UPDATE` without transaction; `replaceActiveForThread` (line 652) correctly uses `db.transaction()`, showing the pattern is known but inconsistently applied. | TBD |
| 14 | likely | non-null assertion `child.pid!` exists (`host-environment-agent.ts:401-403`), but persistent corruption scenario is not fully demonstrated. | likely — `child.pid!` assertion exists but mitigated by `waitForEnvironmentAgent` timeout-throw in default path; downstream guards check `if (existing.pid && ...)`; latent type-safety issue but not practically reachable without custom deps injection. | TBD |
| 15 | denied | sandbox is set before `withExecutionOptions`; `reasoningLevel` early return does not drop sandbox fields in current callsites (`codex-provider-adapter.ts:317-369`). | denied — `sandboxMode` is resolved into base params (`sandbox:` / `sandboxPolicy:`) before `withExecutionOptions` is called; early return spreads input params preserving sandbox fields. | TBD |
| 16 | likely | `stopAll` clears `provisioningTasks` without awaiting tasks (`orchestrator.ts:3487,3533-3578`); in-flight callbacks are partially guarded but still continue running. | denied — provisioning callbacks check `provisioningTasks.get(threadId) !== task` at every entry point (lines 3543/3550/3570); `clear()` causes identity mismatch so in-flight callbacks bail early without operating on cleared state. | TBD |
| 17 | denied | non-awaiting `stopAll` uses `void ...catch` for destruction (`environment-service.ts:1029-1075`); shutdown path uses `stopAll` (`apps/daemon/src/index.ts:168`). | confirmed — `stopAll` is void-returning with `void...catch()`; shutdown handler at line 168 doesn't await; `stopAllAndWait` async variant exists but is unused in shutdown path. | denied — production shutdown always passes `preserveEnvironments: true`, which only detaches runtimes from memory without any destruction. The fire-and-forget `destroyDetachedRuntime` path is never reached in production. `stopAllAndWait` does `environment.suspend()` which would be *worse* during shutdown — we don't want to modify environments on daemon stop. Renamed `stopAll` → `detachAll` and `stopAllAndWait` → `teardownAllForTestsOnly` to clarify intent. |
| 18 | confirmed | docker agent launched detached with no PID tracking and disposed via `pkill -f` (`docker-environment-agent.ts:329-362,393-421`). | confirmed — `docker exec -d` returns no PID; cleanup at line 411 uses `pkill -f 'environment-agent.bundle.mjs'` which would kill all matching processes in the container indiscriminately. | TBD |
| 19 | confirmed | managed host agent map is in-memory only; detached child + `unref` means restart loses handles (`host-environment-agent.ts:55,394-399`). | confirmed — plain in-memory `Map` with no persistence; spawn uses `detached: true` + `child.unref()`; restart means empty map with no rediscovery of running children. | TBD |
| 20 | confirmed | dispose path keeps record if shutdown fails but ping succeeds (`host-environment-agent.ts:455-476`). | confirmed — when `requestShutdown` throws and ping succeeds, code `return`s early skipping `managedHostEnvironmentAgents.delete()`; agent process never forcibly killed, runs indefinitely. | TBD |
| 21 | likely | `suspend()` removes agent only; container removal only in `destroy()` (`docker-environment.ts:227-245`). Could be intentional lifecycle split. | confirmed — `suspend()` (lines 227-238) only disposes managed agent + calls `inner.suspend()`; `destroy()` is sole caller of `removeContainerAsync()`; crash after suspend orphans container. | TBD |
| 22 | confirmed | `destroy()` ignores `runGitAtPathAsync` result then force-removes workspace (`worktree-environment.ts:380-388`). | confirmed — `runGitAtPathAsync` resolves with `{ ok: boolean }` and never throws; return value discarded in `destroy()`; `rm -rf` runs unconditionally leaving stale `.git/worktrees/` entry on failure. | TBD |
| 23 | denied | constructor subscribes once, but `start()` catches its own errors and does not throw (`session-supervisor.ts:105-130`). Leak claim is not shown as written. | denied — `start()` catches all errors via try/catch + `handleError` then continues to `scheduleNextCycle()`; never throws to caller, so the leak scenario is unreachable. | TBD |
| 24 | confirmed | wait loop fetches full event list each poll with no cursor/`afterSeq` (`apps/cli/src/commands/thread.ts:253-269`). | confirmed — poll calls `events.$get` with `query: {}`; no `afterSeq` or cursor parameter; every cycle fetches complete event log from beginning. | TBD |
| 25 | likely | 2s timestamp heuristic is real (`ThreadDetailView.tsx:398-417`), but specific false-ack behavior is plausible rather than proven here. | confirmed — exact heuristic `row.message.createdAt + 2_000 >= pendingSubmittedFollowUp.submittedAt` at line 408; >2s lag means `promptDraft.clear()` never called; reverse skew clears wrong draft. | TBD |

### Part 2 Validation (Code Quality)

| Item | Verdict | Evidence (quick) | Second opinion | Third opinion |
| --- | --- | --- | --- | --- |
| Q1 | confirmed | file is 6317 lines; constructor has many deps (`apps/daemon/src/orchestrator.ts`, `:600-618`). | confirmed — 6317 lines, 17 constructor params, 26+ `new Map`/`new Set` instantiations; responsibilities span all listed concerns. | TBD |
| Q2 | confirmed | `ThreadDetailView.tsx` is 1686 lines with dense state/hook usage. | confirmed — 1686 lines; 8 `useState`, but 30+ custom hook invocations (`useThread`, `useThreadTimeline`, `usePromptDraftStorage`, etc.); God Component pattern confirmed. | TBD |
| Q3 | confirmed | `ThreadSecondaryPanel` prop list is very large (`ThreadSecondaryPanel.tsx:322-397`). | confirmed — 38 props destructured (lines 322-359); many git-diff-specific props could be grouped into sub-component or object prop. | TBD |
| Q4 | confirmed | `renderThreadRow` returns JSX but is called as plain function (`ProjectList.tsx:381-530,726,736,744`). | confirmed — defined as plain function, called as `renderThreadRow(...)` at lines 726/736/744; React cannot track identity or bail out via `memo`. | TBD |
| Q5 | confirmed | duplicate `checkoutSnapshotsMatch`; orchestrator copy appears unused (`orchestrator.ts:261`, `environment-service.ts:77`). | confirmed — byte-for-byte identical implementations; `environment-service.ts` copy called at lines 815/881; orchestrator copy has zero call sites (dead). | TBD |
| Q6 | confirmed | `confirmDestructiveAction` duplicated (`thread.ts:160-179`, `manager.ts:196-213`). | confirmed — identical function with same signature, TTY check, error message, and readline `[y/N]` prompt logic; only minor whitespace differs. | TBD |
| Q7 | confirmed | `buildThreadUrl` duplicated (`thread.ts:188-189`, `manager.ts:262-264`). | confirmed — identical `buildThreadUrl` function with same signature and body in both files. | TBD |
| Q8 | confirmed | duplicated `stopAll`/`stopAllAndWait` cleanup blocks (`orchestrator.ts:3481-3531`, `environment-service.ts:1029-1127`). | confirmed — identical 14-line `.clear()` block copy-pasted in orchestrator; environment-service duplicates 5-line cleanup sequence in early-return branch and at end, across both methods. | fixed — extracted `_clearInMemoryState()` in orchestrator; split `stopAll`/`stopAllAndWait` into `detachAll()`/`teardownAllForTestsOnly()` removing the duplicated preserveEnvironments branching in environment-service. |
| Q9 | confirmed | update methods use `Record<string, unknown>` (`repositories.ts:398,523,907`). | confirmed — all three `update()` methods declare `const updates: Record<string, unknown> = {}` and pass to `.set()`; typos in key names silently no-op. | TBD |
| Q10 | confirmed | ad-hoc cast on `eventRepo` optional methods (`orchestrator.ts:6034-6064`). | confirmed — two inline `as { pruneHistoricalNoiseByThread?: ...; reclaimStorageIfNeeded?: ... }` casts; signature changes compile silently. | TBD |
| Q11 | confirmed | `rowToThread` ends with `as Thread` (`repositories.ts:1063`). | confirmed — forced `as Thread` cast on constructed object; bypasses structural assignability check; new required fields would be silently unset. | TBD |
| Q12 | denied | `rowToThread` omits it, but API route hydrates `attachedEnvironment` in responses (`routes/threads.ts:395-433`). Not “always undefined.” | denied — `hydrateThread`/`hydrateThreads` helpers in routes (lines 387-436) look up attachment via repo and inject `attachedEnvironment` before API response; populated at API layer, not DB layer. | TBD |
| Q13 | confirmed | `MutationObserver` watches subtree + attributes (`useThreadTimelineController.ts:305-324`). | confirmed — `observer.observe(container, { subtree: true, childList: true, characterData: true, attributes: true })` at lines 314-319; any attribute mutation on any descendant fires `scheduleReconcile`. | TBD |
| Q14 | likely | effect depends on mutation object (`ThreadDetailView.tsx:419-432`); potential extra reruns depends on hook identity stability. | confirmed — `markThreadRead` in useEffect deps array; React Query mutations are referentially unstable; `markedReadKeysRef` guard prevents duplicate calls but effect body still re-runs. | TBD |
| Q15 | confirmed | `canTransitionThreadStatus` creates machine per call (`thread-status-machine.ts:76-86`). | confirmed — new machine + `initialTransition` + `transition` on every call; `_setThreadStatus` accepts `force` option bypassing the check at lines 3555/3647. | TBD |
| Q16 | confirmed | correlated `EXISTS` + many `json_extract` operations in delete pruning query (`repositories.ts:1299-1336`). | confirmed — DELETE with correlated EXISTS + up to 9 `json_extract()` per outer row, 6 per inner row; unindexed JSON parsing holds write lock. | TBD |
| Q17 | denied | fallback scan exists (`orchestrator.ts:4315-4323`) but normal repo has indexed helper (`repositories.ts:1468`), so hot-path impact claim is overstated. | denied — `getLatestProviderThreadId` (line 1468) is indexed production path; fallback scan only reached if method absent (stub/fake repo); hot-path impact overstated. | TBD |
| Q18 | confirmed | `getProjectById` lists all projects then filters (`apps/cli/src/commands/manager.ts:215-227`). | confirmed — calls `client.api.v1.projects.$get()` (list) then `.find()` by ID; contrast `getThreadById` directly below which correctly uses `threads[“:id”].$get()`. | TBD |
| Q19 | confirmed | no unique index on `(project_id, descriptor)` in schema (`packages/db/src/schema.ts:24-41`). | confirmed — only non-unique index on `(project_id, updated_at)`; no unique constraint on `(project_id, descriptor)`. | TBD |
| Q20 | confirmed | listed fields are not FK-constrained in schema (`packages/db/src/schema.ts:54-57`, `projects` table fields). | confirmed — all four fields (`environmentId`, `parentThreadId`, `primaryCheckoutThreadId`, `primaryManagerThreadId`) are plain `text()` with no `.references()` calls. | TBD |
| Q21 | confirmed | active-session queries filter status + lease expiry without composite index (`environment-agent-repositories.ts:513-526`; schema indexes differ). | confirmed — `listActive` queries `WHERE status = 'active' AND leaseExpiresAt > now`; only separate indexes exist, no composite `(status, leaseExpiresAt)`. | TBD |
| Q22 | confirmed | watch stub methods are no-op (`orchestrator.ts:842-848`). | confirmed — both methods contain only `void projectId;` with no other logic; complete no-ops. | TBD |
| Q23 | confirmed | `resolveDefaultBranch` returns `undefined` unconditionally (`worktree-environment.ts:227-229`). | confirmed — body is `return undefined;`; async variant `resolveDefaultBranchAsync` (lines 231-246) has the actual implementation. | TBD |
| Q24 | confirmed | for all known statuses, helper returns `true`; only undefined returns false (`to-ui-messages.ts:503-519`). | denied — returns `false` when `threadStatus` is `undefined`/falsy (line 506); for all typed status values returns `true`; `default` branch uses `assertNever` as exhaustiveness check. Claim “never returns false” is incorrect. | TBD |
| Q25 | confirmed | `repairCriticalSchema` runs in migrate path every startup (`migrate.ts:34,40-57`). | confirmed — called unconditionally after `drizzleMigrate`; uses `ALTER TABLE ADD COLUMN` for 4 columns outside migration journal; would fight future migrations that intentionally remove them. | TBD |
| Q26 | confirmed | `_setThreadStatus` has repeated branch structure for update/touch/connection permutations (`orchestrator.ts:6073-6147`). | confirmed — 4-branch `connection`/`touchUpdatedAt` combinatorics block copy-pasted verbatim at lines 6083-6099 and 6118-6135. | TBD |
| Q27 | confirmed | `enqueueQueuedMessage` returns hardcoded `seq: 0` (`repositories.ts:968`). | confirmed — `this.rowToQueuedMessage({ seq: 0, ...row })` without querying actual auto-incremented value. | TBD |
| Q28 | confirmed | mixed raw `fetch` and typed client in same command files (`manager.ts:186`, `thread.ts:575-583`). | confirmed — `delete` (manager.ts:186) and `archive` (thread.ts:575-583) use raw `fetch`; other commands in same files use typed Hono client via `createClient`. | TBD |
| Q29 | confirmed | `(err as Error).message` pattern is pervasive (27 hits currently across `thread.ts` + `manager.ts`). | confirmed — 32 occurrences total: 20 in `thread.ts`, 7+ in `manager.ts`; no `instanceof Error` guard; non-Error throws produce “Error: undefined”. | TBD |
| Q30 | confirmed | `window.prompt`/`window.confirm` used for project rename/delete (`ProjectList.tsx:228-243,272-291`). | confirmed — `window.prompt` (line 231), `window.alert` (line 236), and `window.confirm` (line 274) all used for project operations; blocking native dialogs. | TBD |
| Q31 | confirmed | drizzle SQL folder contains forward migrations only; no rollback/down migration scripts present. | confirmed — only forward SQL files; 7+ destructive DROP operations (e.g., `0010_remove_task_model.sql`, `0042_drop_thread_environment_record.sql`) with no rollback scripts. | TBD |
| Q32 | confirmed | file attach loop breaks on first error (`ThreadDetailView.tsx:650-666`). | confirmed — loop catches error, sets message, calls `break` at lines 661-663; files after failure silently skipped with no partial-upload indication. | TBD |
| Q33 | denied | environment-agent binary already handles SIGTERM/SIGINT and calls shutdown (`packages/environment-agent/src/bin/environment-agent.ts:67-72`). | denied — binary entry point (lines 70-72) registers SIGTERM handler calling `close()` → `shutdown()` → `stopProviderChild()` which rejects pending requests and sends SIGTERM/SIGKILL to provider child. | TBD |
| Q34 | confirmed | identity key differs: host excludes `threadId`, docker includes it (`host-environment-agent.ts:60-65`, `docker-environment-agent.ts:63-67`). | confirmed — host key: `[projectId, environmentId, workspaceRootPath]`; docker key: `[projectId, threadId, environmentId, workspaceRootPath]`; two threads sharing docker env get separate agent records. | TBD |
| Q35 | confirmed | union currently has one variant (`runtime-contracts.ts:181-193`). | confirmed — single variant `{ type: “env-setup” }` with union syntax (`|` prefix) purely ceremonial; premature abstraction. | TBD |

---

## Part 4: Tech Debt & Migration Debt

Parallel internal contracts, half-finished ownership migrations, historical compatibility carried in steady-state code, and disproportionately large files.

### Parallel Internal Contracts

**D1. Sync/async dual surface on `IEnvironment` — largest single source of unnecessary complexity**
- `packages/environment/src/contracts.ts:64-124`
- The interface requires paired sync + async methods: `getCheckoutSnapshot()` / `getCheckoutSnapshotAsync()`, `getWorkspaceStatus()` / `getWorkspaceStatusAsync()`, `run()` / `runAsync()`, etc. (7 pairs).
- **Every sync method in every implementation throws** `"Synchronous ... is unsupported; use ...Async"`. No implementation supports the sync path.
- The orchestrator is littered with `env.fooAsync ? await env.fooAsync(...) : env.foo(...)` conditionals and has a dedicated error-detection helper `_isSyncWorkspaceStatusUnsupportedError`.
- Classification: `closed_internal`. The interface should be migrated to async-only.

**D2. Error parsing stack — 4 independent implementations**
- `apps/daemon/src/voice-transcription.ts:49` (`extractErrorMessage` + `ERROR_KEYS`)
- `packages/agent-server/src/openai-responses-model.ts:114` (inline key list)
- `apps/app/src/lib/api.ts:94` (`normalizeErrorText` + `LEGACY_ERROR_KEYS`)
- `apps/cli/src/client.ts:28` (simpler `normalizeErrorText` variant)
- All four implement the same recursive extract-from-unknown pattern with minor differences in key lists, truncation limits, and HTML filtering. The `api.ts` variant acknowledges drift by naming its keys `LEGACY_ERROR_KEYS`.
- Classification: `closed_internal`. Should be a single shared utility.

**D3. `EnvironmentCapability` type defined in two packages**
- `packages/agent-core/src/types.ts:44`
- `packages/environment/src/contracts.ts:7`
- Identical union + Record type. Neither imports from the other.
- Classification: `closed_internal`. One package should own the canonical type.

**D4. `Thread` type name collision**
- `packages/agent-core/src/types.ts:100` — internal runtime Thread
- `packages/agent-core/src/generated/codex-app-server/schema/v2/Thread.ts:8` — generated wire-protocol Thread
- Completely different shapes in the same package. Confusing for developers.
- Classification: `open_external`. Consider renaming the generated type (e.g. `ApiThread`).

### Ownership Migrations (Stopped Halfway)

**D5. CLI `normalizeThreadEventType` — local copy never removed**
- `apps/cli/src/commands/thread.ts:58` — local reimplementation
- `packages/agent-core/src/thread-event-normalization.ts:327` — canonical version, exported
- The package owns the function and exports it; the CLI never switched to importing it.

**D6. `pruneHistoricalNoiseByThread` accessed via unsafe cast**
- `apps/daemon/src/orchestrator.ts:6034`
- The method exists on the concrete `EventRepository` (`packages/db/src/repositories.ts:1256`) but was never added to the repository interface the orchestrator is typed against. The orchestrator uses an inline `as { pruneHistoricalNoiseByThread?: ... }` cast as a stop-gap.

**D7. Legacy `codex/event/*` dual-format bridge — spans 4 packages**
- `packages/agent-server/src/codex-provider-adapter.ts:33-36,300-302` — suppresses duplicate legacy notifications
- `packages/db/src/repositories.ts:87-90` — hard-coded legacy event types in pruning
- `packages/agent-core/test/to-ui-messages.test.ts` — tests for legacy event projection
- `apps/app/src/lib/thread-context-window-usage.test.ts:175-181` — still processes old `codex/event/token_count`
- The canonicalize plan (`plans/canonicalize-internal-contracts-and-remove-legacy-bridges.md`, step 4) targets this but has not been executed.

**D8. Backward-compatible `error` alias in daemon API responses**
- `apps/daemon/src/routes/error-response.ts:13-14`
- `ApiErrorBody` includes `error: string` as a "backward-compatible alias for existing clients/tests."
- CLI test (`apps/cli/src/__tests__/client.test.ts:56`) explicitly tests "falls back to legacy error fields."
- The canonicalize plan (step 1) questions whether this is still needed.

### Historical Compatibility

**D9. Legacy raw provider payload DB rows**
- `packages/agent-core/src/thread-event-normalization.ts` — `decodeProviderEventEnvelope` handles both old format (`{ thread: { id: ... } }`) and new envelope format
- `packages/db/test/event-repository.envelope.test.ts:100` — explicit compat test
- Classification: `open_external`. Old persisted data must remain readable. All new writes use the envelope format. Read-only tolerance, not active production.

**D10. Legacy field name compat in `to-ui-messages.ts`**
- `packages/agent-core/src/to-ui-messages.ts:1051-1055`
- Parses both `commandActions` (camelCase) and `command_actions` (snake_case) for backward compatibility with older event formats.

**D11. `repairCriticalSchema` shadow migration system**
- `packages/db/src/migrate.ts:40-57`
- Runs every startup, adding columns outside the migration journal. Can silently fight future migrations. (Also listed as Q25 in Part 2.)

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
| `packages/environment-agent/src/runtime.ts` | 998 | 20% of env-agent | Contains the unbounded `events[]` leak. |

### Unfinished Plan Work

**`plans/canonicalize-internal-contracts-and-remove-legacy-bridges.md`**
All 7 steps identified but none executed:
1. Standardize daemon error responses (the `error` alias)
2. Tighten client HTTP error handling
3. Remove prompt-composer fallbacks
4. Finish event history cutover (remove `codex/event/*` dual-format)
5. Make row collapsing metadata-driven
6. Reduce duplicate UI primitive imports
7. Shrink oversized coordination surfaces

**`plans/environment-abstraction-leaks-plan.md`**
- Steps 1-3: Done
- Steps 4-6: In progress
- Steps 7-9: Not started

### Recommended Priority

1. **Sync/async dual surface (D1)** — highest impact. Touches 3 environment implementations, the entire orchestrator, and the interface contract. Every sync method is dead code.
2. **Error parsing consolidation (D2)** — 4 copies of the same utility. Extract to shared package.
3. **Legacy event format cutover (D7)** — spans 4 packages. The canonicalize plan already describes the work.
4. **Orchestrator decomposition (Q1)** — 6,317 lines, 43% of daemon. Prerequisite for making concurrency bugs (Part 1 items 1, 16) tractable.
5. **`EnvironmentCapability` dedup (D3)** — trivial, one package should own the type.
6. **CLI `normalizeThreadEventType` (D5)** — trivial, replace local function with import.
7. **`pruneHistoricalNoiseByThread` interface gap (D6)** — add the method to the repository interface, remove the unsafe cast.

### Validation Pass (Added Tech-Debt Items, 2026-03-14)

Legend:
- `confirmed`: claim is supported by current code/docs.
- `likely`: concern is plausible, but full impact/history is not provable from static inspection.
- `denied`: claim is not supported as written.

| Item | Verdict | Evidence (quick) | Second opinion | Third opinion |
| --- | --- | --- | --- | --- |
| D1 | confirmed | `IEnvironment` defines sync+async pairs (`packages/environment/src/contracts.ts:64-124`); concrete envs throw “Synchronous ... unsupported” in sync paths (`worktree-environment.ts`, `docker-environment.ts`, `local-environment.ts`). | confirmed — 6 sync/async pairs in interface; all sync methods throw in worktree/docker impls; orchestrator has `env.fooAsync ? await env.fooAsync() : env.foo()` conditional at 5+ call sites. | TBD |
| D2 | confirmed | similar recursive error extractors exist in daemon/app/cli/agent-server (`voice-transcription.ts`, `api.ts`, `client.ts`, `openai-responses-model.ts`). | confirmed — all four define `normalizeErrorText` (identical body) + recursive extract-from-unknown with variations: different key lists, truncation limits; `api.ts` names its keys `LEGACY_ERROR_KEYS` acknowledging drift. | TBD |
| D3 | confirmed | `EnvironmentCapability`/`EnvironmentCapabilities` are duplicated in `agent-core` and `environment` packages. | confirmed — identical 5-member `EnvironmentCapability` union + `Record` type in both packages; `contracts.ts` imports other types from `agent-core` but not these. | TBD |
| D4 | confirmed | both `packages/agent-core/src/types.ts` and generated `.../schema/v2/Thread.ts` export `Thread` with different shapes. | confirmed — internal `interface Thread` (runtime: `projectId`, `status`, `environmentId`) vs generated `type Thread` (wire: `preview`, `modelProvider`, `cwd`, `turns`); completely different shapes, same name, same package. | TBD |
| D5 | confirmed | CLI has local `normalizeThreadEventType` while agent-core exports canonical helper (`thread.ts:58`, `thread-event-normalization.ts:327`). | confirmed — CLI local copy has identical body (`type.toLowerCase().replaceAll(“.”, “/”)`); canonical version exported from agent-core; local copy never removed. | TBD |
| D6 | confirmed | orchestrator accesses repo maintenance methods via ad-hoc cast (`orchestrator.ts:6034-6064`) while method exists on concrete repository (`packages/db/src/repositories.ts`). | confirmed — method on concrete class only (repositories.ts:1256); absent from any interface; orchestrator uses inline `as` cast at lines 6034-6041 and 6051-6057. | TBD |
| D7 | confirmed | legacy `codex/event/*` handling/suppression still appears across adapter, db pruning constants, and tests (`codex-provider-adapter.ts`, `repositories.ts`, tests cited). | confirmed — adapter defines `LEGACY_DUPLICATE_NOTIFICATION_METHODS` with `codex/event/item_started` + `item_completed`; repositories.ts hard-codes 4 `codex/event/*` types in pruning list; test processes `codex/event/token_count`. | TBD |
| D8 | confirmed | daemon error response keeps compatibility alias `error` (`apps/daemon/src/routes/error-response.ts:13-14`); CLI test covers legacy fallback (`apps/cli/src/__tests__/client.test.ts:56-66`). | confirmed — `ApiErrorBody` has `error: string` with “Backward-compatible alias” comment; `createBody` mirrors value; CLI test titled “falls back to legacy error fields” tests body with only `{“error”:”...”}`. | TBD |
| D9 | confirmed | compatibility test for legacy raw provider payload rows exists (`packages/db/test/event-repository.envelope.test.ts:100-115`). | likely — compat test exists but `decodeProviderEventEnvelope` only handles new envelope format; legacy handling is implicit via `unwrapProviderEventPayload` falling back to raw payload, not explicit dual-format decode. | TBD |
| D10 | confirmed | `to-ui-messages.ts` still parses both `commandActions` and `command_actions` (`:1051-1055`). | confirmed — lines 1051-1055 parse both `record.commandActions` (camelCase) and `record.command_actions` (snake_case) as legacy fallbacks after modern `parsedCmd`/`parsed_cmd` check. | TBD |
| D11 | confirmed | `repairCriticalSchema` still mutates schema at startup outside migration journal (`packages/db/src/migrate.ts:40-57`). | confirmed — runs every startup after `drizzleMigrate`; executes `ALTER TABLE` + `CREATE INDEX` via `sqlite.exec` for 4 columns outside migration journal; future migrations that remove these columns would be silently fought. | TBD |
| UP1 | likely | “All 7 steps identified but none executed” is not explicitly tracked in the canonicalize plan file; plan text alone does not prove execution status. | confirmed — plan file lists exactly 7 numbered steps (lines 21-61) with no checkboxes, completion markers, or progress indicators; purely design/planning document. | TBD |
| UP2 | confirmed | environment abstraction plan explicitly labels steps as Done/In progress/Next (`plans/environment-abstraction-leaks-plan.md`). | confirmed — plan file explicitly labels steps 1-3 as "Done", steps 4-6 as "In progress", steps 7-9 as "Next" (= not started); matches claim exactly. | TBD |

---

## Part 5: Fix Scope Assessment (2026-03-14)

Scope estimates for all doubly-confirmed items (both first and second opinion = `confirmed`). Items where either opinion was `denied` or `likely` are excluded.

### Quick Wins — S, Low Risk

These can each be done in a single focused PR with minimal review burden.

| Item | ~Lines | Files | Fix |
|------|--------|-------|-----|
| **2** (lock starvation) | 6 | `host-environment-agent.ts`, `docker-environment-agent.ts` | Remove early `return` after lock await; fall through to re-execute action. |
| **3** (event OOM) | 10 | `runtime.ts` | Remove unused `events[]` array entirely (never read back), or add ring-buffer cap. |
| **7** (dropped column write) | 10 | `repositories.ts`, test file | Delete `environmentRecord` field from `update()` input type and remove conditional write block. |
| **10** (FK check) | 3 | `migrate.ts` | Add `PRAGMA foreign_key_check` after migration completes; throw if violations found. |
| **17** (stopAll await) | — | — | ~~SKIPPED~~ — not a real bug. Production shutdown always passes `preserveEnvironments: true` which only detaches from memory. Addressed via rename to `detachAll()`. |
| **20** (zombie agent) | 5 | `host-environment-agent.ts` | Remove `stillReachable` early-return; always delete record from map regardless of ping result. |
| **22** (worktree destroy) | 5 | `worktree-environment.ts` | Check `ok` flag from `runGitAtPathAsync` before running `rm -rf`; log `stderr` on failure. |
| **24** (event polling) | 10 | `thread.ts` (CLI) | Add `afterSeq` cursor variable; server already supports the parameter. Convert O(n) to O(1) per poll. |
| Q5+Q6+Q7 (dedup) | 15 net | `orchestrator.ts`, `thread.ts`, `manager.ts`, new `helpers.ts` | Delete dead orchestrator copy of `checkoutSnapshotsMatch`. Extract `confirmDestructiveAction` + `buildThreadUrl` into shared CLI helpers module. |
| Q8 (stopAll dedup) | — | — | ~~DONE~~ — extracted `_clearInMemoryState()` in orchestrator; split into `detachAll()`/`teardownAllForTestsOnly()` removing duplicated branching. |
| Q9 (Record type) | 3 | `repositories.ts` | Replace `Record<string, unknown>` with `Partial<typeof table.$inferInsert>` in 3 `update()` methods. Pattern already used elsewhere in file. |
| Q10+Q11 (unsafe casts) | 25 | `orchestrator.ts`, `repositories.ts` | Q10: methods already exist on concrete class; remove inline `as` casts and call directly. Q11: change `as Thread` to `const thread: Thread =` for structural checking. |
| Q13 (MutationObserver) | 1 | `useThreadTimelineController.ts` | Remove `attributes: true` from observer config. `childList` + `characterData` already cover all layout-change triggers. |
| Q15 (status machine) | 10 | `thread-status-machine.ts` | Replace per-call machine creation with static `Map<ThreadStatus, Set<ThreadStatus>>` built at module load time. |
| Q22+Q23 (dead code) | 10 | `orchestrator.ts`, `worktree-environment.ts` | Pure deletion — both have zero call sites. Private methods / module-local functions with no callers. |
| Q25 (repairSchema) | 37 del | `migrate.ts` | All 4 columns now covered by proper migrations (0036, 0039, 0044). Delete `repairCriticalSchema` + `ensureColumn` entirely. |
| Q26 (4 branches) | 15 | `orchestrator.ts` | Build options object conditionally with spread; replace 2×4 copy-pasted branch blocks with single call each. |
| Q27 (seq:0) | 5 | `repositories.ts` | Switch `.run()` to `.returning({ seq }).get()` to get actual auto-increment value. No callers use the returned `seq` today, but correctness matters. |
| Q29 (err cast) | 30 | `thread.ts`, `manager.ts` | Extract `getErrorMessage(err: unknown)` helper; mechanical find-replace of 27 `(err as Error).message` instances. |
| Q32 (file attach break) | 10 | `ThreadDetailView.tsx` | Remove `break`; accumulate per-file errors; show aggregated message listing failed filenames. |
| Q35 (single-variant union) | 10 | `runtime-contracts.ts`, `orchestrator.ts` | Replace single-variant union with plain interface; drop redundant `"in" event` type guards. |
| D3+D4+D5 (type dedup) | 15 | `types.ts`, `contracts.ts`, `thread.ts` (CLI), index files | D3: delete duplicate `EnvironmentCapability` from agent-core, re-export from environment. D5: delete local `normalizeThreadEventType` from CLI, import canonical. D4: add `WireThread` alias for generated type. |
| D5 (CLI normalize) | 2 | `thread.ts` | Delete local function, add import from `@beanbag/agent-core`. |
| D6 (interface gap) | 15 | `orchestrator.ts` | Methods already exist on concrete `EventRepository` class — casts and `typeof` guards are stale. Remove all 5 defensive workarounds, call directly. |
| D8 (error alias) | 25 | `error-response.ts`, `client.ts`, `session-http-client.ts`, 4 test files | Delete `error` field from `ApiErrorBody`. Remove `value.error` from legacy candidates in CLI + env-agent client. Update test assertions from `body.error` to `body.message`. |
| D10 (legacy fields) | 2 | `to-ui-messages.ts` | Delete `command_actions` (snake_case) branch only — nothing produces it. Keep `commandActions` (camelCase) — still used by codex-app-server v2 schema. |
| D11 (repairSchema) | 40 del | `migrate.ts` | Same as Q25 — all 4 repairs covered by proper migrations. Delete function and call site entirely. |

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
| D2 (error parsing) | 30 net | `unknown-helpers.ts`, 4 consumer files | Low-medium — behavioral decisions needed on truncation limits (180 vs 220 vs none). | Add `extractErrorMessage(value, { maxLength? })` to agent-core's `unknown-helpers.ts`; update 4 call sites to import shared utility. |
| D7 (legacy events) | 140 | 7 files across 4 packages | Low — legacy types already suppressed at ingestion; no new data enters in old format. | Remove `codex/event/*` strings from pruning constants; one-time `DELETE WHERE type LIKE 'codex/event/%'` migration; remove 6 legacy test cases. |
| UP2 (env plan 4-9) | 400-600 | 10 files across 3 packages + new fake env | Medium — `workspaceRoot` threads through provisioning pipeline across 3 packages; `"worktree"` cleanup touches artifact GC. | Steps 4-6: strip `workspaceRoot` from ~8 orchestrator event emissions, 2 event-data types, `to-ui-messages.ts` pipeline. Step 7: UI audit (mostly done). Step 8: replace `"worktree"` string guards with capability checks. Step 9: build minimal `IEnvironment` fake for integration tests. |

### Large / XL Effort

| Item | ~Lines | Files | Risk | Fix |
|------|--------|-------|------|-----|
| **D1** (sync/async dual) | 250-350 | 9 files: contracts, 3 impls, orchestrator, env-service, tests | **L, medium** — 38 call sites in orchestrator + 50+ mock objects in tests; compiler catches most via type errors after interface change. | Remove 7 optional sync overloads from `IEnvironment`; rename `*Async` → plain names. TypeScript compiler flags all stale `? :` ternary guards. Update test mocks last — compile errors pinpoint every one. |
| **Q1** (orchestrator god object) | 3500 relocated | 8 new service files + orchestrator shrinks to ~1000 lines | **XL, high** — 30+ shared Maps create coupling; callback topology risk. | Extract leaf-first: `timeline-cache.ts` → `thread-title-service.ts` → `ws-broadcast-coordinator.ts` → `thread-operation-queue.ts` → `parent-notification-service.ts` → `thread-provisioner.ts` → `provider-session-manager.ts` → `thread-hydrator.ts`. Each extraction = own commit. |
| **Q2** (ThreadDetailView) | 1686 total | New hook + component files extracted from single file | **XL, medium** — many tightly inter-dependent values; 3-6 cross-references per callback. | Extract 3 custom hooks: `useThreadActions` (~120 lines), `useThreadGitState` (~220 lines), `useThreadComposerState` (~110 lines). Promote `renderThreadMetadataCard` and `managerWorkspaceContent` to proper components. Target: main component under 400 lines. |

### Summary by Size

| Size | Count | Total ~Lines |
|------|-------|-------------|
| S (low risk) | 25 | ~430 |
| S (medium risk) | 6 | ~170 |
| M | 10 | ~1595 |
| L | 1 | ~300 |
| XL | 2 | ~5200 |
| **Total** | **44** | **~7695** |
