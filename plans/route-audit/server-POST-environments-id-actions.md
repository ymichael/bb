# `POST /api/v1/environments/:id/actions` — Execute Environment Action

**Route:** `apps/server/src/routes/environments.ts:93`
**Contract:** `PathId & { json: EnvironmentActionRequest } -> EnvironmentActionResponse` (200) | `EnvironmentActionApiError` (409) | `ApiError` (404)
**Complexity:** High (4 action types, daemon commands, conditional thread archiving, conditional environment cleanup)

## Request Body (or Params)

| Field                          | Required                    | Notes                                                                                                                                                                                           |
| ------------------------------ | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `:id` (path)                   | Yes                         | Environment ID. Looked up via `requireReadyEnvironment`.                                                                                                                                        |
| `threadId`                     | Yes (all actions)           | Validated to belong to this environment via `requireThreadInEnvironment`. Used for promote/demote daemon commands. For commit/squash_merge, the thread is the target for optional auto-archive. |
| `action`                       | Yes                         | Discriminant: `"commit"`, `"squash_merge"`, `"promote"`, `"demote"`.                                                                                                                            |
| `options.autoArchiveOnSuccess` | Required for `commit`       | If true and commit succeeds, archives the acting thread and may trigger environment cleanup.                                                                                                    |
| `options.mergeBaseBranch`      | Required for `squash_merge` | Target branch for squash merge, passed as `targetBranch` to `workspace.squash_merge`.                                                                                                           |
| `options.autoArchiveOnSuccess` | Required for `squash_merge` | Same as commit — archives thread on success.                                                                                                                                                    |

**All fields consumed. No dead params.** The `promote` and `demote` variants have no `options` field.

## Implementation Trace

### Common preamble (all actions)

1. (sync) `requireReadyEnvironment(deps.db, id)` — PK lookup, validates `status === "ready"` and `path` exists.
2. (sync) `requireThreadInEnvironment(deps.db, environmentId, threadId)`:
   - Calls `getThread(db, threadId)` — PK lookup on `threads`. Throws 404 if missing.
   - Validates `thread.environmentId === environmentId`. Throws 409 if mismatch.

### `commit` action

3. (async) `queueCommandAndWait` with `workspace.status` — checks for uncommitted changes. Returns 409 `no_changes` if workspace is clean.
4. (async) `queueCommandAndWait` with `workspace.diff` (target: `uncommitted`) — fetches diff for AI commit message generation.
5. (async) `generateCommitMessage(deps, { diffDescription, shortstat, files, patch })` — calls inference model with 10s timeout. Falls back to `"bb: automated commit"` on failure. Diff and file list are truncated before sending to the LLM (32KB / 4KB caps).
6. (async) `queueCommandAndWait` with `workspace.commit` command (`environmentId`, `workspaceContext`, `message`).
7. (sync) Parses result — extracts `commitSha`, `commitSubject`.
8. (sync) If `autoArchiveOnSuccess`:
   - `archiveThread(deps.db, deps.hub, actingThread.id)` — sets `archivedAt` on the thread, notifies hub.
9. (async) If thread was archived: `maybeCleanupEnvironment(deps, archivedThread.environmentId)`:
   - Looks up environment, checks `managed`, not already `destroying`/`destroyed`.
   - Counts non-archived threads in this environment (`threads WHERE environmentId = ? AND archivedAt IS NULL`).
   - If count is 0: updates environment status to `"destroying"`, queues `environment.destroy` command to daemon.
10. Returns `{ ok, action: "commit", message, autoArchived, commitSha, commitSubject }`.

### `squash_merge` action

3. (async) `queueCommandAndWait` with `workspace.status` — checks for uncommitted changes and current branch. Returns 409 if `currentBranch` is null (detached HEAD).
4. (async, conditional) If dirty: `queueCommandAndWait` with `workspace.commit` using `"bb: pre-merge commit"` to flush uncommitted changes before merging.
5. (async) `queueCommandAndWait` with `workspace.diff` (target: `branch_committed`, `mergeBaseBranch`) — fetches branch diff for AI commit message generation.
6. (async) `generateCommitMessage(deps, ...)` — same inference call as commit, falls back to `"bb: squash merge"`.
7. (async) `queueCommandAndWait` with `workspace.squash_merge` command (`environmentId`, `workspaceContext`, `targetBranch`, `commitMessage`).
8. (sync) Parses result — extracts `merged`, `commitSha`.
   9-10. Same auto-archive + cleanup flow as `commit`.
11. Returns `{ ok, action: "squash_merge", merged, message, autoArchived, commitSha }`.

### `promote` action

3. (sync) `getDefaultProjectSource(deps.db, environment.projectId)` — queries `project_sources WHERE projectId = ? AND isDefault = true`.
4. (sync) Validates `source?.path` exists and `source.hostId === environment.hostId`. Throws 409 if not promotable.
5. (async) `queueCommandAndWait` with `workspace.promote` command (`environmentId`, `workspaceContext`, `threadId`, `primaryPath`).
6. Returns `{ ok, action: "promote", message }`.

### `demote` action

3. (sync) `getDefaultProjectSource(deps.db, environment.projectId)` — same query as promote.
4. (sync) Validates `source?.path`, `source.hostId === environment.hostId`, `environment.branchName`, and `actingThread.mergeBaseBranch` are all present. Throws 409 if not demotable.
5. (async) `queueCommandAndWait` with `workspace.demote` command (`environmentId`, `workspaceContext`, `threadId`, `primaryPath`, `defaultBranch`, `envBranch`).
6. Returns `{ ok, action: "demote", message }`.

> **-> HTTP 200 returns here.** For commit/squash_merge with autoArchive: the environment cleanup (including potential `environment.destroy` command) runs **before** the response — it's awaited. The `environment.destroy` command is fire-and-forget (queued but not awaited).

## DB Query Summary

### Common (all actions)

| #   | Query                                                                                              | Table                  | Index                                  | Notes         |
| --- | -------------------------------------------------------------------------------------------------- | ---------------------- | -------------------------------------- | ------------- |
| 1   | `SELECT * FROM environments WHERE id = ?`                                                          | `environments`         | PK                                     |               |
| 2   | `SELECT * FROM threads WHERE id = ?`                                                               | `threads`              | PK                                     | Thread lookup |
| 3   | `SELECT * FROM host_daemon_sessions WHERE hostId = ? AND status = 'active' AND leaseExpiresAt > ?` | `host_daemon_sessions` | `host_daemon_sessions_host_status_idx` |               |
| 4-5 | cursor max + INSERT into `host_daemon_commands`                                                    | `host_daemon_commands` | `host_daemon_commands_host_cursor_idx` | Transaction   |

### Additional for commit/squash_merge with autoArchive

| #     | Query                                                                         | Table                  | Index                                  | Notes                                |
| ----- | ----------------------------------------------------------------------------- | ---------------------- | -------------------------------------- | ------------------------------------ |
| 6     | `UPDATE threads SET archivedAt = ?, updatedAt = ?`                            | `threads`              | PK                                     | `archiveThread`                      |
| 7     | `SELECT * FROM environments WHERE id = ?`                                     | `environments`         | PK                                     | `maybeCleanupEnvironment` re-fetches |
| 8     | `SELECT count(*) FROM threads WHERE environmentId = ? AND archivedAt IS NULL` | `threads`              | `threads_environment_idx`              | Live thread count                    |
| 9     | `UPDATE environments SET status = 'destroying'`                               | `environments`         | PK                                     | Only if count = 0                    |
| 10    | `SELECT * FROM host_daemon_sessions ...`                                      | `host_daemon_sessions` | `host_daemon_sessions_host_status_idx` | For destroy command                  |
| 11-12 | cursor max + INSERT `environment.destroy`                                     | `host_daemon_commands` | `host_daemon_commands_host_cursor_idx` | Fire-and-forget                      |

### Additional for promote/demote

| #   | Query                                                                    | Table             | Index                         | Notes |
| --- | ------------------------------------------------------------------------ | ----------------- | ----------------------------- | ----- |
| 6   | `SELECT * FROM project_sources WHERE projectId = ? AND isDefault = true` | `project_sources` | `project_sources_project_idx` |       |

**Total: 5-12 queries depending on action type. No N+1.**

## Code Reuse

| Function                         | Shared? | Other callers                          |
| -------------------------------- | ------- | -------------------------------------- |
| `requireReadyEnvironment`        | Shared  | status, diff, diff/branches            |
| `requireThreadInEnvironment`     | Shared  | Only this route                        |
| `queueCommandAndWait`            | Shared  | All daemon-proxying routes             |
| `archiveThread`                  | Shared  | Thread archive route                   |
| `maybeCleanupEnvironment`        | Shared  | Thread archive route                   |
| `getDefaultProjectSource`        | Shared  | DB data layer, used by thread creation |
| `queueEnvironmentDestroyCommand` | Shared  | Called from `maybeCleanupEnvironment`  |

## Flags

1. **`maybeCleanupEnvironment` re-fetches the environment** even though `requireReadyEnvironment` already fetched it at the top. This is a minor redundancy but ensures fresh state after the daemon command completes, so it's arguably correct.

2. **`environment.destroy` command is fire-and-forget** — queued via `queueCommand` (not `queueCommandAndWait`). If the daemon is disconnected, `getActiveSession` returns null and the command is queued with `sessionId: null`. The command will sit pending until a daemon connects. This seems intentional.

3. **Exhaustive switch**: the `default` branch uses `never` typing to catch unhandled action types at compile time.

## Usages

| Caller                                          | Location                                                            | Purpose                                                                                                     |
| ----------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `requestEnvironmentAction` API wrapper          | `apps/app/src/lib/api.ts:469`                                       | Posts an environment action (commit, squash_merge, promote, demote)                                         |
| `useRequestEnvironmentAction` hook              | `apps/app/src/hooks/useApi.ts:1078`                                 | React Query mutation wrapping `requestEnvironmentAction`; invalidates environment/thread queries on success |
| `ThreadDetailView`                              | `apps/app/src/views/ThreadDetailView.tsx:246`                       | Uses `useRequestEnvironmentAction` for commit, squash-merge, promote, and demote buttons                    |
| CLI `environment commit`                        | `apps/cli/src/commands/environment.ts:55`                           | Sends `action: "commit"` for a given environment and thread                                                 |
| CLI `environment squash-merge`                  | `apps/cli/src/commands/environment.ts:86`                           | Sends `action: "squash_merge"` for a given environment and thread                                           |
| CLI `environment promote`                       | `apps/cli/src/commands/environment.ts:112`                          | Sends `action: "promote"` for a given environment and thread                                                |
| CLI `environment demote`                        | `apps/cli/src/commands/environment.ts:132`                          | Sends `action: "demote"` for a given environment and thread                                                 |
| `runEnvironmentAction` test helper              | `tests/integration/helpers/api.ts:313`                              | Integration test helper wrapping `api.environments[":id"].actions.$post`                                    |
| `smoke.test.ts`                                 | `tests/integration/fake/smoke.test.ts:431`                          | Tests commit, squash-merge, promote, demote actions                                                         |
| `multi-thread.test.ts`                          | `tests/integration/fake/multi-thread.test.ts:361`                   | Tests actions across multiple threads sharing environments                                                  |
| `public-environments-system.test.ts`            | `apps/server/test/public-environments-system.test.ts:208`           | Tests action responses, 409 conflicts, and 404 errors                                                       |
| `public-environment-action-regressions.test.ts` | `apps/server/test/public-environment-action-regressions.test.ts:25` | Regression tests for edge cases (missing env, auto-archive, cleanup)                                        |

---

> **Updated 2026-03-29:** DB functions now use RETURNING — post-write re-reads eliminated.
> **Updated 2026-03-30:** Commit and squash merge restructured. `message` removed from `commitOptionsSchema` — server now generates commit messages via AI inference (with fallback). Commit action checks status before proceeding (409 on clean workspace). Squash merge auto-commits dirty state, guards detached HEAD, generates AI message for the squash commit. `commitMessage` added to `workspace.squash_merge` command schema. Diff/file payloads truncated before sending to LLM. `--no-verify` hardcoded in daemon for all automated commits.

## Review Comments

Should the request payload be a discriminated union? is it already one?

> Yes — `environmentActionRequestSchema` is already a discriminated union on `action`. Four variants: `promote` (no options), `demote` (no options), `commit` (with `commitOptionsSchema`), `squash_merge` (with `squashMergeOptionsSchema`).
