# Server/Daemon Protocol Simplification

## Motivation

The timeline sequence incident was one concrete failure of a broader pattern: the
server and host daemon sometimes share ownership of the same lifecycle fact. That
shows up as duplicate identities, retry state, replay sweeps, high-water marks,
session-bound domain rows, and command queues used as synchronous RPC.

The goal of this plan is to make each boundary explicit:

- server owns product policy, durable lifecycle state, event log ordering, and
  final user-visible state;
- daemon owns host-local execution, provider processes, workspace primitives, and
  transient transport state;
- protocol messages carry opaque stable ids for idempotency and correlation, not
  caller-guessed positions or transport session ids;
- durable jobs and synchronous host queries use different protocols.

This plan is a parent roadmap. The detailed event-log hard cutover remains in
`plans/host-daemon-event-protocol-hard-cutover.md` and should land first.

## Current Status (2026-05-04)

Open future work. The short-term timeline safety fixes have landed separately in
this branch and should be reviewed as bug fixes, not as partial implementation of
this roadmap. They harden the current daemon event protocol with conflict
detection, daemon rebase, bounded retry, duplicate canonicalization, and active
manager nudge safeguards.

The codebase still has protocol complexity in several adjacent areas:

- daemon-assigned event sequences and server high-water marks;
- command rows that become `fetched` without a delivery attempt identity;
- synchronous read commands flowing through the durable command queue;
- command result state persisted before lifecycle side effects complete;
- pending interactions keyed by session id;
- reliable retry machinery for environment change hints that only notify hub
  subscribers;
- runtime material sync split across a durable command and separate snapshot
  fetch;
- dynamic tool calls with server side effects but no server-side idempotency key;
- development replay commands mixed into the production daemon command union.

## Target Architecture

### Event Log

`sequence` is server-assigned final thread log order only. The daemon sends
events with opaque `producerEventId`; the server deduplicates retries by that id
and assigns sequence transactionally.

Detailed plan: `plans/host-daemon-event-protocol-hard-cutover.md`.

### Durable Jobs

Durable daemon work is represented as server-owned jobs. Jobs have stable job ids
and per-delivery attempt ids.

Durable job examples:

- `thread.start`
- `turn.submit`
- `thread.stop`
- `environment.provision`
- `environment.destroy`
- `workspace.commit`
- `workspace.squash_merge`
- `workspace.promote`
- `workspace.demote`
- `host.sync_runtime_material` if it remains a durable mutation

The daemon result must include both `jobId` and `attemptId`. The server accepts a
result only for the current active attempt. Late results from older attempts are
stale and cannot settle the job.

### Synchronous Host RPC

Host-local reads and development-only inspection should not enter the durable job
queue. They should use an online request/response RPC over the daemon websocket,
with request id, timeout, and no persisted command row.

RPC candidates:

- `host.list_files`
- `host.read_file`
- `provider.list`
- `provider.list_models`
- `workspace.status`
- `workspace.diff`
- `workspace.list_files`
- `workspace.list_branches`
- replay capture list/get/delete
- one-off development inspection commands

If the host is offline, these fail as host unavailable. They are not requeued.

### Provider-Originated Requests

Provider-originated requests with server side effects must be idempotent by a
stable request id.

- Pending interactions use a daemon/provider request identity, not session id.
- Dynamic tool calls include a request id and dedupe server side effects such as
  `message_user`.
- Provider process restart is a lifecycle boundary; websocket reconnect is not.

### Session Semantics

`sessionId` is transport/auth/lease state only. It is allowed in internal ingress
requests to prove the current daemon is authorized, but it should not appear in
domain uniqueness, idempotency keys, event identity, or pending interaction
identity.

When command delivery attempts record `sessionId`, that value is attempt lease
metadata: it answers which transport session received this delivery attempt. It
is not part of the durable job identity, idempotency key, lifecycle operation
identity, or provider-originated request identity.

### Identity Glossary

- `clientRequestId`: event-plan identity for a persisted
  `client/turn/requested` event. It appears here only because Phase 1 completes
  the event hard cutover first; do not reuse it for durable jobs, RPCs, or
  provider-originated tool calls.
- `producerEventId`: daemon-generated durable id for a daemon-produced event
  record. It deduplicates daemon event delivery retries.
- `jobId`: target protocol name for the stable server-owned durable daemon job
  identity. If the implementation keeps the existing `commandId` field/table
  name, `commandId` is the concrete `jobId`; do not create parallel durable
  identities for the same job.
- `commandId`: current persisted command-row id and lifecycle-operation foreign
  key. It identifies durable work, not a delivery attempt.
- `attemptId`: server-generated id for one delivery attempt of a durable daemon
  job.
- `requestId` on websocket RPC: server-generated id scoped to one online
  `rpc.request`/`rpc.response` exchange. It is not persisted and is not a durable
  job id.
- `requestId` on dynamic tool calls: provider/runtime-generated idempotency
  handle for one provider-originated server-side tool call, scoped by
  `providerRunId` or `providerRequestScope`.
- `providerRunId` or `providerRequestScope`: daemon/provider-process-run
  identity. It scopes provider-originated pending interactions and dynamic tool
  calls across websocket reconnects, and changes on provider process restart.
- `desiredRuntimeMaterialVersion`: server-owned content/version id for the
  runtime material snapshot the host should apply.
- `appliedRuntimeMaterialVersion`: daemon-reported content/version id that the
  server records as currently applied host state.
- `daemonInstanceId`: stable daemon installation/instance identity used to decide
  whether a replacement websocket session represents the same daemon instance.
  It is distinct from shorter provider-run/process identities.
- `sessionId`: transport authorization and lease state only.

### Protocol Boundary Observability

Every phase that introduces a protocol idempotency boundary must add structured
logs and counters for:

- protocol-version mismatch during session open;
- duplicate id with mismatched payload, such as `producerEventId`, command
  `attemptId`, pending interaction identity, and dynamic tool call id;
- stale attempt or stale provider-run result rejection;
- host-unavailable RPC failures.

Counters are owned by the server protocol/lifecycle owner for server-side
decisions and by the host daemon for host-local transport/runtime decisions.
Each phase's exit criteria must name the specific boundary logs/counters and
include automated assertions for them; a generic log line is not enough.

### Deferred Modeling Gaps

These gaps are related to the same ownership boundary but should not block the
event hard cutover. Model them before implementing the phases that depend on
them:

- host registration/auth lifecycle: define whether host keys, enrollment, lease
  renewal, and replacement are owned by host identity or daemon instance state;
- daemon instance vs daemon process identity: define the stable daemon-instance
  id and the shorter provider/process-run ids used for pending interactions and
  tool calls;
- telemetry contract: define which protocol outcomes are emitted as telemetry
  events, who owns their schema, and how stale attempts, host-unavailable RPCs,
  and idempotent retries are counted.

## Implementation Plan

### Phase 1: Finish Event Protocol Hard Cutover

Complete all six phases and completion criteria in
`plans/host-daemon-event-protocol-hard-cutover.md`.

This removes:

- daemon event `sequence`;
- event buffer seeding and rebasing;
- event high-water marks as daemon coordination;
- `clientRequestSequence`;
- sequence conflict/rebase code.

Exit criteria:

- The completion criteria in `plans/host-daemon-event-protocol-hard-cutover.md`
  are met.
- `rg "clientRequestSequence|eventSequence|sequence_conflict|acceptedSequences" apps packages` returns no production matches except migration scripts or unrelated text.

### Phase 2: Add Command Delivery Attempts

Replace `pending`/`fetched` as the command delivery protocol with explicit
attempt records. Phase 4 depends on this active-attempt model; do not implement
atomic command-result settlement until stale and expired results can be
identified by `(commandId, attemptId)`.

Data model:

- Keep a durable command/job row with final state:
  `queued`, `running`, `succeeded`, `failed`, `cancelled`.
- Add a command attempt table or equivalent structured columns:
  - `attemptId`
  - `commandId`
  - `sessionId`
  - `deliveredAt`
  - `leaseExpiresAt`
  - `settledAt`
  - `status`
- A command can have multiple attempts; exactly one attempt can be active.
- `sessionId` on an attempt is lease metadata for that delivery attempt only,
  not job identity.

Migration and drain guidance:

- Add a `host_daemon_command_attempts` table, or equivalent structured columns
  if a table is rejected during design review, with a foreign key to
  `host_daemon_commands.id`.
- Keep lifecycle operation tables pointing at the durable command/job row through
  their existing `commandId` foreign keys. Do not point lifecycle operations at
  attempts; attempts are transport deliveries, not lifecycle work.
- Rename or map current terminal command states:
  - `pending` -> `queued`;
  - `fetched` -> `running` with one synthetic attempt carrying the existing
    `sessionId`, `fetchedAt` as `deliveredAt`, and a lease derived from command
    TTL policy;
  - `success` -> `succeeded`;
  - `error` -> `failed`.
- Before applying the dev DB migration, stop the daemon and run a preflight that
  lists all `pending` and `fetched` command rows. If any `fetched` rows exist,
  either wait for them to settle on the old protocol before migration or mark
  their synthetic attempts expired/stale during migration so late old-protocol
  results cannot settle the job.
- Back up the DB before rewriting command state. Abort without mutation if a row
  has an unknown state, malformed payload, missing host/session reference, or a
  lifecycle operation points at a missing command row.
- Keep `retryCount` and `fetchedAt` until the migrated Phase 2 code no longer
  reads them; then drop them in the final Phase 2 schema migration before moving
  to Phase 3.
- Rollback is restore-from-backup only. Do not try to downgrade attempt rows back
  into `retryCount`/`fetchedAt` because stale attempt semantics cannot be
  represented by the old schema.

Protocol:

- `/session/commands` returns `attemptId` with each command envelope.
- `/session/command-result` requires `attemptId`.
- The server accepts a result only when `(commandId, attemptId)` is the active
  attempt.
- Late results from old attempts return a stale-attempt response and do not
  mutate command or lifecycle state.
- Expiry marks only the attempt expired; it does not synthesize malformed command
  result payloads.

Code changes:

- Replace `fetchCommands()` state mutation in `packages/db/src/data/commands.ts`
  with attempt creation.
- Replace command retry logic in `packages/db/src/data/sweeps.ts` with attempt
  lease expiry.
- Remove `retryCount` once no longer needed.
- Update `HostDaemonCommandEnvelope` and result report schemas.
- Update `CommandRouter` to preserve and return `attemptId`.

Exit criteria:

- A stale result from an expired attempt cannot settle a command.
- A command retry creates a new attempt id.
- Non-idempotent mutation command tests cover late result arrival after retry.
- Dev DB migration tests cover `pending`, `fetched`, `success`, and `error`
  command rows, including a `fetched` row whose late result is rejected after
  migration.
- Lifecycle operation FK tests prove operation `commandId` links still point to
  durable command rows and never to attempt rows.
- Tests assert structured logs/counters for stale-attempt rejection, active
  attempt mismatch, and duplicate/late command-result delivery.
- Phase 2 includes the final schema migration that drops `retryCount` and
  `fetchedAt` after tests prove migrated code no longer reads them.
- `rg "retryCount|state: \"fetched\"|Command expired after retry" apps packages` returns no production matches after migration.

### Phase 3: Split Durable Jobs From Online RPC

Introduce a websocket request/response RPC channel for non-durable host-local
queries.

Protocol:

- Server sends `rpc.request` over the active daemon websocket:
  `{ requestId, method, params, timeoutMs }`.
- Daemon replies `rpc.response`:
  `{ requestId, ok, result | error }`.
- Requests are not persisted.
- The server fails immediately if no active websocket exists for the host.

Move these command types out of the durable command union:

- `host.list_files`
- `host.read_file`
- `provider.list`
- `provider.list_models`
- `workspace.status`
- `workspace.diff`
- `workspace.list_files`
- `workspace.list_branches`

Routes/services that currently call `queueCommandAndWait()` for these reads
should call the RPC client instead.

Compatibility audit:

- Inventory every `queueCommandAndWait()` callsite for moved read/RPC methods.
- For each route, document the previous queued-wait behavior and the new
  host-unavailable API behavior.
- Public API routes must return a typed host-unavailable error instead of
  creating a durable command row while the daemon is offline.
- App and CLI callers must surface host-unavailable state as a retryable online
  availability problem, not as a failed durable operation.
- Tests must cover an offline host for provider list/model list, workspace
  status/diff, file listing, and thread-storage reads.

Keep durable jobs only for mutations and turn/runtime lifecycle work.

Exit criteria:

- `queueCommandAndWait()` is deleted or only supports durable mutation jobs that
  genuinely need a persisted lifecycle.
- `runWithDaemonCommandWaitForbidden()` is deleted.
- The host daemon command union no longer contains host-local read methods.
- Routes that read files, list files, inspect providers, or check workspace
  status do not create `host_daemon_commands` rows.
- Offline-host tests assert the route error body/code for provider, workspace,
  and file-read RPCs.
- App/CLI tests assert that host-unavailable responses are presented as
  retryable availability states.
- Tests assert structured logs/counters for host-unavailable RPC attempts, RPC
  timeout, and response/request id mismatch.

### Phase 4: Make Command Result Application Atomic

Dependency: Phase 2 must land first so the result route can validate the active
attempt before it mutates command or lifecycle state.
Dependency: Phase 1 must already have completed the event protocol hard cutover,
so command result routes no longer need to preserve event high-water-mark
compatibility for daemon sequence coordination.

Move command result settlement and domain lifecycle transition into one owner
transaction.

Current problem:

- The server persists command success/error first, then runs side effects.
- If side effects fail, the system needs replay/failure sweeps to repair the
  mismatch.

Target:

- Each durable command has an owner:
  - thread lifecycle owner;
  - environment lifecycle owner;
  - host runtime material owner;
  - workspace mutation owner.
- The result route calls the owner.
- The owner validates the active attempt and, in one transaction:
  - settles the attempt;
  - settles the command;
  - advances the durable lifecycle operation;
  - appends any server-owned events;
  - records typed result payload if callers need it.
- Follow-up work that may queue another command is requested after commit through
  the owning lifecycle service.

Code to remove or shrink:

- command result side-effect replay/failure sweep modules:
  - `apps/server/src/internal/command-result-side-effect-sweep.ts`;
  - `apps/server/src/internal/command-result-side-effect-failure-common.ts`;
  - the re-export shim
    `apps/server/src/internal/command-result-side-effect-failures.ts`;
  - replay/failure helpers in
    `apps/server/src/internal/command-result-owners.ts` that exist only to
    repair command-result side-effect gaps;
  - `replaySettledSideEffects`, `failSettledSideEffects`,
    `commandResultOwnerReplaysSettledSideEffects`,
    `failCommandResultSideEffects`, and side-effect failure imports/types in
    `command-result-owners.ts`;
- stored command result reconstruction from untyped JSON;
- special expired-result report construction.

Exit criteria:

- There is no state where a command is terminal but its owning active lifecycle
  operation is still active because result side effects failed.
- `apps/server/src/internal/command-result-side-effect-sweep.ts` is deleted.
- `apps/server/src/internal/command-result-side-effect-failures.ts` is deleted.
- `apps/server/src/internal/command-result-side-effect-failure-common.ts` is
  deleted.
- `apps/server/src/internal/stored-command-result-report.ts` is deleted or no
  longer reconstructs reports for side-effect replay.
- `rg "replaySettledSideEffects|failSettledSideEffects|commandResultOwnerReplaysSettledSideEffects|failCommandResultSideEffects|CommandResultSideEffectFailure|settledCommandSideEffectFailureReason|buildStoredCommandResultReport" apps/server/src/internal` returns no production matches.
- Integration tests prove command settlement, attempt settlement, lifecycle
  advancement, and server-owned event appends commit atomically or not at all.
- Tests assert structured logs/counters for atomic owner transaction rollback and
  lifecycle-owner result rejection.
- Expired command handling uses typed lifecycle failure paths, not synthetic
  daemon result reports.

### Phase 5: Rework Pending Interaction Identity

Stop using `sessionId` as part of pending interaction identity.

Target identity:

- daemon/provider process request scope, generated when the provider process is
  started;
- provider id;
- provider thread id;
- provider request id.

The runtime already scopes provider request ids with an in-memory provider
process scope. Promote that into an explicit protocol field such as
`providerRunId` or `providerRequestScope` and persist it.

Migration and drain guidance:

- Add a persisted provider-run/request-scope field before changing the unique
  index.
- Replace the current unique key that includes `sessionId` with one based on the
  provider-run identity, provider id, provider thread id, and provider request
  id.
- Stop the daemon before the dev DB migration and preflight all active pending
  interactions. Active `waiting` or `resolving` rows cannot be safely rekeyed
  from `sessionId` alone because websocket session identity is not provider-run
  identity; resolve them first or expire/interrupt them explicitly as
  old-daemon-instance work.
- That forced resolve/expire option is migration-only for legacy active rows that
  lack provider-run identity. After this phase lands, steady-state websocket
  reconnect keeps pending interactions alive because provider-run identity exists.
- Terminal rows may be backfilled with deterministic legacy provider-run ids for
  retry-window dedupe, but active rows must not be silently guessed.
- Rollback is restore-from-backup only after the unique index has changed.

Lifecycle handling:

- Brief websocket reconnect does not interrupt pending interactions.
- Opening a replacement session with the same daemon instance does not interrupt
  pending interactions.
- Provider process exit or daemon instance restart interrupts pending
  interactions owned by the old provider run.
- Repeated registration with the same identity and same payload returns the
  existing pending interaction.
- Repeated registration with the same identity and different payload is rejected
  as a protocol/data-integrity error.
- Lost resolution delivery is retried against the same provider run/request
  identity until the provider acknowledges it or the provider run exits.
- Expired or stale resolution attempts cannot resolve a pending interaction for a
  newer provider run.
- Terminal pending interactions are retained long enough to deduplicate retries,
  then removed by an owner-defined GC policy.

Exit criteria:

- The unique pending interaction key no longer includes `sessionId`.
- `registerPendingInteraction()` is idempotent across session reconnect.
- Migration tests cover duplicate old rows that would collide under the new
  provider-run key, active-row abort behavior, and terminal-row legacy backfill.
- Tests assert structured logs/counters for duplicate registration with mismatched
  payload, stale provider-run resolution, and terminal-row GC.
- Tests cover:
  - reconnect while approval is pending;
  - daemon process restart while approval is pending;
  - duplicate provider request registration;
  - repeated registration with mismatched payload;
  - lost/stale resolution delivery;
  - stale resolution after provider process exit;
  - GC of terminal pending interactions after the retention window.

### Phase 6: Make Dynamic Tool Calls Idempotent

Dynamic tool calls can have server side effects. `message_user` appends a
timeline event, so the request must be idempotent.

Changes:

- Include `requestId` in `HostDaemonToolCallRequest`.
- Define a stable tool-call idempotency key:
  provider run id + provider thread id + request id, or an opaque request id
  generated once by runtime if provider ids are not stable enough.
- Store processed server-side tool calls in a server-owned idempotency store with
  key, payload hash, response body, status, createdAt, and expiresAt.
- On retry:
  - same key + same payload returns the stored response;
  - same key + different payload is rejected;
  - new key executes normally.

Lifecycle handling:

- If the daemon loses the HTTP response after the server commits side effects,
  retrying the same request returns the stored response without duplicating
  effects.
- Websocket reconnect does not change tool-call identity.
- Provider process restart creates a new provider run; old in-flight tool calls
  are stale and cannot be completed against the new run.
- In-progress records that exceed their timeout are marked failed or expired by
  the tool-call owner before another request can reuse the key.
- Completed records are retained for the retry window, then pruned by the
  owner-defined GC policy.

Exit criteria:

- Retrying `message_user` does not append duplicate
  `system/manager/user_message` events.
- Same tool-call id with different payload is rejected.
- Tool call request schema carries an idempotency key end to end.
- Tests assert structured logs/counters for duplicate tool-call payload mismatch,
  stale provider-run retry, expired in-progress record, and completed-record GC.
- Tests cover lost response retry, stale provider-run retry, mismatched payload,
  expired in-progress records, and GC of completed records.

### Phase 7: Simplify Environment Change Hints

Use best-effort invalidation.

Target:

- Daemon sends environment change hints over websocket when connected.
- No durable retry buffer.
- No exponential retry state.
- Lost hints are acceptable because clients can refetch and periodic status
  checks can reconcile.

Do not keep the current hybrid: durable-looking retry machinery for a hint that
only calls `hub.notifyEnvironment()`.

Exit criteria:

- `apps/host-daemon/src/environment-change-reporter.ts` is deleted.
- `/session/environment-change` is deleted from the internal route contract,
  server registration, and daemon client.
- `rg "createBufferedEnvironmentChangeReporter|postEnvironmentChange|/session/environment-change" apps packages` returns no production matches.
- `apps/host-daemon/src/environment-change-reporter.test.ts` is deleted or
  replaced with websocket hint tests.
- `apps/server/test/internal/internal-environment-change.test.ts` is deleted or
  replaced with websocket hint authorization/fan-out tests.
- App-side tests prove websocket environment-change messages invalidate/refetch
  workspace status, diff, file-list, and thread-storage queries.
- Tests assert structured logs/counters for websocket hint fan-out, unauthorized
  hint rejection, and dropped best-effort hints when no subscribers are present.
- Manual validation confirms workspace status/diff/file-list views refetch after
  a file change and after reconnect.

### Phase 8: Normalize Runtime Material Sync

After the RPC split, decide whether runtime material sync is a durable job or a
direct online operation. The recommended model is content-addressed online sync
with explicit desired version.

Target:

- Server computes desired runtime material snapshot/version.
- Daemon asks for or receives the snapshot by version.
- Daemon applies the snapshot and replies with `appliedVersion`.
- Server records applied version as host state.
- If daemon is offline, sync remains desired but no command is queued until the
  next session opens.

Exit criteria:

- Runtime material sync no longer uses both a durable command and a separate
  `/session/runtime-material` fetch unless the command is explicitly kept as a
  durable host job with attempt identity.
- `rg "host.sync_runtime_material|/session/runtime-material|fetchRuntimeMaterial" apps packages` has matches only in the chosen runtime-material sync path and its tests.
- Session-open reconciliation has one owner function that compares
  desired/applied versions and requests apply if needed.
- `apps/server/test/hosts/sandbox-runtime-material.test.ts` covers offline
  daemon, reconnect reconciliation, repeated desired-version requests, and
  applied-version recording.
- Host-daemon tests cover applying the same runtime material version twice
  without rewriting state unnecessarily.
- Tests assert structured logs/counters for desired/applied version mismatch,
  repeated desired-version request dedupe, offline-daemon deferral, and stale
  applied-version rejection.

### Phase 9: Move Development Replay Out Of Production Commands

Replay capture commands are development tooling. They should not bloat the
production daemon command protocol.

Changes:

- Move replay capture list/get/delete/run behind development-only server routes
  and daemon RPC methods.
- Keep replay runtime code in host daemon, but remove replay command variants
  from `HostDaemonCommand`.
- Do not include replay command result schemas in production command result
  owner logic.

Exit criteria:

- `replay.*` is gone from `HOST_DAEMON_COMMAND_TYPES`.
- `rg "replay\.|replay.capture" packages/host-daemon-contract/src apps/server/src/internal/command-result-owners.ts` returns no production matches.
- Internal replay routes do not call `queueCommandAndWait()` or create
  `host_daemon_commands` rows.
- Development replay UI/routes still work in dev mode through the RPC path.
- `apps/server/test/public/public-internal-replay.test.ts` covers replay list,
  get, delete, and run over the dev-only RPC path.
- Host-daemon replay handler tests move from command dispatch to RPC handling.
- Production command contract tests do not mention replay commands.
- Tests assert structured logs/counters for dev replay RPC authorization,
  host-unavailable replay RPC, and replay request/response id mismatch.

## Deletion Targets

The cleanup is successful only if code disappears. Expected deletion/reduction
targets:

- event buffer seed/rebase/sequence conflict code;
- event high-water mark response plumbing;
- `clientRequestSequence` and daemon command `eventSequence`;
- `retryCount` and `fetched` command state;
- command wait guard machinery;
- queue-and-wait usage for host-local reads;
- command result side-effect replay/failure sweeps;
- pending interaction `sessionId` uniqueness;
- environment change retry buffer;
- replay command variants in the production command union.

## Validation

Run typecheck after each phase for touched packages. At minimum:

```bash
pnpm exec turbo run typecheck --filter=@bb/host-daemon --filter=@bb/server --filter=@bb/host-daemon-contract --filter=@bb/db --filter=@bb/domain --filter=@bb/thread-view --filter=@bb/agent-runtime
```

Run the focused test set after each phase:

```bash
pnpm exec turbo run test --filter=@bb/host-daemon --filter=@bb/server --filter=@bb/host-daemon-contract --filter=@bb/db --filter=@bb/domain --filter=@bb/thread-view --filter=@bb/agent-runtime > /tmp/bb-server-daemon-protocol-test-out.txt 2>&1
git diff --check
```

Required per-phase validation additions:

- Phase 1: protocol-version mismatch contract and session-open tests; old
  sequence-bearing event/command payloads are rejected; duplicate
  `producerEventId` payload mismatch is logged/counted and rejected.
- Phase 2: stale-attempt rejection, retry creates a new attempt, pending/fetched
  dev-row migration, lifecycle operation FK preservation, and late result after
  retry for a non-idempotent mutation.
- Phase 3: offline-host RPC route coverage for provider list/model list,
  workspace status/diff, file listing, and thread-storage reads; app/CLI display
  host-unavailable as retryable availability.
- Phase 4: lifecycle no-gap integration test proving command result settlement
  and lifecycle advancement are atomic.
- Phase 5: reconnect while pending, daemon process restart while pending,
  duplicate registration, mismatched payload, stale/lost resolution delivery,
  stale resolution after provider process exit, and terminal-row GC.
- Phase 6: provider-run idempotency for dynamic tool calls, including lost
  response retry, mismatched payload, stale provider run, expired in-progress
  record, and completed-record GC.
- Phase 7: websocket fan-out/auth tests and app-side refetch reconciliation.
- Phase 8: sandbox runtime material offline-daemon behavior, reconnect
  reconciliation, repeated desired-version requests, and applied-version
  recording.
- Phase 9: public/internal replay routes over dev-only RPC and host-daemon replay
  handling outside the production command union.

Manual validation on dev:

1. Start server and host daemon.
2. Load `thr_bj3p5vk9py` timeline.
3. Start a new thread.
4. Submit a steer to an active turn.
5. Stop an active turn.
6. Trigger a pending interaction and reconnect the daemon websocket without
   restarting the daemon process.
7. Restart the daemon process during a pending interaction.
8. Run workspace status/diff/file-list/read routes.
9. Trigger `message_user` and retry the same tool-call request in a test harness.
10. Exercise replay capture routes in dev mode.

Expected result: all operations either complete once or fail with a clear
non-retryable protocol error. No duplicates, stale results, or timeline
projection errors.

## Completion Criteria

This roadmap is complete when:

- durable mutations and synchronous host reads no longer share one command queue;
- transport session ids are not domain identities;
- daemon retries are idempotent by stable request/event/attempt ids;
- command result settlement and lifecycle advancement are atomic;
- environment change hints are either explicitly best-effort or durable
  snapshots, not retry-buffered notifications;
- development replay no longer expands the production command protocol;
- the deletion targets above are removed or have a documented reason to remain.
