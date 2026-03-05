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
- Migrate spawn selection surfaces from environment-first to workflow-first (daemon/API/app/CLI), with compatibility mapping during transition.
- Migrate project-main workspace-status + quick-commit UX to workflow-driven contracts.
- Migrate developer-instruction composition ownership into workflows (while preserving project-level instructions behavior).
- Migrate CLI thread commands off legacy promote/demote/operation endpoints.

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
1. Phase 1: Add workflow persistence and spawn selection model (dual-read/write)
- Add thread fields: `workflowId`, `workflowStateVersion`, `workflowStateJson`.
- Backfill existing rows from `environmentId` mapping (`local -> local`, `worktree -> worktree`).
- Add spawn request `workflowId?: string` while still accepting legacy `environmentId?: string`.
- Define and enforce workflow resolution precedence:
  - explicit `workflowId`,
  - explicit `environmentId` mapping,
  - persisted thread workflow (for reprovision/resume flows),
  - daemon default workflow.
- Reject incompatible explicit `workflowId` + `environmentId` pairs.
- Keep `environmentId` as compatibility field during transition.

2. Phase 2: Introduce workflow APIs and workflow catalog with compatibility shims
- Add canonical workflow endpoints:
  - `GET /system/workflows` (catalog for UI/CLI selection),
  - `GET /threads/:id/workflow/metadata`,
  - `GET /threads/:id/workflow/actions`,
  - `POST /threads/:id/workflow/actions/:actionId`,
  - `GET /threads/:id/workflow/status`,
  - `GET /threads/:id/workflow/diff`.
- Keep `/system/environment` and `/system/environments` as compatibility wrappers backed by workflow catalog data during transition.
- Route legacy environment catalog requests through workflow catalog adapters only; do not add new call sites to `environment-registry`.
- Keep legacy thread endpoints as wrappers during migration:
  - operation endpoints (`/threads/:id/promote`, `/threads/:id/demote-primary`, `/threads/:id/operations`),
  - workspace status/diff endpoints (`/threads/:id/work-status`, `/threads/:id/git-diff`),
  - primary status endpoint (`/threads/:id/primary-status`).

3. Phase 3: Event and projection migration
- Add canonical workflow events (single family):
  - `system/workflow/action`,
  - `system/workflow/status`,
  - `system/workflow/lifecycle`.
- Add projection adapter that can read both legacy and canonical events and emit one normalized operation model for UI.
- Stop writing legacy workflow-specific events once all consumers read canonical events.

4. Phase 4: UI migration (thread + project-main)
- Move thread detail/list rendering to workflow metadata/status/actions APIs.
- Migrate project-main selector from environment-first to workflow-first (keep compatibility labels while wrappers exist).
- Migrate project-main workspace status + quick-commit flow to workflow-driven metadata/actions.
- Keep temporary fallback adapter for legacy fields only during migration window.

5. Phase 5: CLI migration
- Add/standardize workflow-native CLI flows:
  - workflow-aware spawn selection,
  - workflow action execution commands.
- Add first-class generic action trigger command (`thread action <threadId> <actionId>`) with optional JSON payload and optional `clientRequestId` override.
- Rewire promote/demote/commit/squash CLI paths through workflow action APIs.
- Keep legacy CLI command aliases (`commit`, `squash-merge`, `promote`, `demote`) as wrappers over the generic workflow action command with deprecation text during transition.
- Remove CLI reads of `thread.primaryCheckout` once workflow metadata/adornments are available.

6. Phase 6: Retire legacy request fields and routes
- Remove `demotePrimaryIfNeeded` from tell request schema/API and route handling.
- Remove legacy endpoints after wrapper deprecation window:
  - `/threads/:id/primary-status`,
  - `/threads/:id/promote`,
  - `/threads/:id/demote-primary`,
  - `/threads/:id/operations`,
  - `/threads/:id/work-status`,
  - `/threads/:id/git-diff`,
  - `/system/environment`,
  - `/system/environments`.
- Remove legacy operation/primary-checkout response/request types from shared contracts.
- Remove `environment-registry` exports and runtime usage; all environment selection/listing flows must resolve via workflow catalog/registry.

7. Phase 7: Cleanup
- Remove manager workflow-specific methods and state machines.
- Drop compatibility fields (`environmentId`, `primaryCheckout`) after migration gates pass.
- Remove projection adapter compatibility branches for legacy workflow events.
- Delete `packages/agent-server/src/environment-registry.ts` and its tests once compatibility routes are removed.

Compatibility/removal gates (must pass before cleanup):
- 100% UI paths read workflow metadata/actions/status (no legacy thread-field reads).
- No daemon route handlers directly dispatch legacy operations.
- Spawn/create-thread paths are workflow-first (`workflowId`) with compatibility mapping only at boundaries.
- Project-main workflow selector uses workflow catalog endpoint(s), not environment catalog endpoint(s).
- CLI action paths use workflow action APIs only (legacy aliases optional during deprecation window).
- No manager methods with workflow-specific names/logic remain.
- No route or schema references `demotePrimaryIfNeeded`.
- No workflow branching in manager/UI/CLI based on `thread.environmentId` or `thread.primaryCheckout`.
- No `environment-registry` imports/usages remain in daemon/server entrypoints or route handlers.
- Existing data opens without migration failures across supported versions.

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
- Workspace status/quick commit path source: workflow metadata/actions (or workflow-backed compatibility adapter during migration).

7. Timeline/projection operation rendering
- Source: normalized projection model from canonical workflow events (with temporary legacy adapter while migrating).
- Must preserve current readability characteristics (collapsed operation grouping, titles, and detail lines).

# Implementation Steps
Execution model:
- Ship in ordered phases; each phase must meet exit criteria before starting cleanup in later phases.
- Keep compatibility wrappers in place until Phase 8.
- Prefer one PR per task group; avoid mixing daemon + UI + CLI behavior changes in a single PR unless required for contract compilation.

1. Phase 0: Baseline and WIP reset
- Tasks:
  - `P0.1` Freeze workflow WIP against this plan and isolate unrelated changes.
  - `P0.2` Capture baseline behavior snapshots for Local/Worktree (thread detail rows, workspace status, operations timeline, CLI outputs).
  - `P0.3` Add tracking checklist for phase status in this document.
- Exit criteria:
  - Baseline snapshots exist and are referenced by tests/fixtures.
  - Remaining WIP is either aligned to this plan or explicitly dropped.

2. Phase 1: Persistence and request contract scaffolding
- Tasks:
  - `P1.1` Add thread persistence fields (`workflowId`, `workflowStateVersion`, `workflowStateJson`) and DB migration/backfill (`local -> local`, `worktree -> worktree`).
  - `P1.2` Add repository adapters for dual read/write during migration.
  - `P1.3` Add `workflowId` to spawn contracts while keeping compatibility with `environmentId`.
  - `P1.4` Define selector precedence + incompatible selector validation.
  - `P1.5` Add canonical workflow action request envelope with `payload` and `clientRequestId`.
- Exit criteria:
  - Existing data migrates cleanly.
  - Spawn flows support both selector forms with deterministic precedence.
  - Action request contract is explicit about idempotency key transport.

3. Phase 2: Workflow registry, runtime, and manager dispatch
- Tasks:
  - `P2.1` Implement workflow registry keyed by `workflowId`.
  - `P2.2` Implement workflow context loading + state migration.
  - `P2.3` Implement unknown-workflow read-only behavior.
  - `P2.4` Implement `WorkflowRuntimeApi` (`events`, `state`, `locks`, `llm`, `shell`) with safety constraints.
  - `P2.5` Implement generic manager dispatch + queue/lock envelopes.
  - `P2.6` Enforce server-side action execution policy:
    - reject `hidden`/`disabled` actions,
    - enforce idempotency by `(threadId, actionId, clientRequestId)`.
- Exit criteria:
  - Manager has no new workflow-specific helper logic.
  - Runtime API is infrastructure-level only.
  - Action execution policy is enforced server-side.

4. Phase 3: Port Local workflow
- Tasks:
  - `P3.1` Move Local provisioning/metadata/actions/lifecycle/status/diff into Local workflow definition.
  - `P3.2` Move Local developer-instruction composition into workflow-owned hooks.
  - `P3.3` Wire Local through registry + generic dispatcher only.
- Exit criteria:
  - Local behavior parity passes contract tests.
  - No manager special-case branch remains for Local behavior.

5. Phase 4: Port Worktree workflow
- Tasks:
  - `P4.1` Move Worktree provisioning/metadata/actions/lifecycle/status/diff into Worktree workflow definition.
  - `P4.2` Move Worktree promote/demote logic into workflow actions.
  - `P4.3` Move Worktree developer-instruction composition into workflow-owned hooks.
  - `P4.4` Remove manager-owned worktree methods as replacements land.
- Exit criteria:
  - Worktree behavior parity passes contract tests.
  - Promote/demote/commit/squash semantics are workflow-owned.

6. Phase 5: Canonical routes, wrappers, and events
- Tasks:
  - `P5.1` Add canonical routes: catalog + metadata/actions/status/diff.
  - `P5.2` Rewire legacy operation/status/diff routes to workflow-backed wrappers.
  - `P5.3` Rewire legacy environment catalog routes to workflow-backed wrappers (no new `environment-registry` call sites).
  - `P5.4` Add canonical workflow event family and emission.
  - `P5.5` Add temporary projection adapter for mixed legacy/canonical events.
- Exit criteria:
  - Canonical routes functional for Local and Worktree.
  - Wrappers return parity responses while migration is active.
  - Timeline/projection reads mixed event families correctly.

7. Phase 6: UI migration
- Tasks:
  - `P6.1` Move thread detail/list surfaces to workflow metadata/status/actions contracts.
  - `P6.2` Migrate project-main selector to workflow catalog.
  - `P6.3` Migrate project-main workspace quick actions to workflow action contracts.
  - `P6.4` Remove direct reads of `thread.primaryCheckout` and environment-specific legacy fields.
- Exit criteria:
  - UI parity matrix passes for required rows, badges, and workspace actions.
  - UI no longer branches by `thread.environmentId`.

8. Phase 7: CLI migration
- Tasks:
  - `P7.1` Add `thread action <threadId> <actionId>` backed by `POST /threads/:id/workflow/actions/:actionId`.
  - `P7.2` Support `--payload <json>` and `--request-id <id>` for idempotent retries.
  - `P7.3` Rewire `commit`, `squash-merge`, `promote`, and `demote` to workflow action APIs (aliases during transition).
  - `P7.4` Rewire CLI work-status/diff reads to workflow status/diff APIs or wrappers.
- Exit criteria:
  - CLI can trigger arbitrary workflow actions.
  - Legacy CLI commands behave as compatibility aliases only.

9. Phase 8: Legacy retirement and cleanup
- Tasks:
  - `P8.1` Remove `demotePrimaryIfNeeded` from schemas, route logic, and callers.
  - `P8.2` Remove legacy operation/primary-status/work-status/git-diff/environment endpoints after deprecation window.
  - `P8.3` Remove legacy operation/primary-checkout types from shared contracts.
  - `P8.4` Replace/remove all remaining `environment-registry` usage, then delete module/tests/index exports.
  - `P8.5` Remove compatibility adapters and legacy projection branches.
  - `P8.6` Drop compatibility fields (`environmentId`, `primaryCheckout`) once gates pass.
- Exit criteria:
  - Compatibility/removal gates are all satisfied.
  - Legacy workflow/environment surfaces are removed from production code.

10. Phase 9: Hardening and release gate
- Tasks:
  - `P9.1` Add ownership tests for manager boundary.
  - `P9.2` Add workflow contract tests (metadata/actions/lifecycle/status/diff) for Local + Worktree.
  - `P9.3` Add migration tests (backfill + unknown workflow behavior).
  - `P9.4` Add concurrency/idempotency tests (duplicate request IDs, lock contention, phase ordering).
  - `P9.5` Add CLI parity tests for generic + alias action paths.
  - `P9.6` Run full typecheck/test matrix and migration/behavior validations.
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
- No tests call private manager methods via casts.
- No shared workflow capability API exposes operation-specific helpers (`commit`, `squash_merge`, `promote`, `demote`).
- No shared workflow capability API exposes workflow-status/workspace-domain helpers that encode Local/Worktree semantics.
- No UI reads `thread.primaryCheckout` or workflow-specific legacy fields.
- No manager/UI/CLI workflow branching by `thread.environmentId`.
- Developer-instruction composition paths are workflow-owned; manager invokes generic hooks only.
- No `environment-registry` symbol is imported in production code.

4. Migration checks (required)
- DB migration backfills old rows correctly.
- Spawn/create selection precedence is covered end-to-end:
  - `workflowId` only,
  - `environmentId` only (mapped),
  - both compatible,
  - both incompatible (explicit error).
- New workflow routes and legacy wrappers return equivalent behavior during transition.
- Canonical workflow events cover all migrated action/status/lifecycle flows.
- Projection/timeline rendering remains equivalent while reading mixed legacy + canonical event families.
- Legacy `work-status`/`git-diff` responses remain equivalent while backed by workflow definitions.
- `demotePrimaryIfNeeded` is removed from request schemas, route handlers, and app/CLI callers.
- CLI can execute arbitrary workflow actions via the generic `thread action` path (including payload + request-id handling).

5. Behavior checks (required)
- Local and Worktree run entirely through workflow definitions.
- Workspace status row/popover parity is preserved.
- Primary checkout row + CTA parity is preserved for Worktree.
- Project list active badge parity is preserved.
- Auto-archive runs from predicate evaluation (`done=true` + gates) and remains idempotent across repeated evaluations.
- Project-main workflow selector and workspace quick actions keep parity after workflow-first migration.
- CLI promote/demote/commit/squash commands execute through workflow actions and preserve user-visible behavior.
- Generic CLI workflow action command successfully triggers action execution and reports queued/running/completed/noop/failed outcomes.
- Worktree demote/promote logic executes inside the Worktree workflow definition (not manager methods).

# Open Questions/Risks
- Whether canonical workflow event names should be versioned immediately (`system/workflow/v1/*`) to reduce future migration churn.
- Whether action payload schemas should be strict JSON Schema or typed decode functions per workflow.
- Whether optimistic UI state for action queue phases is needed for responsiveness, or server-only event updates are sufficient.
- Whether `getWatchTargets()` needs global throttling/debouncing rules to avoid high-churn repo watching costs.
- Rollout risk if legacy wrappers remain for too long and become de facto permanent APIs.
