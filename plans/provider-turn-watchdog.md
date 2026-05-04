# Provider Turn Watchdog

## Goal

Prevent provider/runtime stalls from leaving a thread visibly "working" for
hours without meaningful progress, and make the failure explainable after the
fact.

## Incident Context

On May 3, 2026, manager thread `thr_bj3p5vk9py` showed "Worked for 245m 26s"
until it was manually interrupted. The stalled turn inspected worker thread
`thr_jb5xwguekp`.

The provider session was:

- provider thread id: `019de9bd-c282-7d13-a12d-2ce1ceead26e`
- stalled provider turn id: `019debe2-4b19-76d2-87ad-75502194ecb7`
- raw session file:
  `/Users/michael/.codex/sessions/2026/05/02/rollout-2026-05-02T10-30-20-019de9bd-c282-7d13-a12d-2ce1ceead26e.jsonl`

At `2026-05-03T03:29:34Z`, Codex emitted two raw `exec_command` function calls:

- `call_nC7JRtRwAHxWwBHsLfJiFCre`:
  `bb thread output thr_jb5xwguekp`
- `call_lzIfeImSjOO1djVgNKp6L6WP`:
  `bb thread show thr_jb5xwguekp --json`

The database only received normalized command lifecycle events for the second
call. It started and completed immediately. The first call never emitted a
normalized `item/started`, and only produced raw output after manual interrupt:
`aborted by user after 14721.1s`.

## Current Understanding

This is two failures:

1. Codex can have a raw tool call whose execution future is cancellable, but no
   normalized command item has started yet. Upstream Codex emits command
   `item/started` only after unified exec session creation succeeds. A stall in
   the pre-begin path is therefore invisible to BB's normal command timeline.
2. BB has no provider-turn watchdog. Host-daemon commands have TTL sweeps, but
   the provider turn itself can remain active indefinitely when the provider
   stops producing useful events.

Important non-causes already ruled out:

- Raw `function_call_output` is not reliable progress ordering for parallel
  calls. Codex drains raw tool results through an ordered queue, so a fast later
  tool's raw output can be withheld behind an earlier stuck tool.
- Shell startup delay does not explain the missing command start. A probe with
  a sleeping `.zshenv` still emitted normalized `item/started`.
- The BB adapter should not synthesize command starts from raw `function_call`.
  A raw function call means "the model requested a tool," not "the command
  process started."
- `~/.bb-dev/replays` did not contain captures for the incident window.

## Evidence To Preserve

- Incident DB events for `thr_bj3p5vk9py`, sequences 624-635.
- Raw Codex session JSONL listed above.
- Direct Codex ordered-drain probe:
  `/tmp/codex-direct-probe-order.ndjson`
- Direct Codex exact-command probe:
  `/tmp/codex-direct-probe-incident-commands.ndjson`
- Direct Codex shell-startup probe:
  `/tmp/codex-direct-probe-zdotdir.ndjson`

## Phase 1: Define watchdog policy

**Goal:** Decide the lifecycle contract before writing code.

Define provider-turn watchdog thresholds and outcomes:

- Raw `exec_command` call seen, but no matching `commandExecution item/started`
  appears within a short threshold.
- `commandExecution item/started` appears, but no output or completion appears
  within a command-progress threshold.
- A turn is active with no provider events for a turn-idle threshold.
- A turn exceeds a maximum wall-clock duration regardless of intermittent
  low-value events.

For each case, define:

- whether BB interrupts the provider turn or marks the thread error directly
- what durable diagnostic event is emitted
- what thread status transition follows
- what user-facing message appears in CLI/API/UI timelines

Exit criteria:

- Thresholds have named constants and documented rationale.
- The policy distinguishes pre-begin tool stalls from running-command stalls.
- The policy does not use `thread.status` as a hidden queue/lifecycle ladder.

## Phase 2: Add durable diagnostics

**Goal:** Make future incidents explainable from DB events alone.

Add a domain event for provider-runtime watchdog intervention. It should carry
enough structured data to debug without reading raw provider logs:

- reason enum, such as `provider-turn-idle`, `tool-pre-begin-timeout`,
  `command-progress-timeout`, or `turn-wall-time-timeout`
- provider id
- provider thread id
- turn id
- raw call id when applicable
- tool name and command when available
- elapsed time and last observed event sequence/time
- watchdog threshold that fired

Exit criteria:

- Event type and schema live in the shared domain contract.
- Event is persisted before any interrupt/failure transition.
- Timeline/CLI rendering exposes a concise diagnostic instead of a silent status
  change.

## Phase 3: Implement server-owned watchdog sweep

**Goal:** Reconcile stalled active turns from the server, not from routes or the
daemon.

Add a server lifecycle module that runs from the existing periodic sweep loop.
It should:

- query active turns from stored events
- compute last meaningful provider progress per active turn
- detect raw tool calls without matching command starts
- detect started command items without progress or completion
- request provider interruption through the existing runtime/daemon boundary
- persist the diagnostic event and transition thread state according to the
  Phase 1 policy

Use targeted SQL queries. Do not load all thread events and filter in JS for the
normal sweep path.

Exit criteria:

- Active turn detection is based on `turn/started` without a matching
  `turn/completed`.
- The sweep is idempotent and does not emit duplicate diagnostics for the same
  stuck turn/call.
- The sweep works after server restart using only durable DB state.
- Host-daemon command TTL sweep remains separate and unchanged in ownership.

## Phase 4: Cover the incident shape in tests

**Goal:** Ensure this exact class of failure cannot regress silently.

Add tests using fake/runtime event data for:

- raw Codex `exec_command` call with no matching `item/started`
- later unrelated command completing successfully while the first raw call is
  still stuck
- active turn with no provider events past the idle threshold
- already-diagnosed stuck turn not emitting duplicate diagnostics on the next
  sweep
- manual interrupt racing with watchdog interrupt

Exit criteria:

- Tests assert persisted events and final thread state, not implementation call
  order.
- Tests use in-memory SQLite with migrations.
- No database mocking.

## Phase 5: Keep CLI timeout as a separate guardrail

**Goal:** Land the CLI HTTP timeout independently so CLI commands cannot hang
forever, without treating it as the product fix.

The current local patch adds a default 60 second fetch timeout to the CLI API
client. That helps commands like `bb thread output`, but it would not have
prevented the 245 minute manager turn because the provider turn was already
inside Codex.

Exit criteria:

- CLI timeout tests pass.
- The change is documented/reviewed as a CLI guardrail, not the provider-turn
  watchdog.
- Timeout duration is easy to tune later if needed.

## Phase 6: Open or patch upstream Codex

**Goal:** Address the upstream runtime behavior that makes pre-begin stalls
invisible.

Open an upstream issue or patch against `openai/codex` with:

- the incident signature: raw `exec_command` emitted, no normalized
  `ExecCommandBegin`, abort output hours later
- code references showing `ExecCommandBegin` is emitted after
  `open_session_with_sandbox`
- code references showing raw tool outputs are drained through `FuturesOrdered`
- probe results showing shell startup delay and silent output are not sufficient
  explanations

Preferred upstream fixes:

- add a timeout around unified exec pre-begin session creation
- emit an earlier "tool dispatch accepted" lifecycle event distinct from
  command process start
- avoid ordered raw output drain blocking later completed tool outputs behind an
  earlier stuck tool, or document that raw outputs are conversation-history
  ordering rather than UI-progress ordering

Exit criteria:

- Upstream report includes enough evidence to reproduce or reason about the
  pre-begin stall class.
- BB does not depend on upstream changes for its own watchdog protection.

## Validation

Automated:

- `pnpm exec turbo run test --filter=@bb/db`
- `pnpm exec turbo run test --filter=@bb/server`
- `pnpm exec turbo run test --filter=@bb/thread-view`
- `pnpm exec turbo run test --filter=@bb/cli -- src/__tests__/client.test.ts`
- `pnpm exec turbo run typecheck --filter=@bb/db --filter=@bb/server --filter=@bb/thread-view --filter=@bb/cli --filter=@bb/server-contract`

Manual:

- Start the standalone server and daemon using `qa/manual-runbook.md`.
- Spawn a Codex thread with a fake or controlled provider event stream that
  emits a raw `exec_command` call and then stalls before command start.
- Confirm the thread transitions out of active state after the configured
  threshold.
- Confirm the timeline and API include the watchdog diagnostic.
- Confirm a normal long-running command with output/progress is not interrupted
  prematurely.
- Confirm manual interrupt still works and does not produce duplicate watchdog
  diagnostics.

## Completion Criteria

This plan is complete when:

- a provider turn cannot remain active indefinitely without progress
- pre-begin tool stalls produce durable, user-visible diagnostics
- the incident class is covered by tests
- CLI request timeout is either landed separately or explicitly deferred
- upstream Codex has been notified or patched for the pre-begin exec stall
  behavior
