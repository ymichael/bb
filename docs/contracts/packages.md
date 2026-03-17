# Package Contracts

This document is the Phase 5 contract catalog for package boundaries.

## Dependency Direction (Allowed)

- `@bb/core`: no internal runtime dependencies.
- `@bb/ui-core`: no internal runtime dependencies.
- `@bb/provider-adapters` -> `@bb/core`.
- `@bb/db` -> `@bb/core`.
- `@bb/environment` -> `@bb/core`.
- `@bb/server` -> `@bb/core`, `@bb/environment`, `@bb/provider-adapters`, `@bb/db`.
- `@bb/app` -> `@bb/core`, `@bb/ui-core`.
- `@bb/cli` -> `@bb/core`, `@bb/server`.

No other cross-package runtime imports are allowed.

## Public API Inventory

### `@bb/core`

- Domain types: project, thread, event, protocol, API payloads.
- Runtime contracts: provider/environment/orchestrator/scheduler interfaces.
- Guards/helpers: `assertNever`, `toRecord`, `getStringField`.
- Event normalization helpers:
  - `createProviderEventEnvelope`
  - `decodeProviderEventEnvelope`
  - `unwrapProviderEventPayload`
  - `resolveProviderEventMethod`
  - `normalizeThreadEventType`
  - `extractTurnIdFromPersistedEventData`
  - `extractProviderThreadIdFromPersistedEventData`
- UI projection: `toUIMessages`.

### `@bb/provider-adapters`

- Provider adapter registry and implementations (`codex`).
- Provider runtime (`ProviderRuntime`) and RPC lifecycle errors.

### `@bb/environment`

- Environment adapter registry and implementations (`local`, `worktree`).
- Workspace/process helpers used by daemon orchestration.

### `@bb/db`

- Database connection and migration entrypoints.
- Repositories: `ProjectRepository`, `ThreadRepository`, `EventRepository`.
- Schema exports for `projects`, `threads`, `queued_thread_messages`, `events`.

### `@bb/server`

- HTTP + WS host app composition (`createServer`).
- Thread orchestration implementation (`ThreadManager`).
- Route layer for projects, threads, system APIs.

### `@bb/ui-core`

- Reusable ADE primitives for shell/layout, timeline, composer, and context surfaces.

### `@bb/app`

- Product composition shell over `agent-core` + `ui-core` contracts.
- React app shell, thread timeline, prompt composer, and settings views.

## Boundary Ownership

- `closed_internal` (BB-owned, exhaustive handling expected):
  - app-defined thread events (`client/thread/start`, `client/turn/start`, `system/*`)
  - thread status unions
  - API error code unions
- `open_external` (provider/runtime-owned, tolerant fallback expected):
  - provider event methods/payloads
  - provider-specific action/status tokens in tool/event payloads
