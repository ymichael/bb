# Environment-Agent Session Persistence Contract

Status: draft

This document defines the recommended persistence model for the session-based daemon ↔ environment-agent protocol.

It complements:

- `docs/contracts/environment-agent-session-protocol.md`
- `docs/contracts/environment-agent-session-protocol-v1-decisions.md`

The goal is to make storage responsibilities explicit before implementation starts so transport/runtime code can target stable persistence APIs.

## Design Principles

- The daemon owns durable truth for:
  - session lease state
  - per-thread applied cursors
  - durable command delivery state
  - projected thread state and thread event history
- The environment-agent owns durable truth for:
  - outbound unacked events
  - current local stream generation/sequence state
  - command receipt/execution dedupe
- Thread domain history and transport/session bookkeeping must remain separate concerns.
- Per-thread ordering is guaranteed by persisted cursors and per-thread command cursors, not by in-memory maps.
- All repository APIs should prefer closed/internal unions and typed state transitions over generic stringly-typed mutation helpers.

## Storage Ownership

## Daemon-side persistence

Location:

- `packages/db`
- same SQLite database already used by the daemon

Owns:

- session metadata
- daemon-applied cursors
- daemon command log
- command state transitions

Does not own:

- agent outbox entries
- agent command dedupe/execution rows

## Environment-agent-side runtime state

Location:

- in-memory store owned by `packages/environment-agent`
- not part of `packages/db`

Why separate:

- the agent still buffers while the daemon is temporarily unavailable
- the agent may run on a different machine/container than the daemon
- the agent lifecycle differs from daemon app lifecycle
- env-agent crash is treated as terminal, so local state does not need crash durability

Owns:

- current session bootstrap state
- outbound event outbox
- command receipt/execution state

## Daemon DB Tables

## `environment_agent_sessions`

Purpose:

- track active/recent sessions for a thread
- make lease-based liveness durable
- support explicit replacement/expiry semantics

Recommended columns:

- `id` text primary key
- `thread_id` text not null references `threads.id`
- `agent_id` text not null
- `agent_instance_id` text not null
- `protocol_version` integer not null
- `transport_kind` text not null
- `status` text not null
- `lease_expires_at` integer not null
- `last_heartbeat_at` integer
- `created_at` integer not null
- `updated_at` integer not null
- `closed_at` integer
- `close_reason` text

Status union (`closed_internal`):

- `active`
- `expired`
- `closed`
- `replaced`

Indexes:

- `(thread_id, status)`
- `(agent_id, status)`
- `(lease_expires_at)`

Repository owner:

- `EnvironmentAgentSessionRepository`

Key invariants:

- at most one `active` session per thread at a time
- at most one `active` session per `agent_id` when the agent is thread-scoped in v1
- lease expiry must not silently delete history; expiry is a state transition
- session replacement must mark the older session `replaced`, not merely remove it

## `environment_agent_cursors`

Purpose:

- persist the daemon's last durably applied event cursor per thread stream

Recommended columns:

- `thread_id` text primary key references `threads.id`
- `generation` integer not null
- `sequence` integer not null
- `updated_at` integer not null

Repository owner:

- `EnvironmentAgentCursorRepository`

Key invariants:

- one cursor row per thread once the new protocol is active for that thread
- cursor advances only after durable event application succeeds
- cursor never moves backwards
- generation may only stay equal or increase
- if generation increases, resulting cursor sequence must reflect the applied state in that new generation

Migration note:

- `threads.environment_agent_cursor` may coexist temporarily
- final ownership of event-stream progress should move to this dedicated table

## `environment_agent_commands`

Purpose:

- daemon durable command log and outbox
- per-thread command ordering and retry state

Recommended columns:

- `id` text primary key
- `thread_id` text not null references `threads.id`
- `session_id` text references `environment_agent_sessions.id`
- `command_cursor` integer not null
- `command_type` text not null
- `payload` text not null
- `state` text not null
- `result` text
- `error_code` text
- `error_message` text
- `created_at` integer not null
- `updated_at` integer not null

State union (`closed_internal`):

- `queued`
- `sent`
- `received`
- `started`
- `completed`
- `failed`
- `cancelled`

Indexes:

- unique `(thread_id, command_cursor)`
- `(thread_id, state, updated_at)`
- `(session_id, state)`

Repository owner:

- `EnvironmentAgentCommandRepository`

Key invariants:

- `command_cursor` is monotonic per thread
- command retries reuse the same `id`
- `state` transitions are validated, not arbitrary
- `completed` and `failed` are terminal
- terminal commands may remain queryable for diagnostics/compaction policies

## Optional daemon diagnostics table: `environment_agent_command_attempts`

This is optional for v1.

Potential columns:

- `id`
- `command_id`
- `session_id`
- `attempt_number`
- `started_at`
- `finished_at`
- `result_state`
- `error_message`

Useful for:

- retry storm debugging
- timing analysis
- session replacement diagnostics

Not required for correctness.

## Environment-Agent Local State

These structures live in the environment-agent-managed in-memory store.

## `session_state`

Purpose:

- durable bootstrap info for reconnect/resume

Recommended columns:

- `thread_id` text primary key
- `agent_id` text not null
- `agent_instance_id` text not null
- `session_id` text
- `generation` integer not null
- `next_sequence` integer not null
- `last_acked_generation` integer
- `last_acked_sequence` integer
- `last_delivered_command_cursor` integer
- `created_at` integer not null
- `updated_at` integer not null

Key invariants:

- one row per thread-scoped agent in v1
- `next_sequence` is always greater than the highest persisted outbox sequence in the current generation
- session id may be null before first successful `session_open`

## `event_outbox`

Purpose:

- durable agent-side queue of events pending daemon ack

Recommended columns:

- `thread_id` text not null
- `generation` integer not null
- `sequence` integer not null
- `event_id` text not null
- `payload` text not null
- `emitted_at` integer not null
- `acked_at` integer

Primary/unique key:

- unique `(thread_id, generation, sequence)`

Supporting indexes:

- `(thread_id, generation, acked_at, sequence)`
- `(acked_at)`

Key invariants:

- an event is inserted into outbox before it is sent to daemon
- unacked rows survive process restart
- compaction only removes rows covered by daemon ack policy
- daemon ack coverage is applied contiguously per thread/generation

## `command_receipts`

Purpose:

- durable dedupe for daemon commands delivered to the agent
- execution status store for reconnect/retry safety

Recommended columns:

- `command_id` text primary key
- `thread_id` text not null
- `command_cursor` integer not null
- `command_type` text not null
- `state` text not null
- `result` text
- `error_code` text
- `error_message` text
- `created_at` integer not null
- `updated_at` integer not null

State union (`closed_internal`):

- `received`
- `started`
- `completed`
- `failed`

Indexes:

- `(thread_id, command_cursor)`
- `(thread_id, state, updated_at)`

Key invariants:

- receipt row is persisted before `command_ack(state=received)` is emitted
- duplicate command delivery with same `command_id` must not re-execute provider work
- if a command is already terminal, duplicate redelivery should replay the stored status/result rather than execute again

## Recommended Repository APIs

## Daemon: `EnvironmentAgentSessionRepository`

Suggested methods:

- `create(args: { id: string; threadId: string; agentId: string; agentInstanceId: string; protocolVersion: number; transportKind: SessionTransportKind; leaseExpiresAt: number; now?: number }): EnvironmentAgentSessionRecord`
- `getById(id: string): EnvironmentAgentSessionRecord | undefined`
- `getActiveByThreadId(threadId: string): EnvironmentAgentSessionRecord | undefined`
- `listExpiringBefore(timestamp: number): EnvironmentAgentSessionRecord[]`
- `touchHeartbeat(args: { sessionId: string; leaseExpiresAt: number; heartbeatAt: number }): EnvironmentAgentSessionRecord | undefined`
- `markExpired(sessionId: string, now?: number): EnvironmentAgentSessionRecord | undefined`
- `markClosed(args: { sessionId: string; reason: SessionCloseReason; now?: number }): EnvironmentAgentSessionRecord | undefined`
- `markReplaced(args: { sessionId: string; reason: "newer_session"; now?: number }): EnvironmentAgentSessionRecord | undefined`
- `replaceActiveForThread(args: { threadId: string; nextSession: NewSessionInput; now?: number }): { replaced?: EnvironmentAgentSessionRecord; active: EnvironmentAgentSessionRecord }`

Transition rules should be enforced in repository/helper logic, not left to arbitrary callers.

## Daemon: `EnvironmentAgentCursorRepository`

Suggested methods:

- `getByThreadId(threadId: string): EnvironmentAgentCursorRecord | undefined`
- `upsert(threadId: string, cursor: { generation: number; sequence: number }, now?: number): EnvironmentAgentCursorRecord`
- `advanceIfNext(args: { threadId: string; expectedCurrent?: CursorPosition; next: CursorPosition; now?: number }): { advanced: true; cursor: EnvironmentAgentCursorRecord } | { advanced: false; cursor?: EnvironmentAgentCursorRecord }`
- `resetForMigration(threadId: string): void` only if needed for explicit migration tooling

The repository should expose comparison helpers or use a shared cursor comparator from protocol types.

## Daemon: `EnvironmentAgentCommandRepository`

Suggested methods:

- `enqueue(args: { id: string; threadId: string; commandType: EnvironmentAgentCommandType; payload: unknown; sessionId?: string; now?: number }): EnvironmentAgentCommandRecord`
- `getById(id: string): EnvironmentAgentCommandRecord | undefined`
- `listPendingByThreadId(threadId: string): EnvironmentAgentCommandRecord[]`
- `listDeliverableBySessionId(sessionId: string, afterCursor?: number, limit?: number): EnvironmentAgentCommandRecord[]`
- `markSent(commandId: string, now?: number): EnvironmentAgentCommandRecord | undefined`
- `markReceived(commandId: string, now?: number): EnvironmentAgentCommandRecord | undefined`
- `markStarted(commandId: string, now?: number): EnvironmentAgentCommandRecord | undefined`
- `markCompleted(args: { commandId: string; result?: unknown; now?: number }): EnvironmentAgentCommandRecord | undefined`
- `markFailed(args: { commandId: string; errorCode?: string; errorMessage?: string; now?: number }): EnvironmentAgentCommandRecord | undefined`
- `markCancelled(commandId: string, now?: number): EnvironmentAgentCommandRecord | undefined`
- `getNextCursorForThread(threadId: string): number`

`enqueue()` should allocate the next per-thread `command_cursor` transactionally.

## Agent: `SessionStore`

Suggested methods:

- `loadSessionState(threadId: string): AgentSessionState | undefined`
- `initializeThreadState(args: { threadId: string; agentId: string; agentInstanceId: string; generation: number; now?: number }): AgentSessionState`
- `setSessionBinding(args: { threadId: string; sessionId: string; now?: number }): AgentSessionState`
- `bumpGeneration(args: { threadId: string; now?: number }): AgentSessionState`
- `appendOutboxEvent(args: { threadId: string; payload: unknown; emittedAt?: number }): AgentOutboxEvent`
- `listUnackedOutbox(args: { threadId: string; limit?: number }): AgentOutboxEvent[]`
- `ackOutboxThrough(args: { threadId: string; generation: number; sequence: number; ackedAt?: number }): number`
- `recordCommandReceived(args: { commandId: string; threadId: string; commandCursor: number; commandType: string; now?: number }): AgentCommandReceiptRecord`
- `getCommandReceipt(commandId: string): AgentCommandReceiptRecord | undefined`
- `markCommandStarted(commandId: string, now?: number): AgentCommandReceiptRecord | undefined`
- `markCommandCompleted(args: { commandId: string; result?: unknown; now?: number }): AgentCommandReceiptRecord | undefined`
- `markCommandFailed(args: { commandId: string; errorCode?: string; errorMessage?: string; now?: number }): AgentCommandReceiptRecord | undefined`
- `setLastDeliveredCommandCursor(args: { threadId: string; commandCursor: number; now?: number }): AgentSessionState`

This can be implemented as one class over in-memory Maps.

## Recommended Closed/Internal Unions

These should live in shared protocol/store types, not as loose strings in repository implementations.

### Session transport kind

- `http-long-poll`

### Session status

- `active`
- `expired`
- `closed`
- `replaced`

### Session close reason

- `agent_shutdown`
- `daemon_shutdown`
- `lease_expired`
- `newer_session`
- `migration`
- `internal_error`

### Command state (daemon)

- `queued`
- `sent`
- `received`
- `started`
- `completed`
- `failed`
- `cancelled`

### Command receipt state (agent)

- `received`
- `started`
- `completed`
- `failed`

## Compatibility and Migration Rules

### Coexistence period

During migration:

- old `/stream` + `/deliver` threads may continue using `threads.environment_agent_cursor`
- new session-protocol threads should write dedicated cursor/session/command tables
- code should not partially update both models for the same thread once a thread is opted into the new protocol

### Data migration

Suggested approach:

- add new tables with no destructive changes first
- backfill cursor rows lazily when a thread first uses session protocol
- keep old scalar cursor only as a legacy read fallback during migration
- remove legacy field only after all threads/environments have migrated

## Suggested Contract Ownership

- `packages/db/src/schema.ts`
  - daemon DB tables only
- `packages/db/src/repositories.ts`
  - daemon repository classes, or split into dedicated files if the file grows too large
- `packages/environment-agent/src/session-store.ts`
  - local agent in-memory state + persistence APIs
- `packages/environment-agent/src/session-protocol.ts`
  - closed/internal unions shared by runtime/store logic

## Validation Expectations

- repository tests covering legal and illegal state transitions
- cursor tests covering duplicate, contiguous, gap, and generation-change cases
- command repository tests covering idempotent retries and terminal states
- session lease tests covering heartbeat extension, expiry, and replacement
- agent store tests proving:
  - outbox survives restart
  - duplicate command delivery does not double-execute
  - ack compaction only removes covered rows
