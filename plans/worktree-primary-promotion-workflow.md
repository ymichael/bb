# Worktree Primary Promotion Workflow

## Goal

Establish a safe default workflow where agent iteration happens in per-thread worktrees while the primary checkout is reserved for end-to-end/manual testing, with deterministic promotion/demotion, clear UI controls, and timeline visibility.

## Scope

- `packages/agent-core`
  - Add typed contracts/events for promotion status and timeline rendering
- `packages/agent-server`
  - Worktree environment lifecycle integration with optional setup hook (`.bb-env-setup.ts`)
  - Environment adapter support for adding/customizing agent instructions
- `apps/daemon`
  - Promotion/demotion orchestration for the primary checkout
  - Preflight guardrails (promotion blocked when primary is dirty)
  - In-memory promotion state + restart reconstruction from git state
- `apps/cli`
  - Commands for promote/demote/status and clear recovery messaging
- `apps/app`
  - Sidebar/thread metadata visibility for active primary thread
  - Promote/demote toggle action
  - Follow-up flow that auto-demotes before sending follow-up
- Documentation
  - Canonical workflow for parallel threads, promotion, testing, and squash-merge completion

Out of scope for this phase:
- Custom stash/parking worktree implementation
- Symlink-based checkout switching
- Multi-promoted-thread support

## Implementation Steps

1. **Lock MVP workflow decisions**
   - One thread -> one worktree branch (`bb/thread-*`).
   - Primary checkout is integration-only.
   - Only one promoted thread at a time.
   - Promotion is blocked if primary checkout has any dirty state.
   - Promotion does **not** require target worktree to be clean/fully committed; promoted primary state must include all worktree changes (committed + uncommitted + untracked).
   - Promotion status is in-memory and rebuilt on daemon restart by inspecting git state in the primary checkout.

2. **Extend environment adapter capabilities**
   - Add an adapter-level hook to contribute guidance/instructions to the agent runtime.
   - Implement worktree adapter guidance that explicitly tells agents to commit work regularly to avoid loss and follow the guided promote/test/squash workflow.
   - Add optional `.bb-env-setup.ts` execution during environment preparation:
     - non-interactive, idempotent execution contract
     - hard timeout of 10 minutes
     - clear success/failure logging and surfaced error detail
     - emit structured provisioning events so setup start/success/failure is visible in thread timelines

3. **Implement promote/demote orchestration in daemon**
   - Promote preflight checks:
     - target thread exists and is worktree-backed
     - target worktree path exists
     - primary checkout is clean (`git status --porcelain` empty)
   - no active promotion lock in memory
  - Promotion action (no symlinks): switch primary checkout to target thread branch/commit and sync full worktree state so primary reflects all pending worktree edits.
  - Demote action: discard local primary edits created during promotion, then switch primary checkout back to pre-promotion branch/commit snapshot.
  - For follow-up flow, prefer deterministic demote (hard reset + clean in primary) over blocking on dirty-primary state.
  - Ensure preflight failures produce no partial state changes.

4. **Add API + CLI surface**
   - Daemon endpoints:
     - promote thread
     - demote primary
     - get promotion status
   - CLI commands:
     - `bb thread promote <id>`
     - `bb thread demote`
     - `bb thread promote-status`

5. **Track promotion as timeline events**
   - Emit explicit system events for promotion/demotion lifecycle (requested/succeeded/failed) on the relevant thread.
   - Add corresponding typed event contracts/schemas and timeline projection in the canonical message path.
   - Render these events similarly to existing provisioning/system operation rows.

6. **Implement requested UI behavior**
   - Sidebar: badge the git-folder icon for the currently active/promoted thread.
   - Thread detail metadata: show active/primary status.
   - Thread actions: add a promote/demote toggle button.
   - Follow-up flow: auto-demote primary first, then send follow-up to the thread; if demotion fails, show actionable remediation.

7. **Restart reconciliation + docs**
   - On daemon boot, reconstruct promotion status by inspecting the primary checkout and mapping it back to thread/worktree identity.
   - Keep daemon promotion state minimal and derived from git whenever possible.
   - Document happy paths, failure paths, and rationale for avoiding symlink switching.

## Validation

- Automated checks:
  - `pnpm typecheck`
  - `pnpm test`
- New targeted tests:
  - Promotion blocked when primary checkout is dirty (tracked, staged, and untracked files).
  - Promotion blocked when another thread is already promoted.
  - Promotion applies full worktree state, including uncommitted and untracked files.
  - Promotion + demotion roundtrip restores prior branch/commit.
  - Demotion resets/cleans primary checkout and restores the pre-promotion branch/commit snapshot.
  - Optional `.bb-env-setup.ts` hook timeout/failure/idempotency behavior (10-minute timeout).
  - Boot-time reconstruction rebuilds active promotion status from git state.
  - Promotion/demotion system events appear in thread timeline rendering.
- UI checks:
  - Sidebar active-thread badge rendering.
  - Thread metadata active/primary state.
  - Promote/demote toggle behavior.
  - Follow-up auto-demote behavior + failure messaging.

## Open Questions/Risks

- What is the safest implementation for syncing full dirty worktree state into primary (including binary + untracked files) with deterministic rollback on failure?
- In follow-up auto-demote flow, should failure hard-stop follow-up or offer an explicit override path?
- How should restart reconciliation behave if primary checkout appears promoted but corresponding thread/worktree metadata is missing or archived?
- Large dirty worktrees may make promotion slower; we may need progress reporting and operation timeouts.
