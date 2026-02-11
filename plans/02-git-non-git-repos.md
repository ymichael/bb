# Git and Non-Git Repository Support Plan

## Goal
Make Git and non-Git projects first-class citizens in thread provisioning, with one consistent contract:
- `base_branch` exists for Git threads.
- `base_branch` is `null` for non-Git threads.

This plan is intentionally about repository capability and base-branch semantics only. Worktree mode behavior is captured in a separate future-looking section.

## Decisions Locked In
- Thread status lifecycle from Plan 01 remains authoritative (`created -> provisioning -> idle|active|provisioning_failed`).
- `base_branch` is nullable because non-Git projects are supported.
- No auto-`git init`, no automatic migration of non-Git projects.
- Capability checks run during provisioning and again during reprovision.

## In Scope
- Detect project capability at runtime (`git` vs `non_git`).
- Add `base_branch` as nullable thread metadata.
- Resolve/validate `base_branch` for Git projects.
- Keep non-Git projects fully usable in normal thread flow.
- Add deterministic error codes/messages for Git capability/branch resolution failures.

## Out of Scope
- Worktree creation/restore/cleanup mechanics.
- Branch/worktree naming strategies.
- Existing-worktree reuse behavior.

## Behavior Contract (Now)
Thread creation/provisioning behavior:
- Git project + no `base_branch` provided: auto-resolve and persist `base_branch`.
- Git project + `base_branch` provided: validate and persist if valid.
- Non-Git project + no `base_branch` provided: persist `base_branch = null`, continue normally.
- Non-Git project + `base_branch` provided: reject during provisioning as invalid request for this project capability.

Reprovision behavior:
- Re-run capability detection and branch resolution every provisioning attempt.
- If a project changes from non-Git to Git later, reprovision can succeed without special migration steps.

## Surface-by-Surface Changes

### 1) Shared API/Type Surface (`packages/core`)
Files:
- `packages/core/src/api-types.ts`
- `packages/core/src/schemas.ts`
- `packages/core/src/types.ts`

Changes:
- Add optional `baseBranch?: string | null` to `SpawnThreadRequest`.
- Add nullable `baseBranch?: string | null` on `Thread` (serialized as `null` or omitted, but persisted nullable).
- Extend `spawnThreadSchema`:
  - accept `baseBranch` as nullable optional string.
  - trim and reject empty-string values.

Notes:
- Keep naming as `baseBranch` at API layer (camelCase), mapped to `base_branch` in DB.
- No worktree fields in this plan.

### 2) Persistence Surface (`packages/db`)
Files:
- `packages/db/src/schema.ts`
- `packages/db/src/repositories.ts`
- `packages/db/drizzle/*` (new migration)

Changes:
- Add nullable `base_branch` column to `threads`.
- Update `ThreadRepository.create/update/get/list` mapping for `baseBranch <-> base_branch`.
- Ensure row normalization handles legacy rows with missing column (default `null`).
- Add migration compatibility path for existing rows with `base_branch = null`.

Data invariants:
- `base_branch` may be `null`.
- Non-Git threads must end provisioning with `base_branch = null`.

### 3) Provisioning/Capability Surface (`apps/daemon`)
Files:
- `apps/daemon/src/thread-manager.ts`
- New helper: `apps/daemon/src/git-capability.ts` (or similar)

Changes:
- Add a small Git capability service:
  - `detectProjectCapability(rootPath) -> { kind: "git" | "non_git"; reason?: string }`
  - `resolveBaseBranch(rootPath, requestedBaseBranch?) -> string`
  - `validateBaseBranch(rootPath, branch) -> boolean`
- Integrate into provisioning path before provider session start:
  - For `git`: resolve/validate branch and persist `base_branch`.
  - For `non_git`: require `requestedBaseBranch` to be absent and persist `base_branch = null`.
- On failures, set thread `provisioning_failed` with structured error details.

Operational detail:
- Detection command should be deterministic and fast (`git rev-parse --is-inside-work-tree`).
- Base-branch resolution strategy (Git only):
  1. explicit request (if valid),
  2. current branch from HEAD if not detached,
  3. fall back to repo default branch if discoverable,
  4. fail with explicit error if unresolved.

### 4) Error and HTTP Contract (`apps/daemon`)
Files:
- `apps/daemon/src/domain-errors.ts`
- `apps/daemon/src/routes/error-response.ts`

Changes:
- Add explicit domain errors (names indicative, final naming to match existing conventions):
  - `project_not_git`
  - `base_branch_invalid`
  - `base_branch_resolution_failed`
- Include actionable details payload for UI/CLI (`projectId`, `requestedBaseBranch`, root cause string).
- Map to stable HTTP statuses:
  - capability mismatch/invalid branch: `409` or `422` (choose once and enforce consistently).

Retry semantics:
- `project_not_git` can be retryable (user may initialize Git later).
- `base_branch_invalid` usually non-retryable without user input change.
- `base_branch_resolution_failed` retryable if environmental/transient.

### 5) REST Route Surface (`apps/daemon/src/routes/threads.ts`)
Changes:
- Route already validates request via schema; this will pick up `baseBranch`.
- Ensure error payload passthrough preserves retryability and details for client UX.

### 6) Web Client Surface (`apps/web`)
Files:
- `apps/web/src/lib/api.ts`
- `apps/web/src/hooks/useApi.ts`
- `apps/web/src/views/ProjectMainView.tsx`
- `apps/web/src/views/ThreadDetailView.tsx`

Changes:
- Accept/send `baseBranch` in spawn request type path.
- Keep UI simple for now:
  - no required base-branch picker in this phase,
  - default to omitted `baseBranch` (auto for Git, `null` for non-Git after provisioning).
- Improve provisioning failure copy for Git capability/branch errors in thread detail.
- Ensure retry affordance from `provisioning_failed` remains clear.

### 7) CLI Surface (`apps/cli`)
Files:
- `apps/cli/src/commands/thread.ts`

Changes:
- Add optional `--base-branch <name>` to `thread spawn`.
- Show `baseBranch` in `thread show` output (`(none)` for non-Git).
- Preserve backwards compatibility for callers that do not pass the new flag.

### 8) System/Observability Surface
Potential files:
- `apps/daemon/src/routes/system.ts`
- daemon logging in `thread-manager.ts`

Changes:
- Log capability decisions at provisioning time (`git` vs `non_git`) with thread/project IDs.
- Log branch resolution source (`explicit`, `head`, `default`) to aid debugging.
- Keep existing status metrics unchanged in this phase.

## Edge Cases to Handle Explicitly
- Project root path exists but is not a Git repo.
- Project root path was deleted/moved after project creation.
- Git installed but repo is in detached HEAD.
- Requested base branch does not exist locally/remotely.
- Repo default branch cannot be discovered.
- Provisioning retries after project transitions from non-Git to Git.
- Archived thread should not reprovision even if follow-up is attempted.

## Test Plan

### Unit Tests
- Git capability detector:
  - `git` project detected correctly.
  - non-Git detected correctly.
  - command failures return deterministic non-crashing result.
- Base branch resolver:
  - explicit valid branch.
  - explicit invalid branch.
  - auto from HEAD.
  - auto failure path.

### Daemon Integration Tests
- Spawn on non-Git project succeeds with `base_branch = null`.
- Spawn on Git project auto-populates `base_branch`.
- Spawn on Git project with explicit valid `base_branch` persists correctly.
- Spawn with explicit `base_branch` on non-Git fails into `provisioning_failed` with typed error.
- Reprovision after converting non-Git -> Git succeeds.

### API/Client Tests
- Route schema accepts `baseBranch: null` and optional omission.
- Route schema rejects `baseBranch: ""`.
- Web and CLI can create threads without passing `baseBranch`.
- CLI `--base-branch` path sends expected payload.

## Rollout Sequence
1. Core type/schema changes (`baseBranch` request/response contract).
2. DB migration + repository mapping.
3. Daemon capability service + provisioning integration.
4. Error model + HTTP mapping.
5. Web/CLI UX updates and messaging.
6. Full test pass and migration verification.

## Success Criteria
- Non-Git projects can create and run threads without Git setup.
- Git projects consistently persist a valid `base_branch`.
- Capability and branch failures are explicit, typed, and recoverable.
- No worktree-specific behavior is required to achieve this milestone.

## Future-Looking: Worktree Mode Dependencies (Not Implemented in 02)
When Plan 03 (worktree mode) is implemented, it should build on this plan without redefining Git capability:
- Reuse the same capability probe and `base_branch` resolution logic.
- Enforce `worktree` mode requires Git using the same typed capability errors.
- Use `base_branch` already persisted on thread provisioning as input to worktree creation.
- Keep worktree-specific cleanup/snapshot/restore concerns in Plan 03 only.
