# Extensible ADE Replatform Plan

## Status

- State: active
- Last updated: 2026-02-26
- Owner: Beanbag core

## Intent

Replatform Beanbag from a task-centric orchestration app into a thread-first, hackable, extensible agentic development environment (ADE), while being intentional about package boundaries and interfaces before introducing a first-class extension runtime.

## Locked Decisions

- Data migration policy: drop task model data completely.
- Trust model: local trusted code only.
- Package naming: rename now (no long-lived legacy package names).
- Architecture priority: provider/workflow/environment boundaries first, extension type system later.

## Product Principles

- Thread-first core primitive; no task entity or task-derived UX flows.
- Multi-provider support is table stakes (for example: codex, pi-mono, claude code).
- Multi-environment provisioning support is table stakes (for example: local, worktrees, checkouts, sandbox, cloud sandbox).
- UI primitives should be batteries-included, composable, and replaceable.
- Application layout should support left IA sidebar, center thread surface, and right context panel.
- Automation/scheduling of thread operations is a core capability, not a plugin afterthought.

## Target Bones (Packages)

### `@beanbag/agent-core`

Provider/workflow/environment agnostic contracts and domain primitives.

- Thread + event domain types
- Provider-neutral normalized message model
- API/protocol contracts
- Capabilities and adapter interfaces
- Shared guards/assertions and decode helpers

### `@beanbag/agent-server`

Runtime and orchestration host.

- Provider adapter execution runtime
- Environment adapter provisioning lifecycle
- Thread orchestration lifecycle
- Scheduling/automation service
- HTTP/WS host, persistence integration

### `@beanbag/ui-core`

Reusable ADE UI primitives.

- Conversation timeline components
- Prompt composer/input components
- Diff/artifact/operation rendering primitives
- Three-pane layout primitives and slot contracts

### `@beanbag/app`

Composed product shell.

- Route composition
- Information architecture
- Default provider/environment wiring
- Default panel and renderer selection

## Boundary-First Interfaces (Phase-2 critical)

No first-class extension loader yet. Start with explicit interfaces and static composition.

### Provider Adapter

Responsible for provider protocol mapping and event normalization.

- initialize/start/resume/tell/interrupt
- list models/capabilities
- normalize provider events into core event envelope
- expose provider-specific optional capabilities

### Environment Adapter

Responsible for execution context provisioning and cleanup.

- prepare workspace runtime context
- configure shell environment and policies
- support local/worktree/checkout/sandbox/cloud variants
- teardown/cleanup lifecycle

### Thread Orchestrator

Provider/environment agnostic thread lifecycle coordinator.

- spawn/tell/stop/archive
- event persistence and replay support
- per-thread runtime state handling
- delivery of normalized events to UI/API

### Scheduler Service

Durable scheduling for recurring thread operations.

- cron/interval schedule definitions
- trigger thread spawn/tell actions
- run history/status persistence
- guardrails (dedupe, concurrency limit, retry policy)

### UI Contracts

Composable rendering and layout seams.

- conversation renderer contracts
- prompt composer contracts
- right-panel artifact/diff/markdown contracts
- left sidebar IA contracts

## Roadmap

## Phase 1: Task Removal + Package Rename (breaking)

### Goals

- Remove task model and all task-related API/UI/CLI/runtime code.
- Rename package boundaries to new architecture names.

### Scope

- Remove task types/schemas/protocol entities from core package.
- Remove task tables/repositories/routes and thread task linkage columns.
- Remove task CLI command group and `BB_TASK_ID` context semantics.
- Remove task web routes/views/hooks/components and websocket task entity.
- Rename packages and update imports/scripts/docs.

### Acceptance Criteria

- No `Task*`, `taskId`, `taskRole`, `BB_TASK_ID`, or `/tasks` API surfaces remain.
- `pnpm typecheck` and `pnpm test` pass.
- Main app supports projects + threads only.

### Completion Snapshot

- Completed in commits:
  - `b169279`, `cc23e63`, `98052fd`, `33f4fbf`
- Task model removed from core/db/daemon/cli/web.
- Thread-first flows validated with green typecheck + tests.

## Phase 2: Boundary Extraction (no extension runtime)

### Goals

- Establish stable provider/environment/workflow boundaries.
- Keep behavior mostly unchanged while moving code to new package architecture.

### Scope

- Extract provider runtime abstractions into `@beanbag/agent-server`.
- Extract domain/protocol contracts into `@beanbag/agent-core`.
- Extract reusable UI primitives into `@beanbag/ui-core`.
- Keep wiring static in `@beanbag/app`.

### Acceptance Criteria

- All runtime paths flow through explicit adapter interfaces.
- New providers/environments can be added without cross-cutting edits.

### Completion Snapshot

- Completed in commit:
  - `07bbe84`
- Added explicit runtime contracts in `@beanbag/agent-core`.
- Daemon now composes provider, environment, and scheduler boundaries through registries and interface contracts.

## Phase 3: UI Core Hardening

### Goals

- Deliver high-quality reusable ADE UI components with clear seams.

### Scope

- Standardize conversation timeline primitives.
- Standardize prompt composer with batteries included (mentions, options, submit/stop states).
- Introduce stable three-pane layout contracts and slot APIs.
- Ensure right panel supports artifacts, diff summaries, markdown preview/edit.

### Acceptance Criteria

- `@beanbag/app` composes UI mostly via `@beanbag/ui-core` primitives.
- Replacing a panel/renderer is a local composition change.

### Completion Snapshot

- Completed in commit:
  - `50d6ef1`
- Introduced `@beanbag/ui-core` with three-pane layout, conversation timeline, prompt composer shell, and context panel primitives.
- Thread detail view now uses `ui-core` primitives with right-panel runtime/artifact/diff/markdown surfaces.

## Phase 4: Multi-Provider + Multi-Environment First-Party Adapters

### Goals

- Prove interfaces by implementing multiple adapters.

### Scope

- Provider adapters: codex baseline + at least one additional provider adapter.
- Environment adapters: local baseline + at least one non-local variant (worktree/checkout/sandbox/cloud).
- Capability-aware fallback behavior in UI and server.

### Acceptance Criteria

- Runtime can run with different provider/environment combinations with no core refactor.

### Completion Snapshot

- Completed in commit:
  - `07bbe84`
- Provider adapters: `codex`, `pi-mono`, `claude-code`.
- Environment adapters: `local`, `worktree`.
- Capability-aware fallback added in server model listing and app prompt options.

## Phase 5: Scheduler/Automations

### Goals

- Add durable scheduling for thread workflows.

### Scope

- Schedule persistence model
- Scheduler service execution and status reporting
- App UI for schedule management and run history

### Acceptance Criteria

- Scheduled thread operations run deterministically and are observable.

## Phase 6: Optional First-Class Extension Runtime

### Goals

- Add a formal extension registration/loading model only after boundaries are stable.

### Scope

- Local trusted extension manifest and loader
- Registration points for provider/environment/panels/renderers/actions
- Versioned extension API contract

### Acceptance Criteria

- Extensions can add behavior without weakening core boundaries.

## Risks and Mitigations

- Risk: boundary leakage during migration.
  - Mitigation: enforce adapter interfaces before adding new capabilities.
- Risk: package rename churn.
  - Mitigation: do package rename in same breaking window as task removal.
- Risk: over-engineering extension model too early.
  - Mitigation: keep static composition until Phase 6.

## Definition of Done for Replatform

- Thread-first product with no task model.
- Clear provider/environment/workflow package boundaries.
- Multi-provider and multi-environment adapters proven in production path.
- Reusable UI core powering app shell and panel layout.
- Scheduler/automations implemented for recurring thread workflows.
