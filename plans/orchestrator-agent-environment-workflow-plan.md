# Goal

Refactor the current daemon-centered architecture into a four-component model with clear ownership:

- `Orchestrator`
- `Agent Server`
- `Environment`
- `Workflow`

The target state is:

- the current `ThreadManager` role is reduced and renamed into an `Orchestrator`
- `packages/agent-server` owns agent- and provider-specific behavior behind a stable contract
- `packages/environment` owns environment and workspace behavior behind a stable contract
- workflow policy is modeled separately from environment selection
- the orchestrator owns composition, not agent-, environment-, or workflow-specific policy and state bookkeeping
- API and UI surfaces are capability-driven instead of hardcoding `"local"` and `"worktree"`
- stale single-environment compatibility paths are removed

# Scope

In scope:

- shrinking and renaming the current daemon `ThreadManager` into an `Orchestrator`
- moving provider-specific lifecycle logic out of the current `ThreadManager`
- separating workflow concerns from environment concerns
- reducing direct coupling from `packages/environment` to `@beanbag/agent-core` thread/event types
- unifying environment selection, restore, and catalog policy
- removing stale single-environment API/client surfaces
- moving app behavior away from hardcoded environment IDs toward capabilities and metadata
- defining a handoff-ready package/API sketch for orchestrator, agent-server, environment, and workflow
- adding regression coverage for unsupported or non-host-like environments

Out of scope:

- redesigning provider protocols themselves
- adding more than two initial workflow types
- large unrelated cleanup inside thread timeline/message rendering
- generated code under `packages/core/src/generated/**`

Backward compatibility policy:

- This refactor does not need to preserve backward compatibility.
- The codebase is still pre-product, so prefer removing legacy paths over carrying compatibility shims forward.
- Temporary migration code is acceptable only when it is clearly transitional and removed before the refactor is considered complete.
- Do not keep obsolete APIs, duplicate models, or compatibility wrappers “just in case” unless there is a concrete active dependency that is documented in this plan.

Related existing work:

- [environment-abstraction-leaks-plan.md](/Users/michael/Projects/bb/plans/environment-abstraction-leaks-plan.md) covers transport/UI leaks and should land first where it reduces overlap

# Success Criteria

The refactor is only complete when the following code smells are removed, not just renamed:

- The central runtime class is no longer a god object.
  - The final orchestrator must not own provider session mechanics, environment lifecycle policy, and workflow policy at the same time.
- Provider-specific behavior no longer lives in the orchestrator.
  - Provider thread IDs, active turn IDs, provider RPC payload construction, provider-specific error interpretation, and provider capability branching must be owned by `packages/agent-server`.
- Environment-specific behavior no longer lives in the orchestrator.
  - Environment selection/defaulting, restore/provision, runtime caching, cleanup, and environment capability branching must be owned by an environment service and `packages/environment`.
- Workflow policy no longer lives in environment code or the orchestrator.
  - Branch/commit/merge/archive policy must be owned by `packages/workflow` and a workflow service.
- `packages/environment` is no longer tightly coupled to app/thread transport types.
  - It should not depend directly on `@beanbag/agent-core` thread events or UI-facing work-status/event-broadcast contracts for its core runtime behavior.
- The app no longer hardcodes `"local"` and `"worktree"` as the primary behavior switch.
  - UI behavior should be driven by metadata/capabilities and selected workflow.
- Stale singular-environment compatibility paths are removed.
  - The final architecture should not keep `/system/environment` and similar shims unless there is a deliberate compatibility requirement documented elsewhere.
- Legacy compatibility code is not retained without a concrete, documented reason.
  - Pre-product status means deleting obsolete paths is preferred to preserving them.
- Silent fallback behavior is removed where it hides boundary failures.
  - Environment restore failures and workflow/environment incompatibility should surface as structured states or events, not generic “workspace unavailable” behavior.

# Implementation Steps

1. Lock the four-component architecture

- Use these component boundaries:
  - `Orchestrator`: thread lifecycle composition, persistence, recovery, and broadcast coordination
  - `Agent Server`: provider adapters, provider/session lifecycle, model catalogs, normalized agent events
  - `Environment`: provisioning, process execution, workspace operations, capabilities, serialization/restore
  - `Workflow`: lifecycle policy, completion semantics, compatibility requirements, archive-on-success behavior
- Document the dependency direction explicitly:
  - orchestrator depends on agent-server, environment, and workflow
  - workflow depends on environment capabilities/contracts
  - environment does not depend on workflow
  - agent-server does not depend on concrete environments or workflows
- Keep structured workflow policy separate from `workflowInstructions` prompt text passed to the agent.

2. Start with exactly two workflow types

- Initial built-in workflow definitions:
  - `noop`
  - `branch-commit-merge`
- Define initial semantics:
  - `noop`: no structured pre-work or post-work behavior; no special completion semantics
  - `branch-commit-merge`: branch-oriented work, require committed work before completion, and treat merge-back as workflow completion
- Do not add PR-oriented workflows in the first pass.
- Keep the workflow abstraction generic enough to support future workflows, but optimize the initial design for these two only.

3. Introduce the `Orchestrator` boundary and reduce `ThreadManager`

- Extract responsibilities out of the current `ThreadManager` before renaming it.
- Move the current class away from being the owner of:
  - provider session state
  - environment lifecycle state
  - workflow completion policy
- Keep the orchestrator focused on:
  - thread creation/resume/archive
  - composition of agent server, environment, and workflow
  - persistence and recovery
  - websocket/API broadcast coordination
- Rename `ThreadManager` to `Orchestrator` once the remaining responsibility matches the name.

4. Move provider/session behavior fully behind `packages/agent-server`

- Treat the current provider logic in `ThreadManager` as an incomplete extraction that should move behind an agent runtime/session abstraction.
- Move out of the current manager/orchestrator:
  - provider thread ID ownership
  - active turn ID ownership
  - provider RPC request construction
  - resume/start/name-setting/session bookkeeping
  - provider-specific error interpretation
  - capability branching like model-list and multimodal handling
- The orchestrator should call a smaller agent-server surface such as:
  - start session
  - resume session
  - send turn
  - rename thread
  - stop session
  - list models/capabilities
- Agent-server should accept execution context and assembled instructions, but own provider-specific mechanics internally.

5. Introduce a daemon-side `EnvironmentService`

- Extract environment-specific orchestration out of the current `ThreadManager` into a dedicated service or module family.
- Move into that service:
  - environment selection and validation
  - environment restore from persisted state
  - runtime environment caching and watcher lifecycle
  - provisioning/cleanup helpers
  - primary checkout promotion bookkeeping
- Centralize default environment resolution and validation in this service.
- Convert direct route-level environment creation into calls through the daemon environment service.

6. Introduce a daemon-side `WorkflowService`

- Extract workflow policy out of the current `ThreadManager` into a dedicated service or module family.
- Move into that service:
  - before-work setup policy
  - after-work completion policy
  - completion-state evaluation
  - archive-on-success policy
  - workflow event emission and user-facing status summaries
- This service should orchestrate environment operations, not live inside the environment package.
- It should be the home for logic that currently leaks as:
  - worktree-specific developer instructions
  - auto-archive-on-commit policy
  - demote-before-operation policy where that is really a workflow rule
  - "done" semantics after squash merge

7. Define the package/API sketch and use it to guide extraction

- Proposed package layout:
  - `packages/agent-core`: shared product/API types
  - `packages/agent-server`: provider adapters and agent runtime/session lifecycle
  - `packages/environment`: environment registry, provisioning, capabilities, implementations
  - `packages/workflow`: workflow registry, lifecycle policy, compatibility rules
  - `packages/orchestrator` or `apps/daemon/src/orchestrator`: composition layer
  - `apps/daemon`: route setup and service wiring
- Proposed composition object:

```ts
interface ThreadExecutionProfile {
  agent: AgentProfileRef;
  environment: EnvironmentSelection;
  workflow: WorkflowSelection;
}
```

- Proposed agent-server surface:

```ts
interface AgentServer {
  listProviders(): SystemProviderInfo[];
  listModels(providerId?: string): Promise<AvailableModel[]>;
  startSession(
    context: AgentExecutionContext,
    options?: { providerId?: string; restoreFrom?: AgentSessionState },
  ): Promise<AgentSessionDescriptor>;
  sendTurn(sessionId: string, request: AgentTurnRequest): Promise<void>;
  renameSession(sessionId: string, title: string): Promise<void>;
  stopSession(sessionId: string): Promise<void>;
  getSessionState(sessionId: string): AgentSessionState;
}
```

- Proposed environment surface:

```ts
type EnvironmentKind =
  | "local"
  | "worktree"
  | "cloud_sandbox"
  | "container";

interface EnvironmentCapabilities {
  execution: {
    canSpawnProcesses: boolean;
    supportsLongLivedProcesses: boolean;
  };
  filesystem: {
    hostAccessible: boolean;
    supportsOpenPath: boolean;
  };
  workspace: {
    isolated: boolean;
    supportsBranching: boolean;
    supportsCommit: boolean;
    supportsMergeBack: boolean;
    supportsPullRequestHandoff: boolean;
  };
}

interface EnvironmentHandle {
  id: string;
  kind: EnvironmentKind;
  capabilities: EnvironmentCapabilities;
  getState(): EnvironmentState;
  exists(): boolean;
  dispose(): Promise<void> | void;
  spawn(command: string, args: string[], options?: EnvironmentSpawnOptions): ChildProcess;
  run(
    command: string,
    args: string[],
    options?: EnvironmentCommandOptions,
  ): Promise<EnvironmentCommandResult> | EnvironmentCommandResult;
  inspectWorkspace(
    options?: WorkspaceInspectionOptions,
  ): Promise<WorkspaceSnapshot> | WorkspaceSnapshot;
  getPathResolver(): EnvironmentPathResolver | undefined;
  getVersionControl(): EnvironmentVersionControl | undefined;
}

interface EnvironmentVersionControl {
  createBranch(name: string, options?: { fromRef?: string }): Promise<void> | void;
  getStatus(options?: WorkspaceStatusOptions): Promise<WorkspaceStatus> | WorkspaceStatus;
  getDiff(options?: WorkspaceDiffOptions): Promise<WorkspaceDiff> | WorkspaceDiff;
  commit(options?: WorkspaceCommitOptions): Promise<WorkspaceCommitResult>;
  mergeBack(options: WorkspaceMergeOptions): Promise<WorkspaceMergeResult>;
}

interface EnvironmentService {
  listDefinitions(): EnvironmentDescriptor[];
  provisionEnvironment(request: ProvisionEnvironmentRequest): Promise<EnvironmentHandle>;
  restoreEnvironment(
    record: PersistedEnvironmentRecord,
    request: RestoreEnvironmentRequest,
  ): Promise<EnvironmentHandle>;
  validateSelection(environmentId: string): EnvironmentDescriptor;
}
```

- Proposed workflow surface:

```ts
type WorkflowKind =
  | "noop"
  | "branch_commit_merge";

interface WorkflowCompatibilityResult {
  ok: boolean;
  missingRequirements: Array<{
    capability: string;
    reason: string;
  }>;
}

interface WorkflowContext {
  threadId: string;
  projectId: string;
  environment: EnvironmentHandle;
  projectInstructions?: string;
  workflowInstructions?: string;
}

interface WorkflowProgress {
  phase:
    | "preparing"
    | "working"
    | "awaiting_commit"
    | "awaiting_merge"
    | "completed"
    | "failed";
  summary: string;
  terminal: boolean;
  successful?: boolean;
}

interface WorkflowAction {
  type:
    | "prepare_branch"
    | "commit"
    | "merge_back"
    | "archive_thread";
  payload?: Record<string, unknown>;
}

interface WorkflowDefinition {
  kind: WorkflowKind;
  displayName: string;
  description?: string;
  checkCompatibility(
    environment: EnvironmentDescriptor | EnvironmentHandle,
  ): WorkflowCompatibilityResult;
  buildInstructions(context: WorkflowContext): string | undefined;
  onBeforeAgentWork(context: WorkflowContext): Promise<WorkflowAction[]>;
  evaluateProgress(context: WorkflowContext): Promise<WorkflowProgress>;
  onAfterAgentWork(context: WorkflowContext): Promise<WorkflowAction[]>;
}

interface WorkflowService {
  listDefinitions(): WorkflowDefinitionSummary[];
  getDefinition(kind: WorkflowKind): WorkflowDefinition;
  validateSelection(kind: WorkflowKind): WorkflowDefinition;
}
```

- Proposed orchestrator surface:

```ts
interface StartThreadRequest {
  projectId: string;
  input?: PromptInput[];
  agent?: {
    providerId?: string;
    model?: string;
    reasoningLevel?: ReasoningLevel;
    sandboxMode?: SandboxMode;
  };
  environmentId?: EnvironmentKind;
  workflowId?: WorkflowKind;
  title?: string;
}

interface Orchestrator {
  startThread(request: StartThreadRequest): Promise<Thread>;
  sendTurn(threadId: string, request: TellThreadRequest): Promise<void>;
  stopThread(threadId: string): Promise<void> | void;
  archiveThread(threadId: string): Promise<void> | void;
  unarchiveThread(threadId: string): Promise<void> | void;
  listThreads(filters?: ThreadListFilters): Thread[];
  getThread(threadId: string): Thread | undefined;
  getTimeline(threadId: string, options?: TimelineOptions): ThreadTimelineResponse;
  listEnvironments(): EnvironmentDescriptor[];
  listWorkflows(): WorkflowDefinitionSummary[];
  listProviders(): SystemProviderInfo[];
  reconcileOnBoot(): Promise<void>;
}
```

8. Replace capability booleans on `IEnvironment` with operation-oriented interfaces where possible

- The current contract relies on `supportsX()` plus `doX()` pairs.
- Refactor toward optional operation objects or capability-group interfaces like `getVersionControl()`.
- Remove repeated daemon branching like:
  - `supportsPromoteToActiveWorkspace()`
  - `supportsDemoteFromActiveWorkspace()`
  - `supportsSquashMergeIntoDefaultBranch()`
  - `supportsHostFilesystemAccess()`
- Keep tolerant fallbacks only where behavior truly depends on open external/runtime state.

9. Decouple `packages/environment` from app/thread domain types

- Stop importing thread event and UI-facing work-status types directly into the environment package.
- Introduce environment-local result types for:
  - workspace status
  - diff/commit/squash-merge outcomes
  - environment-emitted lifecycle notifications
- Add daemon adapters that translate environment-local results into:
  - thread events
  - websocket change notifications
  - API types in `@beanbag/agent-core`
- Narrow `EnvironmentServices` so it does not know about thread event names or broadcast change kinds.

10. Add workflow selection and workflow state to product/API models

- Introduce explicit workflow identity and lifecycle fields, separate from environment identity.
- Keep the initial workflow union closed and small:
  - `noop`
  - `branch-commit-merge`
- Clarify which fields are:
  - requested environment
  - provisioned environment
  - requested workflow
  - active workflow state
  - terminal workflow outcome
- Start with closed internal built-ins only; project presets can come later if the abstraction proves stable.
- Make workflow completion visible in the thread model so archive decisions are explainable.
- Keep these separate:
  - `workflowInstructions`: natural-language guidance for the agent
  - `workflowState`: structured system state
  - `workflowId`: selected workflow definition

11. Remove stale single-environment compatibility surfaces

- Delete or deprecate:
  - daemon `getEnvironmentInfo()`
  - `/system/environment`
  - app `getSystemEnvironment()`
  - app `useSystemEnvironment()`
- Audit any remaining callers and migrate them to the catalog-based flow.
- Ensure naming consistently reflects that the system can expose multiple environments.

12. Move app behavior from hardcoded kinds to capability-driven rendering

- Replace UI checks against `"local"` and `"worktree"` with metadata derived from the server.
- Add explicit environment capability metadata to the API if the app needs it, for example:
  - supports primary checkout promotion
  - supports squash merge
  - supports host-openable files
  - uses isolated workspace semantics
- Let users see and choose workflow independently from environment when starting a thread.
- Show workflow progress/status in thread detail, for example:
  - branch prepared
  - work committed
  - squash merged
  - archived automatically
- Replace current implicit settings like auto-archive-on-commit with workflow-aware completion settings.

13. Tighten persistence and restore behavior

- Make persisted environment state versioning/validation explicit.
- Stop swallowing environment restore failures silently.
- On restore failure:
  - capture a structured error
  - emit a useful event or provisioning state
  - preserve enough detail for debugging and migrations
- Consider whether `PersistedEnvironmentRecord.kind` should become a closed union in product types once environment registration is stable.

14. Add regression coverage for architectural seams

- Add daemon tests for:
  - orchestrator composition behavior
  - agent-server/orchestrator boundaries
  - environment restore failure reporting
  - multi-environment selection/defaulting
  - workflow/environment compatibility validation
  - workflow terminal-state and auto-archive behavior
  - capability-driven operation gating
  - route behavior after removing singular environment endpoints
- Add app tests for:
  - environment picker behavior from catalog metadata
  - separate workflow picker behavior
  - capability-based rendering instead of hardcoded environment IDs
- Add a fake non-host or capability-limited environment in tests to prevent future host-path assumptions.

15. Clean up naming after the refactor lands

- Remove remaining `worktree` naming from logic that is no longer specific to the git worktree implementation.
- Keep `worktree` names only where they refer to the concrete environment kind itself.
- Remove workflow behavior names from environment code once the split is complete.
- Remove provider/session behavior names from the orchestrator once that logic lives in agent-server.
- Rename `ThreadManager` to `Orchestrator` and related APIs once the extracted responsibilities match the new name.
- Re-audit comments, tests, and route names for stale “single environment” assumptions.

# Delivery Phases

1. Phase 1: Extract provider/session ownership into `packages/agent-server`

- Introduce a narrower agent runtime/session interface for the daemon to call.
- Move provider session state and provider-specific request/response handling out of `ThreadManager`.
- Keep route and product surfaces mostly stable in this phase.
- End-of-phase acceptance criteria:
  - the central daemon class no longer owns provider thread IDs or active turn IDs
  - provider-specific error interpretation no longer lives in the central daemon class
  - provider capability branching is behind `agent-server`

2. Phase 2: Extract environment lifecycle into an `EnvironmentService`

- Move environment selection/defaulting, restore, provision, cleanup, runtime caching, and watcher lifecycle into a dedicated daemon-side environment service.
- Narrow `packages/environment` contracts toward environment-native capabilities and operations.
- Remove route-level direct environment construction.
- End-of-phase acceptance criteria:
  - the central daemon class no longer chooses or restores environments directly
  - default environment policy has a single owner
  - restore failures surface as structured errors/state instead of silent fallthrough

3. Phase 3: Introduce `packages/workflow` and the two initial workflows

- Implement `noop` and `branch-commit-merge`.
- Move branch/commit/merge/archive policy out of `ThreadManager` and out of environment implementations.
- Separate structured workflow state from `workflowInstructions` prompt text.
- End-of-phase acceptance criteria:
  - workflow completion semantics are owned by workflow code
  - auto-archive behavior is workflow-driven, not a special-case side effect
  - environment code no longer encodes workflow policy like preferred worktree flows

4. Phase 4: Narrow and rename `ThreadManager` to `Orchestrator`

- After provider, environment, and workflow ownership are extracted, reduce the remaining central class to composition responsibilities.
- Rename contracts, routes, and tests from manager-centric language to orchestration-centric language where appropriate.
- End-of-phase acceptance criteria:
  - the renamed orchestrator composes services rather than re-implementing their internals
  - the name change reflects actual responsibility, not cosmetic churn

5. Phase 5: Clean up API/UI surfaces and remove compatibility debt

- Remove stale singular-environment APIs.
- Add capability-driven environment metadata and workflow metadata to the app surface.
- Replace hardcoded `"local"` / `"worktree"` UI behavior with environment capabilities plus workflow state.
- End-of-phase acceptance criteria:
  - app behavior is not primarily keyed off environment string literals
  - singular environment compatibility APIs are removed
  - no legacy compatibility wrappers remain unless they are explicitly documented as temporary migration code

6. Phase 6: Final audit and smell check

- Re-audit the implementation against the success criteria in this document.
- If a responsibility still primarily lives in the wrong layer, keep refactoring before considering the plan complete.
- End-of-phase acceptance criteria:
  - all success criteria above are satisfied
  - remaining compromises are explicitly documented as intentional, not accidental leftovers

# Validation

- Before major refactors, record the current daemon/app behavior with targeted tests around:
  - thread provisioning
  - thread work status and diff
  - commit/squash merge operations
  - primary checkout promotion/demotion
  - auto-archive behavior
  - project workflow instructions and defaults
  - system environment catalog endpoints
- During implementation, prefer package-scoped validation:
  - `pnpm --filter @beanbag/environment typecheck`
  - `pnpm --filter @beanbag/environment test`
  - `pnpm --filter @beanbag/agent-core build`
  - `pnpm --filter @beanbag/agent-server typecheck`
  - `pnpm --filter @beanbag/agent-server test`
  - `pnpm --filter @beanbag/daemon typecheck`
  - `pnpm --filter @beanbag/daemon test`
  - `pnpm --filter @beanbag/app typecheck`
  - `pnpm --filter @beanbag/app test`
- After removing singular-environment compatibility paths, add focused regression coverage before deleting fallback code.

# Open Questions/Risks

- `packages/orchestrator` may be overkill initially; keeping orchestrator code inside `apps/daemon` is reasonable until the boundary stabilizes.
- `packages/agent-server` already exists, but provider/session ownership is still partially stuck in `ThreadManager`. The refactor should avoid simply moving that smell into another poorly-bounded service.
- `agent-core` currently mixes transport/product types with runtime contracts. Some proposed interfaces may belong outside `agent-core` to avoid recreating the same coupling problem.
- The workflow abstraction should not become a second god object. It needs a small, explicit scope: lifecycle policy and completion semantics, not generic thread orchestration.
- The orchestrator should not become a renamed god object. If rename happens without extracting provider/environment/workflow ownership first, the architecture does not actually improve.
- Environment capabilities can become too granular if modeled naively. The first pass should prefer a small number of meaningful capability groups.
- Workflow actions may need to be more declarative than imperative if they are persisted or resumed mid-flight.
- Project `workflowInstructions` are currently prompt text, not a workflow model. The refactor needs to keep that distinction clear so instructions do not become the only source of workflow policy.
- The existing environment abstraction leaks plan should remain the source of truth for path/transport cleanup; this plan should not duplicate or conflict with that sequencing.
