# Context Usage And Compaction

## Goal

Audit and resolve the thread context-window indicator and compaction-timeline
gaps across `codex`, `claude-code`, and `pi` without changing behavior until
the provider semantics are verified.

## Why This Matters

The current indicator can render impossible states like `370k / 200k` and then
clamp to `100% used`. That makes the UI look broken and mixes together at least
two different concepts:

- token usage accounting for a turn
- current context occupancy for a thread

Separately, compaction is visible for Codex but not for Claude Code or Pi even
though both installed SDKs expose compaction-related signals.

## Confirmed Findings So Far

- the current UI numerator comes from
  `thread/tokenUsage/updated.tokenUsage.last.totalTokens`
- the denominator comes from
  `thread/tokenUsage/updated.tokenUsage.modelContextWindow`
- product decision: for every provider, the context meter should show current
  post-turn state, not “how full the context was right before compaction”
- product decision: for every provider, compaction should be explained by
  timeline events, not by freezing or reusing a pre-compaction meter value
- for the local repro thread `thr_ass6kspq7c`, the provider is `claude-code`,
  not `pi`
- the local repro denominator `200000` is coming from Claude SDK
  `modelUsage.contextWindow`, not from a bb constant
- the local repro numerator `370207` is dominated by cached-input accounting,
  which makes it unsuitable as a context-occupancy gauge
- Codex compaction is normalized and shown in the timeline today
- Claude Code and Pi compaction are not currently shown in the timeline
- the public Claude SDK `ModelUsage` surface exposes accounting fields plus
  `contextWindow`, but not a general “current context tokens” field
- the public Claude session APIs return metadata and transcript messages, not a
  live occupancy snapshot
- the public Claude SDK does expose real compaction metadata via
  `compact_boundary.compact_metadata.pre_tokens`
- the persisted Claude JSONL transcript stores compaction boundaries as
  `compactMetadata.preTokens` / `compactMetadata.trigger` in camelCase
- live Claude control runs on forked local sessions showed ordinary turns
  emitting `init` + `result` without any `task_progress` events
- a successful live manual Claude `/compact` run emitted:
  `status: compacting` -> `status: null` -> `compact_boundary(pre_tokens=61055)`
  -> `result`, with no `task_progress` or `task_notification` events in that
  compaction flow
- a synthetic auto-compaction run on `claude-opus-4-6` (200k context) hit
  compaction on turn 3 and the live SDK stream emitted:
  `status: compacting` -> `status: null` ->
  `compact_boundary(compact_metadata.pre_tokens=199622)` -> `result`
- that same synthetic auto-compaction run emitted no `task_progress` or
  `task_notification` events at all
- in the persisted Claude JSONL for that synthetic run, only
  `compact_boundary` was stored for the compaction lifecycle; the transient
  `status` messages were not persisted to disk
- the prettified Claude Code binary in
  `/Users/michael/Projects/references/claude-code/cli.js` computes its context
  meter from the latest usage-bearing message, not cumulative totals
- Claude Code’s meter numerator is:
  `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`
  and explicitly excludes `output_tokens`
- Claude Code’s meter denominator is effectively model-based `200000` or
  `1000000`, derived from model string + 1M beta/model selection, not from a
  provider-reported per-result denominator field
- in the synthetic 200k run, the Claude Code-style meter would have been:
  - turn 1: `82190 / 200000` ~= `41%`
  - turn 2: `154242 / 200000` ~= `77%`
  - post-compaction turn 3: `10548 / 200000` ~= `5%`
- that synthetic comparison reinforces the intended meaning of the Claude Code
  meter: it reflects current context state after the last completed call, not
  “how close the triggering turn got right before compaction”
- product decision: bb will ship the Claude Code-compatible current-state meter
  for `claude-code`
- a live ordinary turn on a large Claude `claude-opus-4-6[1m]` session emitted
  `result.usage` totaling more than 680k processed tokens and still emitted no
  `task_progress`, which weakens the idea that `task_progress` is the reliable
  general occupancy source for Claude
- `t3code` currently uses Claude `task_progress` / `task_notification` for its
  context meter and treats `result.usage` as only `totalProcessedTokens`; that
  is a useful prior-art implementation, but the live SDK evidence above does
  not yet prove that approach is generally correct for Claude
- bb currently serves a static Claude model list from
  `packages/agent-runtime/src/claude-code/model-list.ts`
- the installed Claude SDK exposes `initializationResult()` account metadata and
  a live `models` list, and the local probe showed both 1M-capable model IDs
  and `account.subscriptionType`
- bb does not currently use the Claude SDK preset system prompt for regular
  Claude threads; the bridge/session layer only passes a plain string
  `systemPrompt`
- the Claude SDK supports both plain-string `systemPrompt` and
  `{ type: "preset", preset: "claude_code", append?: string }`
- a live smoke test against the real `SdkSession` runtime path succeeded with
  `systemPrompt: { type: "preset", preset: "claude_code", append: ... }`,
  producing a normal Claude turn (`init` -> `assistant` -> `result`) and final
  result `"OK"`; the blocker is our bb typing/plumbing, not SDK runtime support
- bb already knows whether a thread is a manager thread at the server layer,
  but that distinction is not currently threaded through `agent-runtime` into
  the Claude adapter/bridge
- the Claude bridge already has a partial `managerMode` concept, but it only
  exists on `thread/start` today; `thread/resume` does not carry it
- product decision: Claude denominator fallback should be:
  - use provider-reported `modelUsage.contextWindow` when present
  - otherwise derive from Claude model selection as `1000000` for `[1m]`
    variants and `200000` otherwise, matching Claude Code’s own meter logic
- local bb data currently shows `27` Claude `thread/tokenUsage/updated` rows
  and `0` missing `modelContextWindow` values, so the denominator fallback is a
  defensive rule, not the primary fix for the known repro

## Open Questions

1. Does the Claude Code SDK expose a trustworthy current-context metric
   anywhere beyond `compact_boundary.pre_tokens`, or is compaction-time
   metadata the only exact occupancy signal we can observe publicly?
2. Should Claude model availability come directly from SDK
   `initializationResult().models` instead of bb’s static model list?
3. When the Claude SDK exposes 1M-capable models for the current user, should
   bb make the 1M variant the default automatically, or only preselect it when
   the SDK marks it as the recommended/default model?
4. For Pi, should bb switch the indicator to the SDK `getContextUsage()` API?
5. What exact normalized event shape should Claude Code and Pi compaction use so
   they feed the existing timeline projection cleanly?

## Workstreams

### 1. Claude occupancy research

- inspect installed Claude SDK stream types, session APIs, and persisted session
  data
- use `scripts/trace-claude-events.mjs` for:
  - passive tracing of live bb threads via Claude JSONL tailing
  - active controlled SDK runs when raw `result` messages are needed
- determine whether the SDK exposes:
  - exact current context tokens
  - an estimated occupancy value
  - only usage/billing fields
- write down the strongest evidence either way with concrete file references
- record Claude Code binary behavior separately from public SDK behavior so we
  do not conflate “what Claude Code displays” with “what the SDK guarantees”

### 2. Provider event normalization audit

- codex:
  - confirm current compaction and context-usage semantics
- claude-code:
  - identify compaction start/end signals from installed SDK events
  - identify whether any stream or history event can support a real context
    numerator
- pi:
  - confirm `getContextUsage()` semantics and when it returns `null`
  - identify compaction start/end events to normalize

### 3. Claude model discovery and 1M defaults

- replace the static Claude model list with SDK-driven discovery where possible
- determine the safest source of truth, in order:
  - `initializationResult().models`
  - `initializationResult().account.subscriptionType`
  - existing static fallback
- define how bb should map SDK model values like `[1m]` into its model picker
  and persisted model selection
- define when 1M should become the default:
  - always when available
  - only when the SDK marks it as default/recommended
  - only for certain subscription/account types
- ensure provider refresh / model-list fetch semantics are explicit so cached
  capability data does not go stale silently

### 4. Claude system-prompt mode split

- confirm the intended prompt policy:
  - regular Claude threads use the SDK preset Claude Code prompt
  - manager Claude threads keep a plain string `systemPrompt`
- confirm runtime compatibility of the preset prompt object on the actual
  Claude session wrapper
- widen the Claude bridge/session types so `systemPrompt` can use the SDK union
  type instead of only `string`
- thread an explicit manager-thread signal from server thread config through:
  - server thread runtime config / command construction
  - `agent-runtime` start/resume args
  - adapter command/options
  - Claude adapter `thread/start` and `thread/resume`
  - Claude bridge session-option construction
- ensure the regular-thread path uses:
  - `{ type: "preset", preset: "claude_code", append: instructions }`
- ensure the manager-thread path uses:
  - plain string `systemPrompt`
- make sure resume semantics preserve the same prompt mode as start semantics
- validate that manager-only tool restrictions still behave correctly after the
  prompt-mode split

### 5. UI contract design

- separate “usage accounting” from “context occupancy” at the event-contract
  level
- for every provider, define the meter semantics as:
  - current state after the last completed turn
  - never a pre-compaction fullness gauge
  - compaction shown separately in the timeline
- define whether the indicator should consume:
  - exact occupancy
- estimated occupancy
- nullable occupancy with an unknown state
- ensure the contract works consistently across all three providers
- for Claude specifically, treat the target semantics as:
  - meter = current state after the last completed turn
  - compaction timeline = explicit lifecycle events
  - pre-compaction exact fullness = only available at compact boundaries
  - ship the Claude Code-compatible current-state meter

### 6. Implementation plan

- decide the minimal safe change set once provider semantics are proven
- keep timeline compaction work independent from the context-indicator fix
- avoid changing any provider math until the occupancy contract is explicit
- keep Claude model-discovery work independent from the context-indicator fix,
  except where both depend on the same SDK probe path
- if we implement the Claude meter, prefer the Claude Code-compatible formula:
  latest `input + cache_creation + cache_read`, excluding output tokens
- do not describe that Claude meter as an exact pre-compaction gauge
- if needed in the UI, use compaction events to explain sudden drops in the
  Claude meter rather than trying to smooth or reinterpret the numerator
- apply the same high-level UX rule to all providers:
  - meter = current state now
  - timeline = compaction happened

## Exit Criteria

This plan is complete only when all of the following are true:

- we can explain, with concrete evidence, where the numerator and denominator
  come from for all three providers
- we have a defensible answer on whether Claude Code exposes a trustworthy
  occupancy signal
- the intended source of truth for Claude model availability is defined and no
  longer depends on an unexplained static list
- the intended 1M-default behavior for Claude users with access is defined
- the intended Claude prompt policy is defined for regular vs manager threads
- the intended Claude denominator fallback rule is defined for missing
  `contextWindow` cases
- the intended timeline behavior for compaction is defined for all three
  providers
- the intended indicator behavior is defined separately from token-usage
  accounting
- the intended meter semantics are defined consistently across all providers as
  current post-turn state
- the intended Claude indicator semantics are defined as a Claude
  Code-compatible current-state meter
- any implementation work is scoped into follow-up changes with validation steps

## Progress

### Completed

- Claude model discovery now probes the live SDK `initializationResult().models`
  with a static fallback only on probe failure
- Claude regular threads now use the SDK preset system prompt with appended bb
  instructions
- Claude manager threads now keep a plain string `systemPrompt`
- manager-thread identity is threaded through server -> host daemon ->
  `agent-runtime` -> Claude adapter/bridge for both `thread/start` and
  `thread/resume`
- internal runtime/adapter plumbing now treats `managerMode` as an explicit
  boolean after the runtime boundary instead of an optional field
- the context-window meter now consumes a dedicated
  `thread/contextWindowUsage/updated` event instead of
  `thread/tokenUsage/updated`
- token-usage accounting remains on `thread/tokenUsage/updated` for all
  providers and is no longer the meter numerator
- Codex now emits a non-estimated current-state context-window event directly
  from its native token-usage signal
- Claude now emits an estimated Claude Code-compatible current-state meter using
  `input + cache_creation + cache_read`, excluding output tokens
- Pi now emits an estimated current-state meter from bridge-side
  `getContextUsage()` instead of assistant usage totals
- server timeline projection, pruning, UI helpers, and provider-audit replay now
  consume the dedicated context-window event contract

## Validation

### Research validation

- inspect installed SDK types and implementation for Claude and Pi
- inspect local persisted thread/event rows for real provider outputs
- where possible, inspect provider session-history APIs or on-disk session data
- use `node scripts/trace-claude-events.mjs --bb-thread <thread-id> --follow`
  to wait for live Claude compaction events without changing product code
- use `node scripts/trace-claude-events.mjs --sdk-prompt /compact --resume <session-id> --cwd <path>`
  for controlled raw Claude SDK stream captures that include `result`
- inspect live Claude `initializationResult()` output for model availability,
  account metadata, and 1M model variants
- inspect Claude runtime/server plumbing to confirm where manager-thread
  identity is lost between server thread config and Claude bridge session
  construction

### Implementation validation

- targeted provider-adapter tests for normalized context/compaction events
- targeted timeline projection tests for compaction visibility
- targeted UI tests for unknown / exact / estimated context usage states
- targeted Claude provider tests for dynamic model-list projection and 1M
  default selection behavior
- targeted Claude bridge/runtime tests for:
  - regular thread preset prompt mode
  - manager thread string prompt mode
  - preserved manager mode across `thread/start` and `thread/resume`
- live provider / manual QA:
  - start an isolated standalone stack from this worktree with
    `node scripts/qa/start-standalone.mjs --format env`
  - run `bb provider models claude-code --json` against that stack and confirm
    the SDK-probed list includes the live `default` alias and 1M-capable models
  - spawn a real regular Claude thread on model `default`, wait for `idle`, and
    confirm the output completes successfully
  - hire a real Claude manager, wait for `idle`, send a follow-up message, and
    confirm the resumed manager thread completes successfully

### Completed validation notes

- `pnpm exec turbo run test --filter=@bb/agent-runtime --filter=@bb/host-daemon-contract --filter=@bb/host-daemon --filter=@bb/server`
  passes for the Claude slice except for the pre-existing flaky server test
  `test/hosts/host-lifecycle.test.ts > fans out sandbox host progress callbacks across concurrent ready calls`
- the flaky server test above passed when rerun in isolation with
  `pnpm exec turbo run test --filter=@bb/server -- --run test/hosts/host-lifecycle.test.ts`
- live standalone QA confirmed that `bb provider models claude-code --json`
  returns the SDK-discovered list:
  `default`, `sonnet`, `sonnet[1m]`, `haiku`
- live standalone QA confirmed a regular Claude thread on model `default`
  completed with output `OK`
- live standalone QA confirmed a Claude manager thread started, idled, resumed
  on follow-up, and returned `READY`
- `pnpm exec turbo run typecheck test --filter=@bb/agent-runtime --filter=@bb/app --filter=@bb/server --filter=@bb/db --filter=@bb/core-ui --filter=@bb/server-contract --filter=@bb/domain --filter=@bb/provider-audit`
  passed for the context-usage slice after refreshing the provider-audit
  snapshots
- live standalone QA confirmed a fresh Codex thread emitted:
  - `thread/tokenUsage/updated.last.totalTokens = 9102`
  - `thread/contextWindowUsage/updated.usedTokens = 9102`
  - timeline `contextWindowUsage = { estimated: false, modelContextWindow: 258400, usedTokens: 9102 }`
- live standalone QA confirmed a fresh Claude thread emitted:
  - `thread/tokenUsage/updated.last = { inputTokens: 3, cachedInputTokens: 15051, outputTokens: 7, totalTokens: 15061 }`
  - `thread/contextWindowUsage/updated = { estimated: true, modelContextWindow: 1000000, usedTokens: 15054 }`
  - this verifies the Claude meter excludes output tokens and matches Claude
    Code’s current-state semantics
- live standalone QA confirmed a fresh Pi thread emitted:
  - `thread/tokenUsage/updated.last.totalTokens = 0`
  - `thread/contextWindowUsage/updated = { estimated: true, modelContextWindow: 200000, usedTokens: 7 }`
  - timeline `contextWindowUsage` used the Pi bridge signal rather than the
    zeroed token-usage row
