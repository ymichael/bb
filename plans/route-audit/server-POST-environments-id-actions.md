# `POST /api/v1/environments/:id/actions` — Execute Environment Action

**Route:** `apps/server/src/routes/environments.ts:93`
**Contract:** `PathId & { json: EnvironmentActionRequest } -> EnvironmentActionResponse` (200) | `EnvironmentActionApiError` (409) | `ApiError` (404)
**Complexity:** Medium (4 action types, daemon commands, AI commit message generation)

## Request Body (or Params)

| Field                          | Required                    | Notes                                                                                                                                                                                           |
| ------------------------------ | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `:id` (path)                   | Yes                         | Environment ID. Looked up via `requireReadyEnvironment`.                                                                                                                                        |
| `action`                       | Yes                         | Discriminant: `"commit"`, `"squash_merge"`, `"promote"`, `"demote"`.                                                                                                                            |
| `options.mergeBaseBranch`      | Required for `squash_merge` | Target branch for squash merge, passed as `targetBranch` to `workspace.squash_merge`.                                                                                                           |

**All fields consumed. No dead params.** The `commit`, `promote`, and `demote` variants have no `options` field.

## Implementation Trace

### Common preamble (all actions)

1. (sync) `requireReadyEnvironment(deps.db, id)` — PK lookup, validates `status === "ready"` and `path` exists.

### `commit` action

2. (async) `queueCommandAndWait` with `workspace.status` — checks for uncommitted changes. Returns 409 `no_changes` if workspace is clean.
3. (async) `queueCommandAndWait` with `workspace.diff` (target: `uncommitted`) — fetches diff for AI commit message generation.
4. (async) `generateCommitMessage(deps, { diffDescription, shortstat, files, patch })` — calls inference model with 10s timeout. Falls back to `"bb: automated commit"` on failure. Diff and file list are truncated before sending to the LLM (32KB / 4KB caps).
5. (async) `queueCommandAndWait` with `workspace.commit` command (`environmentId`, `workspaceContext`, `message`).
6. (sync) Parses result — extracts `commitSha`, `commitSubject`.
7. Returns `{ ok, action: "commit", message, commitSha, commitSubject }`.

### `squash_merge` action

2. (async) `queueCommandAndWait` with `workspace.status` — checks for uncommitted changes and current branch. Returns 409 if `currentBranch` is null (detached HEAD).
3. (async, conditional) If dirty: `queueCommandAndWait` with `workspace.commit` using `"bb: pre-merge commit"` to flush uncommitted changes before merging.
4. (async) `queueCommandAndWait` with `workspace.diff` (target: `branch_committed`, `mergeBaseBranch`) — fetches branch diff for AI commit message generation.
5. (async) `generateCommitMessage(deps, ...)` — same inference call as commit, falls back to `"bb: squash merge"`.
6. (async) `queueCommandAndWait` with `workspace.squash_merge` command (`environmentId`, `workspaceContext`, `targetBranch`, `commitMessage`).
7. (sync) Parses result — extracts `merged`, `commitSha`.
8. Returns `{ ok, action: "squash_merge", merged, message, commitSha }`.

### `promote` action

2. (sync) `getDefaultProjectSource(deps.db, environment.projectId)` — queries `project_sources WHERE projectId = ? AND isDefault = true`.
3. (sync) Validates `source?.path` exists and `source.hostId === environment.hostId`. Throws 409 if not promotable.
4. (async) `queueCommandAndWait` with `workspace.promote` command (`environmentId`, `workspaceContext`, `primaryPath`).
5. Returns `{ ok, action: "promote", message }`.

### `demote` action

2. (sync) `getDefaultProjectSource(deps.db, environment.projectId)` — same query as promote.
3. (sync) Validates `source?.path`, `source.hostId === environment.hostId`, `environment.branchName`, and `environment.mergeBaseBranch ?? environment.defaultBranch` are present. Throws 409 if not demotable.
4. (async) `queueCommandAndWait` with `workspace.demote` command (`environmentId`, `workspaceContext`, `primaryPath`, `defaultBranch`, `envBranch`).
5. Returns `{ ok, action: "demote", message }`.

> **-> HTTP 200 returns here.**

## DB Query Summary

### Common (all actions)

| #   | Query                                                                                              | Table                  | Index                                  | Notes         |
| --- | -------------------------------------------------------------------------------------------------- | ---------------------- | -------------------------------------- | ------------- |
| 1   | `SELECT * FROM environments WHERE id = ?`                                                          | `environments`         | PK                                     |               |
| 2   | `SELECT * FROM host_daemon_sessions WHERE hostId = ? AND status = 'active' AND leaseExpiresAt > ?` | `host_daemon_sessions` | `host_daemon_sessions_host_status_idx` |               |
| 3-4 | cursor max + INSERT into `host_daemon_commands`                                                    | `host_daemon_commands` | `host_daemon_commands_host_cursor_idx` | Transaction   |

### Additional for promote/demote

| #   | Query                                                                    | Table             | Index                         | Notes |
| --- | ------------------------------------------------------------------------ | ----------------- | ----------------------------- | ----- |
| 6   | `SELECT * FROM project_sources WHERE projectId = ? AND isDefault = true` | `project_sources` | `project_sources_project_idx` |       |

**Total: 4-5 queries depending on action type. No N+1.**

## Code Reuse

| Function                         | Shared? | Other callers                          |
| -------------------------------- | ------- | -------------------------------------- |
| `requireReadyEnvironment`        | Shared  | status, diff, diff/branches            |
| `queueCommandAndWait`            | Shared  | All daemon-proxying routes             |
| `getDefaultProjectSource`        | Shared  | DB data layer, used by thread creation |
| `queueEnvironmentDestroyCommand` | Shared  | Called from `maybeCleanupEnvironment`  |

## Flags

1. **Exhaustive switch**: the `default` branch uses `never` typing to catch unhandled action types at compile time.

## Usages

| Caller                                          | Location                                                            | Purpose                                                                                                     |
| ----------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `requestEnvironmentAction` API wrapper          | `apps/app/src/lib/api.ts:469`                                       | Posts an environment action (commit, squash_merge, promote, demote)                                         |
| `useRequestEnvironmentAction` hook              | `apps/app/src/hooks/useApi.ts:1078`                                 | React Query mutation wrapping `requestEnvironmentAction`; invalidates environment/thread queries on success |
| `ThreadDetailView`                              | `apps/app/src/views/ThreadDetailView.tsx:246`                       | Uses `useRequestEnvironmentAction` for commit, squash-merge, promote, and demote buttons                    |
| CLI `environment commit`                        | `apps/cli/src/commands/environment.ts:55`                           | Sends `action: "commit"` for a given environment                                                            |
| CLI `environment squash-merge`                  | `apps/cli/src/commands/environment.ts:83`                           | Sends `action: "squash_merge"` for a given environment                                                      |
| CLI `environment promote`                       | `apps/cli/src/commands/environment.ts:107`                          | Sends `action: "promote"` for a given environment                                                           |
| CLI `environment demote`                        | `apps/cli/src/commands/environment.ts:126`                          | Sends `action: "demote"` for a given environment                                                            |
| `runEnvironmentAction` test helper              | `tests/integration/helpers/api.ts:313`                              | Integration test helper wrapping `api.environments[":id"].actions.$post`                                    |
| `smoke.test.ts`                                 | `tests/integration/fake/smoke.test.ts:431`                          | Tests commit, squash-merge, promote, demote actions                                                         |
| `multi-thread.test.ts`                          | `tests/integration/fake/multi-thread.test.ts:361`                   | Tests actions across multiple threads sharing environments                                                  |
| `public-environments-system.test.ts`            | `apps/server/test/public-environments-system.test.ts:208`           | Tests action responses, 409 conflicts, and 404 errors                                                       |
| `public-environment-action-regressions.test.ts` | `apps/server/test/public-environment-action-regressions.test.ts:25` | Regression tests for edge cases (missing env, auto-archive, cleanup)                                        |

---

> **Updated 2026-03-29:** DB functions now use RETURNING — post-write re-reads eliminated.
> **Updated 2026-03-30:** Commit and squash merge restructured. `message` removed from `commitOptionsSchema` — server now generates commit messages via AI inference (with fallback). Commit action checks status before proceeding (409 on clean workspace). Squash merge auto-commits dirty state, guards detached HEAD, generates AI message for the squash commit. `commitMessage` added to `workspace.squash_merge` command schema. Diff/file payloads truncated before sending to LLM. `--no-verify` hardcoded in daemon for all automated commits.
