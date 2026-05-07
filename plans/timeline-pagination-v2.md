# Timeline Pagination V2

## Problem

The reverted pagination implementation let the client merge pages and then
globally sort semantic rows by `sourceSeqStart` and `id`. That broke the
timeline's logical order. In the dev DB thread `thr_eqm8uijebf`, rows derived
from the first turn could sort before the first user message even though the
server projection correctly treats the user request as the first visible row.

## Model

Pagination is over deterministic logical segments, not individual semantic
rows. A segment is a contiguous slice of the server-projected top-level
timeline rows. In the standard timeline, a new segment starts at each top-level
primary user message row: `kind === "conversation"`, `role === "user"`, and
`userRequest.kind === "message"`. Accepted and pending primary user messages are
both primary message anchors. Steer rows are not anchors, regardless of accepted
or pending status. Rows after a primary user message, including system
operations, accepted steers, pending steers, turn summaries, assistant
responses, and work rows, remain in that segment until the next primary user
message starts a new segment. If a timeline has no user row at the start, the
leading rows form a bootstrap segment.

This keeps separators deterministic while preserving the row order produced by
`@bb/thread-view`. Segmenting is a pagination concern only. It does not change
timeline projection, row IDs, turn-summary grouping, or row rendering.

## Cursor Semantics

The server returns an opaque older-page cursor for the oldest segment included
in the current page. The cursor names the segment anchor with:

- `anchorSeq`: the `sourceSeqStart` of the segment's first row.
- `anchorId`: the `id` of the segment's first row.

The client must not compare or sort rows with these cursor fields. On an older
page request, the server finds the anchor segment in the current projected
timeline and returns the previous segment window in server order. If there is
no previous segment, `olderCursor` is `null`.

## Responsibilities

Before:

- Server projected rows, but pagination metadata was coupled to visible row
  ordering and event-window fallbacks.
- Client merged older and latest pages, deduped by ID, then globally sorted
  rows by `sourceSeqStart` and `id`.

After:

- Server owns projection order, segment boundaries, cursor interpretation, and
  page metadata.
- Client only appends latest server-ordered pages, prepends older
  server-ordered pages, and dedupes while preserving encountered order.
- The client never globally sorts semantic timeline rows.

## Invariants

- Reconstructing all pages by prepending older pages to the latest page produces
  the same top-level row ID order as the unpaginated server projection.
- A page boundary never splits a logical segment.
- The first visible row for `thr_eqm8uijebf` remains the first user message
  before derived work or turn-summary rows.
- Completed turn-summary rows remain present for `thr_qfk8ksbxkk` and
  `thr_pvp3c84xx4`.
- Refreshing the latest page while older rows are loaded replaces the overlapping
  live tail but preserves already loaded older rows.
- Cursor fields are server-owned. Client merge code treats them only as tokens
  to request the next older page.

## Scope

V2 intentionally keeps the server projection path intact and does not re-add
the reverted event-window/context-hydration machinery. That keeps this branch
focused on the correctness model first: deterministic logical segment pages and
order-preserving client merges. Event-window optimization can be revisited
later only if it preserves these invariants.

## Validation Plan

- Add server tests for segment pagination order, cursor metadata, and page
  reconstruction.
- Add app tests for order-preserving prepend/latest merge helpers, including
  the old `sourceSeqStart` mis-ordering shape.
- Add an opt-in dev DB regression test using `BB_TIMELINE_DEV_DB` against
  `thr_eqm8uijebf`, `thr_qfk8ksbxkk`, and `thr_pvp3c84xx4`.
- Run targeted Turbo typecheck and tests for server, app, server-contract,
  thread-view/db-adjacent affected packages, and integration timeline smoke.
