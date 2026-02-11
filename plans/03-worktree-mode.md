# Worktree Mode Plan

## Goal
Introduce thread-level `worktree` execution mode with safe snapshot/restore semantics and no persistent worktree identity on the thread.

## Product Model
Execution modes:
- `project`: run in project root.
- `worktree`: run in isolated branch/worktree managed by daemon.

Design rule:
- Worktree path is runtime detail, not durable thread identity.

## Spawn Contract
```ts
{
  projectId: string;
  input?: PromptInput[];
  model?: string;
  reasoningLevel?: "low" | "medium" | "high" | "xhigh";
  title?: string;
  execution?: {
    mode?: "project" | "worktree";
    branch?: string;            // optional; auto-generate if omitted
    baseBranch?: string | null; // nullable for non-Git/project mode
  };
}
```

## Thread Fields
- `execution_mode`: `project | worktree`
- `base_branch`: nullable text
- `worktree_branch`: nullable text
- `worktree_snapshot_ref`: nullable text
- `worktree_last_snapshotted_at`: nullable integer (optional for MVP)

## Runtime Semantics
Provisioning for worktree mode:
- resolve/generate title as needed
- resolve/generate worktree branch as needed
- resolve base branch
- materialize worktree

Turn execution:
- `ensureWorktreeMaterialized(thread)` before provider turn
- provider runs with worktree `cwd`

Follow-up after cleanup:
- if `worktree_snapshot_ref` exists, restore and continue
- if restore fails, return `WORKTREE_RESTORE_FAILED`

## Snapshot and Cleanup Strategy
Single strategy:
- Snapshot and cleanup on archive only.

Snapshot-before-cleanup invariant:
1. `git add -A`
2. commit on worktree branch
3. persist `worktree_snapshot_ref` (and optional timestamp)
4. remove worktree

If snapshot fails:
- do not cleanup
- persist/report `WORKTREE_SNAPSHOT_FAILED`

## Worktree Service
Add daemon module (for example `apps/daemon/src/git-worktree-service.ts`) with:
- `createWorktree(...)`
- `ensureWorktreeMaterialized(...)`
- `snapshotWorktree(...)`
- `restoreWorktree(...)`
- `cleanupWorktree(...)`

Managed location:
- `~/.beanbag/worktrees/...`

## Error Model
- `WORKTREE_SNAPSHOT_FAILED`
- `WORKTREE_RESTORE_FAILED`
- `WORKTREE_METADATA_INVALID`
- `WORKTREE_REQUIRES_GIT`

## Implementation Plan
1. Add execution contract + thread metadata fields.
2. Build Git worktree service and safety checks.
3. Integrate with provisioning and tell paths.
4. Integrate archive snapshot+cleanup flow.
5. Add restore-on-follow-up flow.
6. Update web/cli controls for `project` vs `worktree` mode.

## Test Plan
- Worktree spawn with explicit/auto branch.
- Worktree turn uses isolated cwd.
- Archive performs snapshot before cleanup.
- Follow-up restores from snapshot after cleanup.
- Snapshot/restore failure behavior is recoverable and explicit.
- Non-Git worktree path fails with `WORKTREE_REQUIRES_GIT`.

## Success Criteria
- Worktree threads are isolated without becoming separate projects.
- Archive cleanup never discards unsnapshotted work.
- Follow-up still works after cleanup via restore.
