# `POST /internal/session/open` — Establish Daemon Session

**Route:** `apps/server/src/internal/session.ts:19`
**Contract:** `hostDaemonSessionOpenRequestSchema -> HostDaemonSessionOpenResponse` (201)
**Complexity:** High

## Request Body

| Field | Required | Notes |
|---|---|---|
| `hostId` | Yes | Identifies the host machine. Used to upsert into `hosts` table and to look up/replace existing sessions. |
| `instanceId` | Yes | Daemon process instance identifier. Stored on the session row for disambiguation. |
| `hostName` | Yes | Display name for the host. Passed through to `upsertHost` and `openSession`. |
| `hostType` | Yes | Enum via `hostTypeSchema`. Stored on host and session rows. |
| `protocolVersion` | Yes | Must be exactly `2` (`z.literal(HOST_DAEMON_PROTOCOL_VERSION)`). Stored on session row. |
| `activeThreads` | Yes | Array of `{ environmentId, threadId, providerThreadId }`. Used by `reconcileSessionThreads` to sync thread status against what the daemon reports as running. |

**All 6 fields consumed. No dead params.**

## Implementation Trace

1. **Validate request** (sync) — `typedRoutes` Zod middleware parses body against `hostDaemonSessionOpenRequestSchema`.
2. **Check for existing active session** (sync) — `getActiveSession(db, payload.hostId)` queries `host_daemon_sessions` WHERE `hostId` = payload, `status` = "active", `leaseExpiresAt` > now.
3. **Upsert host record** (sync) — `upsertHost(db, hub, { id, name, type })`.
   - SELECT by PK `hosts.id`.
   - If exists: UPDATE `name`, `type`, `lastSeenAt`, `updatedAt`.
   - If not: INSERT new row, notify host `["host-connected"]`.
4. **Open new session** (sync) — `openSession(db, hub, { ... })`.
   - Selects all active sessions for this `hostId` and closes them (status="closed", closeReason="replaced").
   - Inserts new session row with `status="active"`, `leaseExpiresAt = now + LEASE_TIMEOUT_MS` (30s).
   - Notifies host `["host-connected"]`.
   - Returns the newly inserted session row.
5. **Close stale daemon WebSocket** (sync) — If `existingSession` (from step 2) exists and its `id` differs from the new session's `id`, calls `hub.closeDaemonSession(existingSession.id, "replaced")`.
   - Sends `{ type: "session-close", reason: "replaced" }` to the old daemon's WebSocket.
   - Closes the WebSocket with code 1000.
   - Unregisters the daemon from the hub.
6. **Reconcile thread statuses** (sync) — `reconcileSessionThreads(deps, hostId, activeThreads)`.
   - **Errored but active on daemon**: Threads in `error` status that are in `activeThreadIds` -> transition to `active`.
   - **Active on server but missing from daemon**: Threads in `active` status not in `activeThreadIds` -> transition to `idle`.
   - **Idle on server but active on daemon**: Threads in `idle` status that are in `activeThreadIds` -> transition to `active`.
   - Each sub-step does a JOIN query: `threads INNER JOIN environments` filtering by `environments.hostId`.
7. **Compute high-water marks** (sync) — `listHostThreadIds(db, hostId)` gets all thread IDs for this host (JOIN threads/environments). Then `getHighWaterMarks(db, threadIds)` aggregates `MAX(sequence)` from `events` grouped by `threadId`.

> **-> HTTP 201 returns here.** Everything is synchronous.

## DB Query Summary

| # | Query | Table | Index | Notes |
|---|-------|-------|-------|-------|
| 1 | SELECT active session by hostId | `host_daemon_sessions` | `host_daemon_sessions_host_status_idx` | For pre-existing session check |
| 2 | SELECT host by PK | `hosts` | PK | Part of upsertHost |
| 3 | UPDATE or INSERT host | `hosts` | PK | Upsert |
| 4 | SELECT all active sessions for hostId | `host_daemon_sessions` | `host_daemon_sessions_host_status_idx` | To close prior sessions |
| 5 | UPDATE each existing active session -> closed | `host_daemon_sessions` | PK | N updates (usually 0-1) |
| 6 | INSERT new session | `host_daemon_sessions` | — | |
| 7 | SELECT new session by PK | `host_daemon_sessions` | PK | Return value |
| 8-10 | 3x SELECT threads JOIN environments | `threads`, `environments` | `threads_environment_idx`, env PK | Reconciliation sub-queries |
| 11 | N x tryTransition | `threads` | PK | Per-thread status transitions |
| 12 | SELECT thread IDs for host | `threads`, `environments` | `threads_environment_idx` | For HWM |
| 13 | SELECT MAX(sequence) grouped by threadId | `events` | `events_thread_sequence_idx` | High-water marks |

**Total: ~13+ queries depending on thread count. Reconciliation loop does per-thread transitions — could be N+1 for hosts with many threads in wrong status.**

## Code Reuse

- `getActiveSession` — shared with `requireActiveSession` (session-state.ts) and `requireConnectedHostSession` (entity-lookup.ts).
- `upsertHost` — shared DB function used by session open only.
- `openSession` — shared DB function, used here only.
- `reconcileSessionThreads` — dedicated to this route.
- `listHostThreadIds` / `getHighWaterMarks` — reused by events route for HWM response.
- `tryTransition` — shared utility used across many routes.

## Flags

1. **Double active-session lookup**: `getActiveSession` is called at line 21, then `openSession` internally does another `SELECT ... WHERE status='active'` for the same hostId. The first lookup is only used to detect whether to close the daemon WebSocket; the second (inside `openSession`) does the actual DB close. This is redundant but not incorrect.
2. **Reconciliation is unbounded**: If a host has many threads, the three reconciliation queries plus per-thread `tryTransition` calls could be slow. No pagination or batching.
3. **No transaction wrapping**: The entire open flow (upsert host, open session, reconcile) is not wrapped in a single DB transaction. A crash between `openSession` and `reconcileSessionThreads` could leave threads in stale states. The window is small since this is SQLite (single-writer), but worth noting.
4. **`activeThreads.providerThreadId` is unused**: The `HostDaemonActiveThread` schema requires `providerThreadId`, but `reconcileSessionThreads` only uses `threadId`. The `providerThreadId` and `environmentId` fields from each active thread are accepted but ignored by the reconciliation logic.

## Usages

| Caller | Location | Purpose |
|---|---|---|
| `createServerClient().openSession` | `apps/host-daemon/src/server-client.ts:187` | POSTs to `/session/open` with host identity and active threads to establish a daemon session |
| `ServerConnection.openSession` | `apps/host-daemon/src/server-connection.ts:106` | Calls `serverClient.openSession` during initial connect and on WS reconnect |
| `ServerConnection.openSessionAndConnect` | `apps/host-daemon/src/server-connection.ts:99` | Orchestrates session open + WS connect on daemon startup |
| `ServerConnection.connectWebSocket` (reconnect) | `apps/host-daemon/src/server-connection.ts:127` | Re-opens session when WS reconnects with a new URL |
| `createDaemonApp` | `apps/host-daemon/src/app.ts:178` | Wires `ServerConnection` with `serverClient`, triggering session open on app start |
| `HostDaemonInternalSchema["/session/open"]` | `packages/host-daemon-contract/src/session.ts:135` | Type-level contract definition for the endpoint |
| `createHostDaemonClient` | `packages/host-daemon-contract/src/session.ts:174` | Typed Hono RPC client used by integration tests |
| Test: session open | `apps/server/test/internal-session.test.ts:63` | Tests successful session open and reconciliation |
| Test: replaced session | `apps/server/test/internal-session.test.ts:666` | Tests that opening a new session replaces the old one |
| Test: reconciliation regression | `apps/server/test/internal-reconciliation-idle-active-regression.test.ts:31` | Tests idle-to-active thread reconciliation on session open |
| Test: skeleton | `apps/server/test/skeleton.test.ts:25` | Basic route existence / schema validation test |
| Test: fake test-server | `apps/host-daemon/test/helpers/test-server.ts:115` | Fake server stub for host-daemon unit tests |
| Test: contract URL | `packages/host-daemon-contract/test/contract.test.ts:499` | Verifies typed client produces correct URL path |
| Test: integration | `apps/server/test/integration.test.ts` | Uses `createHostDaemonClient` to open sessions in integration tests |
| Test: integration harness | `tests/integration/helpers/harness.ts:398` | Creates typed client for integration test harness |

---

## Review Comments

<!-- Flag 4 is the most actionable — providerThreadId is a dead param inside reconciliation. Either use it (e.g., to update the thread's provider thread ID) or remove it from the contract. -->
