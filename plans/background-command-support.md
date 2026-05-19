# Background Command Support Plan

Last refreshed: 2026-05-19

## Goal

Add first-class support for provider-native background commands so BB can:

- keep background commands inline in the normal thread timeline and turn grouping model
- surface currently active background commands above the follow-up composer
- fetch command output lazily only when the user expands the timeline row or composer banner entry
- let users stop background commands from the app and CLI

## Scope

- v1 providers: Codex and Claude Code
- Pi remains out of scope
- no inference from shell syntax such as `&`, `nohup`, long runtimes, idle time, or missing exit codes
- no separate output-inspection product surface in v1
- background output persists through the normal thread event stream

## Current State

This feature is still not implemented end to end.

- `ThreadTimelineResponse` currently contains `rows`, `activeThinking`, `pendingTodos`, optional `contextWindowUsage`, and `timelinePage`. It does not expose active background commands.
- Timeline pagination is segment-based through `segmentLimit`, `beforeAnchorSeq`, and `beforeAnchorId`. The old plan's top-level limit terminology is stale.
- `summaryOnly=true` now exists for tail-only CLI/status consumers. Any active background-command metadata added to the timeline response needs an explicit decision about whether it is populated in summary-only responses.
- Nested turn rows lazy-load through `/threads/:id/timeline/turn-summary-details`, but there is no lazy output route.
- Command rows render through the current canonical path: `apps/app/src/components/thread/timeline/ThreadTimelineRows.tsx`, `TimelineRowDetails.tsx`, and `TerminalOutputBlock.tsx`.
- The prompt-area extension point is now `ThreadPromptContextBanner` inside `apps/app/src/views/thread-detail/ThreadDetailPromptArea.tsx`.
- Realtime invalidation is registry-driven in `apps/app/src/hooks/realtime-cache-registry.ts`, not handwritten directly in `realtime-cache-effects.ts`.
- The normalized domain `commandExecution` item does not retain Codex `processId` and has no background marker or provider handle.
- The Codex generated app-server schema includes `ThreadItem.processId` and `thread/backgroundTerminals/clean`, but the adapter currently drops `processId` and maps `thread/stop` only to active-turn interruption.
- Claude Code `task_started`, `task_progress`, `task_updated`, and `task_notification` are currently classified as visibility noise. The adapter does not parse `run_in_background`, does not associate `task_id` with a Bash item, and the bridge has no `TaskOutput` or `TaskStop` request path.
- The `events` table has `item_id` and an index on `(thread_id, turn_id, type, item_id, sequence)`. It does not have a direct `(thread_id, item_id, sequence)` index, so the old plan's `threadId + itemId` replay assumption is incomplete.
- Event pruning can remove redundant `item/commandExecution/outputDelta` rows after an `item/completed` command with `aggregatedOutput`. Lazy reconstruction must account for both remaining deltas and completed aggregate output.

## Decisions

### Keep Timeline Identity On The Command Row

Background commands remain normal nested command work rows inside their original turn. Do not add a new top-level row kind.

The background lifecycle is separate metadata keyed by the existing command `itemId`.

### Add An Explicit Background Lifecycle

Add a provider-agnostic background-command lifecycle to `@bb/domain`, `@bb/agent-runtime`, server contracts, and the daemon contract.

The lifecycle must model intent and progress explicitly. Do not overload thread `status` or command row `status` into a queue-state ladder.

Required lifecycle states for v1:

- `running`
- `stop_requested`
- `stopped`
- `completed`
- `lost`

Only `running` and `stop_requested` should appear in `activeBackgroundCommands`.

`stop_requested` means BB accepted a user stop request but has not observed provider termination. `stopped` means provider stop completed or a terminal stopped lifecycle event was observed. `lost` means BB no longer has a live provider connection/handle and cannot prove the command stopped cleanly.

### Use These Event Shapes As The Starting Point

Phase 1 should land the event shape instead of deferring it to runtime/server work:

- Provider-originated turn-scoped lifecycle event: `item/commandExecution/backgroundLifecycle`
- Server-originated lifecycle intent/reconciliation event: `system/backgroundCommand/lifecycle`

Both events should carry `threadId`, `itemId`, lifecycle `status`, and a provider handle when one is known. Provider events also carry `providerThreadId`; server events do not. Server stop actions should first append `stop_requested`, then append `stopped` or `lost` only after command result/reconciliation evidence.

### Use Explicit Provider Handles

Use a discriminated handle union, not optional provider fields:

- Codex: `{ provider: "codex"; processId: string }`
- Claude Code: `{ provider: "claude-code"; taskId: string }`

Provider-thread identity stays in runtime/server internals. The public background-command identity is the existing command `itemId`.

### Normalize Output Through Existing Command Output Events

Keep output bytes on `item/commandExecution/outputDelta`.

- Codex output deltas stay as normalized command output deltas.
- Claude `TaskOutput(task_id)` snapshots must be diffed into appended command output deltas before persistence.
- If a completed command event has `aggregatedOutput`, lazy output reconstruction may use it as the authoritative final body.

### Add Thread-Scoped Active Metadata To Timeline Responses

Add `activeBackgroundCommands` to `ThreadTimelineResponse`.

Recommended public fields:

- `itemId`
- `threadId`
- `turnId`
- `command`
- `cwd`
- `source`
- `status`
- `startedAt`
- `lastUpdatedAt`
- `handle`
- `availableActions`

Do not include `sourceSeqStart` or `sourceSeqEnd` on `ActiveBackgroundCommand` in v1. Timeline rows already carry source sequence bounds, and the lazy output route can return `lastSequence` for streaming/invalidation checks.

Recommended `availableActions` values:

- `stop`
- `stop_all`

The server is authoritative for this field. The app and CLI should render only the actions returned by the server and should not reimplement provider-specific safety checks.

This list is thread-scoped metadata. It must not depend on which timeline page is loaded. Populate it on latest-page and summary-only timeline reads unless profiling shows a real cost.

Timeline command rows should not gain a background-only row field in v1. The app can cross-reference `activeBackgroundCommands` by `TimelineCommandWorkRow.callId`, which is the command item id. This keeps historical command rows compatible and limits timeline contract churn.

### Add A Dedicated Lazy Output Route

Do not overload `turn-summary-details` for live background output bodies.

Add a dedicated public read route, for example:

- `GET /api/v1/threads/:id/background-commands/:itemId/output`

Recommended response fields:

- `itemId`
- `threadId`
- `turnId`
- `command`
- `cwd`
- `source`
- `output`
- `status`
- `exitCode`
- `completedAt`
- `lastSequence`

Use the public identity directly: add a DB helper and migration for an explicit `(thread_id, item_id, sequence)` index. Do not require `turnId` in the public route.

Historical non-background `commandExecution` items should continue to work with this route if the UI later chooses to lazy-load all command output. They are never active, so they have no handle and no stop actions, but output reconstruction follows the same event replay path.

### Stop API Is Logical Per-Command, Physical Provider-Specific

Expose both:

- stop one background command
- stop all background commands in a thread

Recommended public actions:

- `POST /api/v1/threads/:id/background-commands/:itemId/stop`
- `POST /api/v1/threads/:id/background-commands/stop-all`

Stop-one is valid only when that active command's `availableActions` includes `stop`. Stop-all is valid when at least one active command exposes `stop_all`.

Provider behavior:

- Claude Code supports true per-command stop through `TaskStop(task_id)`.
- Codex v1 should use `thread/backgroundTerminals/clean` for stop-all.
- Codex per-command stop is available only when exactly one active Codex background command exists in the thread. In that case the server may map "stop this command" to Codex stop-all.
- If multiple active Codex background commands exist, hide per-command stop and expose only `Stop all background commands`.
- Revalidate the active set immediately before queueing a Codex stop command. If a single-command stop request races with another active Codex command, return a conflict instead of invoking thread-wide cleanup.
- Treat `thread/backgroundTerminals/clean` as a confirmed-but-still-suspicious API until integration tests prove it terminates native agent-started background commands and produces expected terminal lifecycle/output behavior.

### Disconnect Policy Stays Simple

User-visible policy:

- if the provider connection closes, active background commands are treated as lost

Implementation detail:

- Codex commands are expected to die with the provider connection.
- Claude tasks may survive outside BB, but BB should mark them `lost` and only attempt best-effort cleanup if the provider handle is still usable.

## Implementation Plan

### Phase 1: Shared Contracts And Event Model

1. Add background-command lifecycle types and schemas in `packages/domain/src/provider-event.ts`.
2. Add scope policy entries in `packages/domain/src/thread-event-scope.ts`.
3. Land the provider-originated and server-originated lifecycle event shapes sketched above.
4. Add `BackgroundCommandHandle`, `ActiveBackgroundCommand`, lazy output response, stop request, and stop response schemas in `packages/server-contract`.
5. Add `activeBackgroundCommands` to `threadTimelineResponseSchema`.
6. Add public API entries for lazy output, stop one, and stop all.
7. Add daemon command contract entries for background stop and stop-all, then bump `HOST_DAEMON_PROTOCOL_VERSION`.

Relevant code:

- `packages/domain/src/provider-event.ts`
- `packages/domain/src/thread-event-scope.ts`
- `packages/server-contract/src/api-types.ts`
- `packages/server-contract/src/public-api.ts`
- `packages/server-contract/src/thread-timeline.ts`
- `packages/host-daemon-contract/src/commands.ts`

### Phase 2: Runtime And Provider Translation

1. Extend `AgentRuntime` with explicit background-command stop methods.
2. Extend `AdapterCommand` with background stop and stop-all commands.
3. Codex:
   - parse and retain `processId` from command execution items when present
   - detect provider-native background command start
   - emit background lifecycle start with `{ provider: "codex"; processId }`
   - preserve output as `item/commandExecution/outputDelta`
   - implement stop-all through `thread/backgroundTerminals/clean`
   - verify `thread/backgroundTerminals/clean` against real native background commands before exposing Codex stop actions
   - do not assume `command/exec/terminate` applies to native agent-started background terminals until an integration test proves it
4. Claude Code:
   - parse `Bash` input with `run_in_background: true`
   - associate `task_started.task_id` with the originating Bash `itemId`
   - add bridge request support for task output snapshots and task stop
   - poll `TaskOutput(task_id)` every 1s while active as the v1 placeholder cadence, with room to back off later if provider/API cost requires it
   - diff snapshots into appended `item/commandExecution/outputDelta`
   - map task stop/completion/loss into lifecycle events
5. Prevent background commands from being finalized as interrupted just because the foreground turn goes idle or completes.

Relevant code:

- `packages/agent-runtime/src/types.ts`
- `packages/agent-runtime/src/provider-adapter.ts`
- `packages/agent-runtime/src/runtime.ts`
- `packages/agent-runtime/src/codex/schemas.ts`
- `packages/agent-runtime/src/codex/event-translation.ts`
- `packages/agent-runtime/src/codex/adapter.ts`
- `packages/agent-runtime/src/claude-code/schemas.ts`
- `packages/agent-runtime/src/claude-code/adapter.ts`
- `packages/agent-runtime/src/claude-code/bridge/commands.ts`
- `packages/agent-runtime/src/claude-code/bridge/bridge.ts`
- `packages/thread-view/src/exec-lifecycle.ts`

### Phase 3: Daemon Dispatch

1. Add daemon handlers for the new background stop commands.
2. Route stop-one and stop-all to the runtime entry for the thread's environment.
3. Flush buffered provider events before reporting stop success, like `thread.stop`.
4. Preserve existing thread runtime state after background stop unless the provider requires restart.
5. On provider process exit, emit or allow server reconciliation to mark active background commands as lost.

Relevant code:

- `apps/host-daemon/src/command-dispatch.ts`
- `apps/host-daemon/src/command-handlers/thread.ts`
- `apps/host-daemon/src/runtime-manager.ts`
- `apps/host-daemon/src/event-buffer.ts`

### Phase 4: Server Lifecycle And Read Model

1. Add a server-owned background-command lifecycle module. Do not use `thread_operations`.
2. Build active background command state by replaying thread events and server lifecycle intent events.
3. Add DB helpers for:
   - active background command event/state replay
   - per-item command output reconstruction
4. Add the chosen `(thread_id, item_id, sequence)` index for efficient public `threadId + itemId` replay.
5. Keep normal timeline and turn-summary reads lightweight. Do not eagerly return full background output bodies there.
6. Ensure timeline window selection still includes enough events to render the command row shell even when output is omitted from default responses.
7. Implement stop-one and stop-all public actions with provider-specific validation.
8. Reconcile active background commands as `lost` on daemon/provider disconnect according to policy.
9. Ensure event pruning does not break lazy output reconstruction. Reconstruction must consider `item/started`, remaining output deltas, and `item/completed.aggregatedOutput`.

Relevant code:

- `apps/server/src/services/threads/timeline.ts`
- `apps/server/src/routes/threads/data.ts`
- `apps/server/src/routes/threads/actions.ts`
- `apps/server/src/services/threads/thread-events.ts`
- `apps/server/src/internal/events.ts`
- `apps/server/src/internal/reconciliation.ts`
- `packages/db/src/data/events.ts`
- `packages/db/src/schema.ts`
- `packages/db/drizzle/*`

### Phase 5: App Queries And Realtime

1. Add query keys for background command output.
2. Add a query hook for lazy output reads.
3. Add mutations for stop-one and stop-all.
4. Invalidate background output queries on `events-appended` in `REALTIME_THREAD_CHANGE_REGISTRY`.
5. Keep existing timeline invalidation for `activeBackgroundCommands`.
6. Share one output query path between timeline-row expansion and composer-banner expansion.

Relevant code:

- `apps/app/src/lib/api.ts`
- `apps/app/src/hooks/queries/query-keys.ts`
- `apps/app/src/hooks/queries/thread-queries.ts`
- `apps/app/src/hooks/mutations/thread-runtime-mutations.ts`
- `apps/app/src/hooks/realtime-cache-registry.ts`
- `apps/app/src/hooks/realtime-cache-effects.ts`

### Phase 6: App UI

1. Timeline:
   - keep top-level `turn` rows
   - keep background commands as normal nested `workKind: "command"` rows
   - mark active background command rows by cross-referencing `activeBackgroundCommands` against `TimelineCommandWorkRow.callId`
   - fetch output lazily when the row expands
   - reuse `TerminalOutputBlock`
2. Composer banner:
   - extend `ThreadPromptContextBanner` with a background-command section
   - render active background commands above the composer
   - expand each entry lazily through the shared output query
   - expose stop or stop-all actions according to provider rules
3. Collapsed turns:
   - if active-background hints are needed, add them through `@bb/thread-view` title/summary helpers
   - do not add a separate summary row kind

Relevant code:

- `apps/app/src/views/thread-detail/ThreadDetailView.tsx`
- `apps/app/src/views/thread-detail/ThreadDetailPromptArea.tsx`
- `apps/app/src/views/thread-detail/ThreadTimelinePane.tsx`
- `apps/app/src/views/thread-detail/turn-summary/useThreadDetailTurnSummaryRows.ts`
- `apps/app/src/views/thread-detail/turn-summary/useTurnSummaryRowLoader.ts`
- `apps/app/src/components/promptbox/banner/ThreadPromptContextBanner.tsx`
- `apps/app/src/components/thread/timeline/ThreadTimelineRows.tsx`
- `apps/app/src/components/thread/timeline/TimelineRowDetails.tsx`
- `apps/app/src/components/thread/timeline/TerminalOutputBlock.tsx`
- `packages/thread-view/src/timeline-row-title.ts`
- `packages/thread-view/src/timeline-view.ts`

### Phase 7: CLI

1. Add `bb thread background list <thread-id>`.
2. Add `bb thread background stop <thread-id> <item-id>`.
3. Add `bb thread background stop-all <thread-id>`.
4. Update `bb thread show` to surface active background commands through the existing timeline/status formatting path.
5. Ensure `bb status` can read active background metadata cheaply if product wants it there; use `summaryOnly=true` if available.

Relevant code:

- `apps/cli/src/commands/thread/index.ts`
- `apps/cli/src/commands/thread/show.ts`
- `apps/cli/src/commands/status.ts`
- `packages/thread-view/src/format-timeline-text.ts`

## Exit Criteria

- provider-native background commands normalize into an explicit BB background-command lifecycle
- public background-command identity is the existing command `itemId`
- inline history remains the existing nested command row inside the current turn grouping model
- `ThreadTimelineResponse.activeBackgroundCommands` is thread-scoped and independent of the loaded timeline page
- default timeline and turn-summary reads do not eagerly return full active background output
- lazy output reads reconstruct the correct command body for `threadId + itemId`
- lazy output queries live-refresh on `events-appended`
- composer banner shows active background commands above the prompt
- timeline row and banner expansion share the same output query
- Codex stop-one is available only when it safely maps to stop-all for a single active Codex command
- Codex stop-all works through `thread/backgroundTerminals/clean`
- Claude Code supports true per-command stop
- disconnect behavior marks active background commands as lost
- CLI supports list, stop, and stop-all
- v1 remains limited to Codex and Claude Code

## Validation

### Typecheck

Run through Turbo:

```sh
pnpm exec turbo run typecheck --filter=@bb/domain --filter=@bb/db --filter=@bb/agent-runtime --filter=@bb/thread-view --filter=@bb/server-contract --filter=@bb/host-daemon-contract --filter=@bb/server --filter=@bb/host-daemon --filter=@bb/app --filter=@bb/cli
```

### Unit Tests

Add focused tests for:

- domain schema validation for lifecycle events and provider handles
- Codex background command start normalization with `processId`
- Codex stop-all command planning
- Claude `run_in_background`, `task_started`, `TaskOutput`, and `TaskStop` normalization
- Claude snapshot-to-delta diffing
- foreground turn completion not interrupting active background command lifecycle
- server active-background projection
- lazy output reconstruction from started/delta/completed events
- Codex stop-one validation vs stop-all availability
- disconnect reconciliation to `lost`
- app query invalidation for background output on `events-appended`
- timeline row lazy output expansion
- composer banner rendering, expansion, and stop states
- CLI list, stop, and stop-all behavior

### Integration Tests

Extend runtime integration coverage in `packages/agent-runtime/src/test/runtime-integration-harness.ts`.

Use real provider runtimes where available. Keep fake/unit harnesses for edge cases, races, and failure injection that are impractical to force through the provider.

Codex:

- start a provider-native background command
- observe a command item with a retained `processId`
- observe command output after the starting turn completes
- stop via `thread/backgroundTerminals/clean`
- assert lifecycle reaches a terminal state

Claude Code:

- start a background Bash task
- observe `task_started`
- poll output via `TaskOutput`
- verify snapshots normalize into appended command deltas
- stop via `TaskStop`
- assert lifecycle reaches a terminal state

### Server / Public Route Tests

Add or extend:

- `apps/server/test/public/public-thread-data.test.ts`
- `apps/server/test/threads/timeline-service.test.ts`
- `packages/thread-view/test/*`

Focus on:

- paginated timeline responses still returning normal turn rows
- `activeBackgroundCommands` appearing as thread-scoped response metadata
- summary-only timeline responses returning the chosen active-background metadata
- turn-summary detail loading still returning nested command rows correctly
- lazy output reads reconstructing expected output for `itemId`
- output reconstruction still working after event pruning

### Manual QA

Run the dev app and test both providers:

- start a dev server or long-running watcher from the agent
- verify the timeline still uses normal top-level turn rows
- expand the original turn and confirm the background command appears as a normal nested command row
- expand the command row and confirm output is fetched lazily
- confirm the active background-command banner appears above the composer
- expand the banner entry and confirm it uses the same output
- verify output updates as new events append
- verify Codex single-command stop and multi-command stop-all behavior
- verify Claude per-command stop behavior
- kill/restart the provider connection and confirm active commands become lost
- navigate away and back after disconnect/lost reconciliation and confirm the banner/timeline do not resurrect stale active commands
