# Goal

Refactor server route tests to follow the testing principles in AGENTS.md: use real in-memory SQLite instead of mock repos, and assert outcomes (state, return values, persisted data) instead of call sequences.

# Scope

In scope:

- P1: `routes/projects.test.ts` and `routes/threads.test.ts` — replace mock repos/orchestrator with real in-memory DB
- P2: `routes/environments.test.ts` and `routes/system.test.ts` — same treatment
- P3: `startup-tasks.test.ts`, `ws-manager.test.ts`, `http-server-close.test.ts` — refactor assertions from call sequences to state checks (mocking at boundaries is fine, but assertions should verify outcomes)

Out of scope:

- CLI tests (they mock the HTTP client, which is a boundary — this is correct)
- E2e tests (already use real DB)
- `orchestrator.test.ts` (already uses real DB)

# Implementation Steps

## P1: Route tests with mock repos

### 1. Refactor `routes/projects.test.ts`

**Current state:** Mocks `ProjectRepository`, `ThreadRepository`, `EventRepository` with `vi.fn()`. Asserts call sequences like `expect(projectRepo.update).toHaveBeenCalledWith(...)`.

**Target state:** Use real in-memory SQLite via `createTestDb()` + real repositories. Assert actual persisted state.

**How:**

1. Replace `mockProjectRepo()`, `mockThreadRepo()`, `mockEventRepo()` with:
   ```typescript
   const testDb = createTestDb();
   const projectRepo = new ProjectRepository(testDb.db);
   const threadRepo = new ThreadRepository(testDb.db);
   const eventRepo = new EventRepository(testDb.db);
   ```

2. For each test, set up state by calling real repo methods (`projectRepo.create(...)`) instead of `mockReturnValue`.

3. Replace `toHaveBeenCalledWith` assertions with state assertions:
   - Instead of `expect(projectRepo.create).toHaveBeenCalledWith({ name: "foo", rootPath: "/tmp" })`, assert `expect(projectRepo.list()).toHaveLength(1)` and check the returned project fields.
   - Instead of `expect(projectRepo.update).toHaveBeenCalledWith("proj-1", { name: "new" })`, call the route then `expect(projectRepo.getById("proj-1")?.name).toBe("new")`.
   - Instead of `expect(projectRepo.delete).toHaveBeenCalledWith("proj-1")`, assert `expect(projectRepo.getById("proj-1")).toBeUndefined()`.

4. The `threadManager` mock needs more thought. For manager hire tests, the thread manager `spawn()` actually needs to create a thread. Options:
   - Use a real `Orchestrator` — most complete but requires more setup (provider, environment registry, etc.)
   - Use a thin fake that creates threads in the real DB when `spawn()` is called — simpler, tests the route logic without the full orchestrator
   - Keep `spawn` as a mock but make it actually insert into the real DB as a side effect

   **Recommendation:** Keep `threadManager.spawn` as a mock for now (it's a boundary between route and orchestrator), but use real repos for everything else. Assert the route's behavior through HTTP response bodies and DB state, not through spy call assertions. This is a pragmatic middle ground — the orchestrator tests already cover the spawn logic thoroughly.

5. For the `deleteThreadAsync` mock — this is also a boundary (async thread deletion). Keep it as a mock but assert the HTTP response and DB state rather than the mock being called.

6. Remove `writeFileSync` / `chmodSync` workspace hacks. If testing the rollback path, mock `ensureManagerWorkspace` to throw (it's a side-effect function, not a DB operation).

### 2. Refactor `routes/threads.test.ts`

**Current state:** Mocks the entire `ThreadOrchestrator` with 30+ `vi.fn()` methods. This is the biggest offender — 2500+ lines of tests that never touch the real orchestrator.

**Target state:** Use real `Orchestrator` with in-memory DB for most tests. Mock only true boundaries (provider, environment agent).

**How:**

1. Create a test orchestrator factory that sets up a real `Orchestrator` with:
   - Real in-memory SQLite repos
   - A fake/no-op provider adapter (so `spawn` doesn't try to contact a real LLM)
   - A fake environment registry (no real worktree creation)
   - Real event handling

   The e2e tests already have something like this — check `apps/server/src/__tests__/e2e/harness.ts` for the pattern.

2. For each test:
   - Set up state with real repo calls
   - Call the route
   - Assert the HTTP response body
   - Assert the DB state (`threadRepo.getById(...)`, `eventRepo.listByThread(...)`)

3. Tests that check input validation (400 responses) are simpler — they can mostly stay as-is since they test the route's request parsing, not DB interaction.

4. Tests that check orchestrator behavior (spawn, tell, update, archive, delete, promote, demote) should verify the actual result:
   - After spawn: `expect(threadRepo.getById(newId)).toBeDefined()`
   - After tell: check events were appended
   - After archive: `expect(threadRepo.getById(id)?.archivedAt).toBeDefined()`
   - After delete: `expect(threadRepo.getById(id)).toBeUndefined()`

5. Some orchestrator methods have complex side effects (provisioning, environment creation). For these, it's OK to mock at the provider/environment boundary while keeping the orchestrator real.

**This is the largest refactoring task.** Consider splitting into sub-tasks:
- Phase A: Replace orchestrator mock with real one, fix tests that break
- Phase B: Replace call assertions with state assertions
- Phase C: Clean up remaining mocks

## P2: Smaller route tests

### 3. Refactor `routes/environments.test.ts`

Small file (63 lines). Replace `{ getById: vi.fn(), list: vi.fn() }` with real `EnvironmentRepository` on in-memory DB. Create test environments with real repo methods. Assert HTTP responses and DB state.

### 4. Refactor `routes/system.test.ts`

Replace mock orchestrator with real one (or at minimum, use a spy on a real instance). The system routes mostly call `listModels`, `listProviders`, `listEnvironments`, `getActiveCount` — these can work against a real orchestrator with empty state.

## P3: Assertion style fixes

### 5. Refactor `startup-tasks.test.ts`

Keep the mocked `threadManager.reconcileManagedArtifacts` (it's a boundary — the function has real side effects). But instead of:
```typescript
expect(threadManager.reconcileManagedArtifacts).toHaveBeenCalledTimes(1)
```
Consider:
```typescript
// Verify the startup task completed by checking the return value or state
const result = await runStartupTasks(threadManager, logger);
expect(result.reconciled).toBe(true);
```
If the function doesn't return useful state, the existing assertions are acceptable — this is low priority.

### 6. Refactor `ws-manager.test.ts`

WebSocket mocking is correct (system boundary). The assertions like `expect(socket.send).toHaveBeenCalledWith(...)` could be improved to:
```typescript
// Instead of checking send was called, check what was received
const messages = collectSentMessages(socket);
expect(messages).toContainEqual(expect.objectContaining({ type: "thread-changed" }));
```
This is a style improvement, not a bug risk. Low priority.

### 7. Refactor `http-server-close.test.ts`

Same pattern — mocking the server is fine, but assertions should verify the close behavior completed rather than checking call counts. Low priority.

# Validation

- All existing tests must still pass after refactoring (same coverage, better assertions)
- `pnpm exec turbo run test --filter=@bb/server --force` — all server tests green
- `pnpm exec turbo run typecheck --filter=@bb/server --force` — typecheck clean
- CI must pass (the Linux filesystem flake should be eliminated by removing workspace file hacks)

# Open Questions/Risks

- **P1 threads.test.ts is 2500+ lines.** Refactoring it with a real orchestrator is a big change. Consider doing it incrementally — start with a few representative tests and expand.
- **Provider/environment mocking.** Even with a real orchestrator, we need to mock the provider (LLM API) and environment provisioning (worktree creation). The e2e harness has patterns for this — use fake-codex and fake environments.
- **Test performance.** Real in-memory SQLite is fast, but setting up a full orchestrator per test might be slower than mock-based tests. Use `beforeAll` for shared setup where possible.
- **The `threadManager` boundary for project routes.** The project route tests only use `threadManager.spawn` and `threadManager.deleteThread`. These could remain as mocks (they're a boundary) while repos become real. This is the pragmatic approach for P1.
