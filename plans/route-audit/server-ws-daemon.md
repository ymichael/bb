# `GET /internal/ws` — Daemon WebSocket

**Route:** `apps/server/src/server.ts:88-107`
**Protocol:** `apps/server/src/ws/daemon-protocol.ts`
**Contract:** WebSocket upgrade. Auth via `token` query param.
**Complexity:** Medium

## Connection

| Aspect | Detail |
|---|---|
| Path | `/internal/ws` |
| Auth | `token` query param must equal `deps.config.authToken`. Also requires valid `sessionId` query param pointing to an active, non-expired session. Validated during upgrade (before onOpen). |
| Upgrade | Hono `upgradeWebSocket` via `@hono/node-ws`. Context is captured in `validateDaemonWebSocket` closure before socket opens. |

## Query Params

| Param | Required | Notes |
|---|---|---|
| `token` | Yes | Bearer auth token. Compared to `deps.config.authToken`. |
| `sessionId` | Yes | Must reference an active session (status="active", leaseExpiresAt > now). Resolved to `{ sessionId, hostId }` context. |

## Message Types (Daemon -> Server)

| Type | Fields | Notes |
|---|---|---|
| `heartbeat` | (none) | Daemon sends periodically. Parsed via `hostDaemonDaemonWsMessageSchema`. The message exists only to renew the session lease. |

## Message Types (Server -> Daemon)

| Type | Fields | Notes |
|---|---|---|
| `commands-available` | (none) | Sent when new commands are queued for the daemon's host. Triggers the daemon to poll `GET /session/commands`. |
| `session-close` | `reason` | Sent when the session is being closed. `reason` is one of: `"replaced"` (new session opened), `"expired"` (lease timeout), `"daemon-disconnect"` (cleanup). |

## Implementation Trace

### Upgrade / Validation (sync, before WebSocket opens)

`validateDaemonWebSocket(deps, { sessionId, token })`:
1. If `sessionId` is null or `token` doesn't match: throws `Error("Unauthorized websocket")`.
2. `requireActiveSession(db, sessionId)` — SELECT from `host_daemon_sessions` with active+lease check. Throws `ApiError(401)` if invalid.
3. Returns `{ sessionId, hostId }`.

### onOpen

`onDaemonSocketOpen(deps, { hostId, sessionId, socket })`:
1. `hub.registerDaemon(sessionId, hostId, socket)`:
   - If a different session already exists for this `hostId`, unregisters it first.
   - Stores `{ hostId, socket }` keyed by `sessionId`.
   - Stores `sessionId` keyed by `hostId` (reverse lookup).

### onMessage

`onDaemonSocketMessage(deps, sessionId, raw)`:
1. Decode payload via `decodeSocketPayload`.
2. `JSON.parse` inside a try/catch.
3. Parse via `hostDaemonDaemonWsMessageSchema` (validates `type: "heartbeat"`).
4. If invalid: `socket.close(1008, "invalid-message")`.
5. `requireActiveSession(db, sessionId)` — re-validates session is still active.
6. `heartbeatSession(db, sessionId, Date.now() + session.leaseTimeoutMs)`:
   - UPDATE `host_daemon_sessions` SET `lastHeartbeatAt`, `leaseExpiresAt`, `updatedAt`.

### onClose

`onDaemonSocketClose(deps, sessionId)`:
1. `hub.unregisterDaemon(sessionId)` — removes daemon from both maps.
2. SELECT session by PK. If not found or not "active", return.
3. `closeSession(db, hub, sessionId, "daemon-disconnect")`:
   - UPDATE session to `status="closed"`, `closeReason="daemon-disconnect"`.
   - `notifier.notifyHost(["host-disconnected"])`.
4. **Interrupt active threads** — SELECT threads JOIN environments WHERE `environments.hostId = session.hostId` AND `threads.status IN ("active", "provisioning")`.
5. For each interrupted thread:
   - `appendSystemErrorEvent` — inserts `system/error` event with code `"host_daemon_disconnected"`.
   - `tryTransition(db, hub, thread.id, "error")` — transitions thread to error status.

## DB Query Summary

| # | Query | Table | Index | Notes |
|---|-------|-------|-------|-------|
| **Upgrade** | | | | |
| 1 | SELECT session by PK + status + lease | `host_daemon_sessions` | PK | validateDaemonWebSocket |
| **Per Heartbeat** | | | | |
| 2 | SELECT session by PK + status + lease | `host_daemon_sessions` | PK | requireActiveSession |
| 3 | UPDATE session lease/heartbeat | `host_daemon_sessions` | PK | heartbeatSession |
| **On Close** | | | | |
| 4 | SELECT session by PK | `host_daemon_sessions` | PK | Check status |
| 5 | UPDATE session -> closed | `host_daemon_sessions` | PK | closeSession |
| 6 | SELECT active/provisioning threads for host | `threads`, `environments` | `threads_environment_idx` | Interrupt detection |
| 7 | N x INSERT system/error event | `events` | `events_thread_sequence_idx` | Per interrupted thread |
| 8 | N x UPDATE thread status | `threads` | PK | Per interrupted thread |

**Heartbeat: 2 queries per heartbeat (every ~5s). Close: 3 + 2N queries. No N+1 for heartbeat. Close path is N+1 for hosts with many active threads.**

## Code Reuse

- `validateDaemonWebSocket` — local to daemon-protocol.ts.
- `requireActiveSession` — shared guard.
- `heartbeatSession` / `closeSession` — shared DB functions.
- `decodeSocketPayload` — shared with client WebSocket.
- `appendSystemErrorEvent` — shared service function.
- `tryTransition` — shared utility.
- `hub.registerDaemon` / `hub.unregisterDaemon` — hub methods specific to daemon sockets.

## Flags

1. **Session re-validated on every heartbeat**: `requireActiveSession` does a full DB read on each heartbeat message (~every 5s). This is correct for safety but adds query load. Could cache the session in-memory and only re-validate periodically.
2. **No graceful shutdown notification**: When the server itself shuts down, there's no mechanism to send `session-close` to all connected daemons. The daemons will only discover the disconnect via WebSocket close/error.
3. **`validateDaemonWebSocket` throws plain `Error`**: Unlike other routes that throw `ApiError`, the WebSocket validation throws `Error("Unauthorized websocket")`. This is caught by the Hono WebSocket upgrade handler, but the error format differs from the rest of the API.
4. **Thread interruption on close is not batched**: The close handler iterates threads individually, inserting events and transitioning one at a time. For hosts with many active threads, this could be slow and block the close handler.

## Usages

| Caller | Location | Purpose |
|---|---|---|
| `ServerConnection.buildWebSocketUrl` | `apps/host-daemon/src/server-connection.ts:287` | Builds `ws://<host>/internal/ws?sessionId=...&token=...` URL for daemon WS |
| `ServerConnection.connectWebSocket` | `apps/host-daemon/src/server-connection.ts:120` | Creates `ReconnectingWebSocket` to `/internal/ws` after session open |
| `ServerConnection.handleWebSocketMessage` | `apps/host-daemon/src/server-connection.ts:210` | Handles `commands-available` and `session-close` messages from the server |
| `ServerConnection.resetHeartbeat` | `apps/host-daemon/src/server-connection.ts:234` | Sends periodic `heartbeat` messages over the daemon WS |
| `createDaemonApp` | `apps/host-daemon/src/app.ts:178` | Wires `ServerConnection` with callbacks, establishing WS on daemon start |
| Server route registration | `apps/server/src/server.ts:89` | Registers the `/internal/ws` upgrade handler via `upgradeWebSocket` |
| Server auth middleware | `apps/server/src/server.ts:52` | Checks `context.req.path === "/internal/ws"` to skip JSON auth for WS upgrade |
| Test: fake test-server | `apps/host-daemon/test/helpers/test-server.ts:222` | Fake WS upgrade handler at `/internal/ws` for host-daemon unit tests |
| Test: heartbeat lease renewal | `apps/server/test/internal-session-correctness.test.ts:266` | Connects raw WS to `/internal/ws` and tests heartbeat-based lease extension |
| Test: session close on disconnect | `apps/server/test/internal-session-correctness.test.ts:314` | Tests that closing the daemon WS transitions threads to error |
| Test: thread interruption on close | `apps/server/test/internal-session-correctness.test.ts:364` | Tests that active threads are interrupted when daemon WS closes |
| Test: session replacement via WS | `apps/server/test/integration.test.ts:573` | Tests that opening a new session sends `session-close` to old daemon WS |

---

## Review Comments

<!-- Flag 1 is now query-load/operational rather than a contract issue. Flag 3 is still a minor inconsistency — it should probably throw ApiError for consistent error handling. -->
