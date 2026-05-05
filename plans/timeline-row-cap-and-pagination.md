# Timeline Row Cap And Backwards Pagination Plan

## Goal

Ship timeline pagination in the order that reduces user-visible pain first and avoids baking in an unsafe patch transport. Every latest timeline surface should return the active tail plus at most 100 older top-level rows, and older pages should eventually load backwards without reading every historical event or building the full historical row model.

The patch-route prototype from `bb/prototype-timeline-delta-patches-and-pagination-thr_2p348huhey` should not become the default transport. Park or delete it unless it is retained explicitly as an experiment, because the latest assessment concluded pagination and top-level caps are sound but patch-first sequencing is not.

## Current Source Facts

- `GET /api/v1/threads/:id/timeline` routes through `buildThreadTimeline` in `apps/server/src/services/threads/timeline.ts`.
- `buildThreadTimeline` calls `listRecentStoredEventRows`, decodes all non-excluded event rows for the thread, compacts summary events, then builds all top-level rows through `@bb/thread-view`.
- The public timeline query currently exposes `managerTimelineView` and `includeNestedRows`. The response currently returns `rows`, `activeThinking`, and optional `contextWindowUsage`; it has no page metadata.
- Top-level row identity is projection-derived. Source-backed rows use event/message identity, completed-turn summary rows use `threadId:turnId:turn[:segmentIndex]`, and activity summary rows are derived from stable child row ids.
- Lazy turn-summary details already use the correct request boundary: `turnId + sourceSeqStart + sourceSeqEnd`. The client cache is still keyed by the parent row id, so pagination must either include the range in that cache key or clear details when a row range changes.
- `events_thread_sequence_idx(thread_id, sequence)` can support targeted sequence-range reads once row anchors exist.

## Prototype Findings To Carry Forward

Keep the useful prototype facts about row limits, explicit metadata, and anchor-based pagination. Do not carry forward the patch endpoint as production direction:

- The patch endpoint builds previous and current full snapshots, which is roughly 2x the current full-snapshot cost before any patch benefit.
- `appendPatchRow` silently appends when the requested anchor is missing, which can hide cache drift instead of forcing a refetch.
- Patch equality uses `JSON.stringify`, which is brittle for transport correctness and too expensive to become a cache-consistency primitive.

Until patch prerequisites exist, realtime `events-appended` messages may refetch the latest capped timeline. Status and pending-interaction changes should continue to invalidate or refetch timeline queries instead of attempting partial mutation.

## Phase 1: Capped Latest Timeline

Goal: reduce payload size and client render cost for all latest timeline surfaces without taking on the full server-performance problem yet.

Server behavior:

- Apply a fixed latest-page cap to all timeline surfaces/views: regular standard threads, manager standard timeline view, and manager conversation timeline view. Each latest response should include at most 100 older top-level rows plus active tail and pending rows.
- Count only older top-level rows against the cap. Active tail rows, pending steers, pending interactions, and other currently-active rows remain visible even when that produces more than 100 total top-level rows.
- This phase may still build the full timeline internally and cap after projection. That is acceptable only as payload and render relief; the implementation and tests should not claim DB or projection cost has been solved.

Client behavior:

- `useThreadTimeline` should receive capped latest responses by default for regular standard threads, manager standard timeline view, and manager conversation timeline view.
- Existing lazy turn details must keep working for visible rows.
- Expansion state can remain row-id based for visible rows; rows removed by the cap should be dropped from local expansion/detail state.

Exit criteria:

- Latest regular standard, manager standard, and manager conversation timelines each return `<=100` older top-level rows plus active tail/pending rows.
- Pending and active rows are still visible for each timeline surface when they are older than the 100-row historical window.
- Payload size and row render count are measurably lower on long threads across all timeline surfaces.

## Phase 2: Page Metadata And Limit Semantics

Goal: make the latest cap explicit at the route, contract, and query-cache layers before adding older-page loading.

Contract shape:

```ts
timelinePage: {
  kind: "latest" | "older";
  topLevelLimit: number;
  returnedOlderTopLevelRowCount: number;
  hasOlderRows: boolean;
  olderCursor: {
    topLevelSortSeq: number;
    rowId: string;
  } | null;
}
```

Query semantics:

- `topLevelLimit` defaults to 100 at the server boundary, then flows internally as a required number.
- `beforeCursor` omitted means the latest page. `beforeCursor` present means an older page whose rows are strictly older than the cursor tuple.
- The top-level row order is total: `(topLevelSortSeq ASC, rowId ASC)` for display and `(topLevelSortSeq DESC, rowId DESC)` for backwards page fetches. `topLevelSortSeq` should match the row-index sort field used for pagination, not a separate raw event offset.
- Rows older than a cursor are `(top_level_sort_seq, row_id) < (cursor.topLevelSortSeq, cursor.rowId)`. Expanded, that means:
  `top_level_sort_seq < cursor.topLevelSortSeq OR (top_level_sort_seq = cursor.topLevelSortSeq AND row_id < cursor.rowId)`.
- `tailMode` should be explicit once introduced. The first supported value is `active`, meaning active tail rows are included outside the older-row cap for latest pages.
- `topLevelLimit` is a top-level historical row limit, not an event count, byte limit, or raw event offset.
- `olderCursor` is the cursor for the next older page and should be the oldest row tuple returned by the current page. It should be `null` when no older rows remain.

Client query shape:

- Include `topLevelLimit`, page kind, and the full `beforeCursor` tuple in timeline query keys.
- Add a separate older-page query key rather than overloading the latest-page cache entry.
- Merge older pages ahead of already-loaded rows by stable row id. If a row id repeats with a different `sourceSeqStart/sourceSeqEnd`, prefer the newer query result and clear stale nested details for that row.
- Keep pending steers and active tail outside older-page merges; older pages should not invent a second active tail.

Exit criteria:

- Response metadata is required in `ThreadTimelineResponse` once introduced and is populated for latest and older responses.
- Query keys distinguish latest page, older pages, timeline surface/view, `topLevelLimit`, and the full `beforeCursor` tuple.
- Tests cover that `beforeCursor` uses the total `(topLevelSortSeq, rowId)` order and does not skip duplicate-sequence siblings.
- The route fills default values once at the boundary and internal service calls receive explicit values.

## Phase 3: Real Row Index And Anchor Lifecycle

Goal: make older-page queries and server work scale with the selected rows, not the full thread history.

Add a server-owned `timeline_row_index` lifecycle table. The exact schema should live in `@bb/db` shared types, but it needs at least:

- `thread_id`
- `view_mode`
- `row_id`
- `row_kind`
- `turn_id`
- `source_seq_start`
- `source_seq_end`
- `top_level_sort_seq`
- `is_active_tail`
- `updated_at`

Recommended indexes:

- Unique key on `thread_id, view_mode, row_id`.
- Composite cursor/order index on `thread_id, view_mode, is_active_tail, top_level_sort_seq, row_id`. The direction can be declared explicitly as descending if useful, but the query must use the same tuple fields for its predicate and `ORDER BY`.

Lifecycle ownership:

- The server timeline lifecycle owns index writes, reconciliation, and invalidation. Routes may request timeline reads, but they should not advance lifecycle state ad hoc.
- Event appends should enqueue or perform anchor refresh for the affected thread and view mode.
- Reconnect/recovery must reconcile the index from raw events so lost daemon notifications do not leave pagination stale.
- Repeated refresh requests should be idempotent.

Latest-page query shape:

```sql
SELECT *
FROM timeline_row_index
WHERE thread_id = ?
  AND view_mode = ?
  AND is_active_tail = 0
ORDER BY top_level_sort_seq DESC, row_id DESC
LIMIT ?;
```

Fetch active-tail anchors separately, then fetch only event rows for the returned anchor ranges. Include targeted dependency rows required to project selected anchors correctly, such as `turn/started` rows for selected turn ids.

Older-page query shape:

```sql
SELECT *
FROM timeline_row_index
WHERE thread_id = ?
  AND view_mode = ?
  AND is_active_tail = 0
  AND (top_level_sort_seq, row_id) < (?, ?)
ORDER BY top_level_sort_seq DESC, row_id DESC
LIMIT ?;
```

The older-page service must not call `listRecentStoredEventRows` or otherwise load all thread events. It should fetch event rows only for selected anchor ranges and any targeted dependency rows needed for projection.

Exit criteria:

- Older page query returns the previous 100 top-level rows without loading all events.
- `EXPLAIN QUERY PLAN` for latest and older row-index page queries uses the composite cursor/order index and does not use a temp B-tree for `ORDER BY`; the event fetch uses `events_thread_sequence_idx`.
- Index refresh handles append, reconnect reconciliation, and repeated requests without duplicate anchors.
- Lazy turn details hydrate correctly by `turnId + sourceSeqStart + sourceSeqEnd` for rows from latest and older pages.

## Phase 4 Or Later: Reconsider Patch Transport

Goal: revisit patch/delta transport only after pagination has stable row anchors and page semantics.

Required prerequisites before a patch route can be reconsidered:

- Stable row revisions or hashes that avoid `JSON.stringify` equality.
- Full cursor inputs in every patch request: thread id, timeline surface/view, page kind, `topLevelLimit`, `beforeCursor` or latest cursor state, and `tailMode`.
- Page-aware semantics for latest-page active tail, older pages, rows moving across page boundaries, and rows dropping out of the capped window.
- Strict refetch fallback when an anchor is missing, a revision mismatches, a page cursor is stale, or a patch cannot prove correctness.
- No previous-plus-current full-snapshot build as the default implementation path.

Until those exist:

- Do not make the current patch prototype the default transport.
- Prefer deleting the prototype route and cache mutation code. If retained, keep it behind an explicit experiment flag with tests proving it cannot silently append or mutate the wrong page.
- `events-appended` realtime messages may refetch the latest capped page.
- Status and pending-interaction messages should invalidate timeline queries because they affect row status, active tail membership, and visible controls.

Exit criteria:

- Patch transport is either absent or explicitly experimental.
- No production realtime path relies on silent anchor fallback or JSON-string row equality.
- A patch design document exists before implementation and references row revisions, cursor inputs, fallback behavior, and page-aware semantics.

## Validation Instructions

Run focused tests with Turbo, not package scripts directly:

```sh
pnpm exec turbo run test --filter=@bb/server -- --run test/threads/timeline-service.test.ts
pnpm exec turbo run test --filter=@bb/app -- --run src/views/useTurnSummaryRowLoader.test.tsx src/views/ThreadTimelinePane.test.tsx
pnpm exec turbo run test --filter=@bb/server-contract
pnpm exec turbo run test --filter=@bb/db
pnpm exec turbo run typecheck --filter=@bb/server
pnpm exec turbo run typecheck --filter=@bb/app
pnpm exec turbo run typecheck --filter=@bb/server-contract
pnpm exec turbo run typecheck --filter=@bb/db
```

Add or update tests that prove:

- Latest regular standard, manager standard, and manager conversation timelines each return `<=100` older top-level rows plus active tail/pending rows.
- Older page query returns the previous 100 rows without calling the full-event timeline loader.
- `beforeCursor` compares against the total `(topLevelSortSeq, rowId)` tuple.
- Duplicate-sequence top-level rows page without gaps, including multi-file-change siblings that share the same `sourceSeqStart/sourceSeqEnd` range and differ only by row id.
- Lazy turn details request and hydrate by `turnId + sourceSeqStart + sourceSeqEnd`.
- Status and pending-interaction realtime messages invalidate or refetch affected timeline queries.
- `events-appended` can refetch latest until patch prerequisites exist.

For Phase 3 query validation, use an in-memory SQLite test with `createConnection(":memory:")` and `migrate(db)`, plus a dev-database smoke check when useful:

```sh
sqlite3 ~/.bb-dev/bb.db "EXPLAIN QUERY PLAN SELECT * FROM timeline_row_index WHERE thread_id = 'thr_bj3p5vk9py' AND view_mode = 'standard' AND is_active_tail = 0 AND (top_level_sort_seq, row_id) < (1000, 'row_cursor') ORDER BY top_level_sort_seq DESC, row_id DESC LIMIT 100;"
sqlite3 ~/.bb-dev/bb.db "EXPLAIN QUERY PLAN SELECT * FROM events WHERE thread_id = 'thr_bj3p5vk9py' AND sequence BETWEEN 1 AND 1000 ORDER BY sequence;"
```

The row-index query plan should use the composite cursor/order index and should not include `USE TEMP B-TREE FOR ORDER BY`.

If the prototype measurement harness is retained, label Phase 1 `postProjectionCapped*` numbers as payload/render estimates only. They slice an already-built timeline and do not validate capped DB cost, capped projection cost, or older-page query cost.

## Planning Workflow Self-Review

- The plan lives under `plans/`.
- Exit criteria are listed per phase and across validation.
- Validation instructions are concrete and use Turbo.
- This plan supersedes the patch-first prototype plan; delete it once the pagination work is completed or a newer plan replaces it.
