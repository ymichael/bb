# Repository Capability + Worktree Mode Plan

## Goal
Deliver one coherent thread execution model that supports:
- Git and non-Git projects.
- Thread `mode = project | worktree`.
- Safe worktree cleanup on archive without losing work.
- Follow-up on archived/cleaned worktree threads via snapshot restore.

## Decisions Locked In
- Thread status lifecycle already implemented in code remains authoritative:
  - `created -> provisioning -> idle|active|provisioning_failed`.
- Mode names are `project` and `worktree`.
- `base_branch` is nullable (non-Git projects are first-class).
- `existingWorktree` is out of scope.
- Cleanup strategy is fixed: cleanup only on archive.
- Threads do not persist a durable worktree path identity.

## Unified Spawn Contract
```ts
{
  projectId: string;
  input?: PromptInput[];
  model?: string;
  reasoningLevel?: "low" | "medium" | "high" | "xhigh";
  title?: string;
  execution?: {
    mode?: "project" | "worktree"; // default: "project"
    branch?: string;                  // worktree branch override; optional
    baseBranch?: string | null;       // nullable for non-Git projects
  };
}
```

## Thread Persistence Contract
Add/maintain thread-level fields:
- `execution_mode`: `project | worktree` (default `project`)
- `base_branch`: nullable text
- `worktree_branch`: nullable text
- `worktree_snapshot_ref`: nullable text

Intentionally excluded:
- Persistent worktree path on thread.
- `worktree_last_snapshotted_at` (not needed for MVP).

## Capability Model (Git vs Non-Git)
Project capability is evaluated during provisioning/reprovisioning, not permanently cached.

Detection:
- Git-capable if repository preflight succeeds (for example `git rev-parse --is-inside-work-tree`).
- Otherwise capability is `non_git`.

Non-Git -> Git transition contract:
- Retry from `provisioning_failed` must re-run capability detection.
- A thread that failed due to non-Git can succeed after `git init`.
- New threads created after transition should auto-resolve `base_branch`.
- Existing threads with `base_branch = null` remain valid and can be lazily upgraded when Git-only operations are required.

## Execution Semantics by Mode

### `project` mode
- Works for both Git and non-Git projects.
- Non-Git:
  - persist `base_branch = null`.
- Git:
  - resolve and persist a valid `base_branch`.

### `worktree` mode
- Requires Git capability.
- On non-Git project:
  - fail provisioning with typed error,
  - transition to `provisioning_failed`.
- On Git project provisioning:
  1. resolve/generate title (if needed),
  2. resolve `base_branch`,
  3. resolve/generate `worktree_branch`,
  4. materialize worktree,
  5. start provider in worktree cwd,
  6. persist only branch/snapshot metadata (not path).

## Snapshot, Cleanup, and Follow-Up Semantics

### Archive (only cleanup trigger)
For `worktree` threads during archive:
1. Snapshot current worktree changes onto `worktree_branch`.
2. Persist `worktree_snapshot_ref`.
3. Remove worktree directory.

Invariant:
- Never clean up before successful snapshot persistence.

Failure behavior:
- If snapshot fails, do not clean up.
- Return/persist typed error so user can retry archive safely.

### Follow-up after cleanup
When a follow-up arrives for a worktree thread with no materialized worktree:
- If `worktree_snapshot_ref` exists, restore materialized worktree from snapshot and continue.
- If restore fails, set/return typed restore failure and keep thread recoverable.

## Naming Strategy

### Title and branch generation
Use one generation flow where possible:
- If caller provides `title`, keep it.
- If caller provides `execution.branch`, keep it.
- Otherwise generate title and branch together from input/project context.

### Worktree directory name generation
Generate deterministic daemon-managed names (runtime-only), for example from:
- project id,
- thread id,
- branch slug.

Requirement:
- Collisions must be impossible or auto-resolved deterministically.
- Name generation must not become part of external API contract.

## Surface-by-Surface Changes

### 1) Shared Types and Schemas (`packages/core`)
Files:
- `packages/core/src/api-types.ts`
- `packages/core/src/schemas.ts`
- `packages/core/src/types.ts`

Changes:
- Extend `SpawnThreadRequest` with `execution` object.
- Extend `Thread` with `executionMode`, `baseBranch`, `worktreeBranch`, `worktreeSnapshotRef`.
- Update zod schema validation:
  - `execution.mode` enum,
  - `execution.branch` optional non-empty string,
  - `execution.baseBranch` optional nullable non-empty string.

### 2) Persistence (`packages/db`)
Files:
- `packages/db/src/schema.ts`
- `packages/db/src/repositories.ts`
- `packages/db/drizzle/*` migration(s)

Changes:
- Add `execution_mode`, `base_branch`, `worktree_branch`, `worktree_snapshot_ref` to `threads`.
- Map camelCase <-> snake_case in repository layer.
- Ensure legacy rows normalize safely:
  - default `execution_mode = project`,
  - nullable fields default to `null`.

### 3) Provisioning and Runtime (`apps/daemon`)
Files:
- `apps/daemon/src/thread-manager.ts`
- New: `apps/daemon/src/git-capability.ts`
- New: `apps/daemon/src/git-worktree-service.ts`

Changes:
- Provisioning reads execution mode and applies mode-specific flow.
- Add helper to resolve/validate `base_branch`.
- Add helper to resolve/validate/generate `worktree_branch`.
- Materialize worktree for worktree mode before provider start.
- Add archive hook for snapshot + cleanup.
- Add follow-up hook to restore worktree from snapshot ref.
- Keep thread status transitions aligned with existing lifecycle.

### 4) Errors and HTTP Mapping (`apps/daemon`)
Files:
- `apps/daemon/src/domain-errors.ts`
- `apps/daemon/src/routes/error-response.ts`

Add typed errors (final naming can follow existing conventions):
- `project_not_git`
- `base_branch_invalid`
- `base_branch_resolution_failed`
- `worktree_requires_git`
- `worktree_create_failed`
- `worktree_snapshot_failed`
- `worktree_restore_failed`

Behavior:
- Include `retryable` and structured `details`.
- Keep status code mapping consistent for conflict/retryable provisioning states.

### 5) Thread Routes (`apps/daemon/src/routes/threads.ts`)
Changes:
- Accept `execution` payload in spawn.
- Preserve typed error payloads for provisioning and restore failures.

### 6) Web Surface (`apps/web`)
Files:
- `apps/web/src/lib/api.ts`
- `apps/web/src/hooks/useApi.ts`
- `apps/web/src/views/ProjectMainView.tsx`
- `apps/web/src/views/ThreadDetailView.tsx`

Changes:
- Pass execution payload on spawn.
- Add mode picker (`project` default, optional `worktree`).
- Optional branch/base branch advanced controls.
- Show provisioning and provisioning-failed messages with actionable cause.
- Show retry path that triggers reprovision.

### 7) CLI Surface (`apps/cli`)
Files:
- `apps/cli/src/commands/thread.ts`

Changes:
- `thread spawn` flags:
  - `--mode <project|worktree>`
  - `--branch <name>`
  - `--base-branch <name>`
- `thread show` prints execution metadata and snapshot metadata.

### 8) Observability
Files:
- `apps/daemon/src/thread-manager.ts`
- optional `apps/daemon/src/routes/system.ts`

Changes:
- Log capability decision (`git` vs `non_git`).
- Log base-branch resolution source (`explicit`, `head`, `default`).
- Log snapshot/restore outcomes with thread id and error code.

## Edge Cases
- Project path exists but is not Git.
- Project path moved/deleted after creation.
- Detached HEAD, missing default branch, invalid explicit base branch.
- Worktree branch name collision.
- Provider start fails after worktree creation (must avoid silent orphaning).
- Archive called while snapshot fails (must keep worktree, no data loss).
- Follow-up on thread whose worktree was archived and cleaned up.
- Non-Git -> Git transition for both failed and idle historical threads.
- Archived threads should not auto-reprovision unless explicitly retried.

## Test Plan

### Unit
- Git capability detector (`git`, `non_git`, command failure).
- Base branch resolver (explicit valid/invalid, auto strategies, failure).
- Worktree naming generator determinism/collision handling.

### Daemon Integration
- `project` mode works on non-Git with `base_branch = null`.
- `project` mode on Git auto-resolves `base_branch`.
- `worktree` mode on non-Git -> `provisioning_failed` with typed error.
- `worktree` mode on Git provisions and runs in isolated cwd.
- Archive performs snapshot before cleanup.
- Snapshot failure prevents cleanup and keeps recovery path.
- Follow-up after cleanup restores from snapshot and continues.
- Restore failure yields typed recoverable error.
- Non-Git -> Git transition:
  - failed thread retry succeeds,
  - newly created thread gets resolved `base_branch`,
  - old thread with null `base_branch` remains usable and can be upgraded lazily.

### API/Web/CLI
- Spawn schema accepts/rejects execution payload correctly.
- Web mode selector emits expected payload.
- CLI flags emit expected payload.
- Thread show/list display execution metadata correctly.

## Rollout Phases
1. Contract + persistence: extend core/db for execution + branch/snapshot metadata.
2. Capability baseline: Git/non-Git detection and `base_branch` semantics.
3. Worktree provisioning: worktree branch resolution + materialization.
4. Archive/follow-up safety: snapshot-on-archive and restore-on-follow-up.
5. UX and CLI: mode controls, errors, metadata display.
6. Hardening: full test matrix, migration verification, orphan cleanup audit.

## Success Criteria
- One merged plan covers Git capability and worktree behavior end-to-end.
- Non-Git projects are fully supported in `project` mode.
- Worktree mode is safe, recoverable, and does not lose work on cleanup.
- Follow-up after archived cleanup works via snapshot restore.
- Non-Git -> Git transitions work without daemon restart or manual data migration.
