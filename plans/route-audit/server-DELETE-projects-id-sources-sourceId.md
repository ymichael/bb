# `DELETE /api/v1/projects/:id/sources/:sourceId` — Delete a project source

**Route:** `apps/server/src/routes/projects.ts:145`
**Contract:** `PathProjectSourceId -> { ok: true }` (200)
**Complexity:** Simple CRUD (with default-source promotion)

## Request Params

| Field       | Required | Notes                                                      |
| ----------- | -------- | ---------------------------------------------------------- |
| `:id`       | Yes      | Project ID from URL path. Used to verify source ownership. |
| `:sourceId` | Yes      | Source ID from URL path. The row to delete.                |

**All 2 params consumed. No dead params.**

## Implementation Trace

1. `requireProject(db, id)` -- sync. Throws 404 if missing.
2. `requireProjectSource(deps, { projectId, sourceId })` -- sync. Throws 404 if missing or wrong project.
3. `deleteProjectSource(db, hub, sourceId)` -- sync.
   - SELECT source by PK.
   - DELETE from `project_sources` WHERE `id`.
   - If the deleted source was `isDefault`, SELECT another source for the same project and UPDATE it to `isDefault = true`.
   - Notifies project `["project-sources-changed"]`.
   - Returns boolean.
4. If false (shouldn't happen after guard), throws 404.

> **-> HTTP 200 returns here.** Fully synchronous.

## DB Query Summary

| #   | Query                         | Table             | Index                         | Notes                               |
| --- | ----------------------------- | ----------------- | ----------------------------- | ----------------------------------- |
| 1   | SELECT project by PK          | `projects`        | PK                            | requireProject                      |
| 2   | SELECT source by PK           | `project_sources` | PK                            | requireProjectSource                |
| 3   | SELECT source by PK           | `project_sources` | PK                            | deleteProjectSource existence check |
| 4   | DELETE source by PK           | `project_sources` | PK                            |                                     |
| 5   | SELECT replacement source     | `project_sources` | `project_sources_project_idx` | only if deleted was default         |
| 6   | UPDATE replacement to default | `project_sources` | PK                            | only if deleted was default         |

**Total: 4-6 queries depending on default promotion. No N+1.**

## Code Reuse

| Function               | Shared With         |
| ---------------------- | ------------------- |
| `requireProject`       | Most project routes |
| `requireProjectSource` | PATCH sources       |
| `deleteProjectSource`  | Only caller         |

## Flags

> **Updated 2026-03-29:** `"sources-changed"` renamed to `"project-sources-changed"`. Last-source guard added (returns 409).

1. In `deleteProjectSource`, the replacement query (line 138-139) uses `.get()` which returns an arbitrary source. The selection is non-deterministic (SQLite row order). If deterministic promotion is desired, an ORDER BY should be added (e.g., by `createdAt`).
2. The UPDATE for promotion includes `ne(projectSources.id, id)` which is redundant since the row was already deleted. Harmless but dead logic.
3. ~~No check prevents deleting the last source of a project. After deletion, the project has zero sources, which may break routes like GET /files or POST /managers that require a default source.~~ **Fixed** — count check added, returns 409 if attempting to delete the last source.

## Usages

| Caller                       | Location                                                       | Purpose                                                                         |
| ---------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `removeProjectSource` API fn | `apps/app/src/lib/api.ts:256`                                  | Typed wrapper around `apiClient.projects[":id"].sources[":sourceId"].$delete()` |
| auth regression test         | `apps/server/test/public-authorization-regressions.test.ts:38` | Verifies DELETE rejects cross-project source deletion                           |
| source CRUD test             | `apps/server/test/public-projects-hosts.test.ts:181`           | Tests deleting the default source triggers promotion                            |

No direct frontend caller found -- `removeProjectSource` is exported from `api.ts` but not imported or called anywhere in the app views or hooks. No CLI caller either.

---

## Review Comments

<!-- Leave comments, questions, or follow-ups below. Delete this file if no action needed. -->

1. can we rename "sources-changed" to "project-sources-changed"

> Done — renamed in change-kinds.ts and all notifier call sites.

2. please add a check for deleting the last source of a project. this should return a informative error

> Done — added count check in route handler, returns 409 if attempting to delete the last source.
