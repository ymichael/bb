# Provider Turn Watchdog

> **Status:** PAUSED design notes preserved from thread `thr_cbwy32pzws`.
> This plan is not approved for implementation. Re-triage, phase, and review it
> before using it for implementation work.

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
- stalled provider runtime turn id:
  `019debe2-4b19-76d2-87ad-75502194ecb7`
- BB thread id: `thr_bj3p5vk9py`
- inspected worker BB thread id: `thr_jb5xwguekp`
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
2. BB has no provider-turn watchdog. The server already owns a daemon-command
   TTL sweep for queued host commands, but the provider turn itself can remain
   active indefinitely when the provider stops producing useful events.

Important non-causes already ruled out:

- Raw `function_call_output` is not reliable progress ordering for parallel
  calls. Codex drains raw tool results through an ordered queue, so a fast later
  tool's raw output can be withheld behind an earlier stuck tool.
- Shell startup delay does not explain the missing command start. A probe with
  a sleeping `.zshenv` still emitted normalized `item/started`.
- The BB adapter should not synthesize command starts from raw `function_call`.
  A raw function call means "the model requested a tool," not "the command
  process started."
- `~/.bb-dev/replays` did not contain captures for the incident window. That
  is a known reproducibility gap; Phase 4 must either identify an existing
  replay/fake-provider injection harness or add one before manual validation
  can exercise this incident shape.

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

`@bb/domain` owns watchdog contract types only: the reason enum, diagnostic
event schema, diagnostic discriminated union, and shared provider-runtime
observation schema/type. Product policy lives in the server. Add
`apps/server/src/services/threads/provider-turn-watchdog-policy.ts` with a
typed `providerTurnWatchdogPolicyByReason satisfies
Record<ProviderTurnWatchdogReason, ProviderTurnWatchdogPolicyEntry>`. Each
entry records whether the reason is primary or secondary, its server-owned
threshold source, detector kind, initial action, terminal action,
lost-daemon-result handling, diagnostic event type, and required user-visible
surfaces. Tests must fail on any missing or extra reason key without moving
numeric defaults or detector policy into `@bb/domain`.

The canonical watchdog reasons and server-owned default thresholds are:

### Thresholds

| Case                                                                                                                                                    |       Default | Reason enum                | Outcome                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------: | -------------------------- | -------------------------------------------------------------------------------- |
| Durable raw shell tool dispatch for `exec_command`, `Bash`, or `bash` seen, but no matching `item/started` event for a `commandExecution` item appears. |     60,000 ms | `tool-pre-begin-timeout`   | Persist a watchdog diagnostic, then request a watchdog-owned provider interrupt. |
| A `commandExecution` item has no output/progress/completion since `item/started`, or its latest output/progress is stale.                               |    600,000 ms | `command-progress-timeout` | Persist a watchdog diagnostic, then request a watchdog-owned provider interrupt. |
| A turn is active with no meaningful provider events.                                                                                                    |    900,000 ms | `provider-turn-idle`       | Persist a watchdog diagnostic, then request a watchdog-owned provider interrupt. |
| A turn exceeds maximum wall-clock duration regardless of intermittent low-value events.                                                                 | 21,600,000 ms | `turn-wall-time-timeout`   | Persist a watchdog diagnostic, then request a watchdog-owned provider interrupt. |

Default rationale:

- 60 seconds for pre-begin tool stalls is long enough to tolerate local shell
  startup noise, but short enough that a command that never reaches BB's
  timeline is surfaced quickly.
- 10 minutes for running-command progress avoids interrupting quiet commands
  too aggressively while still bounding a command that emitted no stdout,
  stderr, lifecycle event, or completion after start or after its last progress.
- 15 minutes for provider turn idle is a broader runtime silence signal and is
  intentionally longer than the pre-begin threshold so tool-specific detection
  wins first.
- 6 hours wall-clock is a hard safety cap for active turns, not a normal
  progress signal.

### Durable Pre-Begin Signal

`tool-pre-begin-timeout` requires a durable raw tool-dispatch source. Current
Codex shell `rawResponseItem/completed` `function_call` events and
`local_shell_call` raw items are consumed by
`packages/agent-runtime/src/codex/adapter.ts` into in-memory command-output
repair state and `translateEvent` returns no persisted events for the raw
dispatch. The watchdog must not depend on that in-memory adapter state.

Add a durable `provider_turn_raw_tool_dispatches` table before enabling the
pre-begin detector. This requires an explicit non-`ThreadEvent` observation
transport; do not pretend raw shell dispatches are thread events. The owner path
is:

- `packages/domain/src/provider-runtime-observations.ts` defines two shared
  contract-only observation shapes. The adapter/runtime-emitted
  `ProviderAdapterObservation` is provider-scoped, starts with
  `kind: "raw-tool-dispatch"`, and has required fields `providerId`,
  `providerThreadId`, `providerTurnId`, `providerRawCallId`, `toolName`,
  `commandText`, `commandTextTruncated`, and `observedAt`.
  `providerRawCallId` is `string | null` because Codex
  `local_shell_call.call_id` is nullable. Adapter-level observations must not
  include BB `threadId` or daemon observation sequence; Codex raw
  `function_call` and `local_shell_call` payloads only know the provider thread
  at this point.
- The daemon-to-server transported `ProviderRuntimeObservation` wraps or derives
  from `ProviderAdapterObservation` after identity and sequencing are known.
  The host-daemon envelope owns required `daemonObservationSequence` as an
  envelope field. The transported/server observation has required non-null
  `rawCallId`, derived from `providerRawCallId` when non-null, otherwise from a
  deterministic key such as `local_shell_call:${daemonObservationSequence}`.
  `@bb/agent-runtime`, `@bb/host-daemon-contract`, and server ingestion all
  import these shared schemas so the transport does not depend on
  `@bb/agent-runtime` and does not duplicate parser logic.
- `packages/agent-runtime/src/provider-adapter.ts` changes the translation
  boundary to return a structured result such as
  `{ threadEvents: ThreadEvent[], observations: ProviderAdapterObservation[] }`
  or an equivalent adjacent observation emitter. Codex emits the
  `raw-tool-dispatch` observation for every raw shell `function_call` whose tool
  name is in `CODEX_SHELL_TOOL_NAMES` (`exec_command`, `Bash`, `bash`) and for
  every Codex `local_shell_call` whose `action.type` is `exec`, before the
  current in-memory command-output repair state consumes that raw event. For
  `local_shell_call`, set `toolName` to `local_shell_call` and build
  `commandText` from `action.command` with the same 4,096-character
  cap/truncation rules used for shell `function_call`.
- Runtime/daemon observation forwarding stamps BB identity through the same
  provider-thread-to-BB-thread identity mapping used for `ThreadEvent`s. If the
  mapping is not known yet, the runtime buffers the observation until identity
  resolution succeeds or drops it with a structured warning; it must not send an
  observation using the provider thread id as BB `threadId`.
- `packages/host-daemon-contract/src/session.ts` adds a daemon-to-server
  observation envelope or batch, parallel to `hostDaemonEventEnvelopeSchema`,
  carrying `environmentId`, resolved BB `threadId`, required
  `daemonObservationSequence`, `createdAt`, and the transported
  `ProviderRuntimeObservation`. This is a contract/schema addition; the daemon
  forwards observations without interpreting watchdog policy beyond deriving
  the non-null transport `rawCallId` from provider id or sequence.
- `apps/server/src/internal/provider-observations.ts` owns ingestion. In the
  same DB transaction that acknowledges the observation envelope, it verifies
  the resolved BB `threadId` still maps to the observation's `providerThreadId`.
  If identity does not resolve, ingestion rejects or buffers the observation and
  records a structured warning rather than persisting under a provider id. Once
  verified, it upserts `provider_turn_raw_tool_dispatches` with at least
  `thread_id`,
  `provider_turn_id`, `provider_thread_id`, non-null `raw_call_id`, `tool_name`,
  `command_text`, `command_text_truncated`, `raw_call_seen_at`, and the daemon
  observation sequence. Raw-observation ingestion immediately looks for already
  persisted `item/started` events for `commandExecution` items in the same
  `thread_id` / `provider_turn_id` by raw call id or provider item id and sets
  nullable `matched_command_item_id` before commit when a match exists.
  `apps/server/src/internal/events.ts` or the stored-event writer performs the
  reverse operation when command starts arrive later: it updates any existing
  raw dispatch row for the same thread/turn/raw call or provider item id in the
  same persisted-event transaction or an idempotent DB helper.

The pre-begin detector queries this durable table for raw dispatches with no
match past the threshold.

### Approval Wait Suppression

Unresolved user or permission waits are not provider stalls. A pending
interaction with status `pending` or `resolving` suppresses all primary
watchdog interruption only when its `turn_id` equals the current active turn id.
Stale unresolved pending interactions from earlier turns must not suppress a
later active turn. `command-progress-timeout` must ignore `commandExecution`
items whose current projection has `approvalStatus: "waiting_for_approval"` or
whose item id is the subject of an unresolved pending interaction for that same
active turn. `provider-turn-idle` and `turn-wall-time-timeout` must not fire
while any unresolved pending interaction exists for the current active turn.

When the pending interaction reaches a terminal status (`resolved`,
`interrupted`, or `expired`), watchdog timing resumes from the terminal
interaction timestamp for provider-idle and wall-time purposes. For a command
approval resolved with an allow decision, command-progress timing resumes from
the later of the original `item/started`, the approval terminal timestamp, and
the last command progress event. For denial, interruption, or expiry, the
waiting item is not treated as a running command until a later non-waiting
`item/started`, output/progress, or completion event proves command execution
continued; any missing terminal event is a separate approval lifecycle bug, not
a command-progress timeout.

### Runtime Configuration

`@bb/domain` owns the reason taxonomy and event/observation contracts. The
server owns default thresholds, meaningful-provider-event allowlist, reason
priority, detector configuration, action policy, and runtime configuration in
`apps/server/src/services/threads/provider-turn-watchdog-policy.ts` and
`apps/server/src/services/threads/provider-turn-watchdog-config.ts`; routes, the
daemon, and the CLI do not tune watchdog policy. Normal server operation uses
the server defaults with the watchdog enabled. Test/dev code may pass explicit
overrides, and production rollout may use server-owned env/config overrides
such as:

- `BB_PROVIDER_TURN_WATCHDOG_ENABLED`
- `BB_PROVIDER_TURN_WATCHDOG_TOOL_PRE_BEGIN_TIMEOUT_MS`
- `BB_PROVIDER_TURN_WATCHDOG_COMMAND_PROGRESS_TIMEOUT_MS`
- `BB_PROVIDER_TURN_WATCHDOG_PROVIDER_IDLE_TIMEOUT_MS`
- `BB_PROVIDER_TURN_WATCHDOG_TURN_WALL_TIME_TIMEOUT_MS`

Overrides are parsed once at the server boundary into an explicit config object
that is passed through the sweep; downstream helpers must not read env vars.

The watchdog diagnostic reason enum is exactly:

- `tool-pre-begin-timeout`
- `command-progress-timeout`
- `provider-turn-idle`
- `turn-wall-time-timeout`
- `watchdog-interrupt-unconfirmed`

The first four reasons are primary stall detections governed by the threshold
table. `watchdog-interrupt-unconfirmed` is a secondary intervention result
emitted only after a watchdog-issued interrupt fails to confirm.

Meaningful provider events are a closed allowlist. Only these provider event
types reset the provider-idle threshold:

- `turn/input/accepted`
- `item/started`
- `item/completed`
- `item/agentMessage/delta`
- `item/commandExecution/outputDelta`
- `item/fileChange/outputDelta`
- `item/reasoning/summaryTextDelta`
- `item/reasoning/textDelta`
- `item/plan/delta`
- `item/mcpToolCall/progress`
- `item/toolCall/progress`
- `turn/plan/updated`
- `turn/diff/updated`
- `provider/error`
- `provider/warning`

Events outside this allowlist, including token/context-window updates,
identity/name/compaction events, raw ordered-drain bookkeeping, unhandled
provider metadata, duplicate events, and no-op keepalives, do not reset the
provider-idle threshold.

### Reason Selection

If multiple primary reasons are eligible for the same active turn in one sweep,
the watchdog chooses exactly one deterministic primary reason and only that
reason may claim `stopRequestedAt` or persist a primary diagnostic. Priority is:

1. `tool-pre-begin-timeout`
2. `command-progress-timeout`
3. `provider-turn-idle`
4. `turn-wall-time-timeout`

Lower-priority primary reasons are suppressed for that sweep. Once any primary
watchdog diagnostic exists for a turn, no later primary reason may emit for the
same turn; only `watchdog-interrupt-unconfirmed` may add a secondary
diagnostic.

### Active Turn And Stop Claim

BB permits at most one active turn per thread. The watchdog's wall-clock cap
applies to that one active BB turn, not to the whole thread lifetime or earlier
completed turns. `stopRequestedAt` is thread-level state, so every watchdog
claim and reissue transaction must re-check that the same `activeTurnId` is still
the active turn before it requests or finalizes interruption. A later sequential
turn must not inherit a stale watchdog claim from an earlier turn.

Diagnostic fields referenced below are defined in Phase 2.

- For the four primary timeout reasons, BB does not mark the thread error
  directly. It uses one immediate DB transaction routed through the existing
  stop lifecycle owner: extract or add a transaction-scoped variant of
  `requestThreadStop` from
  `apps/server/src/services/threads/thread-lifecycle.ts`. The watchdog must not
  hand-roll raw `host_daemon_commands` insertion. The transaction verifies the
  same `activeTurnId`, conditionally claims `stopRequestedAt IS NULL`, upserts
  the stop operation, queues or links the `thread.stop` daemon-command row,
  persists the watchdog diagnostic with that `daemonCommandId`, and commits the
  matching `provider_turn_watchdog_stop_attempts` link. Only after commit does
  the server notify the hub so the daemon can fetch the command. A non-null
  `daemonCommandId` must therefore reference a command row and stop-attempt row
  committed in the same transaction; the plan must not create dangling command
  links. The normal interrupt completion path transitions the turn/thread when
  the daemon result returns.
- Watchdog stop ownership still lives in the server DB, but watchdog-created
  `thread.stop` commands must also carry an expected target so stale commands
  cannot interrupt a later turn before server finalization runs. Extend the
  host-daemon command contract so `thread.stop` has a target discriminator:
  manual/generic stops use the existing whole-thread target, while watchdog
  stops must use
  `{ kind: "provider-turn"; activeTurnId; providerTurnId; stopAttemptId }`.
  `stopAttemptId` references the server-owned
  `provider_turn_watchdog_stop_attempts` row; it is not the source of product
  policy ownership. Host-daemon/runtime must validate that the current active
  BB turn and provider turn still match this target before sending the provider
  interrupt. If either differs, the command returns a typed stale-target/no-op
  result and does not report a confirmed stop. Ownership, pending expiry,
  reissue, daemon-result finalization, and restart reconciliation still use
  `provider_turn_watchdog_stop_attempts`, keyed by `daemon_command_id` and
  linked to `thread_id`, `provider_turn_id`, `active_turn_id`,
  `stop_requested_at`, `primary_diagnostic_event_sequence`, `attempt_number`,
  `issued_at`, and `confirmation_deadline_at`, to distinguish watchdog stops
  from manual stops. A confirmed watchdog stop must never be finalized as
  `reason: "manual-stop"`.
- The existing `markThreadStopRequested` helper is unconditional and is not the
  watchdog claim primitive. Add or refactor a `@bb/db` helper such as
  `claimThreadStopRequestedForWatchdog(db, { threadId, activeTurnId, requestedAt })`
  that performs a conditional update with `stop_requested_at IS NULL` and the
  active-turn predicate in the same immediate transaction. A zero-row update
  means another interrupt path won.
- Repeated detection is deduped by the canonical persisted DB tuple
  `(thread_id, provider_turn_id, reason)`. The event field `providerTurnId` is
  the provider runtime turn id and maps to `provider_turn_id`; `activeTurnId`
  remains the BB `turn/*` event scope id. The same tuple must never emit twice.
  For primary reasons, priority selection also prevents different primary
  diagnostics from being emitted for the same turn.
- Manual interrupt wins if `stopRequestedAt` is already set before the watchdog
  diagnostic transaction begins. The watchdog claims the interrupt in an
  immediate transaction with a conditional update that requires
  `stopRequestedAt IS NULL` and the same active-turn predicate. If the
  conditional update affects zero rows, the watchdog suppresses its diagnostic
  and exits silently. If the watchdog writes first, later manual interrupt
  handling observes the existing stop request, may report the thread as already
  stopping, and must not emit a duplicate watchdog diagnostic or queue a
  duplicate `thread.stop`. The race winner is the transaction that first
  changes `stopRequestedAt` from `NULL` to non-null; a later manual request is
  still accepted as user intent but does not become the lifecycle owner.
- The server's existing daemon-command TTL sweep owns host command retry/error
  state for watchdog-issued `thread.stop` records, but it must not own the
  watchdog unconfirmed-interrupt product policy. Update
  `sweepExpiredCommands` so watchdog-linked `thread.stop` commands may still be
  requeued or marked `state='error'`, but are excluded from the generic
  `transitionThreadsToError` path and from generic expired-command side effects.
  `apps/server/src/services/system/periodic-sweeps.ts` must partition
  `expired.erroredCommandIds` immediately after `sweepExpiredCommands` with a
  DB helper such as
  `splitWatchdogLinkedExpiredThreadStopCommandIds(db, commandIds)`: generic ids
  go to `handleExpiredCommands`, while watchdog-linked `thread.stop` ids are
  passed to the provider watchdog reconciler. Add a defensive check in
  `apps/server/src/services/hosts/expired-commands.ts` so a watchdog-linked
  `thread.stop` can never reach the generic `thread.stop` command-result owner.
  The watchdog observes the linked `thread.stop` command state, treats
  `host_daemon_commands.state IN ('pending', 'fetched')` as active only while
  the linked command is still inside the current 120,000 ms confirmation window,
  and does not reissue while such an active linked command exists. Existing TTL
  behavior only expires
  `state='fetched'` commands, so extend `sweepExpiredCommands` or an adjacent
  server-owned command lifecycle sweep to expire watchdog-linked
  `state='pending'` `thread.stop` commands once
  `createdAt + WATCHDOG_STOP_PENDING_TTL_MS` is reached. The v1 default is
  `WATCHDOG_STOP_PENDING_TTL_MS = 120,000`. Expired pending watchdog stops are
  marked `state='error'` with a diagnostic result payload and are excluded from
  generic thread error transition and `handleExpiredCommands` generic
  `thread.stop` failure handling. A pending or fetched command past its
  confirmation window must not suppress reissue or forced-error escalation. A
  linked stop command with `state='error'` after pending expiry or TTL retry is
  terminal command evidence for the watchdog's unconfirmed-interrupt decision;
  the watchdog then owns appending `watchdog-interrupt-unconfirmed`, terminal
  `turn/completed`, `system/error`, and the thread status transition.
- The watchdog may read `host_daemon_commands` rows and command states to make
  confirmation decisions, but it must not mutate command queue lifecycle. Only
  the daemon-command TTL sweep and command-result owners update
  `host_daemon_commands.state`, retry count, fetched time, completion time, or
  result payload.
- Server API and app timelines show the watchdog diagnostic before any
  interrupt or error transition, including reason, threshold, elapsed time, and
  last observed provider event. Dedicated CLI rendering remains out of scope.

### Recovery And Reissue

- Lost daemon result handling: if the watchdog-issued `thread.stop` produces no
  `turn/completed` within 120,000 ms, the watchdog re-checks that the same
  active BB turn is still active and reissues `thread.stop` once. If
  confirmation is still missing after another 120,000 ms, the watchdog
  re-checks the same active-turn predicate before it persists
  `watchdog-interrupt-unconfirmed` and forces a `system/error` transition. The
  forced-error path writes `watchdog-interrupt-unconfirmed`, appends terminal
  `turn/completed` for the same `activeTurnId` with `status: "failed"` and an
  error payload, appends `system/error`, and transitions thread status to
  `error` in one transaction, so later active turn queries cannot re-match the
  watchdog-terminated turn. If a crash leaves
  `watchdog-interrupt-unconfirmed` persisted while the same turn is still
  active, restart recovery re-runs the same forced-error transaction without
  emitting a duplicate unconfirmed diagnostic. If the turn completed or the
  thread is no longer active, the watchdog exits silently.
- Normal primary diagnostic writes must atomically commit a non-null
  `daemonCommandId` with the linked `thread.stop` row. If recovery observes a
  legacy or partial diagnostics-table row with `daemon_command_id IS NULL`,
  treat the stop as not issued: if the same turn is still active, queue
  `thread.stop` once without emitting a duplicate primary diagnostic.
- On server startup, active turns are re-evaluated from durable events. An
  in-flight unconfirmed watchdog interrupt is treated as not yet confirmed and
  is eligible for the same reissue/error policy using persisted diagnostics and
  daemon-command records.
- Migration does not backfill diagnostics or immediately mutate existing active
  threads. After the watchdog migration is installed and the server starts with
  the watchdog enabled, currently active turns are evaluated by the first normal
  sweeps after `WATCHDOG_RESTART_GRACE_MS`. Turns already past a threshold are
  treated the same as any other candidate, subject to the page budget,
  deterministic reason priority, and `(thread_id, provider_turn_id, reason)`
  dedup. There is no grandfathering in v1; staged rollout must use the
  server-owned enable flag or threshold overrides.
- Restart escalation has a grace window. Define
  `WATCHDOG_RESTART_GRACE_MS = 60,000` in the server watchdog module. After
  server startup, the watchdog may recover missing stop issuance immediately,
  but it must not reissue or force the unconfirmed-interrupt error path until
  server uptime is at least this grace value and at least one sweep has observed
  the linked command state. This avoids immediate forced errors after a server
  outage longer than the 120-second confirmation window.
- The reissue confirmation clock uses the most recent persisted linked
  watchdog `thread.stop` command row. That row's `createdAt` starts the current
  120-second confirmation window, and the injected sweep `now` computes elapsed
  time. If no command is linked, recovery uses the primary diagnostic `firedAt`
  only to identify the stale recovery shape before queuing the missing stop.
  Tests and manual validation must use an injectable clock.

Exit criteria:

- Thresholds have named constants, documented rationale, and runtime config
  parsing owned by the server.
- `providerTurnWatchdogPolicyByReason` exists in
  `apps/server/src/services/threads/provider-turn-watchdog-policy.ts`, uses
  `satisfies Record<ProviderTurnWatchdogReason, ...>`, and has exact key
  coverage for every watchdog reason.
- Policy documentation enumerates exactly the four primary thresholds above
  with numeric default values and the `reason` enum value each maps to.
- Policy artifacts enumerate each reason's detector kind, diagnostic event,
  initial action, terminal action, lost-daemon-result handling, and
  user-visible surfaces.
- The policy distinguishes pre-begin tool stalls from running-command stalls by
  using separate detection queries, thresholds, and reason values.
- `tool-pre-begin-timeout` has a durable raw-dispatch source and does not rely
  on Codex adapter in-memory repair state.
- The policy does not use `thread.status` as a hidden queue/lifecycle ladder.
- Lost daemon results, server restart reconciliation, repeated detection
  deduplication, and manual-vs-watchdog races have explicit tests in Phase 4.

## Phase 2: Add durable diagnostics

**Goal:** Make future incidents explainable from DB events alone.

Add a thread-scoped `system/provider-turn-watchdog` event to `@bb/domain` by
extending `systemEventTypeValues` in
`packages/domain/src/thread-events.ts`, adding a dedicated event data schema
and matching `ThreadEventDataByType` entry there, adding the event branch to
the `unscopedSystemEventSchema` union that builds `systemEventSchema` in
`packages/domain/src/provider-event.ts`, and updating the exhaustive
`threadEventScopeDefinitionByType` map in
`packages/domain/src/thread-event-scope.ts`. It is a server-authored system
event with concrete `thread` scope policy, not a provider-originated event and
not a turn-scoped provider event. The `unscopedSystemEventSchema` name is the
existing parser branch for server/system events; it does not define the event
scope policy, which remains `thread`. Because existing event schemas are
flattened through `.merge()`, the watchdog branch may carry `providerId` and
`providerThreadId` as diagnostic payload fields on the server-authored event.
Those fields identify the provider context being diagnosed; they do not make
the event provider-originated. Update the `provider-event.ts` parser comment so
it no longer states an absolute "system events do not carry
`providerThreadId`" invariant that the watchdog diagnostic intentionally
breaks. The event data schema serializes the Phase 1 reason taxonomy by
importing or reusing `ProviderTurnWatchdogReason` from
`packages/domain/src/provider-turn-watchdog.ts`; it must not redefine reason
strings in a second location. Threshold constants and the
`providerTurnWatchdogPolicyByReason` map are server policy artifacts imported
from `apps/server/src/services/threads/provider-turn-watchdog-policy.ts` by the
sweep/config code, not by the domain event schema. The schema carries enough
structured data to debug without reading raw provider logs.

Add a watchdog-specific thread interruption reason to
`systemThreadInterruptedReasonValues`, for example `provider-watchdog-stop`.
Update interruption schemas, `nextStatusForInterruptedThread`, and thread-view
rendering so a confirmed watchdog stop is durable as watchdog-owned history and
does not render as "Stopped manually". `nextStatusForInterruptedThread` maps
`provider-watchdog-stop` to `error`, because a watchdog stop is a failure
intervention rather than a user-requested idle transition.

Dedup is enforced durably in the database, not only by application checks. Add
a migration for `provider_turn_watchdog_diagnostics` with a unique index on
`(thread_id, provider_turn_id, reason)` and a required `event_sequence` linking
the diagnostic row to the appended `system/provider-turn-watchdog` event. The
same migration must add a DB-enforced primary slot, preferably a partial unique
index on `(thread_id, provider_turn_id)` for rows whose `reason` is one of the
four primary reasons. If SQLite compatibility requires a different shape, use a
`provider_turn_watchdog_primary_claims` table with unique
`(thread_id, provider_turn_id)` instead. The primary-slot claim occurs in the
same transaction as the diagnostic row.

The claim transaction generates a stop-attempt id, conditionally claims stop,
queues/links the `thread.stop` command row with a watchdog provider-turn target
containing that stop-attempt id, appends the diagnostic event with non-null
`daemonCommandId`, inserts the diagnostic row, inserts the stop-attempt link,
and claims the primary slot in the same immediate transaction. A unique conflict
rolls back the entire transaction, including the stop claim, command row,
stop-attempt link, diagnostic row, diagnostic event, and primary-slot claim, and
suppresses a duplicate diagnostic. The migration must document
`daemon_command_id` nullability explicitly: all new write helpers require a
non-null command id, and nullable DB storage is allowed only for the
legacy/partial recovery shape where a primary diagnostic exists but no stop
command was linked.

The same migration adds `provider_turn_raw_tool_dispatches` for the durable
pre-begin source signal. It has a uniqueness constraint on
`(thread_id, provider_turn_id, raw_call_id)`, a uniqueness constraint on
`(thread_id, daemon_observation_sequence)`, and indexes that support querying
unmatched raw shell dispatches by active turn and `raw_call_seen_at`. It stores
the daemon observation sequence from the non-`ThreadEvent`
daemon-to-server `ProviderRuntimeObservation` envelope so server ingestion is
idempotent and auditable. Persisted `raw_call_id` is always non-null; only the
pre-transport `ProviderAdapterObservation.providerRawCallId` may be null.

The migration also adds `provider_turn_watchdog_stop_attempts` as the durable
ownership/link table for watchdog-issued stops. Required columns are
`id`, `thread_id`, `provider_turn_id`, `active_turn_id`, `stop_requested_at`,
`primary_diagnostic_event_sequence`, `daemon_command_id`, `attempt_number`,
`issued_at`, and `confirmation_deadline_at`. `daemon_command_id` is unique and
foreign-keyed to `host_daemon_commands.id`; `(thread_id, provider_turn_id,
attempt_number)` is unique for deterministic reissue tracking. Pending expiry,
confirmed finalization, and restart reconciliation identify watchdog stops only
through this table, never by parsing the daemon command payload alone. The
watchdog `thread.stop` command target carries this row's `id` as
`stopAttemptId` so the daemon/runtime can reject stale turn targets before
provider interruption while server policy ownership remains DB-backed.
`stop_requested_at` records the thread-level claim value written by the
watchdog transaction so later finalization can clear only the watchdog-owned
claim it is retiring.
Attempt `0` is the primary stop issued with the primary diagnostic; attempt `1`
is the single allowed reissue for the same
`(thread_id, provider_turn_id, active_turn_id,
primary_diagnostic_event_sequence)`. The attempt row is inserted in the same
transaction as the command row and diagnostic event; because it stores the
diagnostic event sequence, its insert may occur after the event append inside
that transaction, but no committed state may expose a non-null diagnostic
`daemonCommandId` without the matching stop-attempt link.

The event field `providerTurnId` maps to the diagnostics table column
`provider_turn_id`. Do not use `turnId` in watchdog event data because
stored-event rehydration reserves that key for scope metadata.

Required common fields for every variant:

- `reason`
- `providerId`
- `providerThreadId`
- `providerTurnId` (provider runtime turn id)
- `bbThreadId` (`thr_*`)
- `activeTurnId` (the BB `turn/*` event scope id)
- `daemonCommandId`
- `thresholdMs`
- `elapsedMs`
- `firedAt`
- `decisionBasis`

Nullable-required common fields, where `null` has the stated semantic meaning:

- `lastProviderEventSeq` (`null` means no provider event has been observed)
- `lastProviderEventAt` (`null` means no provider event has been observed)

`lastProviderEventSeq` and `lastProviderEventAt` describe the latest provider
event of any kind observed for the turn. `lastProviderEventSeq` is the BB
`events.sequence` value, which is per BB thread. It is not a provider-native or
Codex-internal sequence. If provider-native ordering is needed later, add a
separate explicitly named field such as `providerNativeSeq`.

Meaningful provider progress fields in `decisionBasis` describe only events
from the closed allowlist in Phase 1 that reset the provider-idle threshold.
When both latest-provider and meaningful-provider fields are non-null,
meaningful provider progress must not be newer than the latest provider event.

The event schema is discriminated by `reason`:

- Primary reasons (`tool-pre-begin-timeout`, `command-progress-timeout`,
  `provider-turn-idle`, `turn-wall-time-timeout`) must not carry
  `reissueCount` and must carry a non-null `daemonCommandId` because the
  primary claim transaction queues and links `thread.stop` before commit.
- `watchdog-interrupt-unconfirmed` must carry required `reissueCount` and a
  non-null `daemonCommandId` for the latest attempted stop command.
- The normal write path never emits a domain event with
  `daemonCommandId: null`. If a recovery path encounters a legacy or partial DB
  diagnostic row with `daemon_command_id IS NULL`, it treats the stop as not
  issued and queues one through the stop lifecycle owner without appending a
  duplicate primary diagnostic.
- For `watchdog-interrupt-unconfirmed`, `thresholdMs` is the 120,000 ms
  confirmation window and `elapsedMs` is measured from the most recent linked
  watchdog `thread.stop` command.

`decisionBasis` is a closed discriminated union with no extra fields. Fields
that are meaningful only for one reason live inside that reason's variant, not
as nullable common fields:

- `tool-pre-begin-timeout`: `rawCallId`, `rawCallSeenAt`,
  `toolName`, `commandStartDeadlineAt`, `commandText`
- `command-progress-timeout`: discriminated by `commandState`.
  `started-no-progress` carries `commandItemId`, `commandStartedAt`,
  `lastCommandProgressAt: null`, and `commandText`; `null` means no command
  progress has ever been observed and the deadline is
  `commandStartedAt + thresholdMs`. `progress-stale` carries `commandItemId`,
  `commandStartedAt`, non-null `lastCommandProgressAt`, and `commandText`; the
  deadline is `lastCommandProgressAt + thresholdMs`.
- `provider-turn-idle`: `activeTurnStartedAt`,
  `lastMeaningfulProviderEventSeq`, `lastMeaningfulProviderEventAt`
- `turn-wall-time-timeout`: `activeTurnStartedAt`
- `watchdog-interrupt-unconfirmed`: `primaryReason`, `primaryDiagnosticSeq`,
  `latestDaemonCommandState`, `firstStopIssuedAt`, `lastStopIssuedAt`

`commandText` is a nullable-required field only inside the two command-related
`decisionBasis` variants. `null` means no command text was identified. A
non-null value is `{ value, truncated }`, where `value` is capped at 4,096
characters and `truncated` states whether the original text was longer.

For `tool-pre-begin-timeout`, `rawCallId` is required and non-null because the
detector starts from a raw provider tool/function call. It is a stable BB
dispatch key derived during host-daemon/server transport: Codex
`function_call.call_id` and non-null `local_shell_call.call_id` are used
directly; `local_shell_call.call_id=null` uses the deterministic
daemon-observation key defined in Phase 1. Persisted diagnostics never have
`rawCallId=null`. `toolName` is nullable-required inside that variant only;
`null` means the raw call did not expose a parseable tool name. Non-tool
variants do not carry `rawCallId` or `toolName`.

`commandState` is a watchdog command progress enum owned by `@bb/domain` with
exact values `started-no-progress | progress-stale`, not an arbitrary string.
`latestDaemonCommandState` uses one shared host daemon command state enum.
Because `@bb/host-daemon-contract` already depends on `@bb/domain`, define the
canonical `hostDaemonCommandStateValues` in `@bb/domain` and have `@bb/db`,
`@bb/host-daemon-contract`, and server code import or derive from that shared
definition rather than duplicating `pending | fetched | success | error`
strings.

For `provider-turn-idle`, `lastMeaningfulProviderEventSeq` and
`lastMeaningfulProviderEventAt` are nullable-required; `null` means no
meaningful provider event has been observed since the active turn started.

For `tool-pre-begin-timeout`,
`commandStartDeadlineAt = rawCallSeenAt + thresholdMs`.

No optional fields are allowed in the event data. Any future optional field must
answer "why does absence have its own semantic meaning?" during review.

Exit criteria:

- Event type, event data schema, reason enum, diagnostic discriminated union,
  shared provider-runtime observation schema, and `decisionBasis` union live in
  `@bb/domain`; numeric thresholds and detector/action policy do not.
- The event is explicitly modeled as a thread-scoped system event.
- `systemEventTypeValues`, a dedicated event data schema/type, and
  `ThreadEventDataByType` all include `system/provider-turn-watchdog`.
- `packages/domain/src/provider-event.ts` adds a
  `system/provider-turn-watchdog` branch to `unscopedSystemEventSchema`, so
  `systemEventSchema` and `threadEventSchema` parse the event at runtime.
- The `provider-event.ts` system-event parser comment is updated to distinguish
  provider-originated envelope fields from watchdog diagnostic payload fields;
  `providerId` and `providerThreadId` remain required watchdog diagnostic data.
- `threadEventScopeDefinitionByType` in
  `packages/domain/src/thread-event-scope.ts` includes
  `system/provider-turn-watchdog` with `policy: "thread"` and rationale that
  the diagnostic records server watchdog policy for the whole thread while
  carrying `activeTurnId` and `providerTurnId` as diagnostic data.
- `systemThreadInterruptedReasonValues` includes a watchdog-specific stop
  reason and thread-view renders it without saying "manual".
- The event schema imports or reuses the Phase 1 reason taxonomy instead of
  duplicating reason strings. Server policy imports the same reason enum for
  exhaustive policy coverage.
- A DB migration creates `provider_turn_watchdog_diagnostics`, its unique
  `(thread_id, provider_turn_id, reason)` index, the event-sequence link, and
  any active-turn/progress indexes required by Phase 3.
- The same migration creates a DB-enforced primary diagnostic slot for the four
  primary reasons, either as a partial unique index on
  `(thread_id, provider_turn_id)` or as
  `provider_turn_watchdog_primary_claims` with unique
  `(thread_id, provider_turn_id)`. The primary-slot claim is part of the same
  transaction as diagnostic event append, diagnostic row insert, stop claim,
  command row insert, and stop-attempt link insert.
- The migration creates `provider_turn_raw_tool_dispatches` and its
  pre-begin detector indexes.
- `@bb/domain` owns the shared `ProviderAdapterObservation` and
  `ProviderRuntimeObservation` schema/types. `@bb/agent-runtime` emits adapter
  observations that may carry `providerRawCallId=null`; `@bb/host-daemon-contract`
  transports runtime observations outside `threadEventSchema` with required
  `daemonObservationSequence` and non-null `rawCallId`; server ingestion parses
  the same exported schema before persisting raw tool dispatch observations into
  `provider_turn_raw_tool_dispatches` transactionally.
- The migration creates `provider_turn_watchdog_stop_attempts`, including the
  unique `daemon_command_id` link and attempt-number uniqueness.
- `@bb/host-daemon-contract` extends `thread.stop` with a target discriminator
  and typed result. Watchdog-created stops carry
  `{ kind: "provider-turn"; activeTurnId; providerTurnId; stopAttemptId }`.
  Every provider-turn stop result echoes `activeTurnId`, `providerTurnId`, and
  `stopAttemptId`. Provider-turn stop results distinguish at least
  `{ status: "interrupted" }`, meaning the provider interruption was applied or
  otherwise proven, `{ status: "interrupt-sent" }`, meaning the target matched
  and an interrupt request was sent but not proven, and
  `{ status: "stale-target" }`, meaning the target no longer matched and no
  provider interrupt was sent. A generic `{ status: "noop-no-active-turn" }`
  result is allowed for non-watchdog/no-active-turn cases if the existing
  lifecycle owner needs it. Unproven interrupt-sent and stale-target/no-op
  results are distinguishable from confirmed interrupt results.
- `@bb/server-contract` owns a public timeline row schema for watchdog
  diagnostics in `packages/server-contract/src/thread-timeline.ts`.
- `@bb/thread-view` maps the domain event to the server-contract timeline row
  in `packages/thread-view/src/build-thread-timeline.ts`.
- `@bb/ui-core` renders the watchdog timeline row in the shared thread
  timeline components consumed by `@bb/app`.
- Event is persisted before any interrupt/failure transition.
- User-visible surfaces are exactly: the persisted domain event, the
  `@bb/server-contract` timeline row, the server API thread timeline response,
  the `@bb/thread-view` mapping, the shared `@bb/ui-core` timeline row, and
  the app thread timeline rendering. The row exposes reason, threshold, and
  elapsed time without expansion.
- No dedicated `apps/cli/**` rendering work is part of this branch; the CLI may
  only benefit if existing generic timeline rendering already consumes the
  server-contract row.

## Phase 3: Implement server-owned watchdog sweep

**Goal:** Reconcile stalled active turns from the server, not from routes or the
daemon.

Add `apps/server/src/services/threads/provider-turn-watchdog-sweep.ts` and
register it from `runPeriodicSweeps` in
`apps/server/src/services/system/periodic-sweeps.ts`. It should:

- query active turns from stored events and durable raw dispatch rows through a
  new `@bb/db` helper:
  `listProviderTurnWatchdogSweepCandidates(db, { now, limit, afterThreadId })`
- page candidates by stable thread id order with `limit` and `afterThreadId`;
  the normal sweep must never load every active thread or every event
- process pages with defaults `limit=100`, `maxPages=10`, and `maxSweepMs=500`;
  stop cleanly when a page returns fewer than `limit`, no candidates remain,
  `maxPages` is reached, or elapsed sweep time reaches `maxSweepMs`; the next
  periodic sweep starts fresh and no cursor is persisted unless a later scale
  review requires it
- use indexes that support the candidate page and active-turn lookups, adding
  explicit indexes if needed, such as `threads_watchdog_active_idx` on active
  thread filtering/page order and `events_thread_turn_type_sequence_idx` on
  `(thread_id, turn_id, type, sequence)`
- compute last meaningful provider/tool/command progress for the full candidate
  page with one aggregate query per page, not per-turn N+1 queries
- detect raw shell tool dispatch rows without matching `item/started` events
  for `commandExecution` items
- detect `commandExecution` items in `started-no-progress` state when
  `commandStartedAt + thresholdMs <= now`, and in `progress-stale` state when
  `lastCommandProgressAt + thresholdMs <= now`; each command progress event
  resets the command-specific clock
- exclude active turns with unresolved pending interactions from primary
  watchdog interruption, and exclude `commandExecution` items that are still
  waiting for approval from command-progress eligibility
- accept an injectable clock and test/dev threshold overrides while using the
  server policy defaults in normal operation
- request provider interruption by reusing the existing `thread.stop`
  lifecycle owner through `requestThreadStop` or an extracted
  transaction-scoped variant; confirmed watchdog stop finalization must accept
  the watchdog-specific interruption reason instead of hardcoding
  `manual-stop`
- apply the event and thread-state sequences below

The watchdog event and state sequences are:

- Primary detection: in one immediate transaction, verify the active turn,
  generate the stop-attempt id, conditionally claim `stopRequestedAt`, upsert
  the stop operation, and queue/link the `thread.stop` daemon command through
  the stop lifecycle owner with target
  `{ kind: "provider-turn"; activeTurnId; providerTurnId; stopAttemptId }` to
  obtain a non-null `daemonCommandId`. Then append the thread-scoped
  `system/provider-turn-watchdog` diagnostic event with `threadScope()`,
  containing that
  `daemonCommandId`, insert the linked `provider_turn_watchdog_diagnostics`
  row, and insert `provider_turn_watchdog_stop_attempts` attempt 0 with the
  same `daemonCommandId`, `activeTurnId`, provider turn id, primary diagnostic
  event sequence, `stopRequestedAt` claim value, and confirmation deadline. Do
  not append `turn/completed`, do not append `system/error`, and do not
  transition `thread.status`. Any dedup
  conflict rolls back the whole transaction, including the claim, command,
  diagnostic, and stop-attempt link.
- Confirmed interrupt result: when the daemon reports
  `{ status: "interrupted" }` for the watchdog-issued `thread.stop`, use a
  watchdog-aware variant of the existing stop finalization path. It first joins
  the daemon command id to `provider_turn_watchdog_stop_attempts` and verifies
  that the result's `activeTurnId` / provider turn id match the recorded target.
  If the recorded turn still has no `turn/completed`, append terminal
  `turn/completed` for that turn with `status: "interrupted"`. If the daemon
  flushed an already-persisted `turn/completed` for the same target turn before
  reporting command success, use that terminal event as provider interrupt
  terminal evidence only when its status/error semantics prove interruption or
  the typed stop result explicitly identifies it as the interrupt terminal
  event. Do not append a duplicate `turn/completed`. In both proven cases,
  append `system/thread/interrupted` with `reason: "provider-watchdog-stop"` and
  transition thread status to `error` through the explicit
  `nextStatusForInterruptedThread` policy for that reason.
- Interrupt-sent result: `{ status: "interrupt-sent" }` is nonterminal and does
  not by itself confirm interruption. If it is paired with an already-persisted
  interrupted terminal event for the same target turn, handle it through the
  confirmed interrupt path above. If it is followed by normal
  `turn/completed`, reconcile as no-interrupt/normal completion and do not
  append `provider-watchdog-stop` or transition the thread to error. If it has
  no terminal interruption proof, keep the stop attempt in the
  unconfirmed-interrupt/reissue path and continue the confirmation clock.
- Stop operation retirement: in confirmed-interrupt and no-interrupt
  finalization, completing the stop operation and clearing the thread-level
  `stopRequestedAt` claim are allowed only when ownership/currentness checks
  prove they are the watchdog-owned operation and claim being retired: the
  daemon command id joins to a `provider_turn_watchdog_stop_attempts` row for
  the recorded
  `activeTurnId` / provider turn id, the active stop operation still references
  that watchdog-linked command or a later watchdog reissue for the same
  diagnostic, and the thread's current `stopRequestedAt` equals the
  stop-attempt `stop_requested_at` claim value. It must not call
  `finalizeStoppedThread` in a way that emits `reason: "manual-stop"`.
- No-interrupt result: if the typed result says no provider interrupt was sent
  (`stale-target` or watchdog-equivalent no-op), or stop-attempt bookkeeping
  proves the target turn completed normally before daemon/runtime applied the
  interrupt, retire the watchdog-linked command evidence and exit without
  appending `turn/completed`, `system/thread/interrupted`,
  `provider-watchdog-stop`, `system/error`, or an error transition. Complete or
  retire the watchdog-owned stop operation, clear `stopRequestedAt`, and mark
  the stop-attempt bookkeeping resolved only when the same ownership/currentness
  checks above pass. If any check fails, do not complete the active stop
  operation or clear `stopRequestedAt`; leave both for the current manual or
  lifecycle owner.
- Stale target result: when the daemon/runtime returns the typed
  stale-target/no-op result for a watchdog provider-turn stop, the server joins
  the command id to `provider_turn_watchdog_stop_attempts` and reconciles the
  recorded turn. If that turn already completed or a different turn is now
  active, retire the stale watchdog stop attempt and clear the watchdog-owned
  `stopRequestedAt` claim only when the same ownership/currentness checks used
  by no-interrupt finalization pass. Do not append `turn/completed`,
  `system/thread/interrupted`, `provider-watchdog-stop`, `system/error`, or a
  thread status transition for the stale result.
- Unconfirmed stop: after the configured reissue window and active-turn
  rechecks, write `watchdog-interrupt-unconfirmed`, append terminal
  `turn/completed` for the same `activeTurnId` with `status: "failed"` and an
  error payload, append `system/error`, and transition `thread.status` to
  `error` in one transaction.
- Restart mid-interrupt: after startup grace, derive state from persisted
  diagnostics rows, linked daemon commands, and `turn/completed` events. If a
  primary diagnostic exists with an active linked command and stop-attempt row,
  continue the confirmation clock from the most recent stop attempt. If the
  linked command is terminal `error`, run the unconfirmed-stop sequence. If no
  linked command exists only because of a legacy/partial null link, queue one
  stop through the stop lifecycle owner and create the missing stop-attempt link
  without appending a duplicate primary diagnostic.

The watchdog must commit the diagnostic, conditional stop claim, stop operation,
command row, and stop-attempt link before notifying the hub that work is
available for the daemon. A crash before commit leaves no claim; a crash after
commit leaves the diagnostic, linked command row, and stop-attempt row. The
daemon/runtime performs target-staleness validation for watchdog stop commands
but owns no watchdog product policy: if the command target is
`provider-turn`, it verifies the current active BB turn and provider turn match
`activeTurnId` and `providerTurnId` before sending the provider interrupt. A
mismatch returns the typed stale-target/no-op command result for server
reconciliation and never interrupts the currently active turn.

Use targeted SQL queries. Do not load all thread events and filter in JS for the
normal sweep path.

Exit criteria:

- Active turn detection is based on `turn/started` without a matching
  `turn/completed`.
- Candidate detection is exposed by
  `listProviderTurnWatchdogSweepCandidates(db, { now, limit, afterThreadId })`
  with documented pagination and query-plan expectations.
- Pre-begin candidate detection reads `provider_turn_raw_tool_dispatches` and
  has no dependency on Codex adapter in-memory repair state.
- A durable raw-observation transport exists from `@bb/agent-runtime` through
  `@bb/host-daemon-contract` to server ingestion using the shared
  `@bb/domain` observation schema; raw dispatch rows are produced without
  encoding raw provider observations as `ThreadEvent`s, and provider thread ids
  are resolved to BB thread ids before server persistence.
- Active turns with unresolved pending interactions are not eligible for
  primary watchdog interruption only when the pending interaction's `turn_id`
  matches the current active turn; timing resumes from the terminal pending
  interaction timestamp according to Phase 1.
- A conditional `@bb/db` stop-claim helper exists for watchdog use; the
  watchdog does not call unconditional `markThreadStopRequested` directly.
- The sweep loop has a documented stop signal and per-cycle budget.
- Last meaningful progress is computed with page-level aggregate queries, not
  per-candidate scans.
- The sweep is idempotent through the DB-enforced
  `(thread_id, provider_turn_id, reason)` tuple and the Phase 1 rule that only
  one primary diagnostic may exist for a provider turn.
- The sweep works after server restart using only durable DB state.
- The server's existing daemon-command TTL sweep (`sweepExpiredCommands`)
  remains a separate sweep with separate ownership; the watchdog does not
  subsume it. The TTL sweep is updated so watchdog-linked `thread.stop`
  commands are exempt from generic `transitionThreadsToError` and generic
  expired-command `thread.stop` failure side effects; watchdog-owned forced
  error is the only product transition for an unconfirmed watchdog stop.
- Watchdog-linked pending `thread.stop` commands have explicit pending expiry
  semantics and cannot suppress reissue or forced-error escalation after the
  confirmation window.
- The `watchdog-interrupt-unconfirmed` path reissues at most once, re-checks
  active-turn state before each reissue and before forced error, and forces a
  `system/error` transition only for the same still-active turn.
- The forced-error path appends terminal `turn/completed`, appends
  `system/error`, and transitions the thread in one transaction.
- Confirmed watchdog stops append `system/thread/interrupted` with the
  watchdog-specific reason and never persist `manual-stop`.
- Non-null `daemonCommandId` values are created only with a command row in the
  same transaction; restart recovery handles only legacy/partial nullable
  diagnostics-table links without creating duplicate primary diagnostics.

## Phase 4: Cover the incident shape in tests

**Goal:** Ensure this exact class of failure cannot regress silently.

Add tests using fake/runtime event data grouped by scenario. The test seam is
the persisted-event and daemon-command boundary: inject thread/provider events
with DB/event helpers or replay-capture fixtures, and create daemon command
rows/results through DB helpers. Do not stub the Codex adapter, server
lifecycle internals, or host-daemon internals.

Detection:

- Raw Codex shell `rawResponseItem/completed` `function_call` for
  `exec_command`, `Bash`, or `bash` creates a durable
  `ProviderAdapterObservation` that is transported by the host-daemon contract
  as a `ProviderRuntimeObservation` outside `threadEventSchema` and ingested
  into a durable
  `provider_turn_raw_tool_dispatches` row with raw call id and capped command
  text.
- Codex `local_shell_call` with `action.type: "exec"` creates the same
  `raw-tool-dispatch` observation, maps `commandText` from `action.command`, and
  applies the same cap/truncation rules. When `call_id` is `null`, the adapter
  emits `providerRawCallId=null` without casts or placeholders; the host-daemon
  envelope supplies `daemonObservationSequence`, server ingestion derives the
  non-null persisted `rawCallId` from that sequence, and duplicate replay still
  dedups by daemon sequence.
- Provider-scoped raw observation with `providerThreadId` / `providerTurnId`
  resolves through the runtime identity mapping and persists under the BB
  `thread_id`; an unresolved identity is rejected or buffered and never
  persisted under the provider thread id.
- Raw Codex shell `function_call` translation that still returns no
  `ThreadEvent`s nevertheless persists the raw dispatch row through the
  observation transport, proving the table producer is not adapter in-memory
  repair state.
- Duplicate raw-observation envelopes with the same daemon sequence or same
  `(thread_id, provider_turn_id, raw_call_id)` do not create duplicate raw
  dispatch rows.
- Raw-before-start: durable raw shell dispatch with no matching
  `item/started` event for a `commandExecution` item emits
  `tool-pre-begin-timeout`.
- Raw-before-start using Codex `local_shell_call` with no later
  `commandExecution` `item/started` persists
  `provider_turn_raw_tool_dispatches` and emits `tool-pre-begin-timeout`.
- Raw-before-start matched by a later `item/started` event for the same
  `commandExecution` item updates `matched_command_item_id` and does not emit
  `tool-pre-begin-timeout`.
- Start-before-raw: raw-observation ingestion sees an already persisted
  `item/started` for the same thread/turn/raw call or provider item id, sets
  `matched_command_item_id` immediately, and does not emit
  `tool-pre-begin-timeout`.
- `commandExecution` item with `item/started` and no stdout, stderr, lifecycle
  progress, or completion past 600,000 ms emitting `command-progress-timeout`.
  The diagnostic has `commandState: "started-no-progress"` and
  `lastCommandProgressAt: null`.
- `commandExecution` item with one stdout/progress event, then no further
  output/progress/completion for `lastCommandProgressAt + 600,000 ms`, emitting
  `command-progress-timeout` with `commandState: "progress-stale"` and non-null
  `lastCommandProgressAt`.
- `commandExecution` item with current
  `approvalStatus: "waiting_for_approval"` and an unresolved pending
  interaction emits no `command-progress-timeout` even after the command-progress
  threshold.
- Active turn with no meaningful provider events past the idle threshold.
- Active turn receiving only non-allowlisted provider events, such as token or
  context-window updates, during the idle window still emitting
  `provider-turn-idle`.
- Active turn exceeding wall-clock threshold emitting `turn-wall-time-timeout`
  using injected clock and test threshold overrides.
- Active turn with an unresolved pending interaction emits no
  `provider-turn-idle` or `turn-wall-time-timeout` even after long test
  thresholds; after approval resolution with an allow decision, timing resumes
  from the terminal pending-interaction timestamp.
- Turn A with a stale unresolved pending interaction does not suppress watchdog
  eligibility for later active/stuck turn B because suppression is scoped to the
  current active turn id.
- Pending interaction denial, interruption, or expiry does not make the waiting
  command item a running-command candidate unless later command progress or a
  non-waiting `item/started` proves execution continued.

Priority and dedup:

- Already-diagnosed stuck turn not emitting duplicate diagnostics on the next
  sweep because the persisted dedup tuple
  `(thread_id, provider_turn_id, reason)` already exists.
- Concurrent attempts to insert the same
  `provider_turn_watchdog_diagnostics` `(thread_id, provider_turn_id, reason)`
  tuple roll back the losing event append so only one diagnostic event remains.
- Concurrent attempts to insert different primary reasons for the same
  `(thread_id, provider_turn_id)` hit the DB-enforced primary slot: only one
  transaction commits, and the loser rolls back its diagnostic event,
  diagnostic row, stop claim, command row, and stop-attempt link.
- Multiple eligible primary reasons in one sweep choosing exactly one
  diagnostic by the Phase 1 priority order.
- A turn that already has one primary diagnostic for reason A, then later
  becomes eligible for a different primary reason B, emits no second primary
  diagnostic and queues no additional watchdog stop attempt.

Interrupt lifecycle:

- Manual interrupt already claimed before watchdog suppresses watchdog
  diagnostic and command issuance through the zero-row conditional claim path.
- Watchdog claim winning before manual interrupt causes the manual path to avoid
  duplicate diagnostics and duplicate `thread.stop` commands while still
  reporting an already-stopping thread to the caller.
- Watchdog interrupt issued, daemon result never confirming, one reissue
  attempted, and `watchdog-interrupt-unconfirmed` persisted before the forced
  `system/error` transition with terminal `turn/completed` for the same
  `activeTurnId`.
- Watchdog interrupt confirmed by the daemon appends
  `system/thread/interrupted` with `reason: "provider-watchdog-stop"`, renders
  as watchdog-owned interruption, and never persists or displays
  `manual-stop` / "Stopped manually".
- Watchdog stop target validates and the daemon/runtime sends the interrupt,
  then daemon flushes the interrupted `turn/completed` before reporting command
  success: server success handling uses the existing terminal event as
  interrupt evidence, appends `system/thread/interrupted` with
  `reason: "provider-watchdog-stop"`, transitions thread status to `error`, and
  does not append a duplicate `turn/completed`.
- Watchdog stop target validates and daemon/runtime returns
  `{ status: "interrupt-sent" }`, then an interrupted terminal event for the
  same target turn is persisted before the next reconciliation: server handling
  treats the interrupted terminal event as proof, appends
  `system/thread/interrupted`, records `provider-watchdog-stop`, transitions to
  error, and does not duplicate `turn/completed`.
- Watchdog stop target validates and daemon/runtime returns
  `{ status: "interrupt-sent" }`, then the provider appends a normal
  `turn/completed`: server handling reconciles as normal completion/no-op,
  appends no `provider-watchdog-stop`, emits no `system/error`, and does not
  transition the thread to error.
- Watchdog claims stop, the provider appends a normal `turn/completed` before
  daemon/runtime applies the interrupt, and the typed result is
  `stale-target`/no-interrupt or stop-attempt bookkeeping proves no interrupt
  was sent. No-interrupt handling then records only completion/bookkeeping: the
  watchdog-owned stop operation is completed or retired, the watchdog-owned
  `stopRequestedAt` claim is cleared, the next turn is not blocked by a stale
  stop claim, no duplicate terminal event is emitted, no
  `provider-watchdog-stop`, no `system/error`, no error transition, and no
  reissue or forced-error for that completed turn.
- Turn A watchdog stop command is queued, turn A completes normally, turn B
  starts, and then the daemon fetches A's stale watchdog stop command: the
  host-daemon/runtime target check returns the typed stale-target/no-op result,
  no provider interrupt is sent for turn B, and the server retires/reconciles
  A's stop attempt without appending watchdog terminal/error events.
- Turn A being watchdog-claimed and completed, then turn B starting on the same
  thread, does not let A's diagnostic or stop request re-trip turn B.

TTL interaction:

- Linked watchdog `thread.stop` with `state IN ('pending', 'fetched')`
  suppressing watchdog reissue only while still inside the current confirmation
  window.
- Watchdog-linked pending `thread.stop` older than
  `WATCHDOG_STOP_PENDING_TTL_MS` being marked `state='error'` by the
  server-owned command lifecycle sweep and no longer suppressing reissue or
  forced-error escalation.
- TTL requeue from `fetched`/`retryCount=0` being observed, and TTL terminal
  `state='error'` feeding the unconfirmed-interrupt path without the TTL sweep
  transitioning the thread itself.
- Expired watchdog-linked `thread.stop` command ids are partitioned away from
  `handleExpiredCommands` generic `thread.stop` failure handling: no generic
  `system/error` is appended, generic thread-stop side effects do not clear the
  stop request, and watchdog reconciliation consumes the terminal command state
  for `watchdog-interrupt-unconfirmed`.
- Watchdog observation of `host_daemon_commands` does not mutate queue
  lifecycle fields: `state`, `retryCount`, `fetchedAt`, `completedAt`, or
  `resultPayload`.

Restart recovery:

- First enabled sweep after migration/startup grace evaluates already-stuck
  active turns through the normal page budget and emits diagnostics only through
  the standard dedup path.
- Post-restart dedup: an already-persisted
  `(thread_id, provider_turn_id, reason)` diagnostic does not emit again.
- Post-restart forced-error recovery: `watchdog-interrupt-unconfirmed` exists
  while the turn is still active, so the sweep appends terminal
  `turn/completed`, appends `system/error`, and transitions thread status
  without duplicating the unconfirmed diagnostic.
- Legacy/partial crash-after-diagnostic-before-stop recovery: a diagnostic row
  with `daemon_command_id IS NULL` queues `thread.stop` once after restart
  without duplicating the primary diagnostic.
- Reissue clock continuation after restart: elapsed confirmation time continues
  from persisted diagnostics/command records instead of resetting to zero.
- Restart grace: an outage longer than 120 seconds does not immediately force
  error on the first sweep after startup; escalation waits for the Phase 1 grace
  window and one observed linked-command state.

Negative progress:

- Later unrelated command completing successfully while the first raw call is
  still stuck.
- Long-running command with periodic stdout/progress past 600,000 ms that does
  not emit a watchdog diagnostic and is not interrupted because each progress
  event resets the command-specific stale-progress clock.

Contract details:

- `threadEventSchema` accepts a `system/provider-turn-watchdog` event with
  `threadScope()`, `providerId`, and `providerThreadId`, proving the diagnostic
  provider fields do not conflict with the server-authored event branch.
- Stored-event round trip for `system/provider-turn-watchdog` preserves
  `providerTurnId` and proves the event data does not require the reserved
  stored-data key `turnId`.
- Host-daemon observation envelope parsing imports the shared
  `ProviderRuntimeObservation` schema from `@bb/domain`, and contract tests
  prove `@bb/host-daemon-contract` / server ingestion do not depend on
  `@bb/agent-runtime`.
- `local_shell_call.call_id=null` contract tests prove the adapter emits a typed
  `ProviderAdapterObservation` with `providerRawCallId=null` and no
  casts/placeholders, the host-daemon envelope supplies
  `daemonObservationSequence`, server ingestion persists a non-null
  deterministic `rawCallId`, and replay dedups by daemon sequence.
- Non-command diagnostic variants do not carry command text fields.
- Command diagnostic variants persist `commandText=null` when no command text
  is identified.
- `command-progress-timeout` diagnostic contract tests cover both
  `commandState` subvariants: `started-no-progress` requires
  `lastCommandProgressAt=null`, and `progress-stale` requires non-null
  `lastCommandProgressAt`.
- Short command text values are persisted as `{ value, truncated: false }`.
- Long command text values are capped at 4,096 characters as
  `{ value, truncated: true }`.

Exit criteria:

- Tests assert persisted events and final thread state, not implementation call
  order.
- Tests use in-memory SQLite with migrations.
- No database mocking.
- Tests use persisted-event helpers, replay-capture fixtures, and DB command
  helpers as the seam; they do not mock BB runtime adapter or daemon internals.
- Raw dispatch durability tests exercise the real Codex adapter/server
  observation transport and server persistence boundary; they do not replace
  `translateEvent`, the host-daemon contract parser, or private adapter state
  with a mock.
- Raw dispatch durability tests cover provider-thread-id observation stamping,
  raw-before-start matching, start-before-raw matching, and duplicate replay.
- Add `apps/server/test/helpers/provider-watchdog-harness.ts` as the test entry
  point. The harness provides migrated in-memory SQLite, an injected clock,
  threshold overrides, helpers to append turn/provider/tool events, helpers to
  create linked daemon-command rows, and a helper to run the watchdog sweep
  once.
- Update `qa/manual-runbook.md` or add
  `qa/provider-turn-watchdog-manual.md` with operator-facing steps that name the
  harness command or fixture, threshold override values, expected diagnostic
  fields, expected thread/timeline outcome, and cleanup steps.

## Scope Guard: CLI timeout remains deferred

**Goal:** Keep CLI HTTP timeout work separate from the provider-turn watchdog.

CLI request timeout is explicitly deferred to separate guardrail work in a
separate branch or plan. It can help commands like `bb thread output`, but it
would not have prevented the 245 minute manager turn because the provider turn
was already inside Codex.

Scope guard:

- No files under `apps/cli/**` are modified in this watchdog branch.

Scope criteria:

- Scope validation proves no `apps/cli/**` files changed in the watchdog
  implementation branch.
- No CLI runtime tests are required for the watchdog implementation.
- A future CLI timeout patch is documented and reviewed as a separate CLI
  guardrail, not as the provider-turn watchdog fix.

## Follow-up: Open or patch upstream Codex

**Goal:** Address the upstream runtime behavior that makes pre-begin stalls
invisible without blocking the BB watchdog implementation.

Open an upstream issue or patch against `openai/codex` with:

- the incident signature: raw `exec_command` emitted, no normalized
  `ExecCommandBegin`, abort output hours later
- code references, anchored to an `openai/codex` commit SHA, file path, and
  line range, showing `ExecCommandBegin` is emitted after
  `open_session_with_sandbox`
- code references, anchored to an `openai/codex` commit SHA, file path, and
  line range, showing raw tool outputs are drained through `FuturesOrdered`
- probe results showing shell startup delay and silent output are not sufficient
  explanations

Preferred upstream fixes:

- add a timeout around unified exec pre-begin session creation
- emit an earlier "tool dispatch accepted" lifecycle event distinct from
  command process start
- avoid ordered raw output drain blocking later completed tool outputs behind an
  earlier stuck tool, or document that raw outputs are conversation-history
  ordering rather than UI-progress ordering

Follow-up criteria:

- Draft an upstream report that links or attaches a reproducer probe covering
  the pre-begin stall class, plus the incident/probe evidence above.
- Before filing, replace unverified upstream claims with pinned GitHub URLs that
  include commit SHA, file path, and line references.
- BB does not depend on upstream changes for its own watchdog protection.
- This follow-up is not part of the watchdog completion criteria.

## Validation

Automated:

- `pnpm exec turbo run test --filter=@bb/domain`
- `pnpm exec turbo run test --filter=@bb/db`
- `pnpm exec turbo run test --filter=@bb/agent-runtime`
- `pnpm exec turbo run test --filter=@bb/host-daemon`
- `pnpm exec turbo run test --filter=@bb/host-daemon-contract`
- `pnpm exec turbo run test --filter=@bb/server`
- `pnpm exec turbo run test --filter=@bb/server-contract`
- `pnpm exec turbo run test --filter=@bb/thread-view`
- `pnpm exec turbo run test --filter=@bb/ui-core`
- `pnpm exec turbo run test --filter=@bb/app`
- `pnpm exec turbo run test --filter=@bb/integration-tests --force > /tmp/provider-watchdog-integration-tests.txt 2>&1`
- `pnpm exec turbo run typecheck --filter=@bb/domain --filter=@bb/db --filter=@bb/agent-runtime --filter=@bb/host-daemon --filter=@bb/host-daemon-contract --filter=@bb/server --filter=@bb/thread-view --filter=@bb/server-contract --filter=@bb/ui-core --filter=@bb/app`
- `MERGE_BASE="$(git merge-base main HEAD)" && test -z "$(git diff --name-only "${MERGE_BASE}...HEAD" -- apps/cli)"`

Manual:

- Start the standalone server and daemon using `qa/manual-runbook.md`.
- Follow the provider-turn watchdog manual runbook from Phase 4 to use the
  replay/fake-provider harness to emit a raw `exec_command` call and then stall
  before command start.
- Run manual watchdog checks with test/dev threshold overrides rather than
  waiting for the 15 minute idle or 6 hour wall-clock defaults.
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
- scope validation proves no `apps/cli/**` files changed
