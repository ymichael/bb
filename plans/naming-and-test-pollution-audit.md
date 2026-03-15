# Naming & Test Pollution Audit — 2026-03-14

Findings from a targeted audit of two patterns:
1. **Misleading method names** — names that don't match what the implementation does
2. **Test-only behavior in production code** — parameters, branches, or methods that exist solely for tests

These patterns were discovered while fixing audit items 17 and Q8 (`stopAll`/`stopAllAndWait` rename).

---

## Part 1: Misleading Method Names

### Already Fixed

| Method | File | Issue | Fix |
|--------|------|-------|-----|
| `reconcileActiveThreadsOnBoot` | `orchestrator.ts` | Didn't reconcile active threads — cleaned up archived envs and failed interrupted provisioning | Split into `cleanupArchivedEnvironmentsOnBoot` + `failInterruptedProvisioningOnBoot` |
| `stopAll` / `stopAllAndWait` | `orchestrator.ts`, `environment-service.ts` | `stopAll` didn't stop anything in production (just detached from memory). `stopAllAndWait` was test-only. | Renamed to `detachAll` / `teardownAllForTestsOnly` |

### New Findings

**N1. `suspendEnvironmentRuntime` — fire-and-forget, but name suggests blocking**
- `apps/daemon/src/environment-service.ts:480-485`
- Returns `void` immediately, schedules async suspension in background via `trackEnvironmentRuntimeSuspension()`.
- A separate `suspendEnvironmentRuntimeAndWait` (line 487) actually waits.
- Suggested: `scheduleSuspendEnvironmentRuntime()` or unify into one async method.

**N2. `_cleanupEnvironmentRuntime` — dual behavior hidden behind optional flag**
- `apps/daemon/src/orchestrator.ts:4028-4037`
- With `destroyWorkspace: true`: calls `destroyEnvironmentRuntime` (actual destruction).
- Without: calls `detachEnvironmentRuntime` (just removes from map).
- "Cleanup" implies destruction in both cases. Should be two separate methods.
- 3 call sites: 1 passes `{ destroyWorkspace: true }`, 2 pass nothing.

**N3. `getProjectWorkspaceStatusAsync` — creates and destroys a temporary environment**
- `apps/daemon/src/environment-service.ts:277-289`
- Name implies a read-only getter. Actually calls `this.environmentFactory.create()` to construct a temporary environment, queries status, then destroys it.
- Suggested: `computeProjectWorkspaceStatus()` or `resolveProjectWorkspaceStatus()`

**N4. `restoreThreadEnvironment` — returns cached runtime if available**
- `apps/daemon/src/environment-service.ts:244-267`
- Name implies restoring from persistence. Actually returns the in-memory runtime if present (line 245-248), only falls back to persistence.
- Suggested: `getOrRestoreThreadEnvironment()`

**N5. `ensureProviderRunning` — spawns a new child process**
- `packages/environment-agent/src/runtime.ts:131-144`
- "Ensure" implies an idempotent check. Actually spawns a child process if one doesn't exist.
- Suggested: `startProviderIfNeeded()` or `getOrSpawnProvider()`

**N6. `stopPrimaryPromotionWatches` — trivial wrapper with misleading name**
- `apps/daemon/src/environment-service.ts:1084-1086`
- Public method just calls private `stopAllPrimaryPromotionWatches()`. Name without "all" implies partial behavior.
- Suggested: remove wrapper, expose `stopAllPrimaryPromotionWatches()` directly, or rename to match.

**N7. `_scheduleProvisioning` — orchestrates entire provisioning lifecycle**
- `apps/daemon/src/orchestrator.ts:3516-3562`
- Name implies "put in a queue." Actually sets up error handling, status transitions, event publishing, and thread cleanup on failure.
- Suggested: `_initiateProvisioning()`

**N8. `markSent` / `markReceived` / `markStarted` — perform state machine validation**
- `packages/db/src/environment-agent-repositories.ts:956-966`
- "Mark" implies a simple flag set. Actually validates state transitions via `transitionCommand()`, may throw on invalid transitions.
- Suggested: `transitionToSent()`, `transitionToReceived()`, etc.

---

## Part 2: Test-Only Behavior in Production Code

### Already Fixed

| Pattern | File | Issue | Fix |
|---------|------|-------|-----|
| `preserveEnvironments` parameter | `environment-service.ts`, `orchestrator.ts` | Production always passed `true`. The `false` path (destroy everything) was test-only. | Removed parameter, split into `detachAll` / `teardownAllForTestsOnly` |
| `stopAllAndWait` method | `orchestrator.ts`, `environment-service.ts` | Entire method existed only for test cleanup. | Renamed to `teardownAllForTestsOnly` |

### New Findings

**T1. `typeof` guards on repository methods — 6 instances in orchestrator**
- `apps/daemon/src/orchestrator.ts:731,741,4293,4339,6282`
- `apps/daemon/src/environment-service.ts:1062`
- Production repositories always have these methods (`listArchivedIdsWithEnvironmentRecord`, `listNonArchivedIdsByStatuses`, `listProjectNonArchivedIdsWithEnvironmentRecord`, `getLatestProviderThreadId`, `getLatestTurnLifecycle`).
- Guards exist because test mocks in `orchestrator.test.ts:502-514` don't stub them.
- Production code silently returns `[]` or `undefined` when the method "doesn't exist" — but it always exists in production.
- **Fix:** Add methods to the repository interface and update test mocks to implement them. Remove all `typeof` guards.

**T2. `nextThreadEnvironmentId` parameter on `deleteByThreadId`**
- `packages/db/src/repositories.ts:675-694`
- `ThreadEnvironmentAttachmentRepository.deleteByThreadId` accepts optional `nextThreadEnvironmentId` which, when present, mutates the thread's `environmentId` column as a side effect of deleting an attachment.
- Uses `Object.hasOwn()` to detect if the key was explicitly passed — a pattern typical of test harness plumbing.
- Production always passes a computed value. The optionality and side effect exist for test setup convenience.
- **Fix:** Separate concerns — deletion shouldn't silently update a different table. Move thread `environmentId` update to callers.

**T3. `destroyWorkspace` flag on `_cleanupEnvironmentRuntime`**
- `apps/daemon/src/orchestrator.ts:4028-4037`
- Only 1 of 3 production call sites passes `{ destroyWorkspace: true }`. The other 2 rely on default behavior (detach only).
- The flag makes the method do two fundamentally different things behind one name.
- **Fix:** Split into `_detachEnvironmentRuntime()` and `_destroyEnvironmentRuntime()` (also fixes naming issue N2).

**T4. `__testOnly__` exported functions — properly marked but could leak**
- `packages/environment/src/host-environment-agent.ts:481` — `__testOnly__getManagedHostEnvironmentAgentRecord`
- `packages/environment/src/docker-environment-agent.ts` — similar pattern
- These expose internal Maps for test assertions. Properly prefixed, but they grant direct access to production state.
- **Severity:** Low — naming convention is correct, but consider whether test assertions could use public API instead.

**T5. Sync/async dual surface on `IEnvironment` — sync variants exist only for test convenience**
- `packages/environment/src/contracts.ts:64-124`
- 7 paired methods: `getCheckoutSnapshot()` / `getCheckoutSnapshotAsync()`, `run()` / `runAsync()`, etc.
- Every sync method in every implementation throws `"Synchronous ... is unsupported; use ...Async"`.
- Orchestrator has `env.fooAsync ? await env.fooAsync() : env.foo()` conditionals at 5+ call sites.
- Already tracked as audit item D1 (highest priority tech debt). The sync surface exists because older test fakes only implemented sync methods.
- **Fix:** Remove sync methods from interface, rename async methods to drop `Async` suffix.

---

## Recommended Priority

### Quick wins
1. **T1** (typeof guards) — Remove 6 guards, add methods to repo interface, fix test mocks. ~30 lines.
2. **N2/T3** (_cleanupEnvironmentRuntime) — Split into two methods. ~10 lines.
3. **N6** (stopPrimaryPromotionWatches) — Remove trivial wrapper. ~5 lines.

### Small
4. **N1** (suspendEnvironmentRuntime) — Rename or unify with async variant. ~15 lines.
5. **N3** (getProjectWorkspaceStatusAsync) — Rename. ~5 lines + test updates.
6. **N8** (mark* methods) — Rename to transition*. ~20 lines.
7. **T2** (nextThreadEnvironmentId) — Separate concerns. ~30 lines.

### Medium (already tracked in main audit)
8. **T5/D1** (sync/async dual surface) — Remove sync methods from IEnvironment. ~250-350 lines.
