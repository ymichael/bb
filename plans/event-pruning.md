# Event Pruning Restoration Plan

Restore the pre-rebuild event-pruning behavior that kept `events` table growth under control, using the current server/DB architecture instead of resurrecting legacy daemon repositories.

## Problem

Pre-rebuild, bb pruned high-frequency event rows and resolved assistant deltas. The rebuild kept only read-time mitigations:

- DB-level exclusion of a small timeline noise set during timeline reads
- In-memory timeline compaction for large completed assistant-message runs

The rebuild no longer deletes stored event rows, so the `events` table grows without bound. That is especially visible for:

- `item/agentMessage/delta`
- `thread/tokenUsage/updated`
- `turn/diff/updated`
- other high-frequency progress/noise rows that are not needed forever

## Current Constraints

1. The server owns retention policy. `@bb/db` should expose explicit helpers, not hard-code product behavior.
2. The current timeline intentionally preserves the first completed assistant delta for each completed message. Any pruning change must preserve current timeline semantics.
3. The current schema already stores `itemId` and `itemKind` columns on `events`, so pruning should use those columns instead of legacy JSON-path matching.
4. This change should target current stored event types only. Do not restore legacy codex-envelope pruning.
5. Deleting rows will cap logical growth and allow SQLite page reuse, but it will not necessarily shrink the DB file on disk immediately. File-size reclamation is a separate follow-up unless this work proves insufficient.

## Goals

1. Reintroduce write-side pruning for current event rows that are safe to discard.
2. Keep timeline output and message boundaries stable after pruning.
3. Use server-owned hooks for idle, archive, and active-thread pruning.
4. Add focused tests that prove pruning catches real regressions.

## Non-Goals

1. Reintroducing deleted legacy repository code or provider-envelope normalization.
2. Broad retention changes for old codex-only event types that are no longer emitted.
3. Changing the public timeline contract or CLI output shape.
4. Adding full SQLite auto-vacuum or `VACUUM` management in the same change.

## Proposed Design

### 1. Add explicit DB pruning helpers

Add thread-scoped pruning helpers to `packages/db/src/data/events.ts` and export them from `packages/db/src/data/index.ts`.

Recommended helpers:

1. `getLatestThreadSequence`
2. `pruneThreadEventsBeforeSequence`
3. `pruneResolvedAgentMessageDeltas`

Design requirements:

1. `pruneThreadEventsBeforeSequence` accepts an explicit object argument with:
   - `threadId`
   - `sequenceCutoff`
   - `types`
2. `pruneResolvedAgentMessageDeltas` uses `threadId`, `itemId`, `itemKind`, `type`, and `sequence` columns rather than JSON extraction.
3. Resolved assistant-delta pruning keeps the earliest delta row for each completed assistant message and deletes only later deltas for that same item.
4. Incomplete items must never be pruned by the resolved-delta helper.

### 2. Define server-owned pruning policy

Add a server policy/orchestration module, for example `apps/server/src/services/event-pruning.ts`.

The module should define:

1. Keep windows:
   - active threads: keep recent `1000`
   - idle threads: keep recent `300`
   - archived threads: keep recent `120`
2. The current high-frequency event types eligible for age-based pruning.
   Start with:
   - `account/rateLimits/updated`
   - `thread/tokenUsage/updated`
   - `turn/diff/updated`
   - `item/reasoning/summaryPartAdded`
3. A single server entry point that:
   - computes the cutoff from the thread’s latest sequence
   - runs age-based pruning for configured noise types
   - runs resolved assistant-delta pruning
   - returns counts for observability and test assertions

The first implementation should stay conservative. Only add more prunable event types after confirming they are fully superseded by completed item rows in current timeline rendering.

### 3. Wire pruning into server lifecycle hooks

Use current server-owned flow points instead of daemon startup hooks.

Hook points:

1. After a thread transitions to `idle` from `turn/completed`
   - file: `apps/server/src/internal/turn-completed-events.ts`
   - apply idle keep window
2. After thread archive succeeds
   - file: `apps/server/src/routes/threads/actions.ts`
   - apply archived keep window
3. During active event ingestion
   - file: `apps/server/src/internal/events.ts`
   - if a batch contains prunable high-frequency rows for an active, non-archived thread, run active pruning for that thread

Implementation guidance:

1. Keep active-thread pruning best-effort and idempotent.
2. Do not add correctness-critical server memory. If throttling is needed, keep it lightweight and best-effort only.
3. Pruning failures must not fail the event-ingest request or the archive route. Log and continue.

### 4. Preserve current timeline behavior

Keep the current read-time compaction in place initially.

Reasons:

1. It already has coverage and protects large historical rows that predate the pruning rollout.
2. It keeps timeline behavior stable while DB pruning is introduced.
3. It lets us confirm that write-side pruning reduces row count without coupling that work to a timeline refactor.

After pruning lands, reassess whether read-time compaction still needs the same threshold and behavior.

## Implementation Steps

### Phase 1: DB helpers and tests

1. Add the pruning helpers in `packages/db/src/data/events.ts`.
2. Export them through `packages/db/src/index.ts`.
3. Add DB tests for:
   - resolved completed assistant messages keep only the first delta
   - incomplete assistant messages keep all deltas
   - age-based pruning keeps the most recent configured window
   - pruning is thread-scoped

### Phase 2: Server policy and idle/archive hooks

1. Add `apps/server/src/services/event-pruning.ts`.
2. Invoke pruning after `turn/completed` drives a thread to `idle`.
3. Invoke pruning after archive completes.
4. Add server tests for:
   - idle transition prunes old noise rows and resolved assistant deltas
   - archive uses the tighter archive window
   - pruning errors are logged and do not break the request flow

### Phase 3: Active-thread rolling pruning

1. Extend the server pruning service with active-thread policy.
2. Trigger active pruning from batch event ingest when the batch contains prunable noise rows for an active thread.
3. Add server tests for:
   - long active runs cap retained token-usage or diff rows
   - unresolved current-turn assistant deltas are not pruned
   - completed earlier assistant-message deltas are reduced to the preserved first delta

## Validation

Run these commands:

1. `pnpm exec turbo run test --filter=@bb/db`
2. `pnpm exec turbo run test --filter=@bb/server`
3. `pnpm exec turbo run typecheck --filter=@bb/db`
4. `pnpm exec turbo run typecheck --filter=@bb/server`

Validation cases that must be covered by tests:

1. A thread with `1000+` assistant deltas plus a completed assistant item still renders the same final assistant text after pruning.
2. The rendered assistant message still starts at the earliest preserved delta sequence, not at the completion row.
3. Unfinished assistant-message deltas remain intact.
4. Recent token-usage and diff rows for active threads remain within the configured retention window.
5. Idle threads retain the last `300` age-prunable noise rows.
6. Archived threads retain the last `120` age-prunable noise rows.
7. Pruning one thread never deletes rows from another thread.

Recommended regression coverage:

1. Update `apps/server/test/timeline-service.test.ts` to prove timeline output remains stable after DB pruning has already run.
2. Add a dedicated server pruning test file rather than overloading existing timeline tests.
3. Add DB tests that assert row counts before and after pruning, not call sequences.

## Exit Criteria

This work is complete when all of the following are true:

1. The server prunes resolved assistant-message deltas on idle and archive while preserving the first delta per completed message.
2. The server prunes configured high-frequency noise rows using `1000` active, `300` idle, and `120` archived keep windows.
3. The pruning policy lives in server code, while `@bb/db` only exposes generic delete helpers.
4. Existing timeline behavior remains unchanged for covered scenarios.
5. `@bb/db` and `@bb/server` tests and typechecks pass via Turbo.

## Follow-Up Decision

If logical row counts stabilize but on-disk SQLite file size still needs to shrink proactively, open a separate plan for incremental auto-vacuum or explicit maintenance. Do not fold that storage-management work into the first pruning restoration change unless validation shows page reuse is insufficient.
