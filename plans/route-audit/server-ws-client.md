# `GET /ws` — Client WebSocket (Browser/UI)

**Route:** `apps/server/src/server.ts:78-86`
**Protocol:** `apps/server/src/ws/client-protocol.ts`
**Contract:** WebSocket upgrade. No auth required.
**Complexity:** Simple

## Connection

| Aspect | Detail |
|---|---|
| Path | `/ws` |
| Auth | **None** — no token or session check. Any client can connect. |
| Upgrade | Hono `upgradeWebSocket` via `@hono/node-ws`. |

## Message Types (Client -> Server)

| Type | Fields | Notes |
|---|---|---|
| `subscribe` | `entity`, `id?` | Subscribe to change notifications for an entity type (thread, project, environment, system) and optionally a specific ID. |
| `unsubscribe` | `entity`, `id?` | Remove a prior subscription. |

**Validation**: `isClientMessage` is a manual runtime type guard (not Zod). Checks `type` is "subscribe"/"unsubscribe" and `entity` is one of "thread", "project", "environment", "host", "system". Invalid messages close the socket with code 1008.

> **Updated 2026-03-29:** `"host"` entity added to subscription types. `"host-connected"` and `"host-disconnected"` now notify on the host entity instead of system. `SYSTEM_CHANGE_KINDS` is now empty.

## Message Types (Server -> Client)

| Type | Fields | Notes |
|---|---|---|
| `changed` | `entity`, `id?`, `changes` | Notification that an entity has changed. `changes` is an array of change kinds (e.g., `["events-appended"]`, `["status-changed"]`). Sent by `NotificationHub.notifyClients`. |

## Implementation Trace

1. **onOpen** — `hub.registerClient(socket)`: Adds socket to `clientKeysBySocket` map with an empty subscription set.
2. **onMessage** — `onClientSocketMessage(hub, socket, event.data)`:
   - Decodes raw payload via `decodeSocketPayload` (handles string, ArrayBuffer, TypedArray).
   - `JSON.parse` + `isClientMessage` type guard.
   - If invalid: `socket.close(1008, "invalid-message")`.
   - If `subscribe`: `hub.subscribe(socket, entity, id)` — adds socket to `clientSocketsByKey` map keyed by `"entity"` or `"entity:id"`.
   - If `unsubscribe`: `hub.unsubscribe(socket, entity, id)` — removes socket from the key set.
3. **onClose** — `hub.unregisterClient(socket)`: Removes socket from all subscription sets and the socket registry.

## Hub Notification Flow

When server code calls `hub.notifyThread(threadId, changes)` (or notifyProject, notifyEnvironment, notifyHost, notifySystem):
- `notifyClients` looks up sockets subscribed to the broad key (e.g., `"thread"`) and the specific key (e.g., `"thread:abc123"`).
- Unions both sets, serializes the `ChangedMessage`, and sends to each socket.

## Code Reuse

- `decodeSocketPayload` — shared with daemon WebSocket.
- `NotificationHub` — singleton, shared across all routes.
- `isClientMessage` — local to client-protocol.ts.

## Flags

1. **No authentication**: The `/ws` endpoint has no auth check. The `/internal/*` middleware only covers the `/internal/` prefix. Any client can connect, subscribe to any entity, and receive change notifications. This may be intentional (the UI is assumed to be on a trusted network) but is worth documenting.
2. **Manual type guard instead of Zod**: `isClientMessage` is a hand-written type guard rather than a Zod schema parse. This is less maintainable — if the `ClientMessage` type adds new fields or variants, the guard must be updated manually.
3. **No rate limiting on subscriptions**: A client can subscribe to an unbounded number of entity keys. No protection against a client subscribing to every thread ID.
4. **JSON.parse is unguarded**: If `decodeSocketPayload` returns non-JSON, `JSON.parse` throws and the error propagates to the WebSocket framework (likely closes the connection). No explicit try/catch.

## Usages

| Caller | Location | Purpose |
|---|---|---|
| `WebSocketManager.connect` | `apps/app/src/lib/ws.ts:30` | Connects to `ws://<host>/ws` using `ReconnectingWebSocket` from the browser |
| `WebSocketManager.subscribe` | `apps/app/src/lib/ws.ts:81` | Sends `subscribe` messages for entity change notifications |
| `WebSocketManager.unsubscribe` | `apps/app/src/lib/ws.ts:89` | Sends `unsubscribe` messages to stop receiving notifications |
| `wsManager` (singleton) | `apps/app/src/lib/ws.ts:160` | Singleton `WebSocketManager` instance shared across the app |
| `useWebSocket` hook | `apps/app/src/hooks/useWebSocket.ts:90` | Connects, subscribes to thread/project/environment/system, and invalidates React Query caches on changes |
| `App` component | `apps/app/src/App.tsx:12` | Calls `useWebSocket()` at the app root to initialize the WS connection |
| `useServerConnectionState` | `apps/app/src/hooks/useWebSocket.ts:266` | Exposes WS connection state (connecting/connected/reconnecting) to UI |
| `AppSidebar` component | `apps/app/src/components/layout/AppSidebar.tsx:15` | Imports `useServerConnectionState` to show connection status indicator |
| `wsManager.onChanged` (atoms) | `apps/app/src/lib/atoms.ts:43` | Listens for WS changes to update Jotai atoms |
| `useApi` (connection check) | `apps/app/src/hooks/useApi.ts:798` | Checks `wsManager.getConnectionState()` before certain API calls |
| Vite dev proxy | `apps/app/vite.config.ts:26` | Proxies `/ws` path to the backend server during development |
| Test: integration WS | `apps/server/test/integration.test.ts:296` | Connects a raw `WebSocket` to `/ws` to test change notifications |
| Server route registration | `apps/server/src/server.ts:79` | Registers the `/ws` upgrade handler via `upgradeWebSocket` |

---

## Review Comments

<!-- Flag 1 is the most significant — depending on the deployment model, unauthenticated WebSocket access could be a security concern. Flag 4 is a robustness issue — a malformed message crashes the handler instead of cleanly closing the socket. -->
