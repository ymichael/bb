# `GET /api/v1/environments/:id/diff` — Get Workspace Git Diff

**Route:** `apps/server/src/routes/environments.ts:57`
**Contract:** `PathId & { query: EnvironmentDiffQuery } -> ThreadGitDiffResponse` (200)
**Complexity:** Medium (dispatches daemon command, awaits result)

## Request Body (or Params)

| Field | Required | Notes |
|---|---|---|
| `:id` (path) | Yes | Environment ID. Looked up via `requireReadyEnvironment`. |
| `selection` (query) | Yes | Discriminant: `"combined"` or `"commit"`. Determines the diff mode passed to the daemon. |
| `commitSha` (query) | Required when `selection === "commit"` | Specific commit SHA to diff. Passed to daemon as `selection.sha`. |
| `mergeBaseBranch` (query) | Yes | Passed directly to the daemon command for merge-base-relative diffing. |

**All fields consumed. No dead params.** The `toWorkspaceDiffSelection` helper maps the query discriminated union into the daemon command's `selection` format.

## Implementation Trace

1. (sync) `requireReadyEnvironment(deps.db, id)` — PK lookup, validates `status === "ready"` and `path` exists.
2. (sync) `toWorkspaceDiffSelection(query)` — maps query `selection` to the daemon command shape (`{ type: "commit", sha }` or `{ type: "combined" }`).
3. (async) `queueCommandAndWait(deps, {...})` — queues `workspace.diff` command with `environmentId`, `workspacePath`, `selection`, `mergeBaseBranch`. Same flow as status route (session check -> queue -> wait -> validate).
4. (sync) Parses result with `hostDaemonCommandResultSchemaByType["workspace.diff"]`, returns `.diff`.

> **-> HTTP 200 returns here.** No background work.

## DB Query Summary

| # | Query | Table | Index | Notes |
|---|-------|-------|-------|-------|
| 1 | `SELECT * FROM environments WHERE id = ?` | `environments` | PK | |
| 2 | `SELECT * FROM host_daemon_sessions WHERE hostId = ? AND status = 'active' AND leaseExpiresAt > ?` | `host_daemon_sessions` | `host_daemon_sessions_host_status_idx` | |
| 3 | `SELECT max(cursor) FROM host_daemon_commands WHERE hostId = ?` | `host_daemon_commands` | `host_daemon_commands_host_cursor_idx` | Inside transaction |
| 4 | `INSERT INTO host_daemon_commands ...` | `host_daemon_commands` | — | Inside same transaction |

**Total: 4 queries. No N+1.**

## Code Reuse

| Function | Shared? | Other callers |
|---|---|---|
| `requireReadyEnvironment` | Shared | status, diff/branches, actions |
| `queueCommandAndWait` | Shared | All daemon-proxying routes |
| `toWorkspaceDiffSelection` | One-off | Only this route (file-local helper) |

## Flags

None. Clean daemon proxy with properly validated discriminated union query.

## Usages

| Caller | Location | Purpose |
|---|---|---|
| `getEnvironmentDiff` API wrapper | `apps/app/src/lib/api.ts:516` | Fetches git diff for an environment (combined or per-commit) |
| `useEnvironmentGitDiff` hook | `apps/app/src/hooks/useApi.ts:667` | React Query hook wrapping `getEnvironmentDiff` |
| `useGitDiffPanel` | `apps/app/src/views/useGitDiffPanel.ts:107` | Consumes `useEnvironmentGitDiff` to power the diff panel in thread detail |
| `ThreadDetailView` | `apps/app/src/views/ThreadDetailView.tsx:353` | Uses `useGitDiffPanel` which fetches diff data |
| CLI `thread show --git-diff` | `apps/cli/src/commands/thread/show.ts:173` | Fetches combined diff when `--git-diff` flag is passed |
| `getEnvironmentDiff` test helper | `tests/integration/helpers/api.ts:231` | Integration test helper wrapping `api.environments[":id"].diff.$get` |
| `smoke.test.ts` | `tests/integration/fake/smoke.test.ts:402` | Verifies diff content after file changes |
| `provider-smoke.test.ts` | `tests/integration/real/provider-smoke.test.ts:456` | Verifies diff in real provider tests |
| `public-environments-system.test.ts` | `apps/server/test/public-environments-system.test.ts:50` | Tests validation (missing mergeBaseBranch) and success responses |

---

## Review Comments

<!-- Leave comments, questions, or follow-ups below. Delete this file if no action needed. -->
