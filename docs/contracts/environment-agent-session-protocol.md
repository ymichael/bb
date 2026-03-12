# Environment-Agent Session Protocol

Status: current

This document specifies the current canonical protocol between the Beanbag daemon and environment-agent.

It defines the session-based model used for liveness, command delivery, event delivery, acknowledgement, reconnect, and restart-time nudging of surviving agents.

## Goals

- fast: low-latency command and event propagation over a live connection when available
- reliable: daemon-side durable acknowledgement semantics with idempotent retry behavior
- resilient: surviving agents can reconnect after daemon restart or outage, but daemon correctness does not depend on agent-local durability
- scalable: supports many concurrent agents without daemon-side polling of every agent
- adaptable: message semantics stay stable across WebSocket, HTTP long-poll, SSE+POST, or future transports

## Non-Goals

- Redesign provider-side JSON-RPC between environment-agent and the provider runtime
- Build a distributed broker or externally managed queue
- Guarantee global ordering across all threads or all agents

## Terminology

- **Agent**: the environment-agent process managing one or more thread channels.
- **Daemon**: the Beanbag daemon.
- **Session**: an explicit leased relationship between daemon and a specific agent instance.
- **Lease**: the daemon-granted validity window for a session. A session is active until its lease expires, is explicitly closed, or is replaced.
- **Channel**: an independently ordered logical stream carried inside a session. In v1, a channel is expected to map to a thread.
- **Generation**: a monotonically changing identifier for a channel stream after agent-side restart/reset.
- **Cursor**: the daemon's last durably applied position for a channel stream, expressed as `(generation, sequence)`.
- **Outbox**: the agent's local store of outbound messages/events not yet acknowledged by the daemon. In the current model this is best-effort, not crash-durable.

## Core Invariants

1. Wire delivery is **at least once**, never assumed to be exactly once.
2. Both sides must apply messages **idempotently** using stable ids.
3. Ordering is guaranteed **per channel** only.
4. The daemon advances a channel cursor only after it has **durably applied** the corresponding events.
5. The agent removes outbound events from its local outbox only after receiving a daemon ack that covers them. If the agent crashes first, those uncommitted events may be lost.
6. A new agent instance must not reuse an old channel stream without changing its **generation**.
7. Session liveness is determined by **lease state**, not inferred from one-off request success.

## Session Model

A session is established or resumed by an agent. The daemon does not need to discover or poll all agents continuously.

### Session Identity

Each session is associated with:

- `agentId`: stable logical identity for an environment-agent target
- `agentInstanceId`: unique id for the current agent process instance
- `sessionId`: server-issued id for the current session lease
- `protocolVersion`: negotiated version
- `controlEndpoint`: optional daemon-reachable control URL and auth token used for restart nudges

### Channel Identity

Each channel is identified by:

- `channelId`: thread id in v1
- `generation`: stream generation for that channel
- `sequence`: channel-local monotonically increasing event number within the generation

An event is uniquely identified by `(channelId, generation, sequence)`.

## Message Envelope

All protocol messages share a common envelope.

```json
{
  "protocol": "beanbag.env-agent.v1",
  "messageId": "01JXYZ...",
  "sentAt": 1770000000000,
  "sessionId": "sess_123",
  "type": "event_batch",
  "payload": {}
}
```

Fields:

- `protocol`: closed/internal protocol id
- `messageId`: stable id for dedupe and diagnostics
- `sentAt`: sender timestamp in epoch milliseconds
- `sessionId`: omitted only for `session_open`
- `type`: closed/internal union handled exhaustively
- `payload`: type-specific payload

## Message Types

### `session_open`

Sent by agent when no valid resumable session is known.

```json
{
  "protocol": "beanbag.env-agent.v1",
  "messageId": "msg_open_1",
  "sentAt": 1770000000000,
  "type": "session_open",
  "payload": {
    "agentId": "agent_thread_local_proj1_thread1",
    "agentInstanceId": "agentinst_01",
    "supportedProtocolVersions": [1],
    "controlEndpoint": {
      "baseUrl": "http://127.0.0.1:4310",
      "authToken": "secret-token"
    },
    "channels": [
      {
        "channelId": "thread-1",
        "generation": 7,
        "lastDaemonAcked": {
          "generation": 7,
          "sequence": 104
        }
      }
    ]
  }
}
```

`controlEndpoint` is optional restart metadata. When present, the daemon may use it to send `/control/session-sync` nudges after restart so a surviving agent resets reconnect backoff and checks in quickly.

### `session_welcome`

Sent by daemon in response to `session_open`.

```json
{
  "protocol": "beanbag.env-agent.v1",
  "messageId": "msg_welcome_1",
  "sentAt": 1770000005100,
  "sessionId": "sess_124",
  "type": "session_welcome",
  "payload": {
    "leaseTtlMs": 30000,
    "heartbeatIntervalMs": 10000,
    "protocolVersion": 1,
    "channels": [
      {
        "channelId": "thread-1",
        "applyFrom": {
          "generation": 7,
          "sequenceExclusive": 104
        }
      }
    ]
  }
}
```

The daemon may issue a new `sessionId` on resume.

### `heartbeat`

Either side may send heartbeats. Agent heartbeats are required for lease extension.

```json
{
  "protocol": "beanbag.env-agent.v1",
  "messageId": "msg_hb_1",
  "sentAt": 1770000010000,
  "sessionId": "sess_124",
  "type": "heartbeat",
  "payload": {
    "agentObservedAt": 1770000010000,
    "outboxDepth": 3,
    "channels": [
      {
        "channelId": "thread-1",
        "lastSent": {
          "generation": 7,
          "sequence": 107
        },
        "lastAcked": {
          "generation": 7,
          "sequence": 104
        }
      }
    ]
  }
}
```

### `event_batch`

Sent by agent. Each batch may include events for one or more channels, but events must remain ordered within each channel.

```json
{
  "protocol": "beanbag.env-agent.v1",
  "messageId": "msg_evt_1",
  "sentAt": 1770000012000,
  "sessionId": "sess_124",
  "type": "event_batch",
  "payload": {
    "batches": [
      {
        "channelId": "thread-1",
        "generation": 7,
        "events": [
          {
            "sequence": 105,
            "eventId": "evt_105",
            "emittedAt": 1770000011800,
            "event": {
              "type": "provider.event",
              "method": "turn/started",
              "payload": { "turnId": "turn-1" }
            }
          },
          {
            "sequence": 106,
            "eventId": "evt_106",
            "emittedAt": 1770000011900,
            "event": {
              "type": "provider.event",
              "method": "item/completed",
              "payload": { "itemId": "item-1" }
            }
          }
        ]
      }
    ]
  }
}
```

### `event_ack`

Sent by daemon after durable application.

```json
{
  "protocol": "beanbag.env-agent.v1",
  "messageId": "msg_ack_1",
  "sentAt": 1770000012050,
  "sessionId": "sess_124",
  "type": "event_ack",
  "payload": {
    "channels": [
      {
        "channelId": "thread-1",
        "ackedThrough": {
          "generation": 7,
          "sequence": 106
        }
      }
    ]
  }
}
```

`event_ack` is authoritative. The agent may compact any outbox entries covered by the ack.

### `command_batch`

Sent by daemon. Commands are durable before sending.

```json
{
  "protocol": "beanbag.env-agent.v1",
  "messageId": "msg_cmd_1",
  "sentAt": 1770000014000,
  "sessionId": "sess_124",
  "type": "command_batch",
  "payload": {
    "commands": [
      {
        "channelId": "thread-1",
        "commandCursor": 19,
        "commandId": "cmd_01",
        "createdAt": 1770000013900,
        "command": {
          "type": "turn.start",
          "providerThreadId": "provider-thread-1",
          "params": {
            "input": [{ "type": "text", "text": "hello" }]
          }
        }
      }
    ]
  }
}
```

### `command_ack`

Sent by agent when commands are durably received and deduped.

```json
{
  "protocol": "beanbag.env-agent.v1",
  "messageId": "msg_cmd_ack_1",
  "sentAt": 1770000014010,
  "sessionId": "sess_124",
  "type": "command_ack",
  "payload": {
    "commands": [
      {
        "commandId": "cmd_01",
        "channelId": "thread-1",
        "state": "received"
      }
    ]
  }
}
```

### `command_result`

Optional dedicated result message if command lifecycle is not fully represented as normal events.

```json
{
  "protocol": "beanbag.env-agent.v1",
  "messageId": "msg_cmd_result_1",
  "sentAt": 1770000015000,
  "sessionId": "sess_124",
  "type": "command_result",
  "payload": {
    "commandId": "cmd_01",
    "channelId": "thread-1",
    "state": "completed",
    "result": {
      "providerThreadId": "provider-thread-1"
    }
  }
}
```

### `session_close`

Either side may close the session explicitly.

```json
{
  "protocol": "beanbag.env-agent.v1",
  "messageId": "msg_close_1",
  "sentAt": 1770000019000,
  "sessionId": "sess_124",
  "type": "session_close",
  "payload": {
    "reason": "agent_shutdown"
  }
}
```

### `session_replaced`

Sent by daemon to an older session when a newer agent instance takes over.

```json
{
  "protocol": "beanbag.env-agent.v1",
  "messageId": "msg_replaced_1",
  "sentAt": 1770000020000,
  "sessionId": "sess_124",
  "type": "session_replaced",
  "payload": {
    "reason": "newer_agent_instance"
  }
}
```

## Liveness and Lease Rules

A session is considered active when all of the following are true:

- it has been accepted by the daemon
- it has not been explicitly closed or replaced
- its heartbeat deadline has not passed

The daemon extends the stored liveness deadline when it receives timely heartbeats or other valid session traffic.

Suggested v1 defaults:

- `livenessTimeoutMs`: 30_000
- `heartbeatIntervalMs`: 10_000
- daemon may expire a session after missing enough heartbeats to pass the liveness deadline

Important distinctions:

- **active**: heartbeat deadline still valid
- **connected**: transport currently open
- **healthy**: delivery is progressing normally

A brief transport blip does not immediately make the session inactive if the heartbeat deadline is still valid.

## Durable State Requirements

### Daemon

The daemon must durably persist:

- session metadata needed to resume or replace sessions safely
- per-channel last applied event cursor `(generation, sequence)`
- durable command log and command delivery state
- command ids and states needed for idempotent retry handling

### Environment-Agent

The agent keeps best-effort in-memory runtime state for:

- outbound event outbox entries until covered by `event_ack`
- received/executed command ids and their state to suppress duplicate execution
- per-channel current generation and next sequence number
- minimal reset metadata needed after reconnect or restart

## Reconnect and Recovery Flows

### Agent reconnect after transient disconnect

1. agent keeps unacked events in its local outbox
2. transport disconnects
3. agent reconnects and sends `session_open`
4. daemon responds with `session_welcome`
5. daemon tells agent to resume from daemon cursor
6. agent resends unacked events after that cursor
7. normal `event_ack` flow resumes

### Daemon restart while agent keeps running

1. daemon restarts and restores persisted cursors/command log
2. agent reconnects using `session_open`
3. daemon issues fresh `session_welcome`
4. daemon requests events from its last durably applied cursor
5. agent resends any surviving local outbox events from that cursor
6. daemon reissues still-outstanding commands after its last acknowledged command cursor

### Agent restart before daemon ack

1. agent had locally buffered events but not received daemon ack
2. agent restarts
3. agent increments channel generation if stream continuity is lost
4. agent resumes from empty or surviving local runtime state
5. daemon either:
   - continues same generation if continuity is valid, or
   - accepts new generation and applies according to explicit generation rules

Generation change must be explicit; sequence reuse within the same generation is invalid.

### Session replacement

1. newer agent instance opens/resumes the same logical `agentId`/channel set
2. daemon chooses replacement policy
3. daemon grants lease to newer instance
4. daemon sends `session_replaced` to older session if reachable
5. older session must stop sending new traffic

## Ordering and Deduplication Rules

### Events

- Within a channel generation, the daemon applies only contiguous sequences.
- Events with sequence less than or equal to the durable cursor are duplicates and must be ignored safely.
- Events ahead of the cursor must not silently advance the durable cursor. The daemon responds with an `event_ack` at the last contiguous cursor so the agent can reset and resend from there.
- A generation mismatch must be handled explicitly, never heuristically.

### Commands

- Every retry uses the same `commandId`.
- The agent persists command receipt before acknowledging `received`.
- If a duplicate `commandId` arrives, the agent must not re-execute it.
- The daemon treats `command_ack` and `command_result` idempotently.

## Error Handling

The protocol should use structured error payloads instead of transport-specific status guesses.

Suggested closed/internal error codes:

- `unsupported_protocol_version`
- `unknown_session`
- `session_expired`
- `session_replaced`
- `generation_mismatch`
- `sequence_gap`
- `invalid_cursor`
- `duplicate_command`
- `command_not_found`
- `not_authorized`
- `internal_error`

Transport failures and protocol failures must remain distinct.

## Backoff and Retry

Retry behavior is transport-level, but recommended defaults are:

- exponential backoff
- bounded max delay
- jitter for automatic reconnect attempts
- server-directed retry hints may be honored, optionally with bounded jitter applied client-side

Retries must not change protocol semantics because ids and cursors remain stable.

## Transport Mapping

The message model is transport-agnostic.

### WebSocket Mapping

- one bidirectional socket carries all protocol envelopes
- messages are sent as JSON frames
- heartbeats ride on the same socket

### HTTP Long-Poll Mapping

One possible mapping:

- `POST /sessions/open`
  - carries `session_open`
  - returns `session_welcome`
- `POST /sessions/:sessionId/push`
  - carries agent→daemon envelopes such as `heartbeat`, `event_batch`, `command_ack`, `command_result`
- `GET /sessions/:sessionId/pull?waitMs=30000`
  - blocks until daemon has outbound envelopes such as `command_batch`, `event_ack`, `session_replaced`

This preserves the same session, cursor, and ack semantics without requiring WebSockets.

### SSE + POST Mapping

- daemon→agent: SSE stream of protocol envelopes
- agent→daemon: POST of protocol envelopes
- same ids, same cursors, same lease rules

## Versioning and Capability Negotiation

The daemon and agent negotiate:

- protocol version

Unknown required protocol versions must fail fast.

## Current Implementation Notes

The current HTTP implementation uses:

- `POST /threads/:id/environment-agent/session/open`
  - agent opens or reopens a leased session
- `POST /threads/:id/environment-agent/session/messages`
  - agent sends `heartbeat`, `event_batch`, `command_ack`, `command_result`, and `session_close`
- `GET /threads/:id/environment-agent/session/commands`
  - agent long-polls for daemon `command_batch` responses

This is the intentional v1 transport boundary for the current codebase.
