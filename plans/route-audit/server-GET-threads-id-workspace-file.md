# `GET /api/v1/threads/:id/workspace/file` — Read Single File from Thread Workspace

**Route:** `apps/server/src/routes/threads/data.ts:110`
**Contract:** `PathId & { query: ThreadWorkspaceFileQuery } -> { path: string; content: string }` (200)
**Complexity:** High

## Request Params

| Field  | Required | Notes                                                                                                |
| ------ | -------- | ---------------------------------------------------------------------------------------------------- |
| `:id`  | Yes      | Thread ID. Resolved to thread -> environmentId -> environment -> hostId for daemon dispatch.         |
| `path` | Yes      | File path to read within the workspace. Passed directly to the `workspace.read_file` daemon command. |

**All 2 fields consumed. No dead params.**

## Implementation Trace

1. **Sync** `requireThreadEnvironment(db, id)` (`services/entity-lookup.ts:134`):
   - Calls `requireThread(db, threadId)` -- throws 404 if thread not found.
   - Checks `thread.environmentId` -- throws 409 if null.
   - Calls `requireEnvironment(db, thread.environmentId)` -- throws 404 if environment not found.
   - Returns `{ thread, environment }`.
2. **Sync** `requireReadyWorkspaceEnvironment(environment)` (local helper, line 29):
   - Checks `environment.status === "ready"` and `environment.path` is truthy.
   - Throws 409 if not ready.
3. **Async** `queueCommandAndWait(deps, { hostId, timeoutMs, command })` (`services/command-wait.ts:35`):
   - Same flow as workspace/files route:
     - Validates active daemon session (throws 502 if disconnected).
     - Queues `workspace.read_file` command with `{ environmentId, workspacePath, path }` (`environmentStatus` removed).
     - Awaits daemon result with 30s timeout (throws 504 on timeout).
     - Validates result shape, throws 502 if daemon reports error.
4. **Sync** Parses raw result with `hostDaemonCommandResultSchemaByType["workspace.read_file"]`.
5. Returns `{ path, content }`.

> **-> HTTP 200 returns here.** The route is async due to the daemon command wait.

## DB Query Summary

| #   | Query                                                                                              | Table                | Index                                  | Notes                         |
| --- | -------------------------------------------------------------------------------------------------- | -------------------- | -------------------------------------- | ----------------------------- |
| 1   | `SELECT * FROM threads WHERE id = ?`                                                               | threads              | PK                                     | `requireThread`               |
| 2   | `SELECT * FROM environments WHERE id = ?`                                                          | environments         | PK                                     | `requireEnvironment`          |
| 3   | `SELECT * FROM host_daemon_sessions WHERE hostId = ? AND status = 'active' AND leaseExpiresAt > ?` | host_daemon_sessions | No dedicated index                     | `requireConnectedHostSession` |
| 4   | `SELECT MAX(cursor) FROM host_daemon_commands WHERE hostId = ?`                                    | host_daemon_commands | `host_daemon_commands_host_cursor_idx` | Inside transaction            |
| 5   | `INSERT INTO host_daemon_commands ...`                                                             | host_daemon_commands | --                                     | Insert                        |
| 6   | `SELECT * FROM host_daemon_commands WHERE id = ?`                                                  | host_daemon_commands | PK                                     | Re-read after insert          |

**Total: 6 queries (3 reads + 1 aggregate + 1 insert + 1 re-read). No N+1.**

## Code Reuse

| Function                           | Shared with                                                    |
| ---------------------------------- | -------------------------------------------------------------- |
| `requireThreadEnvironment`         | Shared with workspace/files route                              |
| `requireReadyWorkspaceEnvironment` | Local to this file; shared with workspace/files route          |
| `queueCommandAndWait`              | Shared with workspace/files, environment routes, system routes |

## Flags

> **Updated 2026-03-29:** Now uses shared `requireReadyEnvironment` helper. Path traversal guard added at the server level.

1. ~~**`requireReadyWorkspaceEnvironment` duplicates `requireReadyEnvironment`** in `entity-lookup.ts` (same issue as workspace/files). Should use the shared version.~~ **Fixed** — now uses the shared helper.
2. ~~**No path traversal guard.** The `path` query param is passed directly to the daemon's `workspace.read_file` command. Path validation/sandboxing is presumably handled by the daemon, but this is worth confirming -- if the daemon blindly joins `workspacePath + path`, a `../../etc/passwd` input could escape the workspace. Verify daemon-side validation exists.~~ **Fixed** — path traversal guard added at the server route level (in addition to the existing daemon-side guard).

## Usages

| Caller                                             | Location                                               | Purpose                                                                                                                 |
| -------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `getThreadManagerWorkspaceFile` (API client)       | `apps/app/src/lib/api.ts:351`                          | Fetches a single workspace file's content from the server                                                               |
| `useThreadManagerWorkspaceFile` (React query hook) | `apps/app/src/hooks/useApi.ts:565`                     | Wraps the API call in a `useQuery` hook                                                                                 |
| `useManagerWorkspaceViewer`                        | `apps/app/src/views/useManagerWorkspaceViewer.ts:47`   | Calls `useThreadManagerWorkspaceFile` to load the selected file content                                                 |
| `ThreadDetailView`                                 | `apps/app/src/views/ThreadDetailView.tsx:218`          | Calls `useManagerWorkspaceViewer` which fetches selected workspace file for manager threads                             |
| Server route test                                  | `apps/server/test/public-thread-data.test.ts:723`      | Direct HTTP request to `/api/v1/threads/:id/workspace/file?path=...`                                                    |
| Contract route definition                          | `packages/server-contract/src/public-api.ts:260`       | Typed route definition for `/threads/:id/workspace/file`                                                                |
| `thread-runtime-config` (server-side internal)     | `apps/server/src/services/thread-runtime-config.ts:99` | Uses the same `workspace.read_file` daemon command to read config files (not via this HTTP route, but same daemon path) |

---

## Review Comments

<!-- Flag #2 is security-relevant -- verify the daemon validates that the resolved path stays within the workspace root. -->

1. please use the shared version

> Done — switched to the shared `requireReadyEnvironment` from `entity-lookup.ts`.

2. we should do a path traversal guard regardless (in both places)

> Done — path traversal guard added at the server route level. The daemon already had its own guard; now both layers validate.
