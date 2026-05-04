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

Complete `plans/host-daemon-event-protocol-hard-cutover.md`.

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

### Phase 4: Make Command Result Application Atomic

Dependency: Phase 2 must land first so the result route can validate the active
attempt before it mutates command or lifecycle state.

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

- command result side-effect replay/failure sweep modules;
- stored command result reconstruction from untyped JSON;
- special expired-result report construction.

Exit criteria:

- There is no state where a command is terminal but its owning active lifecycle
  operation is still active because result side effects failed.
- `apps/server/src/internal/command-result-side-effect-sweep.ts` is deleted.
- `apps/server/src/internal/command-result-side-effect-failures.ts` is deleted.
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
pnpm exec turbo run typecheck --filter=@bb/host-daemon --filter=@bb/server --filter=@bb/host-daemon-contract --filter=@bb/db --filter=@bb/domain --filter=@bb/agent-runtime
```

Run the focused test set after each phase:

```bash
pnpm exec turbo run test --filter=@bb/host-daemon --filter=@bb/server --filter=@bb/host-daemon-contract --filter=@bb/db --filter=@bb/domain --filter=@bb/agent-runtime > /tmp/bb-server-daemon-protocol-test-out.txt 2>&1
git diff --check
```

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
