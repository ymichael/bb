# Goal

Break up the two giant files in `@bb/core-ui` — `to-ui-messages.ts` (~2900 lines) and `thread-detail-rows.ts` (1083 lines) — into focused modules.

# Scope

- Extract well-bounded helper groups from both files into new modules
- Keep the main orchestration functions (`toUIMessages`, `buildThreadDetailRows`) in their current files but dramatically smaller (~500 and ~400 lines respectively)
- Re-export everything through `index.ts` so the public API doesn't change
- Add targeted unit tests for extracted pure-function modules
- Existing integration tests must continue to pass without modification

# Done (already landed)

- ~~Remove dead `@bb/templates` dep~~ (b94a0fcb)
- ~~Remove `LEGACY_TYPE_MAP`, `normalizeEventType()`, CLI `"turn/end"` check~~ (b94a0fcb)

# Implementation Steps

## Step 1: Extract `event-decode.ts` (~40 lines)
From `to-ui-messages.ts`:
- `EventMeta` interface
- `decodeRow()`

Entry-gate for the pipeline — pure function, no state.

## Step 2: Extract `tool-call-parsing.ts` (~200 lines)
From `to-ui-messages.ts`:
- `SHELL_WRAPPER_NAMES`
- `unwrapQuotedShellArg()`
- `isKnownShellWrapper()`
- `extractShellCommandFromString()`
- `toolNameToParsedIntents()`
- `formatToolCallCommand()`
- `isExploringIntent()`
- `isExploringCall()`

Pure functions that classify and format tool calls. No state machine coupling.

## Step 3: Extract `exec-lifecycle.ts` (~120 lines)
From `to-ui-messages.ts`:
- `ExecCallPartial` interface
- `ExecLifecycleEvent` interface
- `toExecDefaultStatus()`
- `parseExecLifecycleEvent()`
- `itemStatusToToolStatus()`
- `itemStatusToFileEditStatus()`

Decode raw exec events into a normalized lifecycle shape. Pure input→output.

## Step 4: Extract `web-search-lifecycle.ts` (~60 lines)
From `to-ui-messages.ts`:
- `WebSearchLifecycleEvent` interface
- `parseWebSearchLifecycleEvent()`

Small but self-contained.

## Step 5: Extract `provisioning-helpers.ts` (~250 lines)
From `to-ui-messages.ts`:
- `provisioningProgressTitle()`
- `readProvisioningTranscript()`
- `getProvisioningProgressFromTranscript()`

From `thread-detail-rows.ts`:
- `appendProvisioningOutput()`
- `mergeProvisioningSetup()`
- `provisioningTranscriptEntryKey()`
- `mergeProvisioningTranscriptEntry()`
- `mergeProvisioningTranscript()`
- `mergeProvisioningMetadata()`
- `isProvisioningOperation()`
- `shouldNormalizeProvisioningLifecycleOperation()`
- `mergeProvisioningOperations()`

All provisioning logic from both files, unified into one module.

## Step 6: Extract `thread-operation-helpers.ts` (~220 lines)
From `thread-detail-rows.ts`:
- `ClassifiedThreadOperation` interface
- `isThreadOperation()`
- `classifyThreadOperation()`
- `areThreadOperationIdsCompatible()`
- `isTerminalThreadOperationStatus()`
- `mergeThreadOperationMessages()`
- `isWorktreeSquashMergeOperation()`
- `isWorktreeCommitOperation()`
- `hasAdjacentThreadOperationOutcome()`
- `mergeThreadOperationOutcomeMessages()`
- `enrichWorktreeSquashMergeMessages()`

## Step 7: Extract `format-helpers.ts` (~60 lines)
From `to-ui-messages.ts`:
- `durationToString()`
- `capitalize()`
- `getFirstStringField()` (re-export from unknown-helpers or co-locate)

Generic utilities used across multiple modules.

## Step 8: Extract `user-message-parsing.ts` (~150 lines)
From `to-ui-messages.ts`:
- `parsePromptInput()`
- `userMessageSignature()`
- `shouldRenderThreadStartInput()`
- `shouldPreservePendingMessages()`
- `messageId()`
- `parseUserFromItemEvent()`
- `parseUserFromClientStart()`
- `parseManagerUserMessage()`

User message construction, dedup signatures, and rendering decisions.

## Step 9: Extract `parse-operation-message.ts` (~450 lines)
From `to-ui-messages.ts`:
- `parseOperationMessage()` — the big `if (decoded.type === "system/...")` dispatch
- All its local helpers: `threadOperationTitle()`, `threadOperationStatus()`, `provisioningSetupOperationStatus()`, `provisioningProgressOperationStatus()`

This is a pure function: `(decoded, meta, eventTurnId, options) → UIOperationMessage | null`. Zero dependency on `ProjectionState`. It's the single biggest win — ~450 lines out in one move.

## Step 10: Extract `tool-activity-state.ts` (~400 lines)
From `to-ui-messages.ts`:
- `ProjectionState` interface
- `createProjectionState()`
- `ToolActivityState` interface
- `RunningExecCall` interface
- `getCallStatusRank()`, `mergeCallStatus()`
- `hasSemanticIntent()`, `chooseParsedIntents()`
- `upsertRunningExecCall()`
- `appendExecOutputDelta()`
- `areExploringCallsCompatible()`, `syncExploringStatus()`
- `findCallInActiveCell()`, `findCallInHistoryCells()`
- `mergeCallSummary()`
- `flushActiveToolCell()`, `flushToolActivityBeforeNonToolMessage()`
- `createToolCallMessage()`, `createExploringMessage()`
- `onExecBegin()`, `onExecOutput()`, `onExecEnd()`
- `onWebSearchBegin()`, `onWebSearchEnd()`
- `onCompactionBegin()`, `onCompactionEnd()`

Self-contained state machine for tool call grouping and exploring-call merging.

## Step 11: Extract `parse-error-message.ts` (~50 lines)
From `to-ui-messages.ts`:
- `parseErrorMessage()`
- `isIgnoredNoiseType()`
- `isDuplicateEventType()`
- `isIgnoredItemStartEvent()`
- `appendDebugEvent()`

Event filtering and error projection.

## Step 12: Extract `assistant-buffering.ts` (~80 lines)
From `to-ui-messages.ts`:
- `parseAssistantDeltaText()`, `parseAssistantFinalText()`
- `parseReasoningDeltaText()`, `parseReasoningFinalText()`
- `isTerminalAssistantFlushEvent()`
- `flushBufferedAssistantMessages()`

## After extraction — what remains

**`to-ui-messages.ts`**: **~500 lines** — `decodeRow()` call, the main `toUIMessages()` event loop with its per-event-type dispatch, dedup signature maps, and `finalizePendingMessages()`. This is the orchestrator that calls into the extracted modules.

**`thread-detail-rows.ts`**: **~400 lines** — type guards (`isCollapsibleTurnMessage`, `isToolExploringMessage`, `isFileEditMessage`), tool-group collapsing logic (`mergeConsecutiveToolActivityMessages`, tool group status/summary helpers), and `buildThreadDetailRows()` itself.

# Testing Strategy

## Current state

4 test files, 105 tests, 5125 total lines:
- `to-ui-messages.test.ts` (3583 lines, ~65 tests) — integration tests on `toUIMessages()`. Constructs `ThreadEventRow[]` arrays by hand and asserts on the projected `UIMessage[]` output. One large fixture-based stability test (500+ real events).
- `thread-detail-rows.test.ts` (1338 lines, ~25 tests) — integration tests on `buildThreadDetailRows()`. Feeds `UIMessage[]` arrays and asserts on the row structure, collapsing, and status merging.
- `format-timeline-text.test.ts` (161 lines) — unit tests on CLI text rendering.
- `environment-display-name.test.ts` (43 lines) — unit tests on display name formatting.

### What works well
- The integration tests are thorough and use realistic data (hand-crafted event sequences + a real 500-event fixture).
- They catch regressions across the full pipeline — if an extraction breaks the wiring, these fail.
- The fixture-based stability test guards against dedup/ordering regressions that are hard to cover with small examples.

### What's missing
- **No unit tests for pure helpers.** Functions like `extractShellCommandFromString()`, `isExploringCall()`, `durationToString()`, `toolNameToParsedIntents()`, `formatToolCallCommand()`, `provisioningProgressTitle()`, etc. are only tested indirectly. Their edge cases are hard to cover through integration tests alone.
- **`parseOperationMessage()` branches are partially tested.** Some operation types (provisioning, compaction, thread-title, plan-updated) have dedicated integration tests. Others (mcp-progress, warning/deprecation, worktree-commit, worktree-squash-merge) are only exercised through the fixture.
- **Tool activity state machine** — the exploring-call coalescing, cell flushing, and late-completion-update logic is tested through `toUIMessages` integration tests but the state transitions are hard to reason about from those tests.

## Testing approach for extracted modules

### Principle: unit-test pure functions, integration-test the orchestrator

The extraction creates a natural seam: pure functions get direct unit tests, the stateful orchestrator (`toUIMessages`, `buildThreadDetailRows`) keeps its existing integration tests. No need to duplicate coverage.

### New test files to add during extraction

**`test/tool-call-parsing.test.ts`** (~100 lines)
Target: `extractShellCommandFromString`, `isExploringCall`, `toolNameToParsedIntents`, `formatToolCallCommand`
- Shell wrapper unwrapping edge cases: `bash -c 'cmd'`, `zsh -lc "cmd"`, `/usr/bin/bash -c cmd`, unknown shells
- Exploring classification: Read/Glob/Grep → exploring, Bash/Edit/Write → not, empty parsedCmd → not
- Tool name intent mapping: known tools (Read, Glob, Grep, Bash, Edit) with various arg shapes
- Command formatting: compact display for unknown tools, path extraction for known tools

**`test/format-helpers.test.ts`** (~40 lines)
Target: `durationToString`, `capitalize`
- Duration edge cases: sub-second, exact seconds, fractional seconds, minutes+seconds, undefined
- Capitalize: empty string, single char, already capitalized

**`test/parse-operation-message.test.ts`** (~150 lines)
Target: `parseOperationMessage`
- One test per operation type with minimal event input → expected UIOperationMessage output
- Covers: provisioning-started, provisioning-progress, provisioning-env-setup, provisioning-fallback, provisioning-completed, provisioning-cleanup-failed, thread-interrupted, plan-updated, mcp-progress, warning, deprecation, thread-title-updated, thread/name/updated, system/operation, worktree-commit, worktree-squash-merge, compaction, turn/diff/updated
- Returns null for unrecognized types

**`test/exec-lifecycle.test.ts`** (~60 lines)
Target: `parseExecLifecycleEvent`, `itemStatusToToolStatus`
- item/started + commandExecution → begin event
- item/completed + commandExecution → end event with exit code mapping
- item/commandExecution/outputDelta → output event
- Non-exec item types → null
- Status mapping: pending/completed/failed/interrupted

**`test/user-message-parsing.test.ts`** (~60 lines)
Target: `parsePromptInput`, `userMessageSignature`
- Multi-part input: text + images + files
- Empty/missing input → null
- Signature stability: same content → same signature, different content → different signature

**`test/provisioning-helpers.test.ts`** (~80 lines)
Target: `mergeProvisioningTranscript`, `mergeProvisioningMetadata`, `readProvisioningTranscript`, `provisioningProgressTitle`
- Transcript merging: same-key replacement preserves earliest startedAt, new keys appended
- Invalid transcript entries filtered out
- Phase/status title matrix

### Tests we do NOT add

- **`tool-activity-state.ts`** — the state machine is tightly coupled (cell management, running call tracking, flush timing). Testing it in isolation would require constructing the same `ProjectionState` scaffolding that `toUIMessages` builds. The existing integration tests cover it well. If we later want to test it in isolation, the right move is to give it a proper class API with clear input methods, but that's a refactor beyond this plan.
- **`assistant-buffering.ts`** — the delta parsing functions are trivial type narrowing. The buffering/flush logic depends on `ProjectionState`. Covered by existing integration tests.
- **`event-decode.ts`** — `decodeRow()` is now a 5-line function. Not worth its own test file.

### Existing tests: no changes needed

The existing `to-ui-messages.test.ts` and `thread-detail-rows.test.ts` remain as-is. They test the full pipeline end-to-end and will catch any wiring mistakes from the extraction. The new unit tests complement them by covering edge cases in individual functions.

# Validation

- `pnpm exec turbo run typecheck --filter=@bb/core-ui` passes
- `pnpm --filter @bb/core-ui test` — all existing + new tests pass
- No changes to `index.ts` public exports (internal re-paths only)
- Consumers (`apps/app`, `apps/cli`) unaffected

# Open Questions / Risks

1. **Step 5 merges helpers from both files** — the provisioning logic is currently split across `to-ui-messages.ts` (event→UI decoding) and `thread-detail-rows.ts` (row-level merging). Unifying them is the right call but touches two "ownership" zones.
2. **Step 10 (tool-activity-state) is the riskiest extraction** — the state machine has many functions that mutate `ProjectionState`. The wiring between the main loop and these handlers needs careful attention to import/export the state type correctly. The existing integration tests are the safety net.
3. **Test file sizes may grow** — `to-ui-messages.test.ts` is already 3583 lines. As we add more operation types or event scenarios, consider splitting the test file along the same module boundaries (e.g., `test/parse-operation-message.test.ts` for new operation tests instead of appending to the monolithic file).
