# Phase 2a Findings: CLI Contract Mismatches

## Resolved

- All import path and type renames applied
- Route renames applied (tell→send, queue→drafts, operations→actions)
- `bb server health`, `bb project files`, `bb thread sessions` — commands deleted
- `/threads/:id/diff`, `/threads/:id/diff/branches` — wired to contract routes
- `/threads/:id/output` — added to contract, CLI wired up (requires explicit thread ID)
- Thread statuses reduced to 5 (removed provisioned, provisioning_failed)
- Environment action field/value renames fixed
- `providerId` is required — CLI must pass it

## Remaining

### Domain shape changes (need code updates)

| Issue | CLI usage | Resolution |
|---|---|---|
| `Project.rootPath` gone | `bb project show/list`, `bb status`, `bb thread show` | Use `project.sources` from `ProjectResponse`, filter by local hostId (from daemon `/host-id`) |
| `Thread.attachedEnvironment` gone | `bb status`, `bb thread show`, `bb environment demote` | Fetch environment by `thread.environmentId` separately |
| `Thread.primaryCheckout` gone | `bb environment demote`, `bb environment promote-status` | Derive from environment branchName vs primary source branch |
| `Thread.workStatus` gone | `bb thread list --include-work-status` | Fetch via `GET /environments/:id/status`. List view shows "-" or omits. |
| `Thread.titleFallback` gone | `bb thread delete`, `bb manager list` | CLI already falls back to `thread.id` |

### Schema decisions

| Issue | Current state | Decision needed |
|---|---|---|
| `CreateProjectRequest` requires `hostId` | CLI requires `--host` flag | Auto-detect local hostId from daemon `/host-id` |
| `UpdateProjectRequest` reduced to `{ name? }` | CLI options reduced to `--name` only | Add source management (add/remove sources) |
| `includeWorkStatus` query param | Not in contract | Workspace status is now per-environment, not per-thread |

### Commands still disabled

- `bb environment promote-status` — needs to derive promoted state from environment + source data
- `bb environment demote` (without explicit env ID) — needs environment lookup from thread
