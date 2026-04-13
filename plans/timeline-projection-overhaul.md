# Timeline Projection Overhaul

Status: Deferred design plan. This branch only fixes the stale web-search projection bug that exposed the active-turn inference problem; it does not implement the projection overhaul below.

## Goal

Make timeline rendering use explicit turn lifecycle state instead of inferring whether a turn is active from child message statuses. A provider turn should be active because its `turn/started` event has not been matched by a terminal `turn/completed` event, not because one projected child row happens to be `pending`.

This plan intentionally does not preserve the current message-only projection API for production timeline paths. Compatibility wrappers may exist temporarily during the refactor, but the merge-ready end state should make the projection-aware path the only production path.

## Current Problem

- `toViewMessages` projects raw thread events into a flat `ViewMessage[]`.
- `buildTimelineRows` receives only `ViewMessage[]`, so it cannot directly know the lifecycle state of a turn.
- `isActiveTurn` currently infers active state by scanning child message statuses for `pending`.
- That inference is brittle: stale or malformed child lifecycle projection can make a completed turn look active.
- The timeline route is split for performance: collapsed rows avoid sending detailed child messages, while detail routes hydrate them later. Any replacement model must preserve that summary/detail split.

## Target Model

Introduce an explicit projection model with ordered entries:

```ts
export type ViewTimelineEntry =
  | ViewStandaloneTimelineEntry
  | ViewTurnTimelineEntry;

export interface ViewStandaloneTimelineEntry {
  kind: "message";
  message: ViewMessage;
}

export interface ViewTurnTimelineEntry {
  kind: "turn";
  turn: ViewTurn;
}

export interface ViewTurn {
  turnId: string;
  threadId: string;
  sourceSeqStart: number;
  sourceSeqEnd: number;
  startedAt: number;
  createdAt: number;
  completedAt: number | null;
  status: "pending" | "completed" | "error" | "interrupted";
  summaryCount: number;
  durationMs?: number;
  terminalMessage?: ViewMessage;
  messages?: ViewMessage[];
}

export interface ViewProjection {
  entries: ViewTimelineEntry[];
}
```

The important boundary is that `ViewTurn.status` is the authoritative turn lifecycle state. `ViewMessage.status` remains scoped to the individual projected message.

## Projection Rules

- `turn/started` creates or updates a `ViewTurn` with `status: "pending"`.
- `turn/completed` updates the matching `ViewTurn` to the provider terminal status.
- Messages with a `turnId` are attached to the matching `ViewTurn`.
- Messages without a `turnId` remain standalone ordered entries.
- If a message references a `turnId` that has no lifecycle event, projection should treat that as a contract violation in production paths rather than silently guessing active state.
- Active turns keep their messages present because active work is rendered expanded.
- Terminal turns may omit `messages` in summary mode, but must keep summary metadata and a terminal display message when available.

## API Changes

- Replace production `toViewMessages(...)` timeline usage with `toViewProjection(...)`.
- Replace production `buildTimelineRows(messages, ...)` usage with `buildTimelineRows(projection, ...)`.
- Keep any message-only builder under an explicit lossy name, such as `buildTimelineRowsFromMessagesForNestedDisplay`, only for synthetic or nested message arrays that cannot have turn lifecycle metadata.
- Keep route response contracts focused on `TimelineRow[]`; the projection model can remain an internal core-ui/server construction detail unless app hydration requires exposing turn detail metadata directly.

## Summary And Detail Routes

The existing performance split should remain:

- Summary timeline route builds a projection with terminal turn `messages` omitted.
- Summary rows include turn identity, source sequence range, status, duration, summary count, and terminal message.
- Detail route fetches the event range for a row and builds the same turn with `messages` included.
- Active pending turns always include messages in the summary response because they are not collapsed.

## Implementation Phases

1. Add `ViewProjection`, `ViewTimelineEntry`, and `ViewTurn` domain types.
2. Add `toViewProjection` alongside the existing projector, reusing the current message projection internals where possible.
3. Update `buildTimelineRows` to consume `ViewProjection` and use `ViewTurn.status` for active-turn decisions.
4. Update server timeline summary and detail routes to build rows from projections.
5. Update provider-audit capture/replay to use projection-aware row building.
6. Rename or remove message-only production helpers so lossy rendering paths are explicit.
7. Remove obsolete active-turn inference from production code.

## Exit Criteria

- Completed turns collapse even when a child message remains `pending`.
- Pending turns stay expanded even when all current child messages are individually terminal.
- Timeline summary route does not send full child messages for collapsed terminal turns.
- Timeline detail route hydrates the same turn row with full child messages.
- Production timeline code does not call a message-only `buildTimelineRows` helper.
- Message-only timeline building is limited to explicitly named nested/synthetic display paths.
- Provider-audit snapshots reflect lifecycle-driven turn grouping.

## Validation

- `pnpm exec turbo run typecheck --filter=@bb/core-ui --filter=@bb/server --filter=@bb/agent-provider-audit`
- `pnpm exec turbo run test --filter=@bb/core-ui`
- `pnpm exec turbo run test --filter=@bb/server`
- `pnpm exec turbo run test --filter=@bb/agent-provider-audit`
- Manual smoke: run a thread with a long-running tool and verify the active turn remains expanded until `turn/completed`.
- Manual smoke: replay a fixture with stale child pending status and verify the completed turn is still collapsed.
