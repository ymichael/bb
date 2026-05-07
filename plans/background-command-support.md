# Background Command Support Plan

## Goal

Add first-class support for provider-native background commands so BB can:

- keep them inline in the normal thread timeline/grouping model,
- surface active background commands above the follow-up composer,
- lazily fetch output only when the user expands the timeline row or banner,
- let users stop them from the app and CLI.

## Scope

- v1 providers: Codex and Claude Code
- no background-command inference from shell `&`, `nohup`, long runtimes, or idle heuristics
- no separate output-inspection surface in v1
- Pi is out of scope

## Provider Facts

### Codex

- Native agent-started background commands arrive as long-lived, thread-owned `commandExecution` items with a non-null `processId`.
- Output continues after the starting turn via `item/commandExecution/outputDelta`.
- The only confirmed native stop surface is `thread/backgroundTerminals/clean`.
- That stop is thread-wide, not per-command.
- If the Codex provider connection dies, the background command dies with it.

### Claude Code

- Native background commands come from `Bash` with `run_in_background: true`.
- The SDK emits explicit task lifecycle signals including `task_started`, `TaskOutput(task_id)`, `TaskStop(task_id)`, and `task_notification`.
- `TaskOutput(task_id)` returns accumulated snapshots, so BB must diff snapshots into appended deltas.
- A Claude task may survive session loss, but BB product policy should still assume it is gone once the provider connection closes.

## Existing Patterns To Follow

### 1. Keep the semantic turn timeline

The current timeline on `main` is already the right shape:

- top-level rows are `turn` rows
- command executions render as nested `work` rows with `workKind: "command"`
- timeline responses are paginated

Relevant code:

- `packages/server-contract/src/api-types.ts`
- `packages/server-contract/src/thread-timeline.ts`
- `packages/thread-view/src/build-thread-timeline.ts`
- `packages/thread-view/src/timeline-row-title.ts`
- `packages/thread-view/src/timeline-view.ts`
- `apps/server/src/services/threads/timeline.ts`

Implication:

- background commands should stay on the existing nested command row
- do not add a new top-level background-command row kind

### 2. Reuse turn-summary lazy row loading

Nested rows already lazy-load through `/threads/:id/timeline/turn-summary-details`.

Relevant code:

- `packages/server-contract/src/api-types.ts`
- `packages/server-contract/src/public-api.ts`
- `apps/server/src/routes/threads/data.ts`
- `apps/server/src/services/threads/timeline.ts`
- `apps/app/src/hooks/queries/thread-queries.ts`
- `apps/app/src/views/useTurnSummaryRowLoader.ts`

Implication:

- expanding a turn should keep using the current turn-summary-details flow
- the background command still shows up as a normal nested command row inside that turn

### 3. Follow the existing React Query + realtime invalidation pattern

The app already has the right invalidation seam for live updates.

Relevant code:

- query keys: `apps/app/src/hooks/queries/query-keys.ts`
- timeline query hooks: `apps/app/src/hooks/queries/thread-queries.ts`
- realtime invalidation: `apps/app/src/hooks/realtime-cache-effects.ts`

Implication:

- any lazy background-command output query should be a normal cached query
- `events-appended` should invalidate that query from `realtime-cache-effects.ts`
- the main timeline query can keep using the existing thread/timeline invalidation behavior

### 4. Reuse the current timeline renderers

Expanded command output already has a canonical renderer path in the app.

Relevant code:

- `apps/app/src/components/thread-timeline/ThreadTimelineRows.tsx`
- `apps/app/src/components/thread-timeline/TimelineRowDetails.tsx`
- `apps/app/src/components/thread-timeline/TerminalOutputBlock.tsx`
- `apps/app/src/views/ThreadTimelinePane.tsx`

Implication:

- background command rows should reuse the current command row render path
- the main renderer change is to let background command bodies read from a lazy output query instead of assuming `row.output` is already populated

### 5. Reuse the existing banner/composer slot

The composer area already has the right insertion point.

Relevant code:

- `apps/app/src/views/ThreadDetailPromptArea.tsx`
- `apps/app/src/views/ThreadFollowUpComposer.tsx`

### 6. Reuse the thread event stream and `itemId` indexing

The `events` table already stores `itemId` and already has the right index for per-command event replay.

Relevant code:

- `packages/db/src/schema.ts`
- `packages/db/src/data/events.ts`

Implication:

- background command output can live in the normal thread event stream
- lazy output reads should key off `threadId + itemId`
- we do not need a second public identifier for v1

### 7. Reuse existing CLI timeline formatting

CLI timeline rendering already flows through `@bb/thread-view`.

Relevant code:

- `apps/cli/src/commands/thread/show.ts`
- `packages/thread-view/src/format-timeline-text.ts`

Implication:

- `bb thread show` should reuse the existing formatting path and add active background-command summaries there
- dedicated CLI actions should stay narrow: list, stop, stop-all

## Decisions

### 1. Use explicit background-command lifecycle state, but keep row identity on the existing command item

We should add a first-class provider-agnostic background-command lifecycle in the shared model and `@bb/agent-runtime`, but keep the visible timeline identity on the existing `commandExecution` item.

Concretely:

- lifecycle state is first-class
- the canonical public background-command id is the existing `itemId`
- the inline history row remains the normal nested command `work` row

This keeps the current semantic timeline model intact and avoids parallel row concepts.

### 2. Use explicit provider handle unions, not optional provider fields

Avoid optional provider-specific fields in shared contracts.

Use an explicit discriminated handle shape for active background commands, for example:

- Codex: `{ provider: "codex", processId: string }`
- Claude Code: `{ provider: "claude-code", taskId: string }`

This applies to:

- active background-command metadata on timeline responses
- stop command payloads/results
- daemon/server lifecycle state

### 3. Normalize all background output through `item/commandExecution/outputDelta`

Do not add a second output event type for v1.

Instead:

- Codex keeps its native `item/commandExecution/outputDelta`
- Claude polls `TaskOutput(task_id)`, diffs the latest snapshot, and emits only the appended suffix as `item/commandExecution/outputDelta`

That lets existing command output replay and projection code keep working.

### 4. Store full output in the event stream, but do not preload it into normal timeline reads

For v1:

- keep all normalized background-command output in the thread event stream
- do not cap stored output
- do not eagerly load full background output in the default timeline response
- do not eagerly load full background output in `turn-summary-details`

This matches the product requirement that output only gets fetched when the user expands:

- the nested background command row, or
- the active-command banner entry

### 5. Add thread-scoped active background commands to `ThreadTimelineResponse`

The current thread detail flow already fetches the timeline, so that response is the right place to surface the active background-command list.

Add an `activeBackgroundCommands` collection to `ThreadTimelineResponse`.

Recommended fields:

- `itemId`
- `threadId`
- `turnId`
- `callId`
- `command`
- `status`
- `sourceSeqStart`
- `sourceSeqEnd`
- `handle` as a discriminated provider union

Important:

- this list should be thread-scoped metadata
- it should not depend on which timeline page is currently loaded

### 6. Add a dedicated lazy output route keyed by `threadId + itemId`

Do not overload `turn-summary-details` for live background output bodies.

Instead, add a dedicated output read that follows the existing server/query pattern:

- schema in `packages/server-contract`
- route in `apps/server/src/routes/threads/data.ts`
- service in `apps/server/src/services/threads/timeline.ts`
- query key + hook in `apps/app/src/hooks/queries`

Recommended request identity:

- `threadId`
- `itemId`

Recommended response shape:

- `itemId`
- `command`
- `source`
- `output`
- `status`
- `exitCode`
- `completedAt`

This route should rebuild the current background-command body by replaying thread events for that `itemId` using the existing `(thread_id, item_id, sequence)` index.

### 7. The timeline row and the banner should share the same lazy output query

There should be one output-fetch path for both app surfaces:

- expanding the nested background command row in the timeline
- expanding the active background-command banner entry

The app should invalidate that cached query when realtime thread changes report `events-appended`.

The normal timeline query should keep using the existing invalidation behavior it already has.

### 8. Keep collapsed-turn hints inside `@bb/thread-view`

If collapsed turns need to hint that a background command is still active, extend the existing summary/title builders in `@bb/thread-view`.

Do not add a separate summary row.

Relevant code:

- `packages/thread-view/src/timeline-row-title.ts`
- `packages/thread-view/src/timeline-view.ts`

### 9. Stop API is per-command logically, provider-specific physically

The product surface should still be “stop this background command,” but the provider implementations differ:

- Claude Code: true per-command stop via `TaskStop(task_id)`
- Codex:
  - if exactly one active Codex background command exists in the thread, allow a normal stop action and implement it with `thread/backgroundTerminals/clean`
  - if multiple active Codex background commands exist in the thread, do not show per-command stop buttons; show a Codex-specific `Stop all background commands` action instead

This means the server/daemon API needs both:

- stop one background command
- stop all background commands in a thread

The CLI should mirror that shape.

### 10. Reconnect policy stays simple

User-visible policy:

- if the provider connection closes, assume the background commands are gone

Implementation nuance:

- Codex commands really are gone
- Claude tasks may survive, but BB should still transition the lifecycle as gone and only do best-effort cleanup later if a handle remains usable after resume

## Implementation Plan

### Phase 1: Contracts and shared model

1. Add explicit background-command lifecycle events/state to the shared event model and `@bb/agent-runtime`.
2. Use `itemId` as the public background-command id for v1.
3. Add a discriminated provider-handle union type for active background commands.
4. Add `activeBackgroundCommands` to `ThreadTimelineResponse`.
5. Add request/response schemas for lazy background-command output reads.
6. Add request/response schemas for background-command stop and stop-all actions.

Relevant code:

- `packages/domain/src/provider-event.ts`
- `packages/server-contract/src/thread-timeline.ts`
- `packages/server-contract/src/api-types.ts`
- `packages/server-contract/src/public-api.ts`
- `packages/host-daemon-contract/src/*`

### Phase 2: Provider translation in `@bb/agent-runtime`

1. Codex:
   - detect native background `commandExecution` items
   - preserve `processId`
   - keep output flowing through `item/commandExecution/outputDelta`
   - translate stop-all to `thread/backgroundTerminals/clean`
2. Claude Code:
   - translate `run_in_background` plus `task_started` into background lifecycle start
   - map `task_id` back to the originating `itemId`
   - poll `TaskOutput(task_id)` on a bounded cadence while active
   - diff snapshots into appended `item/commandExecution/outputDelta`
   - translate `TaskStop(task_id)` and terminal notifications into terminal lifecycle state
3. Keep `task_updated` adapter-internal unless implementation proves it is necessary for correctness.
4. Prevent active background commands from being auto-finalized as interrupted when the thread itself goes idle.

Relevant code:

- `packages/agent-runtime/src/codex/*`
- `packages/agent-runtime/src/claude-code/*`
- `packages/thread-view/src/exec-lifecycle.ts`

### Phase 3: Server lifecycle and read model

1. Add a dedicated server-owned background-command lifecycle module.
2. Do not use `thread_operations` for this lifecycle.
3. Derive active background commands alongside the normal timeline projection.
4. Keep top-level rows as `turn` rows and nested command rows as normal `workKind: "command"` rows.
5. Add the lazy background-command output read by replaying events for `threadId + itemId`.
6. Keep timeline and turn-summary reads lightweight by omitting full background output bodies there.
7. Add stop-one and stop-all server actions, with provider-specific validation.
8. Persist lifecycle and output through the normal thread event ingestion path.
9. Reconcile disconnect cleanup according to the agreed product policy.

Relevant code:

- `apps/server/src/routes/threads/data.ts`
- `apps/server/src/services/threads/timeline.ts`
- `packages/db/src/data/events.ts`
- `packages/db/src/schema.ts`

### Phase 4: App queries and realtime

1. Add query keys and hooks for lazy background-command output reads.
2. Reuse the current timeline query for `activeBackgroundCommands`.
3. Invalidate the lazy output query from `realtime-cache-effects.ts` on `events-appended`.
4. Keep using `turn-summary-details` and `useTurnSummaryRowLoader()` for nested-row structure only.

Relevant code:

- `apps/app/src/hooks/queries/query-keys.ts`
- `apps/app/src/hooks/queries/thread-queries.ts`
- `apps/app/src/hooks/realtime-cache-effects.ts`
- `apps/app/src/views/useTurnSummaryRowLoader.ts`

### Phase 5: App UI

1. Timeline:
   - keep the existing top-level `turn` rows
   - keep background commands on the normal nested command row
   - when an expanded background command row body is opened, fetch its output lazily through the dedicated output query
   - reuse `WorkRowBody` and `TerminalOutputBlock`
2. Banner:
   - render active background commands above the composer through the existing banner slot
   - expand lazily using the same output query
   - expose stop or stop-all actions according to provider rules
3. Collapsed turns:
   - if necessary, add active-background hints through existing thread-view summary/title builders rather than a new row kind

Relevant code:

- `apps/app/src/views/ThreadDetailPromptArea.tsx`
- `apps/app/src/views/ThreadFollowUpComposer.tsx`
- `apps/app/src/views/ThreadDetailView.tsx`
- `apps/app/src/views/ThreadTimelinePane.tsx`
- `apps/app/src/components/thread-timeline/ThreadTimelineRows.tsx`
- `apps/app/src/components/thread-timeline/TimelineRowDetails.tsx`
- `apps/app/src/components/thread-timeline/TerminalOutputBlock.tsx`

### Phase 6: CLI

1. Add `bb thread background list <thread-id>`.
2. Add `bb thread background stop <thread-id> <item-id>`.
3. Add `bb thread background stop-all <thread-id>`.
4. Update `bb thread show` to surface active background commands clearly through the existing timeline/status formatting path.

Relevant code:

- `apps/cli/src/commands/thread/index.ts`
- `apps/cli/src/commands/thread/show.ts`
- `packages/thread-view/src/format-timeline-text.ts`

## Exit Criteria

- provider-native background commands normalize into an explicit BB background-command lifecycle
- the public background-command identity is the existing `itemId`
- inline timeline history remains the existing nested command row inside the current `turn` grouping model
- `ThreadTimelineResponse` exposes thread-scoped `activeBackgroundCommands`
- background-command output is stored via normalized `item/commandExecution/outputDelta`
- Claude snapshots are diffed into appended command deltas before persistence
- default timeline reads do not eagerly fetch full background output
- expanding a background-command timeline row fetches output lazily
- expanding a background-command banner entry fetches the same output lazily
- lazy output queries live-refresh through realtime invalidation on `events-appended`
- the composer shows active background commands above the follow-up area
- Codex supports stop when exactly one active background command exists
- Codex supports stop-all when multiple active background commands exist
- Claude supports per-command stop
- CLI supports list, stop, and stop-all
- v1 scope is Codex + Claude only
- disconnect behavior follows the agreed product policy

## Validation

### Typecheck

`pnpm exec turbo run typecheck --filter=@bb/domain --filter=@bb/db --filter=@bb/agent-runtime --filter=@bb/thread-view --filter=@bb/server-contract --filter=@bb/host-daemon-contract --filter=@bb/server --filter=@bb/host-daemon --filter=@bb/app --filter=@bb/cli`

### Unit Tests

- runtime tests for:
  - Codex background `commandExecution` normalization
  - Claude `task_started` / `TaskOutput` / `TaskStop` normalization
  - Claude snapshot-to-delta diffing
  - no false interrupt when the thread goes idle
- thread-view tests for:
  - background commands remaining inline in the current `turn` grouping
  - collapsed turn hints if new active-background summaries are added
- server tests for:
  - `ThreadTimelineResponse.activeBackgroundCommands`
  - lazy background output reconstruction by `threadId + itemId`
  - repeated stop requests
  - Codex stop-one validation vs stop-all availability
  - disconnect reconciliation
- app tests for:
  - background output query invalidation from `realtime-cache-effects`
  - lazy row expansion fetching the dedicated output query
  - composer banner rendering and stop states
- CLI tests for:
  - list / stop / stop-all command behavior

### Integration Tests

Extend `packages/agent-runtime/src/test/runtime-integration-harness.ts` coverage:

- Codex:
  - start a native background command
  - observe long-lived `commandExecution` with `processId`
  - observe `item/commandExecution/outputDelta` after turn completion
  - stop via `thread/backgroundTerminals/clean`
  - assert the original item completes terminally
- Claude:
  - start a native background Bash task
  - observe `task_started`
  - poll output via `TaskOutput`
  - verify normalization into appended command deltas
  - stop via `TaskStop`
  - assert terminal notification/state

### Public Route / Timeline Tests

Add or extend coverage in:

- `apps/server/test/public/public-thread-data.test.ts`
- `apps/server/test/threads/timeline-service.test.ts`
- `packages/thread-view/test/*`

Focus on:

- paginated timeline responses still returning normal turn rows
- active background commands appearing as thread-scoped response metadata
- turn-summary detail loading still returning nested command rows correctly
- lazy output reads reconstructing the expected command body for `itemId`

### Manual QA

- start a dev server in Codex
- verify:
  - the thread timeline still uses normal top-level `turn` rows
  - expanding the relevant turn reveals the background command as a normal nested command row
  - expanding the background command row fetches output lazily
  - the active background-command banner appears above the composer
  - expanding the banner fetches the same output lazily
  - expanded output updates as new thread events append
  - stop button works when there is exactly one active Codex background command
  - multi-command Codex thread shows `Stop all background commands`
- repeat in Claude Code
- verify disconnect behavior matches the agreed policy
