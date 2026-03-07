# Goal

Remove the `workflow` concept from `bb` completely, without losing any existing safety or power.

The replacement model should be:

- `Environment` defines workspace setup, lifecycle, and environment-specific instructions.
- `Built-in actions` define which thread operations are available at any moment and what guards/side effects they have.
- Auto-archive is based on repository state, not on a completed workflow. In particular, a thread should auto-archive when its branch is caught up to the default branch after a merge/completion path.

# Scope

In scope:

- Remove workflow selection and workflow terminology from product surfaces.
- Remove workflow types, API fields, storage, orchestration, and tests.
- Move prompt/instruction injection responsibility onto environments.
- Introduce a server-owned built-in action model for operations such as `commit`, `squash_merge`, `promote`, `demote`, and future actions like `pr`.
- Replace workflow-based auto-archive decisions with branch/repo-state-based decisions.
- Preserve or strengthen current data-loss protections for isolated workspaces/worktrees.

Out of scope for the first pass:

- Implementing `pr` itself.
- Reworking unrelated thread provisioning behavior.
- Broad UI redesign outside the current workflow surfaces.

# Implementation Steps

1. Inventory and classify current workflow responsibilities.

- Document every place `workflow` currently means one of:
  - a user-facing picker or label
  - a thread compatibility filter
  - prompt instruction injection
  - operation policy evaluation
  - auto-archive policy
  - persisted thread/project metadata
- Treat these as separate responsibilities during migration. Do not replace `workflow` with another umbrella noun unless it is strictly necessary.

2. Define the target replacement model in types first.

- Add environment-level instruction hooks to the environment contract in [contracts.ts](/Users/michael/Projects/bb/packages/environment/src/contracts.ts).
- Add a built-in action contract in `agent-core` for daemon-to-UI communication. Proposed shape:
  - stable action id
  - label
  - availability
  - disabled reason
  - queue behavior
  - requires-demote-first
  - optional destructive/warning tone
- Define whether actions are exposed as:
  - a dedicated thread endpoint, or
  - a derived field on thread detail responses
- Keep action ids closed/internal and exhaustively switched.

3. Move instruction injection from workflows to environments.

- Remove workflow-specific instruction building from [orchestrator.ts](/Users/michael/Projects/bb/apps/daemon/src/orchestrator.ts#L2720).
- Add environment-specific instruction generation, likely from the active/restored environment instance or its definition.
- Preserve project-level custom instructions, but rename them away from `workflowInstructions`.
- Combine instructions in a deterministic order:
  - existing system/base instructions
  - project instructions
  - environment instructions
- Ensure local/root environments can inject nothing, while worktree-like environments can inject durability/safety guidance.

4. Make isolated worktree setup safe by construction.

- For the worktree environment, always create a fresh branch during thread environment provisioning.
- Do not expose branch creation as a user choice for worktree-backed threads.
- Ensure the created branch is owned by the thread lifecycle and can be reasoned about later for merge/archive decisions.
- Confirm cleanup/disposal semantics do not delete unmerged work silently.
- Audit restore logic in [environment-service.ts](/Users/michael/Projects/bb/apps/daemon/src/environment-service.ts) so branch/worktree ownership remains reconstructable after restart.

5. Replace workflow compatibility with environment-driven selection rules.

- Remove `/system/workflows` and the client hook/query that fetches workflow definitions.
- Remove `workflowId` from thread creation requests and thread state.
- If some environments require capabilities or setup constraints, enforce them inside environment resolution/provisioning rather than via a cross-product workflow x environment matrix.
- If multiple environments remain user-selectable, the environment picker alone should determine the workspace model.

6. Introduce built-in action evaluation on the daemon.

- Replace workflow operation policy evaluation in [index.ts](/Users/michael/Projects/bb/packages/workflow/src/index.ts) with a daemon-owned action evaluator.
- The evaluator should derive available actions from:
  - current thread status
  - archive state
  - environment capabilities
  - whether the environment is an isolated workspace
  - whether the active checkout is the project root or a secondary workspace
  - current git status
  - whether the thread branch is ahead/behind/caught up
- Initial action rules:
  - `commit`: available when inside a git repo and there are uncommitted changes.
  - `squash_merge`: available when the thread has commits to merge and is not on the default branch.
  - `promote`: available when the environment is not the main project root and promotion is supported.
  - `demote`: available when a thread has promoted into the primary checkout and demotion is supported.
- Preserve current queueing semantics where actions may be requested while a thread is active.

7. Decide where action execution lives.

- Keep actual implementations near existing operation handlers in the orchestrator.
- Refactor policy checks so operation handlers ask the built-in action evaluator instead of asking a workflow service.
- Preserve the current "requires demote first" behavior as an action precondition, not as workflow policy.
- Keep availability and execution validation server-side; the UI should only render what the daemon reports.

8. Replace workflow state with narrower thread state, or remove it entirely.

- Audit whether `workflowState` is still needed once workflow is gone.
- If it only reflects provisioning/compatibility summaries, fold it into:
  - provisioning state, or
  - action/environment readiness state
- Remove any residual thread detail rows that only exist to explain workflow progress.

9. Replace workflow-based auto-archive with branch-state-based auto-archive.

- Remove `shouldAutoArchiveOnSuccess({ workflowId, ... })`.
- Define a new archive decision helper based on git state after action completion.
- Concrete first rule:
  - auto-archive when the thread branch is not the default branch, has produced meaningful work since thread creation, and no longer carries any unique changes relative to the default branch
- Clarify how this should behave after:
  - squash merge into default branch
  - direct commit to the main/root workspace
  - manual branch deletion
  - non-default merge bases
- For this migration, define "caught up to main" as:
  - `currentBranch !== defaultBranch`
  - the branch has been meaningfully used since thread creation
  - the branch has no unique diff relative to the default branch
- "Meaningfully used" should not be inferred from branch existence alone. It should require evidence such as:
  - the thread branch was ahead of the default branch at least once, or
  - the thread produced commits, or
  - the thread produced a non-empty diff relative to the default branch
- Prefer a content-based git check over ancestry-only checks so squash merges archive correctly. "Ahead count is zero" is not sufficient by itself.

10. Rename project-level custom instructions.

- Rename `workflowInstructions` everywhere to something like `projectInstructions`.
- Update:
  - DB schema and repository mapping
  - API schemas/contracts
  - daemon routes
  - app settings UI
  - tests and fixtures
- Add a migration path that preserves existing saved values.

11. Remove workflow package and contracts after callers are migrated.

- Delete the `@beanbag/workflow` package once:
  - instruction injection has moved to environments
  - action policy has moved to daemon action evaluation
  - auto-archive policy no longer depends on workflow
- Remove `WorkflowKind`, `SystemWorkflowInfo`, workflow schema fields, and `/system/workflows`.
- Remove fallback workflow option logic in the app.
- Drop workflow-specific tests only after equivalent coverage exists for environments/actions.

12. Update UI flows to match the simpler model.

- Project main view:
  - remove workflow picker
  - keep environment picker if still needed
  - surface built-in actions contextually
- Thread detail view:
  - remove workflow metadata rows
  - show environment details and available actions instead
- Project settings:
  - rename "Workflow instructions"
  - make wording reflect project-specific instructions, not process selection
- Ensure the UI never asks the user to choose a process abstraction up front.

13. Migrate persistence safely.

- Add DB migrations to:
  - rename or replace `projects.workflow_instructions`
  - remove `threads.workflow_id`
  - remove `threads.workflow_state`
- Update repository serialization/deserialization in [repositories.ts](/Users/michael/Projects/bb/packages/db/src/repositories.ts).
- Decide whether to:
  - drop old columns immediately, or
  - ship a compatibility window first and clean up in a follow-up migration
- Prefer a two-step migration if mixed-version compatibility matters during development.

14. Update API and runtime contracts in one pass.

- Remove workflow fields from:
  - thread start request schemas
  - thread response types
  - project update payloads, after rename
  - runtime contracts and generated API types where applicable
- Update tests around `/system`, `/threads`, and `/projects`.
- Ensure the app does not depend on stale generated types or fallback workflow data.

15. Add coverage for the new model before deleting the old one.

- Environment tests:
  - instruction injection
  - worktree branch creation
  - restore/restart behavior
- Action evaluator tests:
  - commit availability
  - squash merge availability
  - promote/demote availability
  - queueing and demote-first rules
  - archived/provisioning state blocking
- Auto-archive tests:
  - archives when a non-default thread branch has produced work and no unique diff remains
  - does not archive an unused or empty non-default branch
  - does not archive when unique work remains
  - behaves correctly for squash merge and direct-root workflows
- UI tests:
  - no workflow picker
  - action rendering from daemon state
  - renamed project instructions settings

16. Remove dead references and clean up naming.

- Remove `workflow` references from:
  - code comments
  - log messages
  - debug output
  - test names
  - docs and contracts
- Be careful not to rename open/external terms if they come from persisted/generated artifacts outside this codebase.

# Validation

- Run unit/integration tests for:
  - `packages/environment`
  - `packages/db`
  - `packages/agent-core`
  - `packages/workflow` replacement area
  - `apps/daemon`
  - `apps/app`
- Manually verify these scenarios:
  - create a local/root-environment thread
  - create a worktree thread and confirm a new branch is always created
  - make uncommitted changes and verify `commit` appears
  - create commits on a non-default thread branch and verify `squash_merge` appears
  - promote to primary checkout and verify `demote` appears
  - complete a merge path and verify auto-archive triggers only when branch state is caught up
  - restart the daemon and verify isolated thread environments restore correctly
- Query persisted thread/project rows directly to confirm workflow columns are no longer read/written after migration.

# Open Questions/Risks

- Precise archive semantics:
  - Choose the exact git primitive for "no unique diff remains relative to the default branch" and make sure it is robust after squash merge.
- Direct-root thread behavior:
  - Should direct work on the main project root ever auto-archive automatically, or only isolated branches?
- Action API shape:
  - Is a dedicated built-in actions endpoint cleaner than embedding derived actions in thread detail responses?
- Environment ownership:
  - Where should environment instruction builders and branch-creation policies live: environment definitions, environment service, or orchestrator glue?
- Migration sequencing:
  - Do we want a compatibility phase where workflow fields are ignored but still readable, or a hard cut?
- Terminology:
  - If some residual summary state remains, what should it be called so we do not accidentally reinvent workflow under another name?
