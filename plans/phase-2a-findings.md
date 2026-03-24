# Phase 2a Findings: CLI Contract Mismatches

## Resolved

- All import path and type renames applied
- Route renames applied (tell→send, queue→drafts, operations→actions)
- `bb server health`, `bb project files`, `bb thread sessions` — commands deleted
- `/threads/:id/diff`, `/threads/:id/diff/branches` — wired to contract routes
- `/threads/:id/output` — added to contract, CLI wired up (requires explicit thread ID)
- Thread statuses reduced to 5 (removed provisioned, provisioning_failed)
- Environment action field/value renames fixed
- `providerId` is required — CLI `--provider` is now a required option on `bb thread spawn`
- `Project.rootPath` gone — CLI uses `ProjectResponse.sources[]`, resolves local source via daemon hostId
- `Thread.attachedEnvironment` gone — `bb status` fetches environment by `thread.environmentId`
- `Thread.workStatus` gone — `bb thread show --work-status` fetches from `GET /environments/:id/status`; `--include-work-status` removed from `bb thread list` (N+1 not viable)
- `Thread.titleFallback` — added back to domain type, CLI test fixture updated
- `CreateProjectRequest` requires `hostId` — `--host` is optional, auto-detects from daemon `/host-id`
- `includeWorkStatus` query param — removed from CLI (per-environment now)
- CLI migrated from hardcoded defaults to `@bb/config/cli`
- CLI depends on `@bb/host-daemon-contract` for daemon communication
- Test fixes: `--provider` required, tell→send route mock, environmentCreationArgs→provisionerId

## Remaining

### Schema additions needed

| Issue | Current state | Resolution |
|---|---|---|
| `UpdateProjectRequest` reduced to `{ name? }` | CLI options reduced to `--name` only | Add source management (add/remove sources) |

### Commands still disabled

- `bb environment promote-status` — needs to derive promoted state from environment + source data
- `bb environment demote` (without explicit env ID) — needs environment lookup from thread
