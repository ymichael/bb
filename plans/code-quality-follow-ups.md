# Code Quality Follow-ups

Selected items from the agent-provider, host-daemon, ui, server, and data-domain boundary cleanup reviews. Each phase is independent unless noted.

## Phase 1: Fix credential nullable ambiguity in `agent-provider-auth`

**Goal:** Eliminate fields where `null` carries two different meanings.

In `agent-provider-auth`, `lastRefreshedAt: number | null` and `lastErrorMessage: string | null` let `null` mean both "never attempted" and "attempted with no value." AGENTS.md §Contracts: *"Use `required + nullable` only when `null` has a distinct meaning."* This is the forbidden pattern.

**Changes:**
- Update `CloudAuthResolvedCredential` (or its equivalent) in `packages/agent-provider-auth/src/types.ts`:
  - Replace `lastRefreshedAt: number | null` with optional `lastRefreshedAt?: number`. Absence = "never refreshed"; presence = "refreshed at this time."
  - Replace `lastErrorMessage: string | null` with either an optional field or an explicit `lastError?: { at: number; message: string }` struct.
  - If state needs an explicit "failed last time" vs "never attempted" distinction, encode it in a `state` field with named variants — not by abusing nullable.
- Update callers in `apps/server/src/services/cloud-auth/` and any consumers.
- Add a test exercising the three states that previously collapsed to `null`: never-attempted, attempted-succeeded-no-message, attempted-failed.

**Exit criteria:**
- No field uses `| null` to mean both "unset" and "set to no value."
- Callers handle the three states explicitly.
- `pnpm exec turbo run typecheck --filter=@bb/agent-provider-auth --filter=@bb/server` passes.

## Phase 2: Move policy from host daemon to server

**Goal:** Daemon requires policy inputs from the server; no defaults, no hardcoded behavior.

**Changes:**
- Remove `SYSTEM_MAX_DIFF_BYTES` and `SYSTEM_MAX_FILE_LIST_BYTES` fallbacks in `apps/host-daemon/src/command-dispatch.ts`. Make `maxDiffBytes` and `maxFileListBytes` required on the `workspace.diff` and `workspace.list_files` commands. Update the server to always supply them.
- Add a required `skipHooks: boolean` field on the workspace commit command. Update the server to decide and pass it explicitly. Remove the hardcoded `noVerify: true` in the daemon handler.
- Make `eventSink` required on `CommandDispatchOptions`. Provide a `noopEventSink` for tests that don't care about event flow. Remove the `eventSink?.flush()` / `eventSink?.emit()` optional chains.

**Exit criteria:**
- `grep -n "SYSTEM_MAX\|noVerify: true\|eventSink?" apps/host-daemon/src/` returns no matches except in comments or tests.
- Command schemas for `workspace.diff`, `workspace.list_files`, `workspace.commit` have the new required fields.
- Server updated to supply them.
- `pnpm exec turbo run test --filter=@bb/host-daemon` passes.

## Phase 3: Consolidate workspace state ownership

**Goal:** One source of truth for "what changed in this workspace and when."

**Changes:**
- `RuntimeManager` in `apps/host-daemon/src/` currently owns a `WorkspaceWatchState` map and also orchestrates `HostWorkspace` and `HostWatcher`. Move `WorkspaceWatchState` into `packages/host-workspace` so the package that knows git state also tracks change state.
- Audit `environment-change-reporter` and runtime-manager for duplicated status checks. Pick one site to do the detection; have the other read its result.
- `trackedThreadStorageTargets` stays in RuntimeManager (daemon-level thread routing, not workspace state).

**Exit criteria:**
- `WorkspaceWatchState` defined in `host-workspace`, not `host-daemon`.
- No duplicate `getStatus()` / `lastLocalFingerprint` tracking between reporter and runtime-manager.
- `pnpm exec turbo run test --filter=@bb/host-daemon --filter=@bb/host-workspace` passes.

## Phase 4: Narrow `ThreadEvent` at the boundary, delete field-accessor helpers

**Goal:** Replace `getEventTurnId(event)`-style calls with type-narrowed access to the specific variant.

`core-ui/src/event-decode.ts` exposes helpers like `getEventTurnId`, `getEventProviderThreadId`, `getEventParentToolCallId` that projection modules call throughout the codebase. These helpers walk around `ThreadEvent`'s discriminated union with runtime accessors, erasing the type system's knowledge of which variant carries which field. The right shape is: decode/narrow once at the boundary, then access variant-specific fields directly.

**Changes:**
- In `to-view-messages.ts` and the projection modules it calls, replace calls to `getEventTurnId`, `getEventProviderThreadId`, `getEventParentToolCallId`, and similar accessors with `switch (event.type)` blocks that narrow the union.
- Where a projection genuinely needs "turnId if the event has one" across heterogeneous variants, add a single helper in `core-ui` that returns `string | undefined` with a strongly-typed parameter (`event: Extract<ThreadEvent, { turnId: string }>` or similar). Do not create a parallel union type.
- Delete the `getEvent*` accessors once call sites migrate.

**Exit criteria:**
- `grep -r "getEventTurnId\|getEventProviderThreadId\|getEventParentToolCallId" packages/core-ui/src` returns zero matches outside the file being deleted.
- No new types added that mirror `ThreadEvent`.
- `pnpm exec turbo run test --filter=@bb/core-ui` passes.

## Phase 5: Move `threadDetailActivity` from `ui-core` to `core-ui`

**Goal:** Projection logic lives with the other projection logic.

`findLatestActivityMessageId` and `shouldPreferOngoingLabelsForRow` reach into `ViewMessage` discriminated unions to classify rendering intent. That is projection logic, and projection logic lives in `core-ui`. `ui-core` should be rendering, not classification.

**Changes:**
- Move `packages/ui-core/src/thread-timeline/threadDetailActivity.ts` to `packages/core-ui/src/thread-detail-activity.ts`.
- Export from `core-ui/src/index.ts`.
- Update import sites in `ui-core` and `apps/app` to import from `core-ui`.

**Exit criteria:**
- File no longer in `ui-core/src`.
- `grep -r "threadDetailActivity" packages/ui-core/src` returns no matches.
- `pnpm exec turbo run test --filter=@bb/core-ui --filter=@bb/ui-core` passes.

## Phase 6: Extract projection state lifecycle from `to-view-messages.ts`

**Goal:** Let the main loop be read top-to-bottom without paging through initialization and finalization helpers.

`to-view-messages.ts` at 852 lines mixes state initialization, the event loop, subsidiary lifecycle handlers (tool activity, operations), and normalization passes.

**Changes:**
- Create `packages/core-ui/src/projection-state.ts`:
  - `ProjectionState` interface (currently declared inline in `to-view-messages.ts`).
  - `initProjectionState()` factory.
  - `finalizeProjectionState(state, options)` (encapsulates the current `finalizePendingMessages()` logic).
- Have `tool-activity-projection.ts` and `operation-projection.ts` register their state initialization/teardown through `projection-state.ts` rather than being set up inline in `to-view-messages.ts`.
- `to-view-messages.ts` becomes: `initProjectionState()` → loop over events → `finalizeProjectionState()` → return.

**Exit criteria:**
- `to-view-messages.ts` drops below 600 lines (sanity check that the extraction pulled weight, not a prescriptive limit).
- `ProjectionState` interface has exactly one definition, in `projection-state.ts`.
- `pnpm exec turbo run test --filter=@bb/core-ui` passes.

## Phase 7: Resolve server contract defaults at the route boundary

**Goal:** Move server policy decisions out of services and into a shared resolver that routes call before dispatching.

Routes accept `model`, `serviceTier`, `reasoningLevel`, `permissionMode` as optional. Services then infer whether missing means "use project default" or "use user's last choice." The contract does not say which.

**Changes:**
- Create `apps/server/src/services/lib/execution-defaults.ts` with a pure function:
  ```
  resolveThreadExecutionOptions(
    payload: CreateThreadRequest,
    projectDefaults: ProjectDefaults,
    lastChoice?: ThreadExecutionOptions,
  ): ResolvedThreadExecutionOptions
  ```
  No db calls inside. Takes inputs, returns a fully-resolved value.
- Update `CreateThreadRequest`, `CreateDraftRequest`, `SendMessageRequest` routes to call the resolver before entering service methods.
- Services stop accepting optional `model` / `serviceTier` / etc. — require the resolved shape.

**Exit criteria:**
- One resolver function, one call site per entry-point route.
- Services receive resolved options only; their types no longer mark these fields optional.
- `pnpm exec turbo run test --filter=@bb/server` passes.

## Phase 8: Remove daemon contract leakage from server routes

**Goal:** Routes do not parse daemon response schemas inline.

**Changes:**
- Audit `apps/server/src/routes/` for any `@bb/host-daemon-contract` imports.
- For each: move the daemon-contract interaction into a service method with a server-friendly return type.
- Routes call the service; service handles the daemon round-trip and schema parsing.

**Example:** `routes/environments.ts` currently uses `hostDaemonCommandResultSchemaByType["workspace.status"].parse(rawResult)` — move into a `getWorkspaceStatus` service method.

**Exit criteria:**
- `git grep "@bb/host-daemon-contract" apps/server/src/routes/` returns nothing.
- Services that talk to the daemon parse its responses at a single internal seam.
- `pnpm exec turbo run test --filter=@bb/server` passes.
