# Environment-Agent Session Persistence Contract

Status: current

This document describes the persistence model that matches the current daemon `<->` environment-agent lifecycle.

It complements:

- `docs/contracts/environment-agent-session-protocol.md`

## Ownership

The daemon database is the only durable source of truth for:

- thread status
- applied thread event history
- env-agent session lease records
- daemon-applied event cursors
- daemon-owned command delivery state
- last-known env-agent control endpoint used for restart nudges

The environment-agent only keeps best-effort in-memory runtime state for:

- current bound session id
- current generation and last daemon-acked cursor
- unacked outbound events
- command receipt and result dedupe

If the environment-agent dies, its local state may be lost. That is acceptable by design.

## Daemon Persistence

The daemon persists three transport-facing concerns:

### `environment_agent_sessions`

Tracks active and recent leases for a thread.

Important fields:

- `id`
- `thread_id`
- `agent_id`
- `agent_instance_id`
- `protocol_version`
- `status`
- `lease_expires_at`
- `last_heartbeat_at`
- `control_base_url`
- `control_auth_token`
- `created_at`
- `updated_at`
- `closed_at`
- `close_reason`

Important invariants:

- at most one active session per thread
- heartbeat timeout is a state transition, not silent deletion
- replacement marks the older session `replaced`

### `environment_agent_cursors`

Tracks the daemon's last durably applied event cursor per thread.

Important fields:

- `thread_id`
- `generation`
- `sequence`
- `updated_at`

Important invariants:

- cursor advances only after durable event application
- cursor never moves backwards
- generation changes are explicit

### `environment_agent_commands`

Tracks the daemon-owned command log and delivery lifecycle.

Important fields:

- `id`
- `thread_id`
- `session_id`
- `command_cursor`
- `command_type`
- `payload`
- `state`
- `result`
- `error_code`
- `error_message`
- `created_at`
- `updated_at`

Important invariants:

- command cursor is monotonic per thread
- command ids are stable across retries
- terminal command states remain queryable

## Environment-Agent Runtime State

The environment-agent keeps runtime-only in-memory state in `packages/environment-agent`.

Important state:

- thread session state
- outbox events waiting for daemon ack
- command receipts and reported results

Important invariants:

- runtime state is not crash-durable
- daemon correctness must not depend on recovering it
- reconnect may flush surviving buffered state, but recovery does not require it

## Liveness

Liveness is daemon-owned and heartbeat-based.

- the daemon persists heartbeat timestamps
- the agent retries failed heartbeats with backoff
- daemon restart nudges known live agents and resets the liveness baseline
- missing heartbeat past timeout is treated as worker loss, not as a replay problem

## Status Consequences

- `active` thread loses required env-agent -> `error`
- `provisioned` thread loses required env-agent -> `provisioning_failed`
- `provisioning` does not imply env-agent liveness by itself
- `idle` does not require a live env-agent

## Non-Goals

This model does not provide:

- crash-durable agent-local outbox storage
- daemon recovery that depends on hidden agent-local state
- broker-style session rebinding across replacement workers
