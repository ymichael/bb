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
- `[ ]` Phase 7 complete
- `[ ]` Phase 8 complete

## Locked Decisions (Do Not Reopen Without Explicit Product Decision)

- `[x]` Drop task model data migration (no backfill/export requirement)
- `[x]` Local trusted code only
- `[x]` Rename package names now
- `[x]` Align folder topology with package boundaries
- `[x]` Keep daemon separate from agent-server runtime shim
- `[x]` Boundary-first architecture before first-class extension runtime
- `[x]` Deliver table-stakes features before scheduler/automation

## Phase 1: Task Removal + Package Rename

- `[x]` Remove task domain types/schemas/protocol entities
- `[x]` Remove task DB schema/repositories/routes
- `[x]` Remove task CLI commands and `BB_TASK_ID`
- `[x]` Remove task web routes/views/components/hooks
- `[x]` Remove websocket `task` entity semantics
- `[x]` Rename packages to `agent-core`, `agent-server`, `ui-core`, `app`
- `[x]` Update tests/docs/scripts
- `[x]` Run `pnpm typecheck`
- `[x]` Run `pnpm test`

## Phase 2: Boundary Extraction

- `[x]` Define and apply provider adapter contracts
- `[x]` Define and apply environment adapter contracts
- `[x]` Define and apply thread orchestrator contracts
- `[x]` Define scheduler service interfaces
- `[x]` Keep composition static in app layer

## Phase 3: UI Core Hardening

- `[x]` Extract conversation primitives to `ui-core`
- `[x]` Extract prompt composer primitives to `ui-core`
- `[x]` Introduce stable layout slot contracts
- `[x]` Add optional right-panel/context primitives

## Phase 4: Multi-Adapter Validation

- `[x]` Ship codex adapter under new interface
- `[x]` Ship at least one additional provider adapter
- `[x]` Ship local environment adapter
- `[x]` Ship at least one additional environment adapter
- `[x]` Validate capability-driven fallback behavior

## Phase 5: Folder Rename + Daemon/Agent-Server Split

- `[x]` Move `packages/core` to `packages/agent-core`
- `[x]` Move `apps/web` to `apps/app`
- `[x]` Create `packages/agent-server` runtime bridge package from current mixed daemon code
- `[x]` Keep/reshape `apps/daemon` as `@beanbag/daemon` host app
- `[x]` Update workspace paths (`pnpm-workspace.yaml`, `turbo`, Vitest, scripts, tsconfig refs)
- `[ ]` Update docs and references to new folder paths
- `[ ]` Publish contract catalog for package boundaries, API schemas, and DB shapes
- `[ ]` Document all supported `events.type` values and event payload typing strategy
- `[ ]` Add typed decode/guard helpers where runtime unknown payloads cross boundaries
- `[ ]` Enforce exhaustive handling for closed internal unions (`assertNever`)
- `[ ]` Implement event pipeline boundary: provider-specific -> normalized DB events -> UI projection -> render
- `[ ]` Run `pnpm typecheck`
- `[ ]` Run `pnpm test`

## Phase 6: Table-Stakes Feature Pass

- `[ ]` Environment provisioning parity for local/worktree (lifecycle + UX)
- `[ ]` Prompt composer file attachments end-to-end
- `[ ]` Prompt composer image attachments/paste end-to-end
- `[ ]` Voice input capture to prompt text with fallback behavior
- `[ ]` Add test coverage for each table-stakes capability

## Phase 7: Scheduler/Automations

- `[ ]` Add schedule persistence model
- `[ ]` Add scheduler execution engine
- `[ ]` Add run history/status model
- `[ ]` Add app UI for schedules and runs

## Phase 8: First-Class Extension Runtime (Optional)

- `[ ]` Define local trusted extension manifest
- `[ ]` Define extension API versioning
- `[ ]` Add registration/loading for provider/environment/ui/action extensions
- `[ ]` Document extension lifecycle and compatibility rules

## Current Focus

- Next focus: Phase 5 folder rename + daemon/agent-server split.
- Supporting plans:
  - `plans/extensible-ade-phase5-split-map.md`
  - `plans/extensible-ade-contract-hardening.md`
  - `plans/extensible-ade-table-stakes-phase6.md`

## Suggested Commit Chunks for Phase 5

- Chunk A: folder moves and workspace/script/config path updates only.
- Chunk B: extract `packages/agent-server` runtime bridge surface and exports.
- Chunk C: reshape `apps/daemon` host to consume `@beanbag/agent-server`.
- Chunk D: docs cleanup + final typecheck/tests.
