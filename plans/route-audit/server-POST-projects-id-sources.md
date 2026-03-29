# `POST /api/v1/projects/:id/sources` — Add a source to a project

**Route:** `apps/server/src/routes/projects.ts:114`
**Contract:** `createProjectSourceRequestSchema -> ProjectSource` (201)
**Complexity:** Simple CRUD

## Request Params / Body

| Field     | Required                    | Notes                                                                                                 |
| --------- | --------------------------- | ----------------------------------------------------------------------------------------------------- |
| `:id`     | Yes                         | Project ID from URL path. Used as `projectId` for the source.                                         |
| `hostId`  | Yes                         | Validated via `requireHostWithStatus`. Stored on the source row.                                      |
| `type`    | Yes                         | Discriminated union: `"local_path"` or `"github_repo"`. Determines which of `path`/`repoUrl` is used. |
| `path`    | Yes (when type=local_path)  | Stored as `path` on the source. Set to `null` when type is `github_repo`.                             |
| `repoUrl` | Yes (when type=github_repo) | Stored as `repoUrl` on the source. Set to `null` when type is `local_path`.                           |

**All fields consumed. No dead params.**

## Implementation Trace

1. `requireProject(db, id)` -- sync. Throws 404 if missing.
2. `requireHostWithStatus(db, payload.hostId)` -- sync. Throws 404 if host missing.
3. `createProjectSource(db, hub, { projectId, hostId, type, path, repoUrl })` -- sync.
   - SELECT existing sources for `projectId` (count check for default logic).
   - If this is the first source or `isDefault` was set, UPDATE all existing sources to `isDefault = false`.
   - INSERT new source row. Note: `isDefault` is not passed from the route, so it defaults to `undefined`. The DB function sets `isDefault = true` only if there are zero existing sources.
   - Notifies project `["project-sources-changed"]`.
   - SELECT back the inserted row.

> **-> HTTP 201 returns here.** Fully synchronous.

## DB Query Summary

| #   | Query                           | Table                  | Index                                  | Notes                                 |
| --- | ------------------------------- | ---------------------- | -------------------------------------- | ------------------------------------- |
| 1   | SELECT project by PK            | `projects`             | PK                                     | requireProject                        |
| 2   | SELECT host by PK               | `hosts`                | PK                                     | requireHostWithStatus                 |
| 3   | SELECT session by hostId+status | `host_daemon_sessions` | `host_daemon_sessions_host_status_idx` | active session check                  |
| 4   | SELECT sources for project      | `project_sources`      | `project_sources_project_idx`          | default-source logic                  |
| 5   | INSERT project_source           | `project_sources`      | --                                     | may fail on unique(projectId, hostId) |
| 6   | SELECT project_source by PK     | `project_sources`      | PK                                     | re-read after insert                  |

**Total: 6 queries. No N+1.**

## Code Reuse

| Function                | Shared With                              |
| ----------------------- | ---------------------------------------- |
| `requireProject`        | Most project routes                      |
| `requireHostWithStatus` | POST /projects                           |
| `createProjectSource`   | POST /projects (initial source creation) |

## Flags

1. The unique index `project_sources_project_host_idx(projectId, hostId)` means you cannot add two sources with the same host to one project. If this INSERT violates the constraint, SQLite throws an unhandled error that will surface as a 500. Should be caught and returned as a 409.
2. The route does not pass `isDefault` to `createProjectSource`. The first source added via POST /projects always gets `isDefault: true` explicitly, but subsequent sources via this route will only become default if there are zero existing sources (which shouldn't happen post-creation). This is correct behavior but the implicit defaulting is subtle.

## Usages

| Caller                    | Location                                                    | Purpose                                                                                     |
| ------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `addProjectSource` API fn | `apps/app/src/lib/api.ts:234`                               | Typed wrapper around `apiClient.projects[":id"].sources.$post()`                            |
| `ProjectList`             | `apps/app/src/components/layout/ProjectList.tsx:233`        | Adds a local source when user picks a folder for a project that has no matching host source |
| source CRUD test          | `apps/server/test/public-projects-hosts.test.ts:115`        | Tests adding a second source to a project                                                   |
| auth regression test      | `apps/server/test/public-authorization-regressions.test.ts` | (Indirectly -- seeds projects with sources, then tests cross-project access)                |

No CLI caller -- source management is only available through the web app.

---

## Review Comments

<!-- Leave comments, questions, or follow-ups below. Delete this file if no action needed. -->

Flag 1 is expected behavior. What is the error message when this happens?

> The SQLite unique constraint violation surfaces as a generic 500. This should be caught and returned as a 409 with a descriptive message. Not yet addressed in this round.

Flag 2 is fine. we should update PATCH to support setting isDefault

> Done — PATCH route now supports `isDefault`. See `server-PATCH-projects-id-sources-sourceId.md`.
