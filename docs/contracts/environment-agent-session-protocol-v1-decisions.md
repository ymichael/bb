# Environment-Agent Session Protocol: Recommended V1 Decisions

Status: draft

This document turns the more general RFC in `docs/contracts/environment-agent-session-protocol.md` into concrete v1 recommendations that fit Beanbag's current architecture and code layout.

## Summary

Recommended v1 choices:

- **session granularity**: one session per thread/environment-agent
- **channel model**: one channel per session, `channelId === threadId`
- **generation format**: monotonically increasing integer per thread stream
- **primary transport**: WebSocket
- **fallback transport**: HTTP long-poll + POST push/pull protocol envelopes
- **event durability**: in-memory environment-agent outbox
- **command durability**: durable daemon SQLite command log
- **command receipt dedupe**: in-memory environment-agent command receipt/execution table keyed by `commandId`
- **command completion**:
  - provider/user-visible state remains canonical in the normal event stream
  - `command_result` exists for transport/control-plane completion and RPC-style return values that are not naturally modeled as events
- **daemon source of truth**: daemon-owned persisted cursor `(generation, sequence)` plus command delivery state
- **migration strategy**: parallel protocol version behind a feature flag; migrate `local` first, then `worktree`, then `docker`

These choices intentionally optimize for the current one-thread-per-agent architecture while leaving room to grow into multiplexed sessions later.

## Why These Choices

### One session per thread

This matches the current model closely:

- each thread already owns one environment runtime
- each environment runtime already exposes one environment-agent target
- many current daemon maps are keyed by `threadId`

Benefits:

- smallest migration surface
- simplest lease/liveness reasoning
- easiest failure isolation
- avoids designing multi-channel fairness and head-of-line blocking in v1

Tradeoff:

- higher connection count than multiplexing
- but acceptable for current Beanbag scale and much easier to reason about

### Integer generations

Use a thread-local integer generation that increases whenever the environment-agent cannot prove stream continuity for that thread.

Why not ULIDs in v1:

- integer comparison is simpler
- easier comparison and testing
- fits current cursor mental model

Rule:

- `(threadId, generation)` identifies one ordered event stream
- `sequence` resets to `1` only when `generation` increments

### WebSocket + HTTP long-poll

WebSocket is the cleanest live transport.

HTTP long-poll is the safest fallback because it works even when:

- ingress does not support WebSocket
- infrastructure terminates idle sockets aggressively
- we need a simpler deployment path in hosted environments

We should not make protocol semantics depend on WebSocket-only concepts.

### Event stream remains canonical for user-visible state

Provider lifecycle and user-visible thread changes should still come from normal events because:

- the daemon already projects thread state from events
- UI realtime updates already key off event persistence and derived thread changes
- this keeps one canonical domain history

However, some command outcomes are not naturally represented as provider events, for example:

- command receipt
- duplicate suppression
- some RPC return payloads like initial `providerThreadId`
- workspace-status/diff style request/response operations

So v1 should support both:

- **domain state** via normal events
- **control-plane completion** via `command_result`

## Recommended Persistence Model

## Daemon DB additions

Add daemon-owned persisted state under `packages/db`.

### New table: `environment_agent_sessions`

Purpose:

- current or recent session metadata per thread
- lease/liveness state
- protocol negotiation state

Recommended columns:

- `id` (PK) — session id
- `thread_id` (FK -> `threads.id`, indexed)
- `agent_id` (not null)
- `agent_instance_id` (not null)
- `protocol_version` (not null)
- `status` (`active` | `expired` | `closed` | `replaced`)
- `lease_expires_at` (not null)
- `last_heartbeat_at` (nullable)
- `created_at` (not null)
- `updated_at` (not null)
- `closed_at` (nullable)
- `close_reason` (nullable)

Indexes:

- `(thread_id, status)`
- `(agent_id, status)`
- `(lease_expires_at)`

### New table: `environment_agent_cursors`

Purpose:

- daemon durable cursor per thread stream

Recommended columns:

- `thread_id` (PK, FK -> `threads.id`)
- `generation` (not null)
- `sequence` (not null)
- `updated_at` (not null)

This should replace the current scalar `threads.environment_agent_cursor` once migration is complete.

During migration, both may coexist temporarily.

### New table: `environment_agent_commands`

Purpose:

- durable daemon outbox / command log
- retry-safe command delivery state

Recommended columns:

- `id` (PK) — `commandId`
- `thread_id` (FK -> `threads.id`, indexed)
- `session_id` (nullable; command may survive session replacement)
- `command_cursor` (not null, monotonic per thread)
- `command_type` (not null)
- `payload` (JSON, not null)
- `state` (`queued` | `sent` | `received` | `started` | `completed` | `failed` | `cancelled`)
- `result` (JSON, nullable)
- `error_code` (nullable)
- `error_message` (nullable)
- `created_at` (not null)
- `updated_at` (not null)

Indexes:

- `(thread_id, command_cursor)` unique
- `(thread_id, state, updated_at)`

### Optional follow-up table: `environment_agent_command_attempts`

Useful for diagnostics but not required for first migration.

## Environment-agent runtime store

The environment-agent should own its own small in-memory store.

Recommended location policy:

- local/worktree: process-local memory
- docker/container: process-local memory

### Table: `session_state`

- current `agent_id`
- current `agent_instance_id`
- current `session_id`
- current `thread_id`
- current `generation`
- next `sequence`
- last daemon acked `(generation, sequence)`
- last delivered command cursor
- timestamps

### Table: `event_outbox`

- `thread_id`
- `generation`
- `sequence`
- `event_id`
- `payload` (JSON)
- `emitted_at`
- `acked_at` (nullable)

Indexes:

- `(thread_id, generation, sequence)` unique
- `(acked_at)`

### Table: `command_receipts`

- `command_id`
- `thread_id`
- `command_cursor`
- `state` (`received` | `started` | `completed` | `failed`)
- `result` (JSON, nullable)
- `error_code` (nullable)
- `error_message` (nullable)
- `created_at`
- `updated_at`

This is the key table that prevents duplicate execution after reconnect or redelivery.

## Recommended Codebase Mapping

## `packages/environment-agent`

### New modules

- `src/session-protocol.ts`
  - closed/internal TypeScript unions for all session protocol messages
  - encode/decode helpers
  - generation/cursor comparison helpers
- `src/session-store.ts`
  - agent-side in-memory runtime store
  - CRUD for `session_state`, `event_outbox`, `command_receipts`
- `src/session-runtime.ts`
  - owns reconnect, heartbeat, outbox flush, replay, and command dedupe/execution
- `src/transports/http-long-poll.ts`
  - protocol envelope transport over long-poll HTTP
- `src/session-service.ts`
  - wires runtime + chosen transport for the CLI/bundle entrypoint

### Existing files likely to change heavily

- `src/runtime.ts`
  - split current provider-runtime handling from daemon session/delivery handling
- `src/client.ts`
  - current HTTP control client becomes either:
    - legacy compatibility layer, or
    - transport adapter client for migration endpoints
- `src/http-server.ts`
  - replaced or supplemented by session endpoints for long-poll fallback
- `src/protocol.ts`
  - current environment-agent control/replay/delivery shapes likely split into:
    - legacy protocol
    - new session protocol

## `apps/daemon`

### New modules

- `src/environment-agent-session-manager.ts`
  - session open/resume
  - lease tracking
  - heartbeat processing
  - session replacement
  - reconnect/replay orchestration
- `src/environment-agent-command-dispatcher.ts`
  - durable command enqueue/send/retry logic
- `src/environment-agent-event-applier.ts`
  - validates `(generation, sequence)` ordering
  - applies idempotently
  - advances durable cursor

### Existing files likely to change heavily

- `src/orchestrator.ts`
  - remove mixed responsibilities for:
    - live client cache
    - replay cursor maps
    - `/deliver` ingestion
    - direct retry nudges as the main recovery mechanism
  - delegate to session manager
- `src/routes/threads.ts`
  - legacy environment-agent status/replay/deliver routes likely remain during migration
  - add or route through new session endpoints for HTTP fallback transport
- `src/environment-service.ts`
  - still resolves connection targets, but target shape will need to support transport negotiation and session bootstrap

### Existing in-memory fields expected to disappear or shrink

In `Orchestrator`, the following are good candidates to remove once migration is complete:

- `liveEnvironmentAgentClientsByThreadId`
- `liveEnvironmentAgentIngestByThreadId`
- `environmentAgentReplayCursorByThreadId`

Their semantics move into durable DB-backed session/cursor state.

## `packages/db`

### New schema/repository work

- add new session/cursor/command tables
- add repositories for:
  - `EnvironmentAgentSessionRepository`
  - `EnvironmentAgentCursorRepository`
  - `EnvironmentAgentCommandRepository`
- keep thread/event repository semantics focused on domain threads/events, not transport bookkeeping

### Migration recommendation

Do **not** overload `threads` with many session fields.

A temporary coexistence period with `threads.environment_agent_cursor` is acceptable, but the final design should move session bookkeeping into dedicated tables.

## `packages/environment`

### Connection target evolution

Current `EnvironmentAgentConnectionTarget` should evolve from “HTTP endpoint + headers” toward:

- `agentId`
- transport endpoints/options
- supported transports
- auth material
- maybe bootstrap metadata like thread/environment ids

The environment should still be responsible for making the agent reachable, but not for transport semantics themselves.

## Transport Recommendation in More Detail

## WebSocket v1

Use when available.

Why:

- lowest latency
- simple bidirectional semantics
- easiest mapping to leases and push/pull envelopes

## HTTP long-poll fallback v1

Prefer long-poll over sync-style short polling in v1.

Recommended endpoints:

- `POST /api/v1/environment-agent/sessions/open`
- `POST /api/v1/environment-agent/sessions/:sessionId/push`
- `GET /api/v1/environment-agent/sessions/:sessionId/pull?waitMs=30000`
- `POST /api/v1/environment-agent/sessions/:sessionId/close`

Rationale:

- preserves server push semantics without requiring WebSocket support
- easier to reason about than SSE in both Node-only and browser-less agent environments
- keeps a single envelope model

SSE can remain a future optimization if needed.

## Recommended Command Semantics

### Commands that should produce `command_result`

Use `command_result` for operations where the daemon needs an RPC-style answer not guaranteed to appear as a normal provider event, for example:

- `thread.start` returning initial `providerThreadId`
- `thread.resume` returning confirmed provider identity
- `workspace.status`
- `workspace.diff`

### Commands that should still rely on normal events for user-visible state

These should continue to drive thread projection through the event log:

- `turn.start`
- `turn.steer`
- provider lifecycle transitions like `turn/started` and `turn/completed`
- provider-generated content/tool events

This keeps the event history canonical for UI/state while allowing the command plane to be operationally correct.

## Rollout Sequence

### Phase 1: protocol + persistence foundations

- add new DB tables and repositories
- add agent durable store
- define session protocol types and transport abstraction
- no behavior change yet

### Phase 2: daemon session manager + agent runtime behind a feature flag

- implement open/resume/heartbeat/event ack/command ack flows
- keep current `/stream` + `/deliver` path for legacy threads

### Phase 3: migrate `local`

- one environment kind on new protocol
- validate restart, reconnect, duplicate-command suppression, and durable outbox behavior

### Phase 4: migrate `worktree`

- validate isolated workspace lifecycle and suspend/resume behavior

### Phase 5: migrate `docker`

- validate long-lived remote-ish agents and HTTP fallback if needed

### Phase 6: remove legacy transport semantics

- remove `/stream`-as-fast-path semantics
- remove `/deliver`-specific recovery semantics
- remove heuristic active/inactive inference
- remove in-memory-only cursor assumptions

## Decisions We Likely Do Not Need User Input For Yet

These can move forward with implementation unless product constraints appear later:

- one session per thread in v1
- integer generation counters
- WebSocket primary + HTTP long-poll fallback
- in-memory env-agent outbox/command stores
- event stream as canonical user-visible history

## Decisions That May Still Need Product/Operator Input Later

- final lease TTL / heartbeat intervals
- how much diagnostics surface to expose in product UI vs daemon-only diagnostics
- whether session history should be retained long-term for debugging or aggressively compacted
