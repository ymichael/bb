# `GET /api/v1/threads/:id/manager-workspace/files` — List Durable Manager Workspace Files

**Route:** `apps/server/src/routes/threads/data.ts`
**Contract:** `PathId & { query?: ManagerWorkspaceFilesQuery } -> WorkspaceFileListResponse` (200)
**Complexity:** Medium

## Request Params

| Field | Required | Notes |
|---|---|---|
| `:id` | Yes | Thread ID. Must resolve to a manager thread. |
| `query` | No | Case-insensitive substring filter passed through to `host.list_files`. |
| `limit` | No | Positive integer string. Defaults to `1000`, capped at `10000`. |

**All 3 fields consumed. No dead params.**

## Implementation Trace

1. `requireManagerWorkspaceTarget(deps, { threadId })`:
   - `requireThread(db, id)` -> 404 if missing
   - rejects non-manager threads with 409
   - rejects threads without an environment with 409
   - `requireEnvironment(db, environmentId)` -> 404 if missing
   - `requireManagerWorkspacePath(deps, { hostId, threadId })`:
     - `requireConnectedHostSession(deps, hostId)` -> 502 if disconnected
     - reads the active session `dataDir`
     - builds `<dataDir>/workspace/<threadId>`
2. Parses `limit` with default `1000` and max `10000`.
3. Calls `queueCommandAndWait(...)` with `host.list_files` rooted at the durable manager workspace path.
4. Parses the daemon result as `host.list_files` and returns `{ files, truncated }`.
5. Special case: daemon `ENOENT` is treated as an empty workspace and returns `{ files: [], truncated: false }`.

## DB Query Summary

| # | Query | Table | Notes |
|---|---|---|---|
| 1 | `SELECT * FROM threads WHERE id = ?` | `threads` | `requireThread` |
| 2 | `SELECT * FROM environments WHERE id = ?` | `environments` | `requireEnvironment` |
| 3 | `SELECT * FROM host_daemon_sessions WHERE hostId = ? ...` | `host_daemon_sessions` | `requireConnectedHostSession` |

**Total: 3 synchronous DB lookups before the daemon command is queued.**

## Flags

1. **Manager-only route.** Standard and managed child threads receive 409 rather than reading any workspace.
2. **Server owns the durable workspace root.** The client cannot choose an arbitrary host path; it only supplies `:id`, `query`, and `limit`.
3. **Missing workspace is not an error.** A manager that has never written durable files yet gets an empty list instead of a 404.

## Usages

| Caller | Location | Purpose |
|---|---|---|
| `listManagerWorkspaceFiles` | `apps/app/src/lib/api.ts` | Fetches the file list for the manager workspace viewer |
| `useManagerWorkspaceFiles` | `apps/app/src/hooks/useApi.ts` | React Query wrapper for the same route |
| `useWorkspaceViewer` | `apps/app/src/views/useWorkspaceViewer.ts` | Loads durable manager workspace file names for the thread detail side panel |

## Review Comments

<!-- Leave comments, questions, or follow-ups below. Delete this file if no action needed. -->
