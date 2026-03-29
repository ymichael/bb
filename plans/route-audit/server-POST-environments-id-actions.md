# `POST /api/v1/environments/:id/actions` — Execute Environment Action

**Route:** `apps/server/src/routes/environments.ts:93`
**Contract:** `PathId & { json: EnvironmentActionRequest } -> EnvironmentActionResponse` (200) | `EnvironmentActionApiError` (409) | `ApiError` (404)
**Complexity:** High (4 action types, daemon commands, conditional thread archiving, conditional environment cleanup)

## Request Body (or Params)

| Field | Required | Notes |
|---|---|---|
| `:id` (path) | Yes | Environment ID. Looked up via `requireReadyEnvironment`. |
| `threadId` | Yes (all actions) | Validated to belong to this environment via `requireThreadInEnvironment`. Used for promote/demote daemon commands. For commit/squash_merge, the thread is the target for optional auto-archive. |
| `action` | Yes | Discriminant: `"commit"`, `"squash_merge"`, `"promote"`, `"demote"`. |
| `options.message` | Required for `commit` | Commit message passed to `workspace.commit` daemon command. |
| `options.autoArchiveOnSuccess` | Required for `commit` | If true and commit succeeds, archives the acting thread and may trigger environment cleanup. |
| `options.mergeBaseBranch` | Required for `squash_merge` | Target branch for squash merge, passed as `targetBranch` to `workspace.squash_merge`. |
| `options.autoArchiveOnSuccess` | Required for `squash_merge` | Same as commit — archives thread on success. |

**All fields consumed. No dead params.** The `promote` and `demote` variants have no `options` field.

## Implementation Trace

### Common preamble (all actions)

1. (sync) `requireReadyEnvironment(deps.db, id)` — PK lookup, validates `status === "ready"` and `path` exists.
2. (sync) `requireThreadInEnvironment(deps.db, environmentId, threadId)`:
   - Calls `getThread(db, threadId)` — PK lookup on `threads`. Throws 404 if missing.
   - Validates `thread.environmentId === environmentId`. Throws 409 if mismatch.

### `commit` action

3. (async) `queueCommandAndWait` with `workspace.commit` command (`environmentId`, `workspacePath`, `message`).
4. (sync) Parses result — extracts `commitSha`, `commitSubject`.
5. (sync) If `autoArchiveOnSuccess`:
   - `archiveThread(deps.db, deps.hub, actingThread.id)` — sets `archivedAt` on the thread, notifies hub.
6. (async) If thread was archived: `maybeCleanupEnvironment(deps, archivedThread.environmentId)`:
   - Looks up environment, checks `managed`, not already `destroying`/`destroyed`.
   - Counts non-archived threads in this environment (`threads WHERE environmentId = ? AND archivedAt IS NULL`).
   - If count is 0: updates environment status to `"destroying"`, queues `environment.destroy` command to daemon.
7. Returns `{ ok, action: "commit", message, autoArchived, commitSha, commitSubject }`.

### `squash_merge` action

3. (async) `queueCommandAndWait` with `workspace.squash_merge` command (`environmentId`, `workspacePath`, `targetBranch`).
4. (sync) Parses result — extracts `merged`, `commitSha`.
5-6. Same auto-archive + cleanup flow as `commit`.
7. Returns `{ ok, action: "squash_merge", merged, message, autoArchived, commitSha }`.

### `promote` action

3. (sync) `getDefaultProjectSource(deps.db, environment.projectId)` — queries `project_sources WHERE projectId = ? AND isDefault = true`.
4. (sync) Validates `source?.path` exists and `source.hostId === environment.hostId`. Throws 409 if not promotable.
5. (async) `queueCommandAndWait` with `workspace.promote` command (`environmentId`, `workspacePath`, `threadId`, `primaryPath`).
6. Returns `{ ok, action: "promote", message }`.

### `demote` action

3. (sync) `getDefaultProjectSource(deps.db, environment.projectId)` — same query as promote.
4. (sync) Validates `source?.path`, `source.hostId === environment.hostId`, `environment.branchName`, and `actingThread.mergeBaseBranch` are all present. Throws 409 if not demotable.
5. (async) `queueCommandAndWait` with `workspace.demote` command (`environmentId`, `workspacePath`, `threadId`, `primaryPath`, `defaultBranch`, `envBranch`).
6. Returns `{ ok, action: "demote", message }`.

> **-> HTTP 200 returns here.** For commit/squash_merge with autoArchive: the environment cleanup (including potential `environment.destroy` command) runs **before** the response — it's awaited. The `environment.destroy` command is fire-and-forget (queued but not awaited).

## DB Query Summary

### Common (all actions)

| # | Query | Table | Index | Notes |
|---|-------|-------|-------|-------|
| 1 | `SELECT * FROM environments WHERE id = ?` | `environments` | PK | |
| 2 | `SELECT * FROM threads WHERE id = ?` | `threads` | PK | Thread lookup |
| 3 | `SELECT * FROM host_daemon_sessions WHERE hostId = ? AND status = 'active' AND leaseExpiresAt > ?` | `host_daemon_sessions` | `host_daemon_sessions_host_status_idx` | |
| 4-5 | cursor max + INSERT into `host_daemon_commands` | `host_daemon_commands` | `host_daemon_commands_host_cursor_idx` | Transaction |

### Additional for commit/squash_merge with autoArchive

| # | Query | Table | Index | Notes |
|---|-------|-------|-------|-------|
| 6 | `UPDATE threads SET archivedAt = ?, updatedAt = ?` + re-SELECT | `threads` | PK | `archiveThread` |
| 7 | `SELECT * FROM environments WHERE id = ?` | `environments` | PK | `maybeCleanupEnvironment` re-fetches |
| 8 | `SELECT count(*) FROM threads WHERE environmentId = ? AND archivedAt IS NULL` | `threads` | `threads_environment_idx` | Live thread count |
| 9 | `UPDATE environments SET status = 'destroying'` + re-SELECT | `environments` | PK | Only if count = 0 |
| 10 | `SELECT * FROM host_daemon_sessions ...` | `host_daemon_sessions` | `host_daemon_sessions_host_status_idx` | For destroy command |
| 11-12 | cursor max + INSERT `environment.destroy` | `host_daemon_commands` | `host_daemon_commands_host_cursor_idx` | Fire-and-forget |

### Additional for promote/demote

| # | Query | Table | Index | Notes |
|---|-------|-------|-------|-------|
| 6 | `SELECT * FROM project_sources WHERE projectId = ? AND isDefault = true` | `project_sources` | `project_sources_project_idx` | |

**Total: 5-12 queries depending on action type. No N+1.**

## Code Reuse

| Function | Shared? | Other callers |
|---|---|---|
| `requireReadyEnvironment` | Shared | status, diff, diff/branches |
| `requireThreadInEnvironment` | Shared | Only this route |
| `queueCommandAndWait` | Shared | All daemon-proxying routes |
| `archiveThread` | Shared | Thread archive route |
| `maybeCleanupEnvironment` | Shared | Thread archive route |
| `getDefaultProjectSource` | Shared | DB data layer, used by thread creation |
| `queueEnvironmentDestroyCommand` | Shared | Called from `maybeCleanupEnvironment` |

## Flags

1. **`maybeCleanupEnvironment` re-fetches the environment** even though `requireReadyEnvironment` already fetched it at the top. This is a minor redundancy but ensures fresh state after the daemon command completes, so it's arguably correct.

2. **`environment.destroy` command is fire-and-forget** — queued via `queueCommand` (not `queueCommandAndWait`). If the daemon is disconnected, `getActiveSession` returns null and the command is queued with `sessionId: null`. The command will sit pending until a daemon connects. This seems intentional.

3. **Exhaustive switch**: the `default` branch uses `never` typing to catch unhandled action types at compile time.

## Usages

| Caller | Location | Purpose |
|---|---|---|
| `requestEnvironmentAction` API wrapper | `apps/app/src/lib/api.ts:469` | Posts an environment action (commit, squash_merge, promote, demote) |
| `useRequestEnvironmentAction` hook | `apps/app/src/hooks/useApi.ts:1078` | React Query mutation wrapping `requestEnvironmentAction`; invalidates environment/thread queries on success |
| `ThreadDetailView` | `apps/app/src/views/ThreadDetailView.tsx:246` | Uses `useRequestEnvironmentAction` for commit, squash-merge, promote, and demote buttons |
| CLI `environment commit` | `apps/cli/src/commands/environment.ts:55` | Sends `action: "commit"` for a given environment and thread |
| CLI `environment squash-merge` | `apps/cli/src/commands/environment.ts:86` | Sends `action: "squash_merge"` for a given environment and thread |
| CLI `environment promote` | `apps/cli/src/commands/environment.ts:112` | Sends `action: "promote"` for a given environment and thread |
| CLI `environment demote` | `apps/cli/src/commands/environment.ts:132` | Sends `action: "demote"` for a given environment and thread |
| `runEnvironmentAction` test helper | `tests/integration/helpers/api.ts:313` | Integration test helper wrapping `api.environments[":id"].actions.$post` |
| `smoke.test.ts` | `tests/integration/fake/smoke.test.ts:431` | Tests commit, squash-merge, promote, demote actions |
| `multi-thread.test.ts` | `tests/integration/fake/multi-thread.test.ts:361` | Tests actions across multiple threads sharing environments |
| `public-environments-system.test.ts` | `apps/server/test/public-environments-system.test.ts:208` | Tests action responses, 409 conflicts, and 404 errors |
| `public-environment-action-regressions.test.ts` | `apps/server/test/public-environment-action-regressions.test.ts:25` | Regression tests for edge cases (missing env, auto-archive, cleanup) |

---

## Review Comments

<!-- Leave comments, questions, or follow-ups below. Delete this file if no action needed. -->
