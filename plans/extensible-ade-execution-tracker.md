# Extensible ADE Execution Tracker

## Status Legend

- `[ ]` not started
- `[~]` in progress
- `[x]` complete

## Global Progress

- `[x]` Planning decisions locked
- `[x]` Phase 1 complete
- `[x]` Phase 2 complete
- `[x]` Phase 3 complete
- `[x]` Phase 4 complete
- `[ ]` Phase 5 complete
- `[ ]` Phase 6 complete

## Locked Decisions (Do Not Reopen Without Explicit Product Decision)

- `[x]` Drop task model data migration (no backfill/export requirement).
- `[x]` Local trusted code only.
- `[x]` Rename package names now.
- `[x]` Boundary-first architecture before first-class extension runtime.

## Phase 1: Task Removal + Rename

- `[x]` Remove task domain types/schemas/protocol entities.
- `[x]` Remove task DB schema/repositories/routes.
- `[x]` Remove task CLI commands and `BB_TASK_ID`.
- `[x]` Remove task web routes/views/components/hooks.
- `[x]` Remove websocket `task` entity semantics.
- `[x]` Rename packages to `agent-core`, `agent-server`, `ui-core`, `app`.
- `[x]` Update tests/docs/scripts.
- `[x]` Run `pnpm typecheck`.
- `[x]` Run `pnpm test`.

## Phase 2: Boundary Extraction

- `[x]` Define and apply provider adapter contracts.
- `[x]` Define and apply environment adapter contracts.
- `[x]` Define and apply thread orchestrator contracts.
- `[x]` Define scheduler service interfaces.
- `[x]` Keep composition static in app layer.

## Phase 3: UI Core Hardening

- `[x]` Extract conversation primitives to `ui-core`.
- `[x]` Extract prompt composer primitives to `ui-core`.
- `[x]` Introduce stable 3-pane layout slots.
- `[x]` Add right-panel artifact/diff/markdown primitives.

## Phase 4: Multi-Adapter Validation

- `[x]` Ship codex adapter under new interface.
- `[x]` Ship at least one additional provider adapter.
- `[x]` Ship local environment adapter.
- `[x]` Ship at least one additional environment adapter.
- `[x]` Validate capability-driven fallback behavior.

## Phase 5: Scheduler/Automations

- `[ ]` Add schedule persistence model.
- `[ ]` Add scheduler execution engine.
- `[ ]` Add run history/status model.
- `[ ]` Add app UI for schedules and runs.

## Phase 6: First-Class Extension Runtime (Optional)

- `[ ]` Define local trusted extension manifest.
- `[ ]` Define extension API versioning.
- `[ ]` Add registration/loading for provider/environment/ui/action extensions.
- `[ ]` Document extension lifecycle and compatibility rules.

## Current Focus

- Next focus: Phase 5 scheduler persistence + execution engine.
