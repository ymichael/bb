# `DELETE /api/v1/projects/:id` — Delete a project and its attachments

**Route:** `apps/server/src/routes/projects.ts:107`
**Contract:** `PathProjectId -> { ok: true }` (200)
**Complexity:** Medium (filesystem cleanup)

## Request Params

| Field | Required | Notes |
|---|---|---|
| `:id` | Yes | Project ID from URL path. |

**All 1 param consumed. No dead params.**

## Implementation Trace

1. `requireProject(db, id)` -- sync. SELECT by PK. Throws 404 if missing.
2. `deleteProjectAttachments(config.dataDir, id)` -- **async**. `rm` the `attachments/<projectId>` directory recursively. Uses `force: true` so missing dir is not an error.
3. `deleteProject(db, hub, id)` -- sync.
   - SELECT project by PK (existence check).
   - DELETE from `projects` WHERE `id`.
   - CASCADE deletes `project_sources`, `environments`, `threads`, `events` (via FK cascades).
   - Returns boolean (true if existed).

> **-> HTTP 200 returns here.** Filesystem cleanup is awaited before response.

## DB Query Summary

| # | Query | Table | Index | Notes |
|---|-------|-------|-------|-------|
| 1 | SELECT project by PK | `projects` | PK | requireProject |
| 2 | SELECT project by PK | `projects` | PK | deleteProject existence check |
| 3 | DELETE project by PK | `projects` | PK | cascades to sources, environments, threads, events |

**Total: 3 queries (plus cascaded deletes handled by SQLite). No N+1.**

## Code Reuse

| Function | Shared With |
|---|---|
| `requireProject` | Most project routes |
| `deleteProjectAttachments` | Only caller |
| `deleteProject` | Only caller |

## Flags

> **Updated 2026-03-29:** `deleteProject` now notifies `"project-deleted"`.

1. ~~`deleteProject` does not call `notifier.notifyProject(...)` or `notifier.notifySystem(...)` after deletion. Connected clients won't get a real-time update that the project was removed. Compare with `createProject` which does notify.~~ **Fixed** — now notifies `"project-deleted"`.
2. ~~The delete relies on SQLite FK cascades for threads, environments, etc. This is correct but means no application-level cleanup runs for those child entities (e.g., no environment teardown commands are sent to the host daemon). Deleting a project with active managed environments will leave orphaned worktrees/clones on the host filesystem.~~ **Fixed** — now queues `environment.destroy` commands for managed environments before the cascade delete.
3. ~~Attachment cleanup happens before the DB delete. If the DB delete fails after attachments are removed, the data is lost. Low risk but ordering could be swapped.~~ **Fixed** — DB delete now runs before attachment cleanup.

## Usages

| Caller | Location | Purpose |
|---|---|---|
| `deleteProject` API fn | `apps/app/src/lib/api.ts:230` | Typed wrapper around `apiClient.projects[":id"].$delete()` |
| `useDeleteProject` hook | `apps/app/src/hooks/useApi.ts:465` | React Query mutation; calls `api.deleteProject()` |
| `ProjectList` | `apps/app/src/components/layout/ProjectList.tsx:260` | Delete project from context menu in sidebar |
| `project delete` CLI | `apps/cli/src/commands/project.ts:150` | `bb project delete <id>` command (with confirmation) |
| project CRUD test | `apps/server/test/public-projects-hosts.test.ts:83` | Verifies delete removes project from list |

---

## Review Comments

<!-- Leave comments, questions, or follow-ups below. Delete this file if no action needed. -->
