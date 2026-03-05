# Goal
Define and adopt a first-class `Workflow` concept as the core abstraction for thread behavior.

`Local` and `Worktree` are existing workflows today, and the architecture must support adding more workflows without hardcoded branching in core systems.

A workflow must define:
- how workspace/environment preparation and provisioning works,
- what metadata appears in thread detail surfaces,
- what actions are available (both UI availability and server-side execution logic),
- how to react to thread lifecycle events (for example follow-up and archive),
- workflow status (including whether the workflow is done),
- how workspace diffs and related information are extracted.

Success criteria:
- Core daemon/thread manager types and flows are workflow-agnostic.
- `Local` and `Worktree` are implemented as workflow definitions, not manager special cases.
- Auto-archive-on-done behavior is driven by workflow status and user setting.
- Adding a new workflow does not require editing manager business logic branches.

# Status (2026-03-05 Reset)
- The previous implementation attempt is rejected and will be rolled back before continuing.
- Rejection reasons:
  - `apps/daemon/src/thread-manager.ts` is still oversized and still owns workflow-specific behavior.
  - Local/Worktree behavior was not moved into standalone workflow definition modules.
- Restart constraints for the next attempt:
  - Introduce explicit standalone workflow modules under `apps/daemon/src/workflows/` (registry + per-workflow definitions).
  - Move all workflow-specific provisioning/metadata/actions/lifecycle/status/diff/developer-instruction logic into workflow definitions.
  - Keep `ThreadManager` limited to generic orchestration, persistence coordination, dispatch, and lock/queue infrastructure.
  - Do not count adapter wrappers as complete decoupling; true ownership must live in workflow definitions.

# Scope
In scope:
- Introduce workflow contracts that cover provisioning, metadata, actions, lifecycle hooks, status, and diff extraction.
- Move Local/Worktree behavior behind workflow definitions.
- Remove/generalize hardcoded workflow logic from:
  - daemon orchestration,
  - `ThreadManager`,
  - shared event/type mapping,
  - client-side rendering paths that assume fixed workflow semantics.
- Preserve current user-visible behavior parity where intended, except where explicitly improved by workflow contracts.
- Define and execute a migration plan for DB, API, events, and UI.
- Migrate spawn selection surfaces from environment-first to workflow-first (daemon/API/app/CLI) as a direct cutover.
- Migrate project-main workspace-status + quick-commit UX to workflow-driven contracts.
- Migrate developer-instruction composition ownership into workflows (while preserving project-level instructions behavior).
- Replace operation-specific CLI commands with a generic workflow action command.

Out of scope:
- Shipping a third workflow in this change.
- Redesigning unrelated provider/runtime subsystems.
- Broad UI redesign beyond workflow-driven rendering.

ThreadManager boundary (explicit):
- Allowed:
  - lifecycle orchestration,
  - persistence/repository coordination,
  - process/session coordination,
  - generic workflow dispatch plumbing,
  - generic queue/lock execution.
- Not allowed:
  - workflow-specific business logic,
  - worktree-specific git state machines,
  - hardcoded action/promotion/demotion semantics.

# Proposed Interface (V3)
```ts
type WorkflowId = string;
type WorkflowJson = null | boolean | number | string | WorkflowJson[] | { [k: string]: WorkflowJson };
type WorkflowJsonObject = { [k: string]: WorkflowJson };

type WorkflowTone = "default" | "success" | "warning" | "danger";
type WorkflowStatusState = "active" | "done" | "blocked";

type WatchTarget =
  | { kind: "path-exists"; path: string }
  | { kind: "path-changed"; path: string; recursive?: boolean }
  | { kind: "git-head-changed"; repoRoot: string };

type WorkflowStatus = {
  state: WorkflowStatusState;
  done: boolean;
  summary: string;
  tone?: WorkflowTone;
  code?: string;
  data?: WorkflowJsonObject;
};

type WorkflowDetailValue =
  | { kind: "text"; text: string }
  | { kind: "pill"; label: string; tone?: WorkflowTone };

type WorkflowDetailRow = {
  id: string;
  label: string;
  value: WorkflowDetailValue;
  inlineCta?: {
    actionId: string;
    label: string;
  };
};

type WorkflowListAdornment =
  | { kind: "pill"; label: string; tone?: WorkflowTone }
  | { kind: "icon"; icon: string; label?: string };

type WorkflowActionAvailability = "enabled" | "disabled" | "hidden";

type WorkflowActionLock =
  | { scope: "thread" }
  | { scope: "project"; key: string };

type WorkflowActionExecution = "inline" | "queued";

type WorkflowAction = {
  id: string;
  label: string;
  description?: string;
  payloadSchema?: WorkflowJsonObject;
  availability: WorkflowActionAvailability;
  disabledReason?: string;
  execution: WorkflowActionExecution;
  lock?: WorkflowActionLock;
  confirm?: {
    title: string;
    body: string;
  };
};

type WorkflowActionResult = {
  status: "accepted" | "completed" | "noop" | "failed";
  message: string;
  operation?: {
    id: string;
    executionStatus: "queued" | "running";
  };
  data?: WorkflowJsonObject;
};

type WorkflowArchiveDecision = {
  requiresForce: boolean;
  code?: string;
  message?: string;
};

type WorkflowDiffSection =
  | { kind: "summary"; title?: string; lines: string[] }
  | { kind: "commit-list"; commits: Array<{ sha: string; message: string; authorName: string; timestamp: number }> }
  | { kind: "patch"; patch: string; truncated?: boolean };

type WorkflowDiffInfo = {
  title?: string;
  sections: WorkflowDiffSection[];
  data?: WorkflowJsonObject;
};

type WorkflowWorkspaceStatusDetails = {
  pill: {
    label: string;
    tone?: WorkflowTone;
  };
  popover?: {
    title?: string;
    sections: Array<{ title?: string; lines: string[] }>;
  };
  actionIds?: string[];
};

interface WorkflowContext<TState extends WorkflowJsonObject = WorkflowJsonObject> {
  thread: Thread;
  project: Project;
  workspaceRootPath?: string;
  stateVersion: number;
  state: Readonly<TState>;
}

interface WorkflowRuntimeApi<TState extends WorkflowJsonObject = WorkflowJsonObject> {
  listThreadEvents(): ThreadEvent[];
  resolveWorkspaceRoot(): string | undefined;
  patchState(patch: Partial<TState>): void;
  replaceState(next: TState): void;
  appendWorkflowEvent(event: {
    phase: "requested" | "queued" | "running" | "completed" | "failed";
    actionId?: string;
    message: string;
    data?: WorkflowJsonObject;
  }): void;
  runWithLock<T>(lock: WorkflowActionLock, fn: () => Promise<T>): Promise<T>;
  llm: {
    complete(args: {
      prompt: string;
      input?: string;
      context?: WorkflowJsonObject;
    }): Promise<{ text: string }>;
  };
  shell: {
    exec(args: {
      cwd: string;
      command: string;
      timeoutMs?: number;
      env?: Record<string, string>;
    }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  };
}

interface WorkflowDefinition<TState extends WorkflowJsonObject = WorkflowJsonObject> {
  id: WorkflowId;
  displayName: string;
  icon: string;
  stateVersion: number;

  createInitialState(input: { thread: Thread; project: Project }): TState;
  migrateState?(input: {
    fromVersion: number;
    state: WorkflowJsonObject;
  }): { version: number; state: TState };

  prepareWorkspace(
    input: WorkflowContext<TState>,
    api: WorkflowRuntimeApi<TState>,
  ): Promise<{ workspaceRootPath: string }>;

  getThreadMetadata(
    input: WorkflowContext<TState>,
    api: WorkflowRuntimeApi<TState>,
  ): Promise<{ detailRows: WorkflowDetailRow[]; listAdornments?: WorkflowListAdornment[] }>;

  getWorkspaceStatusDetails?(
    input: WorkflowContext<TState>,
    api: WorkflowRuntimeApi<TState>,
  ): Promise<WorkflowWorkspaceStatusDetails | undefined>;

  getActions(input: WorkflowContext<TState>, api: WorkflowRuntimeApi<TState>): Promise<WorkflowAction[]>;

  runAction(
    input: WorkflowContext<TState> & { actionId: string; payload?: WorkflowJsonObject },
    api: WorkflowRuntimeApi<TState>,
  ): Promise<WorkflowActionResult>;

  beforeFollowUp?(
    input: WorkflowContext<TState> & { request: TellThreadRequest },
    api: WorkflowRuntimeApi<TState>,
  ): Promise<void> | void;

  beforeArchive?(
    input: WorkflowContext<TState> & { force?: boolean },
    api: WorkflowRuntimeApi<TState>,
  ): Promise<void> | void;

  afterArchived?(
    input: WorkflowContext<TState>,
    api: WorkflowRuntimeApi<TState>,
  ): Promise<void> | void;

  getStatus(input: WorkflowContext<TState>, api: WorkflowRuntimeApi<TState>): Promise<WorkflowStatus>;

  getArchiveDecision?(
    input: WorkflowContext<TState>,
    api: WorkflowRuntimeApi<TState>,
  ): Promise<WorkflowArchiveDecision>;

  getDiff(
    input: WorkflowContext<TState> & { selection?: WorkflowJsonObject },
    api: WorkflowRuntimeApi<TState>,
  ): Promise<WorkflowDiffInfo>;

  getWatchTargets?(input: WorkflowContext<TState>): WatchTarget[];
}
```

Interface decisions for this plan:
- Keep workflow-specific behavior in workflow definitions; shared helpers are optional and only extracted after repeated real usage.
- Keep closed_internal unions for core orchestration states (`WorkflowStatusState`, action phase, lock scope).
- Keep extension fields only in `data` payloads (`WorkflowJsonObject`) for workflow-specific extras.
- Capability APIs must stay low-level and domain-agnostic (events/state/locks/llm/shell), not operation-specific (`commit`, `squash_merge`, `promote`, `demote`).
- Workflow status/workspace logic is computed inside workflow definitions (typically via `shell.exec`), not via manager-owned workflow helper APIs.
- Workflow-driven developer instructions are composed by workflow definitions; manager only invokes composition hooks and passes context.
- Keep `getWorkspaceStatusDetails(...)` as the explicit escape hatch for workspace-status pill + popover.
- Keep `inlineCta` for simple metadata-row CTA.

# Execution Semantics (Required)
1. Action execution and queueing
- Manager enforces at most one running workflow action per thread.
- `execution: "queued"` actions always emit phases: `requested -> queued -> running -> completed|failed`.
- `execution: "inline"` actions emit phases: `requested -> running -> completed|failed`.
- `lock` controls cross-thread serialization. `scope: "project"` prevents concurrent conflicting actions in the same project.

2. Idempotency
- Each action request carries `clientRequestId` (generated by client if missing).
- Duplicate request (`threadId + actionId + clientRequestId`) returns previous result and does not re-run logic.

3. Lifecycle hooks
- `beforeFollowUp` runs before tell/systemTell dispatch.
- `beforeArchive` runs before archive mutation.
- Hook failures block the operation and produce workflow failure event payloads.

4. Done and auto-archive trigger model
- `getStatus()` is evaluated at minimum after: provisioning completion, action completion, follow-up completion, and daemon boot reconciliation.
- Auto-archive is predicate-based (not transition-tracked): archive when `done=true` and all gates pass.
- Auto-archive gate: user setting enabled, thread not already archived, thread status idle.
- Auto-archive evaluation is idempotent; repeated status evaluations must not create duplicate archive side effects.
- Auto-archive is one-way; `done=false` after archive does not unarchive.

5. Archive decision precedence
- Archive flow order is: `beforeArchive` hook -> `getArchiveDecision` -> archive mutation.
- `requiresForce: true` blocks archive unless request includes `force=true`.
- `getStatus().done` does not bypass `getArchiveDecision`; force policy always wins.
- Exception: when thread workflow is unknown/unavailable, archive/unarchive bypass workflow hooks/decisions and apply direct archive mutation.

6. Runtime API safety contract
- `shell.exec` must enforce bounded execution defaults:
  - default timeout when unset,
  - bounded output capture with truncation markers,
  - normalized non-zero exit handling (`exitCode`, `stderr`) with no thrown transport ambiguity.
- `shell.exec.cwd` must be constrained to project/workspace-owned paths for that thread; reject unrelated roots.
- `shell.exec.env` must be additive and sanitized; do not allow overriding guarded daemon/runtime vars.
- `llm.complete` must include request/response telemetry through workflow events for auditability.

# Migration Plan (Concrete)
No-wrapper policy:
- Legacy daemon routes are removed in the same rewrite that introduces canonical workflow routes.
- No compatibility route layer is allowed.
- No mixed legacy/canonical event projection adapter is allowed.

1. Phase 1: Persistence and request contract rewrite
- Add thread fields: `workflowId`, `workflowStateVersion`, `workflowStateJson`.
- Backfill existing rows from persisted `environmentId` mapping (`local -> local`, `worktree -> worktree`).
- Make spawn/create contracts workflow-first (`workflowId` required in public API).
- Remove public request/response contract usage of:
  - `environmentId` as a selector,
  - `demotePrimaryIfNeeded`,
  - operation-specific promote/demote request surfaces.

2. Phase 2: Standalone workflow runtime and registry
- Create `apps/daemon/src/workflows/` with:
  - `types.ts`,
  - `registry.ts`,
  - `local/*`,
  - `worktree/*`,
  - `unknown/*`.
- Move all workflow-specific behavior into workflow definitions:
  - provisioning,
  - metadata,
  - actions,
  - lifecycle hooks,
  - status,
  - diff,
  - developer-instruction composition.
- Keep `ThreadManager` orchestration-only (dispatch, persistence coordination, locks/queueing, lifecycle plumbing).

3. Phase 3: Canonical route cutover (single-step)
- Add canonical workflow endpoints:
  - `GET /system/workflows`,
  - `GET /threads/:id/workflow/metadata`,
  - `GET /threads/:id/workflow/actions`,
  - `POST /threads/:id/workflow/actions/:actionId`,
  - `GET /threads/:id/workflow/status`,
  - `GET /threads/:id/workflow/diff`.
- Remove legacy daemon endpoints in the same phase:
  - `/threads/:id/primary-status`,
  - `/threads/:id/promote`,
  - `/threads/:id/demote-primary`,
  - `/threads/:id/operations`,
  - `/threads/:id/work-status`,
  - `/threads/:id/git-diff`,
  - `/system/environment`,
  - `/system/environments`.
- Remove legacy route wiring from OpenAPI/Hono route typing so clients cannot compile against deleted paths.

4. Phase 4: Canonical event cutover
- Emit only canonical workflow event families:
  - `system/workflow/action`,
  - `system/workflow/status`,
  - `system/workflow/lifecycle`.
- Remove legacy workflow event writes.
- Update projection/timeline readers to canonical events only (no mixed-event adapter).

5. Phase 5: App rewrite to canonical workflow contracts
- Move thread detail/list rendering to workflow metadata/status/actions/diff APIs.
- Move project-main selector to workflow catalog only.
- Rebuild workspace quick actions around workflow actions only.
- Remove all UI logic keyed off `thread.environmentId` and `thread.primaryCheckout`.

6. Phase 6: CLI rewrite to canonical workflow contracts
- Add first-class generic action command:
  - `thread action <threadId> <actionId>`.
- Remove operation-specific commands (`commit`, `squash-merge`, `promote`, `demote`).
- Rewire CLI status/diff reads to workflow endpoints only.
- Remove CLI reliance on legacy primary-checkout fields.

7. Phase 7: Contract and codebase cleanup
- Remove legacy operation/primary-checkout types from shared contracts.
- Remove `environment-registry` exports/usages and delete:
  - `packages/agent-server/src/environment-registry.ts`,
  - related tests and index exports.
- Drop deprecated thread fields from shared API models once migrations and readers no longer require them.

Rewrite gates (must pass before merge):
- 100% daemon route surface for workflow behavior is canonical-only.
- 100% app and CLI workflow behavior compiles and runs without legacy route references.
- No route, schema, or caller references `demotePrimaryIfNeeded`.
- No manager/UI/CLI branching on `thread.environmentId` or `thread.primaryCheckout`.
- `ThreadManager` contains no workflow-specific action logic.
- Existing data opens and runs through workflow definitions after DB backfill.

# Unknown Workflow Behavior (Required)
- Spawn with unknown `workflowId`: reject with 400.
- Existing thread with unknown `workflowId`:
  - thread remains visible and readable,
  - metadata shows `Workflow unavailable`,
  - workflow actions/follow-up that require workflow runtime are blocked,
  - archive/unarchive still work via direct archive mutation (no workflow hook/decision evaluation).
- Unknown workflow state migration failure:
  - mark workflow status as `blocked`,
  - include recovery message in workflow status summary,
  - never silently downgrade to another workflow.

# UI Parity Matrix (Required)
1. Workspace status row
- Contract source: `getWorkspaceStatusDetails()`.
- Must support: pill label/tone, popover sections, action buttons.

2. Worktree primary checkout row (active/inactive + CTA)
- Contract source: `getThreadMetadata()` row with pill value + `inlineCta`.
- Action source: `getActions()` + `runAction()`.

3. Project list active badge
- Contract source: `getThreadMetadata().listAdornments`.

4. Worktree path/open-directory row
- Contract source: `getThreadMetadata()` row payload.

5. Commit/squash controls currently in workspace popover
- Contract source: `getWorkspaceStatusDetails().actionIds` + `getActions()` descriptors.

6. Project-main workflow selector + workspace quick actions
- Selector source: workflow catalog endpoint(s) and workflow IDs (not legacy environment endpoint assumptions).
- Workspace status/quick commit path source: workflow metadata/actions only.

7. Timeline/projection operation rendering
- Source: normalized projection model from canonical workflow events only.
- Must preserve current readability characteristics (collapsed operation grouping, titles, and detail lines).

# Implementation Steps
Execution model:
- Execute as a coordinated rewrite with no compatibility route layer.
- Update daemon routes, shared contracts, app, and CLI in lockstep before merge.
- Prefer phase-isolated commits, but do not merge partial compatibility states.

1. Phase 0: Baseline and WIP reset
- Tasks:
  - `P0.1` Freeze workflow WIP against this plan and isolate unrelated changes.
  - `P0.1a` Roll back rejected workflow migration code, then restart from clean baseline.
  - `P0.2` Capture baseline behavior snapshots for Local/Worktree (thread detail rows, workspace status, operations timeline, CLI outputs).
  - `P0.3` Add tracking checklist for phase status in this document.
- Exit criteria:
  - Baseline snapshots exist and are referenced by tests/fixtures.
  - Remaining WIP is either aligned to this plan or explicitly dropped.

2. Phase 1: Persistence and contract rewrite
- Tasks:
  - `P1.1` Add thread persistence fields (`workflowId`, `workflowStateVersion`, `workflowStateJson`) and DB migration/backfill (`local -> local`, `worktree -> worktree`).
  - `P1.2` Make spawn/create contracts workflow-first and remove legacy selector inputs from public API.
  - `P1.3` Remove `demotePrimaryIfNeeded` from request schemas/contracts.
  - `P1.4` Add canonical workflow action request envelope with `payload` and `clientRequestId`.
- Exit criteria:
  - Existing data migrates cleanly.
  - Spawn/create paths compile and run with workflow-only selector inputs.
  - Action request contract is explicit about idempotency key transport.

3. Phase 2: Standalone workflow runtime and manager decoupling
- Tasks:
  - `P2.1` Implement workflow registry keyed by `workflowId`.
  - `P2.1a` Create standalone workflow module layout under `apps/daemon/src/workflows/`:
    - `registry.ts`,
    - `types.ts`,
    - `local/`,
    - `worktree/`,
    - `unknown/`.
  - `P2.2` Implement workflow context loading + state migration.
  - `P2.3` Implement unknown-workflow read-only behavior.
  - `P2.4` Implement `WorkflowRuntimeApi` (`events`, `state`, `locks`, `llm`, `shell`) with safety constraints.
  - `P2.5` Implement generic manager dispatch + queue/lock envelopes.
  - `P2.6` Enforce server-side action execution policy:
    - reject `hidden`/`disabled` actions,
    - enforce idempotency by `(threadId, actionId, clientRequestId)`.
- Exit criteria:
  - Manager has no workflow-specific helper logic or workflow-specific action identifiers.
  - Runtime API is infrastructure-level only.
  - Action execution policy is enforced server-side.
  - `ThreadManager` is materially reduced in size because workflow behavior is extracted into standalone modules.

4. Phase 3: Canonical daemon route cutover
- Tasks:
  - `P3.1` Add canonical workflow routes for catalog/metadata/actions/status/diff.
  - `P3.2` Remove legacy daemon routes (`promote`, `demote-primary`, `operations`, `work-status`, `git-diff`, `primary-status`, `system/environment*`) in the same change set.
  - `P3.3` Remove legacy route declarations from typed client surfaces.
- Exit criteria:
  - Daemon workflow route surface is canonical-only.
  - App/CLI cannot compile against removed legacy routes.

5. Phase 4: Canonical event cutover
- Tasks:
  - `P4.1` Emit only canonical workflow events (`action`, `status`, `lifecycle`).
  - `P4.2` Remove legacy workflow event writes and legacy-only projection paths.
- Exit criteria:
  - Timeline/projection reads canonical workflow event families only.

6. Phase 5: UI rewrite to workflow contracts
- Tasks:
  - `P5.1` Move thread detail/list surfaces to workflow metadata/status/actions/diff contracts.
  - `P5.2` Migrate project-main selector and workspace quick actions to workflow catalog/actions only.
  - `P5.3` Remove direct reads of `thread.primaryCheckout` and environment-specific legacy fields.
- Exit criteria:
  - UI parity matrix passes for required rows, badges, and workspace actions.
  - UI no longer branches by `thread.environmentId`.

7. Phase 6: CLI rewrite to workflow contracts
- Tasks:
  - `P6.1` Add `thread action <threadId> <actionId>` backed by `POST /threads/:id/workflow/actions/:actionId`.
  - `P6.2` Support `--payload <json>` and `--request-id <id>` for idempotent retries.
  - `P6.3` Remove operation-specific commands (`commit`, `squash-merge`, `promote`, `demote`) and route users to `thread action`.
  - `P6.4` Rewire CLI work-status/diff reads to workflow status/diff APIs only.
- Exit criteria:
  - CLI can trigger arbitrary workflow actions.
  - CLI has no legacy daemon route dependencies.

8. Phase 7: Cleanup and hardening
- Tasks:
  - `P7.1` Remove legacy operation/primary-checkout types from shared contracts.
  - `P7.2` Replace/remove all remaining `environment-registry` usage, then delete module/tests/index exports.
  - `P7.3` Drop compatibility fields (`environmentId`, `primaryCheckout`) once readers no longer require them.
  - `P7.4` Add manager-boundary, workflow-contract, migration, and idempotency tests.
- Exit criteria:
  - Required validation checks in this document pass in CI.
  - No outstanding architecture or migration gate violations remain.

# Validation
1. Compile/type checks
- `pnpm --filter @beanbag/daemon typecheck`
- `pnpm --filter @beanbag/agent-core typecheck`
- `pnpm --filter @beanbag/app typecheck`
- `pnpm --filter @beanbag/cli typecheck`

2. Tests
- `pnpm --filter @beanbag/daemon test`
- `pnpm --filter @beanbag/agent-core test`
- `pnpm --filter @beanbag/app test`
- `pnpm --filter @beanbag/cli test`

3. Architecture checks (required)
- No manager-owned workflow business logic methods remain.
- Standalone workflow definitions exist and are the sole owners of Local/Worktree workflow business logic.
- No tests call private manager methods via casts.
- No shared workflow capability API exposes operation-specific helpers (`commit`, `squash_merge`, `promote`, `demote`).
- No shared workflow capability API exposes workflow-status/workspace-domain helpers that encode Local/Worktree semantics.
- No UI reads `thread.primaryCheckout` or workflow-specific legacy fields.
- No manager/UI/CLI workflow branching by `thread.environmentId`.
- Developer-instruction composition paths are workflow-owned; manager invokes generic hooks only.
- No `environment-registry` symbol is imported in production code.

4. Migration checks (required)
- DB migration backfills old rows correctly.
- Spawn/create paths require workflow selection and no longer accept legacy environment-selector request shapes.
- Legacy daemon workflow endpoints are removed and no longer routable.
- Canonical workflow events cover all migrated action/status/lifecycle flows.
- Projection/timeline rendering remains equivalent while reading canonical workflow event families only.
- `demotePrimaryIfNeeded` is removed from request schemas, route handlers, and app/CLI callers.
- CLI can execute arbitrary workflow actions via the generic `thread action` path (including payload + request-id handling).

5. Behavior checks (required)
- Local and Worktree run entirely through workflow definitions.
- Workspace status row/popover parity is preserved.
- Primary checkout row + CTA parity is preserved for Worktree.
- Project list active badge parity is preserved.
- Auto-archive runs from predicate evaluation (`done=true` + gates) and remains idempotent across repeated evaluations.
- Project-main workflow selector and workspace quick actions keep parity after workflow-first migration.
- CLI uses `thread action` as the only action execution surface (zero operation-specific aliases).
- Generic CLI workflow action command successfully triggers action execution and reports queued/running/completed/noop/failed outcomes.
- Worktree demote/promote logic executes inside the Worktree workflow definition (not manager methods).

# Open Questions/Risks
- Whether canonical workflow event names should be versioned immediately (`system/workflow/v1/*`) to reduce future migration churn.
- Whether action payload schemas should be strict JSON Schema or typed decode functions per workflow.
- Whether optimistic UI state for action queue phases is needed for responsiveness, or server-only event updates are sufficient.
- Whether `getWatchTargets()` needs global throttling/debouncing rules to avoid high-churn repo watching costs.
- Rewrite risk: larger single-cutover blast radius across daemon/app/CLI requires strong integration validation before merge.
