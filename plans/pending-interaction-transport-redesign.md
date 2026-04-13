# Pending Interaction Transport Redesign

## Goal

Move pending-interaction resolution delivery off long-lived HTTP requests and onto the existing daemon command/result lifecycle.

The server should persist and own the interaction lifecycle. The daemon should own the live provider request handle. User resolution should travel from server to daemon as a durable command, not as the eventual response body of a long-polling request.

## Current Problem

The current transport couples three lifetimes:

- the provider's in-flight JSON-RPC request
- the daemon/runtime callback waiting to answer that provider request
- the server's HTTP request waiting for the user to resolve the interaction

That makes request abort semantics ambiguous. If the HTTP request aborts, the server cannot know whether the provider request is still alive unless the daemon has a separate durable pending-request registry. Treating the abort as terminal can cancel a valid prompt. Treating the abort as non-terminal can leave a UI prompt that no provider request can receive.

The long-poll also does not match the rest of the server/daemon architecture. Other durable async work is requested by the server, delivered to the daemon as commands, and acknowledged through command results.

## Target Model

Registration and resolution delivery become separate operations:

- daemon registers the provider's interactive request with the server
- server persists the pending interaction and returns quickly
- daemon keeps a local pending-request registry keyed by the provider request identity
- user resolves the interaction through UI or CLI
- server validates the answer and moves the interaction to `resolving`
- server queues an `interactive.resolve` daemon command
- daemon consumes the command and resolves the local provider request
- daemon reports command success or failure
- server settles the interaction lifecycle based on the command result

The provider request is still not durable across daemon or provider process death. If the daemon loses the local request handle, the server must interrupt the interaction rather than pretending it can still be resolved.

## Lifecycle Ownership

### Server

- owns pending interaction rows
- validates registration and resolution payloads
- enforces project, thread, provider, and permission policy
- queues resolution delivery commands
- handles command-result acknowledgement
- interrupts interactions on thread stop, thread deletion, provider exit, daemon restart, session replacement, and session lease expiry

### Host Daemon

- translates provider requests into domain pending-interaction payloads
- registers provider requests with the server
- keeps live provider request deferreds in memory
- handles `interactive.resolve` commands
- translates domain resolutions back into provider wire responses
- reports stale or missing provider request handles as command failures

### Runtime Adapters

- decode provider interactive requests into domain payloads
- encode domain resolutions into provider JSON-RPC responses
- never own server product policy

## Proposed Protocol Shape

### Register request

The current internal request should become a fast registration call:

```ts
POST /internal/session/interactive-request
```

Request carries:

- `sessionId`
- `hostId`
- `threadId`
- `providerId`
- `providerThreadId`
- `providerRequestId`
- `payload`

Response carries:

- `interactionId`
- `status`

Registration must be idempotent for the same live provider request. If the daemon retries because the HTTP response was lost, the server should return the existing pending interaction rather than creating a duplicate or rejecting a valid retry.

The idempotency key should be:

```text
sessionId + threadId + providerId + providerThreadId + providerRequestId
```

The session id is part of the key because provider request ids can repeat after provider or daemon restart. A repeated provider id from a new daemon session is not the same live request handle.

### Resolve command

Add a daemon command:

```ts
kind: "interactive.resolve"
```

Command payload carries:

- `interactionId`
- `threadId`
- `providerId`
- `providerThreadId`
- `providerRequestId`
- `resolution`

The daemon succeeds only if the matching provider request handle is still live. If the handle is missing, the daemon returns a stale-request failure and the server interrupts the interaction with a clear reason.

### Command result

The command result must distinguish:

- delivered to provider
- stale provider request
- provider response encoding error
- provider process exited
- daemon/session mismatch

The server should map terminal delivery failures to `interrupted`, not `resolved`.

## Lifecycle States

The redesign adds `resolving` as a first-class status:

```ts
pending -> resolving -> resolved
pending -> interrupted
resolving -> interrupted
```

`resolving` means: the user answered and the server queued delivery to the daemon, but the provider has not acknowledged the response yet.

The server must not mark an interaction `resolved` when it merely queues delivery. `resolved` means the daemon reported that the provider request was answered.

UI, CLI, and timeline copy should distinguish:

- `pending`: waiting for user action
- `resolving`: user answered, delivering to provider
- `resolved`: provider request answered successfully
- `interrupted`: provider request could not be answered or is no longer live
- `expired`: ephemeral resource lifecycle expired before resolution

## Recovery Rules

### Lost registration response

Daemon retries registration with the same provider request identity. Server returns the existing pending interaction if it is still pending and belongs to the same session/thread/provider scope.

If the retry arrives after the user already answered, the server returns the existing row in its current state. The daemon must reconcile that response with its local live handle instead of registering a duplicate.

### HTTP abort after registration

No terminal state change. Registration is complete, and resolution delivery no longer depends on that HTTP request.

If registration never succeeds after bounded retries, the daemon should deny or error the provider request locally and report best-effort interruption to the server. The daemon must not hold a local provider request forever when no server row exists.

### Daemon restart or session replacement

Server interrupts pending interactions for provider requests owned by the previous daemon session, because the local provider request handles are gone.

Same-instance replacement must still be treated carefully. If a daemon replaces a session and omits a previously active thread from its active thread list, the server should interrupt pending interactions for that missing thread.

### Provider process exit

Daemon reports process exit and interrupts any locally registered pending provider requests for that thread.

### Thread stop or deletion

Server interrupts pending interactions before stopping or deleting thread resources. Deletion must emit an interrupted event before DB cascade removes rows.

### Session lease expiry

Periodic sweeps should interrupt pending interactions for hosts whose daemon lease expired. This addresses hard-kill cases without imposing arbitrary user-facing expiry on persistent-host prompts.

### Ephemeral host expiry

Ephemeral hosts may still need bounded pending-interaction expiry because the compute resource has a bounded lifetime. That expiry should be documented as resource-lifecycle cleanup, not HTTP timeout handling.

### Resolve command lost or delayed

The existing command lifecycle should own retry, expiry, and reconciliation. A pending interaction in `resolving` should not stay there forever; command expiry should transition it to `interrupted` with a reason that the resolution could not be delivered.

Interactive resolve command expiry is different from user-wait time. The command is queued only after the user answers, so long user think time happens while the interaction is still `pending`, not while a command is aging. The resolve command TTL should cover only delivery to a daemon that is expected to be online.

If the daemon delivers the provider response but the command-result ack is lost, retry must not double-answer the provider request or incorrectly mark the interaction interrupted. The daemon should keep a short-lived delivered-command tombstone keyed by `interactionId` and provider request identity, or the command-result lifecycle must otherwise guarantee idempotent acknowledgement after successful delivery.

## Implementation Phases

### Phase 1: Inventory Current Transport Semantics

- Identify every place that currently assumes the HTTP response is the provider response delivery mechanism.
- Identify every place that turns HTTP abort, daemon disconnect, provider exit, thread stop, thread deletion, command expiry, or session replacement into an interaction terminal state.
- Identify every UI, CLI, and timeline path that renders interrupted, expired, resolved, or HTTP-aborted pending interactions.
- Identify every test fixture that asserts long-poll behavior or HTTP-abort-specific messages.

Exit criteria:

- There is a concrete implementation checklist for removing the long-poll path.
- The review can distinguish provider-lifecycle interruption from transport-request abort.
- No tests are added only to preserve behavior that this plan intends to delete.

### Phase 2: Add Daemon Pending-Request Registry

- Add a daemon-owned registry for live interactive provider requests.
- Store entries by the scoped provider request identity used by the server.
- Ensure provider process exit, thread stop, and session replacement remove entries and notify the server.
- Add bounded registration retry. If the server row cannot be created or recovered, resolve the provider request locally with a denial/error and report best-effort interruption.
- Add double-delivery protection for resolve-command retry after successful provider delivery.

Exit criteria:

- Daemon can register and later resolve a local provider request without depending on a long-held HTTP response.
- Missing entries are reported as stale provider requests, not ignored.
- Daemon-local entries cannot leak forever when registration fails.
- Retried resolve commands cannot answer the same provider request twice.

### Phase 3: Resolving State And Atomic Command Cutover

- Add `resolving` to the DB schema, domain schemas, and server lifecycle.
- Change the internal interactive-request route to persist and return `interactionId`.
- Make registration idempotent for retry after lost response.
- Remove waiter semantics from the registration request path.
- Add `interactive.resolve` to the host-daemon command contract.
- Bump the host-daemon protocol version.
- Reject or disable pending-interaction registration for daemons that do not support the new protocol. Do not silently fall back to long-poll.
- Queue the command when a user resolves an interaction.
- Have the daemon translate the domain resolution and answer the provider request.
- Handle stale-request failures explicitly.
- Move interactions to `resolving` before command delivery and to `resolved` only after successful command result.

Exit criteria:

- There is no intermediate commit where registration fast-returns but no resolution delivery path exists.
- HTTP request abort after registration does not terminally change the interaction.
- Retried registration returns the same pending row for the same live provider request.
- User resolution reaches the provider through command delivery.
- Server does not mark provider delivery successful when the daemon lacks the live request.
- Contract tests cover the new command on the bumped daemon protocol version.
- Old daemons cannot accept pending-interaction work through an unsupported protocol path.

### Phase 4: Surface Resolving State

- Update app UI, CLI, API responses, and timeline events for `resolving`.
- Remove copy that implies provider acceptance before successful command result.
- Ensure app and CLI still expose one active interaction per thread while it is `pending` or `resolving`.

Exit criteria:

- The lifecycle state language is accurate.
- UI and CLI do not misrepresent an undelivered resolution as provider-accepted.
- Timeline events distinguish "answer submitted" from "provider request answered" when both are user-visible.

### Phase 5: Recovery And Sweep Integration

- Interrupt pending interactions on daemon restart, session replacement, provider exit, thread stop, and thread deletion.
- Add session lease-expiry cleanup for persistent hosts.
- Keep ephemeral-host expiry only if it reflects resource lifecycle constraints.
- Ensure command expiry interrupts `resolving` interactions.

Exit criteria:

- No pending row can remain forever after the provider request handle is gone.
- Persistent-host prompts do not expire solely because an HTTP request timed out.
- Ephemeral-host cleanup is explicit and tested.

### Phase 6: Remove Long-Poll Code

- Delete server waiter code that exists only to hold HTTP requests open.
- Delete daemon long-poll request handling.
- Remove tests, fixtures, and app/CLI error-rendering paths that distinguish HTTP-aborted waits from lifecycle interruptions.
- Replace long-poll tests with command-delivery and lifecycle-recovery tests.

Exit criteria:

- No production pending-interaction path depends on an HTTP request remaining open while the user thinks.
- The only durable delivery path is the daemon command/result lifecycle.

## Validation

Automated:

- `pnpm exec turbo run typecheck --filter=@bb/server --filter=@bb/host-daemon --filter=@bb/host-daemon-contract --filter=@bb/agent-runtime`
- `pnpm exec turbo run test --filter=@bb/server`
- `pnpm exec turbo run test --filter=@bb/host-daemon-contract`
- `pnpm exec turbo run test --filter=@bb/agent-runtime`
- `pnpm exec turbo run test --filter=@bb/integration-tests --force > /tmp/pending-interaction-transport-integration.txt 2>&1`

Targeted tests:

- registration retry after lost response returns the same pending interaction
- registration retry after the user resolved returns the same current row and does not create a duplicate
- HTTP abort after successful registration does not interrupt the interaction
- UI resolution queues an `interactive.resolve` command
- user resolution transitions `pending -> resolving`
- daemon resolves the matching live provider request
- successful daemon command result transitions `resolving -> resolved`
- stale provider request command result interrupts the interaction
- retried resolve command after successful delivery does not double-answer or mark interrupted
- daemon restart interrupts pending interactions owned by the old session
- session lease expiry interrupts persistent-host pending interactions
- thread deletion emits interrupted timeline event before cascade removes rows
- command expiry interrupts `resolving` interactions

Manual smoke:

- trigger a Codex approval, resolve it in the UI, and verify the provider continues
- trigger a Claude permission request, resolve it in the CLI, and verify the provider continues
- trigger an approval, restart the daemon before resolving, and verify the UI shows an interrupted interaction
- trigger an approval, resolve it, kill the provider before command delivery, and verify the server records interrupted rather than resolved

## Non-Goals

- Do not make provider JSON-RPC requests durable across daemon or provider process death.
- Do not add arbitrary expiry for persistent-host user prompts as a substitute for lifecycle cleanup.
- Do not preserve long-poll compatibility once the command-delivery path is complete.
