# Thread Timeline Losslessness Remaining Work

## Status

The core correctness fix is already implemented on this branch:

- assistant delta `itemId` is required at the normalized event boundary
- buffered assistant/reasoning text uses canonical scoped identity
- projection, compaction, and pruning no longer treat raw `itemId` as
  thread-global
- regression coverage exists for cross-turn `itemId` reuse and
  `parentToolCallId`-scoped instances

This plan now tracks only the deferred follow-up work that was intentionally not
shipped with the main fix.

## Remaining Scope

### Phase 1: Projection Invariants

**Goal:** Make silent omission impossible to ship again.

**Changes:**

- Add a pure validator in `@bb/core-ui` that:
  - scans ordered events
  - computes expected assistant/reasoning buffered-text instances
  - compares them against the final `toViewMessages(...)` output
- Validate the full projected message set, not just one internal buffering
  helper.
- Enforce:
  - every source buffered-text instance with visible text maps to exactly one
    projected assistant/reasoning message
  - no projected assistant/reasoning message exists without a matching source
    instance
  - completed text wins over retained deltas
  - projected text matches the expected final text for the instance

**Exit criteria:**

- Projection validation catches omission, duplication, and text mismatch.
- A broken projection cannot silently return partial timeline data.

### Phase 2: Fail Closed In The Timeline Route

**Goal:** Return validated timeline data or fail loudly.

**Changes:**

- Update server timeline construction so projection is computed once, validated
  once, and reused for `activeThinking`, manager filtering, and row rendering.
- On invariant failure:
  - log a structured critical error with thread id, turn id, canonical key, and
    source sequence range
  - increment a projection invariant metric/counter
  - return a loud server error instead of truncated timeline data
- Do not add a repair/fallback projection in the first pass.

**Exit criteria:**

- Timeline routes either return validated data or error loudly.
- No route can silently omit assistant/reasoning text and still return `200`.

## Validation

### Automated

- `pnpm exec turbo run typecheck --filter=@bb/core-ui --filter=@bb/server`
- `pnpm exec turbo run test --filter=@bb/core-ui --filter=@bb/server --force`

### Manual

- Verify `/api/v1/threads/thr_4nsvwcvaf7/timeline` and
  `/api/v1/threads/thr_4nsvwcvaf7/output` still agree on final assistant text.
- Verify `/api/v1/threads/thr_yn2i6jeaca/timeline` and
  `/api/v1/threads/thr_yn2i6jeaca/output` still agree on final assistant text.
- Intentionally trigger a projection invariant failure in a focused test and
  confirm the route errors loudly instead of returning partial timeline data.

## Cleanup

Delete this plan file once the invariant/fail-closed follow-up work ships or
replace it with a newer plan if the remaining scope changes.
